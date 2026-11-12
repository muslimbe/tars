# How tars works

tars runs a Telegram bot whose brain is a long-lived Claude Code process. tars itself is the harness around it: it receives Telegram messages, feeds them to Claude Code as one ongoing conversation, serves its own tools over a local MCP server, and supervises the process. Node.js 24 + TypeScript, no build step — Node runs `src/*.ts` directly.

## One message, end to end

```
Telegram ──▶ dispatcher ──▶ engine ──▶ worker ──▶ claude (Claude Code)
                                         ▲              │ calls tools
                                    MCP server ◀────────┘
                                         │
                                    src/tools/ ──▶ back out to Telegram
```

1. **Boot.** `src/main.ts` loads `.env`, parses the config once (`src/config.ts`), takes the lock on `data/.instance.lock` (a second bot on the same data directory exits before writing anything there), sets up logging and turns signals into a clean shutdown (a hard exit after 12 s, inside Docker's 15 s grace). `App` in `src/app.ts` is the composition root: `start()` brings the parts up in order — database and boot-time reminder seeding, Telegram bot, MCP server with a warm Chromium, Claude Code, engine and reminder loop, dispatcher — and `stop()` tears them down in reverse.
2. **Dispatcher** (`src/telegram/dispatcher.ts`). grammY long-polls Telegram; outbound calls are throttled (30/s overall, 20/min per group) and a `429` is retried after Telegram's `retry_after`. Owner commands run first and never reach the model. Everything else passes the access gate, the per-user DM rate limit and the attachment download, becomes a `ChatMessage` (normalised, secrets scrubbed — `updates.ts`), is saved to SQLite and handed to the engine.
3. **Engine** (`src/engine/engine.ts`). Bundles messages that arrive together into one `<msg>` XML batch (`envelope.ts`) and starts a turn; a message that arrives mid-turn is injected into it. When the turn ends, `outcome.ts` decides what that ending means (see below). `typing.ts` keeps "typing…" up while a chat waits.
4. **Worker** (`src/claude/worker.ts`). Runs `claude --print --input-format stream-json` in its own process group (`child.ts`, the only file allowed to spawn), writes each turn to stdin, parses stdout into a `TurnResult` (`turn.ts`), saves the session id so a restart resumes the same conversation, records the raw wire to `data/cc_logs/` (`capture.ts`) and respawns after a crash.
5. **MCP server** (`src/mcp/server.ts`). The MCP SDK's low-level server over Streamable HTTP on `127.0.0.1`, random port. It lists the tools registered in `src/tools/index.ts`, validates every call against the tool's zod schema and writes a `tool_calls` audit row.
6. **Tools** (`src/tools/`). One factory per tool. The bot replies by calling `telegram_send_message` or `telegram_reply_to_message` (`src/tools/telegram/send.ts`), which sends the message and stores it. Tools reach the disk only through the path-hardened stores in `src/stores/`.

Messages that were saved but never handed to Claude (the bot stopped first) are replayed at the next boot if they're under 24 hours old.

**One turn at a time.** A 3-minute task for chat A delays chat B by up to 3 minutes: messages from other chats are injected into the running turn and wait for Claude to get to them. Fine for one user or a small group; for busy setups, run one bot per group of chats (backlog P1). The system prompt asks the bot to send a quick "on it" before any long task.

## Where things live

```
src/
├── main.ts, app.ts   # entry point; the composition root that wires and starts everything
├── config.ts         # every environment variable, parsed once
├── plugins.ts        # plugins.json
├── telegram/         # grammY bot, dispatcher, access gate, rate limit, owner commands, attachments
├── engine/           # turns: batching, the <msg> envelope, outcomes, typing, restored context
├── claude/           # the claude process: argv and system prompt, turn parsing, breaker, failures, capture
├── mcp/              # the local MCP server and the tool contract
├── tools/            # every tool, registered in index.ts
├── stores/           # path-hardened files: memory, skills, instructions, attachments, renders
├── db/               # SQLite: migrations, queries, the read-only query worker
├── scheduler/        # reminder loop, cron, boot-time seeding
├── browser/          # warm Chromium, the browsing session, the SSRF guard, HTML → PNG
├── log/              # logger, sinks, owner DMs, the [RX]/[TX]/[CC.*] transcript
├── text/             # chunking, Markdown → Telegram HTML, normalising, scrubbing, frontmatter
└── scripts/trace.ts  # npm run trace
prompts/              # system.md (shipped), project.md (the instance's), subagents.md
skills/               # the built-in playbooks
test/                 # vitest, mirroring src/; fakes/ has a fake claude and a fake Telegram, golden/ the pinned model-visible output
```

For a first read: `src/main.ts` and `App.start()`; `engine.ts` and `outcome.ts`; `worker.ts` and `turn.ts`; `src/mcp/server.ts` and one tool in `src/tools/telegram/`; `prompts/system.md`; then `test/integration/dm.test.ts` — the whole journey as one test, against a fake Telegram and a fake `claude`.

## What Claude Code may do

`src/claude/argv.ts` starts `claude` with three tool flags:

- `--tools` — an exclusive allow-list over Claude Code's built-ins: `WebFetch`, `WebSearch`, `StructuredOutput` (the turn-end tool), the MCP-discovery tools and the task-checklist tools. Anything else — `Bash`, `Edit`, `Agent`, native `Skill` — is unreachable, not merely unapproved. `tool_groups` in `plugins.json` extend the list. Claude Code runs in `projects/`, so the file tools of the `read` group see only that folder.
- `--allowedTools` — auto-approves that surface, `mcp__tars` and every enabled external MCP. `--disallowedTools` repeats the dangerous built-ins as a backstop.
- `--strict-mcp-config` with a generated config (`src/claude/mcpconfig.ts`). The local server is registered with `alwaysLoad: true`, so its tools are never deferred behind ToolSearch — which once made the bot "forget" `telegram_send_message` existed. Requires Claude Code ≥ 2.1.121.

- `--setting-sources ''` and `--settings '{"autoMemoryEnabled":false}'` — none of the host's Claude Code customisation loads: no hooks, plugins, permission rules, `CLAUDE.md` files or auto-memory (`MEMORY.md`), even on a developer machine or with `~/.claude` mounted. The bot sees tars' prompt and its own memory, nothing else.

`--dangerously-skip-permissions` is never passed: the argv builder and the worker's spawn-time check both refuse it.

The system prompt is `prompts/system.md`, then `prompts/project.md` (the instance's persona) if present, then generated blocks: the model and effort, the skills index, the memory index, the exact callable name of every reachable tool (`# Your tools` — built from the same list as `--tools`, so the two can't drift) and `prompts/subagents.md` when that group is on. All of it is re-read whenever `claude` starts, so a prompt edit applies at the next restart, respawn or `/reset_session` — never mid-session.

## How a turn ends

Claude's answer is a list of blocks: thinking, text and tool calls. On Telegram a text block reaches nobody — only a tool call such as `telegram_reply_to_message` does. So every turn ends with a `StructuredOutput` call, `{action, reason}`:

- `stop` — "I replied." Needs a reason (at most 100 characters).
- `skip` — "silence is right here", e.g. group chatter not meant for the bot. Needs a reason.
- `heartbeat` — "still working." The model posts a status line first; the engine resumes the same session so it can carry on (at most 10 in a row).

The reason is a forcing function — without it models end turns reflexively — and the only record of *why* a turn ended (`[CC.done] action=stop reason=…` in the log). The schema stays flat because the API rejects `if`/`then`/`oneOf` in tool schemas, so "a reason on stop and skip" is checked in `parseControlAction` (`src/claude/turn.ts`).

What `outcome.ts` does with an ending:

- **Dropped text.** Text blocks but no user-visible tool call: the model believes it replied while the chat sees nothing. Unless the action is `skip`, the engine delivers that text itself, threaded to the message it answers. On `skip` it's narration and is thrown away. When the text is really a Claude Code diagnostic (bad model, auth, quota), `src/claude/failures.ts` turns it into a targeted owner alert instead.
- **Silent stop.** A `stop` that delivered nothing while someone waits gets one nudge to reply or switch to `skip`.
- **Aborts, crashes and API rejections** — next section.

## When things go wrong

- **Tool-error breaker** (`src/claude/breaker.ts`). `TARS_TOOL_ERROR_MAX_COUNT` (10) failed tool calls within `TARS_TOOL_ERROR_WINDOW_SECONDS` (600) of the first, with no success in between, end the turn at once: the owner is alerted, text the model already wrote is delivered, and `claude` is killed and respawned on the same session. Without it, a model retrying a deterministically failing tool spins for minutes.
- **Liveness watchdog** (`checkLiveness` in the worker). Mid-turn, if neither a stdout event nor a tars tool call shows activity for `TARS_LIVENESS_TIMEOUT_SECONDS` (600), the turn is aborted and `claude` respawned. Silence between turns is normal and never triggers it.
- **Crash supervisor.** After a crash the worker respawns with growing backoff (`TARS_CRASH_BACKOFF_BASE` 2 s, doubling up to `TARS_CRASH_BACKOFF_CAP` 64 s). After `TARS_CRASH_LIMIT` (10) crashes within `TARS_CRASH_WINDOW_SECONDS` (600) it gives up: the owner gets a DM and the process exits 1 for Docker (`restart: on-failure`) or systemd to restart. Breaker and watchdog kills are deliberate and never count as crashes.
- **Broken session.** When the API rejects a turn outright (a usage-policy refusal, a context overflow), resuming would replay the rejected content, so the engine tells the chats, deletes `data/session_id` and starts a fresh session that opens with a recap of the last 10 cleanly processed messages (`<restored_context>`, `src/engine/restore.ts`). Rate-limit, auth and quota errors are recoverable and keep the session. A session id Claude Code doesn't know (after moving servers, say) is dropped the same way, and the owner is told; a message that arrives while Claude Code is still rejecting it goes to the fresh session instead of being lost.
- **Every error reaches the owner.** Once the bot is up, each log record at ERROR or worse is sent to the owner as a DM, linked to the message the bot was answering (`src/log/owner.ts`; an identical alert at most once a minute). A failure the engine already reports — a crashed, wedged or breaker-stopped turn — is one alert, not one per layer. Errors during boot, before the bot can send (a skipped MCP plugin, say), stay in the log.

## Data

SQLite at `data/tars.db` (better-sqlite3); the schema lives in `src/db/migrations/` — change it with a new numbered file, never by editing one that has shipped.

- `messages` — every message in and out. Inbound rows are written before Claude sees them: `consumed` marks the ones handed to Claude (the rest replay at boot), `processed` the ones whose turn finished cleanly — only those enter a restored-context recap, so a poisonous message can't come back. `reactions` is JSON, `{"👍": [user_id, …]}`, filled from both directions; Telegram only sends user reactions in DMs and in groups where the bot is an admin.
- `users`, `reminders`, `tool_calls` (one row per tool call, kept 30 days), `rate_limits`, and `unauthorized_messages` (blocked messages, kept 30 days).

## Memory, skills and self-editing

**Memory** is one folder, `memories/`. The bot lists, searches, reads, writes and appends; there's no delete tool — forgetting means overwriting, and real deletion is the operator's job. Writes are path-hardened (no `..`, absolute paths or symlinks) and capped at 64 KiB per file, and an existing file must be read in the same session before it's overwritten or appended to (the read set clears on restart), so the bot can't clobber notes it never saw. The system prompt carries an index of every file's path and description. File format and layout: [tools.md](tools.md#memory).

**Learning.** When a user corrects the bot, it writes an entry to `memories/self/learnings.md` in the same turn (a prompt rule — the signal is gone by the next turn). An entry marked `[pending]` with a `**Proposed rule:**` line is a candidate for a durable rule.

**Self-reflection** (`skills/self-reflection/`). A daily loop fired by a seeded reminder (`TARS_SELF_REFLECTION_CRON`, default midnight UTC). It reviews its own replies and their reactions from the last 24 hours, adds up to three `[pending]` lessons, stress-tests every pending lesson against 10–20 scenarios and DMs the owner a numbered proposal; on approval it appends a rule to `project.md`, writes a memory or writes a skill. Resolved entries shrink to one-line tombstones so `learnings.md` stays under the 64 KiB cap.

**Self-editing.** `instruction_read`, `instruction_append` and `instruction_rewrite` expose `prompts/project.md` — only that file; `system.md` ships with tars. The owner-only rule is enforced by the system prompt, not code. The code rails are a hardcoded path, a 128 KiB cap, an atomic write and a timestamped backup in `data/prompt_backups/` before every write (to revert, copy the backup back and restart). An edit applies at the next `claude` start, which gives the operator a review window.

**Skills** follow the [Agent Skills spec](https://agentskills.io/specification): `skills/<name>/SKILL.md` with `name` and `description` frontmatter. An *invoked* skill runs when a reminder's text is `<skill name="X">run</skill>`: the scheduler wraps it in a `<reminder>` envelope and the bot executes the playbook. The system prompt trusts `<skill>` only inside that server-made envelope, so a user typing one in chat does nothing. A *reference* skill, like `render-style`, is read on the bot's own initiative. A malformed `SKILL.md` is left out of the list, and the boot log says why.

**Reminders.** The loop (`src/scheduler/loop.ts`) polls every 60 s and injects due reminders as `<reminder>` envelopes, into the running turn if there is one. A fired row is claimed (`pending` → `processing`) and only marked `sent` (or its cron advanced) once its turn ends; a crash or reset puts it back to `pending`, and a row a shutdown left `processing` is re-armed at boot. A turn cut short by the breaker or the watchdog counts as delivered, so a poisoned reminder can't loop. Rows the harness seeds — the self-reflection loop and every `default-reminders.json` entry — carry an `auto_seed_key`: `reminder_cancel` refuses them and boot re-seeds a missing one, so only the operator's config turns them off.

## Security model

tars is a public-facing agent: anyone in an allowed chat can talk to it, and not everyone is friendly. The rails below are enforced by code, lint rules (`eslint.config.js`) and tests (`test/security.test.ts` for the process-wide ones, each store's and tool's tests for its own); `npm run check` fails if one is weakened.

- **Locked-down Claude Code.** The exclusive `--tools` list, no shell, code editing or subagents unless `tool_groups` turns them on, and never `--dangerously-skip-permissions`.
- **Web access isn't network-fenced.** `WebFetch` and `WebSearch` are on; the system prompt forbids private and internal URLs, but a determined prompt injection could still fetch one. **Don't run the bot on a host whose network reaches sensitive internal endpoints.**
- **Browser and render rails.** The `browser_*` tools check the target before navigating and every response again, by the address Chromium actually connected to (`src/browser/ssrf.ts`); an internal address closes the whole session, and `browser_download` guards every redirect hop. `render_html` blocks all network; `render_latex` may only load KaTeX from `cdn.jsdelivr.net`. Ceiling: blind requests on redirect hops and sub-resources still go out — only reading the answer is prevented (backlog P33).
- **MCP namespace.** The local server is named `tars`, so its tools are `mcp__tars__<name>` and `plugins.json` can't reuse the name. It listens on `127.0.0.1` only, with DNS-rebinding protection and no auth of its own.
- **Import rails.** Tools can't import `node:fs` — files go through the stores in `src/stores/`, which share one path resolver. Only `src/claude/child.ts` may spawn processes; it kills the whole process group (SIGTERM, then SIGKILL after 5 s), so nothing Claude started outlives it. Only `src/browser/` may import Playwright.
- **Owner-only commands.** All eleven check the sender against `TARS_OWNER_ID` and `TARS_OWNER_ALT_IDS` and silently do nothing for anyone else; they run before the access gate and never reach the model.
- **`database_query` is read-only by structure.** One statement, starting with `SELECT` or `WITH`, that SQLite itself reports as read-only, run verbatim on its own read-only connection in a worker thread: at most 100 rows, text cells cut at 2000 characters, a 30 s deadline. Ceiling: SQLite can't be interrupted, so an endless query keeps that thread busy until restart (backlog P19).
- **DM rate limit.** Inbound and per user — limiting the bot's own output would still let a spammer flood Claude. `TARS_RATE_LIMIT_PER_MIN` (20) per fixed minute, stored in `rate_limits` so it survives restarts and checked right after the access gate, so excess DMs are never stored or seen by Claude; the user gets one "too fast" notice per minute. Groups aren't limited and the owner is exempt. Fixed buckets allow up to twice the rate in a burst across a minute boundary.
- **Secrets scrubbing.** Inbound text, the replied-to text and every string in the stored raw update pass through `scrub()` (`src/text/scrub.ts`) before reaching SQLite, and text attachments are scrubbed on disk. It redacts Bearer tokens, `sk-` keys, GitHub, Slack and Telegram tokens, AWS keys, JWTs, PEM private keys and DSN passwords as `[REDACTED]` — conservative on purpose: a miss is possible, a false positive would break real content.
- **Unicode normalisation.** `normalizeInbound()` (`src/text/normalize.ts`) strips zero-width and bidi-control characters and NFKC-normalises text before it's scrubbed, so a key split by invisible characters is still caught. A changed message carries `flags=` in its envelope, and the system prompt treats instructions in flagged messages as adversarial.
- **Audit.** Every tool call is stored in `tool_calls`; `/audit` shows recent failures.

## Why it's built this way

1. **The `claude` CLI, not the Claude Agent SDK.** The SDK's real argv is unpublished and its defaults keep changing, so there's no proving which flags reach Claude Code; byte-faithful wire capture and the process-group kill would still need a custom spawn hook.
2. **Node 24 runs the TypeScript directly** — identical code in dev, tests and Docker. The cost is erasable syntax only, enforced by `tsconfig.json`. TypeScript stays on 6.0 because `typescript-eslint` supports `<6.1`.
3. **ESLint, not Biome.** Its core rules express the size and complexity limits, and per-directory `no-restricted-imports` expresses the import rails.
4. **grammY** tracks the current Bot API. The Telegram layer is one adapter, so the choice is cheap to revisit.
5. **better-sqlite3, not `node:sqlite`** — `stmt.reader`/`stmt.readonly` and true read-only connections, which `database_query`'s guarantee needs.
6. **The MCP SDK's low-level `Server`.** tars owns `tools/list` — zod's JSON Schema minus the ±2⁵³ bounds zod puts on every integer, which would cost tokens in every schema — and the whole call path (validation, audit, liveness beat) in one place.
7. **A small logger, not pino.** Three sinks (console, a daily JSON file, owner DMs) and a midnight rotation take ~150 lines in `src/log/`.
8. **Injected loggers and no module-level state.** One composition root passes everything in; tests assert log output through `memoryLogger()`.
9. **An exclusive SQLite lock as the instance lock.** Node has no `flock`; the OS releases a SQLite lock on any exit, `kill -9` included, and it works across containers sharing the bind mount.
10. **Hand-rolled cron** (`src/scheduler/cron.ts`). croner returned wrong dates after short months and reads 6-field expressions seconds-first; tars puts seconds last.
11. **Expected failures are error results, not throws.** Every ERROR log DMs the owner, so a tool returns `{ content, isError: true }` for a failure the model should handle and keeps throws for real malfunctions.
12. **The SSRF guard checks what Chromium connects to**, not what a URL looks like: parsers disagree, and `http://127.0.0.1\@evil.com/` is 127.0.0.1 to Chromium.
