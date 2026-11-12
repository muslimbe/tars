# Running an instance

tars is the harness; a bot is an instance of it. An instance lives in its own private **agent repo**, with tars pulled in as a git submodule and everything that makes the bot *yours* — persona, skills, memories, config — kept next to it. Never fork tars.

## The agent repo

```
my-agent/                    # your private repo
├── framework/               # git submodule → github.com/Bayramooov/tars
├── docker-compose.yml       # builds framework/, mounts the files below
├── .env                     # bot token, owner id, model, secrets — gitignore this, and data/
├── prompts/
│   ├── system.md            # copied from framework/ — required
│   ├── subagents.md         # copied from framework/ — if the subagents group is on
│   └── project.md           # the bot's name, language and persona
├── skills/                  # the framework's playbooks plus your own
├── memories/                # the bot's memory, committed like any file
├── projects/                # docs and code the `read` tool group may read
├── plugins.json             # tools and external MCPs
├── access.json              # who may talk to the bot
└── default-reminders.json   # recurring reminders
```

Set it up once:

```bash
git init my-agent && cd my-agent
git submodule add https://github.com/Bayramooov/tars framework
cp framework/.env.example .env             # fill in the token, owner id and model
mkdir prompts
cp framework/prompts/project.md.example prompts/project.md
cp framework/prompts/system.md framework/prompts/subagents.md prompts/
cp -R framework/skills/. skills/
cp framework/plugins.json.example plugins.json
cp framework/access.json.example access.json
cp framework/default-reminders.json.example default-reminders.json
```

`docker-compose.yml` — the submodule is the build context, everything else is a mount:

```yaml
services:
  tars:
    build: ./framework
    restart: on-failure        # the bot exits 1 when Claude keeps crashing; this brings it back
    stop_grace_period: 15s     # tars needs up to 12 s to shut down cleanly
    env_file: .env
    volumes:
      - ./data:/app/data
      - ./prompts:/app/prompts
      - ./skills:/app/skills
      - ./memories:/app/memories
      - ./projects:/app/projects:ro
      - ./plugins.json:/app/plugins.json
      - ./access.json:/app/access.json
      - ./default-reminders.json:/app/default-reminders.json:ro
      - ~/.claude:/root/.claude
      - ~/.claude.json:/root/.claude.json
    working_dir: /app
```

`docker compose up -d --build`, then `docker compose logs -f tars` until it says `tars is live`, and DM the bot.

- **Clone with the submodule.** A plain clone leaves `framework/` empty and the build fails: use `git clone --recurse-submodules`, or `git submodule update --init` afterwards.
- **`prompts/` and `skills/` replace the image's copies, they don't merge.** Re-copy `system.md`, `subagents.md` and the built-in skills after updating the framework.
- **Updating the framework:** `git submodule update --remote framework && git add framework && git commit -m "bump tars"`, then rebuild.
- **Claude Code is pinned** (`CLAUDE_CODE_VERSION` in the Dockerfile), so a rebuild never changes it behind your back. To move to a newer one without waiting for a framework bump: `docker compose build --build-arg CLAUDE_CODE_VERSION=<version>`.

### Extra packages

Need ffmpeg, a font, or the runtime an MCP server is launched with (the image has `npx`, but not `uvx`)? Don't edit `framework/` — build on top of its image in your own `Dockerfile`:

```dockerfile
FROM tars-base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
```

Point compose at it (`build: .`) and build the base first: `docker build -t tars-base ./framework && docker compose up -d --build` — again after every framework update.

## Configuration

### .env

Read once at boot (a variable already set in the environment wins over the file); a bad value stops boot with one message listing every problem. `plugins.json` can reference any of these as `${VAR}`.

| Variable | Default | What it does |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | required | From @BotFather. |
| `TARS_OWNER_ID` | required | Your numeric Telegram user id (ask @userinfobot). |
| `CLAUDE_CODE_OAUTH_TOKEN` | required | From `claude setup-token`; read by Claude Code, not tars. |
| `TARS_MODEL` | required | Passed to `--model`, e.g. `claude-sonnet-4-6`. |
| `TARS_EFFORT` | required | Passed to `--effort`: `low`, `medium`, `high`, `xhigh` or `max`. |
| `TARS_DATA_DIR` | `./data` | The database, session id, attachments, renders and logs. |
| `TARS_ACCESS_PATH`, `TARS_PLUGINS_PATH`, `TARS_REMINDERS_PATH` | repo root | Where `access.json`, `plugins.json` and `default-reminders.json` live. |
| `TARS_MEMORIES_DIR` | `./memories` | Where the memory folder lives (still addressed as `memories/…`). |
| `CLAUDE_CODE_BIN` | `claude` | Name or path of the `claude` program. |
| `TARS_DEBOUNCE_MS` | `0` | Wait this long after a message so a burst becomes one turn. |
| `TARS_RATE_LIMIT_PER_MIN` | `20` | DMs per minute from one user; groups and the owner aren't limited. |
| `TARS_GROUP_MESSAGES` | `all` | `addressed`: a group message reaches Claude only if the owner wrote it, or it mentions or replies to the bot or the owner; the rest is dropped unstored. Needs privacy mode off in BotFather, or Telegram won't deliver the owner mentions. |
| `TARS_GROUP_ADDRESSEES` | — | Comma-separated user ids that `addressed` treats like the owner, e.g. the owner's work account. Owner rights stay with `TARS_OWNER_ID`. |
| `TARS_ATTACHMENT_MAX_BYTES` | `20000000` | Largest inbound photo or document the bot will download. |
| `TARS_BROWSER_HEADLESS` | `true` | `false` shows the browser window, for local debugging. |
| `TARS_SELF_REFLECTION_ENABLED` | `true` | The daily self-reflection loop; `false` cancels it at the next boot. |
| `TARS_SELF_REFLECTION_CRON` | `0 0 * * *` | When it runs (UTC). |
| `TARS_LIVENESS_TIMEOUT_SECONDS` | `600` | A turn silent this long (no output, no tool activity) is killed and Claude restarted. |
| `TARS_LIVENESS_POLL_SECONDS` | `30` | How often that is checked. |
| `TARS_TOOL_ERROR_MAX_COUNT` | `10` | This many failed tool calls in a row end the turn… |
| `TARS_TOOL_ERROR_WINDOW_SECONDS` | `600` | …if they land within this window of the first. |
| `TARS_CRASH_BACKOFF_BASE` | `2` | Seconds before the first restart after a crash; doubles each time… |
| `TARS_CRASH_BACKOFF_CAP` | `64` | …up to this. |
| `TARS_CRASH_LIMIT` | `10` | This many crashes… |
| `TARS_CRASH_WINDOW_SECONDS` | `600` | …within this window and the bot tells the owner and exits 1. |
| `TARS_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING` or `ERROR`. |
| `TARS_LOG_TRANSCRIPT` | `compact` | `full` prints whole bodies in the `[CC.*]` log lines. |

Credentials the sample MCPs reference: `GITLAB_URL`, `GITLAB_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN` (see [tools.md](tools.md#the-sample-mcps)).

### access.json

Who may talk to the bot. Re-read on every message, so edits apply at once; the owner can also change it from Telegram (below). A missing file starts as `owner_only`; a malformed one is moved aside (`access.corrupt-<time>.json`) and the bot falls back to `owner_only` — it fails closed.

```json
{ "policy": "allowlist", "allowed_users": [12345], "allowed_chats": [-1001234567890] }
```

| Policy | DMs | Groups |
|---|---|---|
| `owner_only` | the owner | none |
| `allowlist` | the owner, `allowed_users` and members of `allowed_chats` | `allowed_chats` |
| `open` | anyone | any group |

Group membership is checked with Telegram when someone off the list writes a DM, and remembered for a minute, so someone who leaves the group loses DM access within a minute.

A blocked message never reaches Claude, the history or memory; it's kept 30 days in `unauthorized_messages` so you can see who's asking. In a DM, the first blocked message gets a one-time "This is a private assistant" reply; blocked groups get nothing. The owner gets a chat's first blocked message too, with **Allow** and **Ignore** buttons.

### Owner commands

Only `TARS_OWNER_ID` can use them; for anyone else they silently do nothing. They're handled before the access gate and `/pause`, and never reach the model.

```
/access                     policy and allowlists
/allow                      in the owner's DM: Telegram's user and group pickers (or Cancel) — no ids needed
/allow user|group <id>      add to the allowlist
/deny user|group <id>       remove from it
/policy owner_only|allowlist|open
/pause, /resume             drop every inbound message until /resume (in memory; a restart resumes)
/reset_session              start a fresh Claude session; history and memories stay, a short recap carries over
/kill                       clean shutdown
/health                     pause state, last send, reminders, rate-limit notices, the current turn
/audit                      recent tool failures, prompt backups, memory size
/logs [N]                   the log tail that fits one message, or the last N lines (max 200)
```

### Prompts

`prompts/system.md` is tars's general prompt; `prompts/project.md` is your bot's — name, language, persona, house rules. The bot can append to `project.md` itself on your request (backed up first). Both are re-read whenever `claude` starts, so an edit applies at the next restart or `/reset_session`.

### default-reminders.json

Recurring reminders that ship with the bot:

```json
{
  "reminders": [
    { "name": "morning-brief", "cron": "0 6 * * *", "chat": "owner", "text": ["Good morning. Today's brief:", "1. Top 3 AI stories."] }
  ]
}
```

`name` (unique), `cron` (5 fields, UTC) and `text` (a string, or a list of lines) are required; `chat` is `"owner"` (the default) or a chat id; `enabled: false` turns an entry off without deleting it. Boot reconciles the file with the database: new and edited entries are seeded, removed and disabled ones cancelled. The bot can't cancel these from chat — change the file and restart. Only recurring reminders are accepted (a one-shot would re-fire on every restart), and a malformed file stops boot rather than silently dropping a reminder.

### plugins.json

Tool groups, external MCPs and what to hide: see [tools.md](tools.md#pluginsjson).

### BotFather

Turn off "Allow groups" if strangers shouldn't add the bot to groups, and turn on "Bot to bot communication" if it should see other bots' messages. With privacy mode on (the default), Telegram delivers only group messages that mention or reply to the bot; turn it off for `TARS_GROUP_MESSAGES` to see the rest.

## On a server

Any VPS with Docker works (Hetzner, Contabo, DigitalOcean, …). Once:

```bash
curl -fsSL https://get.docker.com | sh
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs
npm install -g @anthropic-ai/claude-code
claude setup-token        # prints an sk-ant-oat01-… token for CLAUDE_CODE_OAUTH_TOKEN; works on any OS

git clone --recurse-submodules git@github.com:you/my-agent.git ~/my-agent && cd ~/my-agent
git config user.name "my-agent" && git config user.email "my-agent@localhost"   # for the server's commits
cp framework/.env.example .env && vim .env
docker compose up -d --build
```

The server needs SSH access to **both** repos — the agent repo (read and write, since it pushes the bot's memories) and tars. An SSH key on your GitHub account is simplest. Deploy keys work too, but GitHub won't attach one key to two repos, so each needs its own key and `~/.ssh/config` host alias, and the agent repo's key needs "Allow write access".

### Updating

The bot writes its memories (and, when asked, `project.md` and skills) into the server's checkout, so commit those before pulling — an uncommitted file that also changed upstream makes `git pull` stop:

```bash
cd ~/my-agent
git add -A && git diff --cached --quiet || git commit -m "sync server state [skip ci]"
git pull --rebase --recurse-submodules && git push
docker compose up -d --build
```

To deploy on every push, run the same lines from GitHub Actions over SSH, with the server's address and a private key in the repo's secrets:

```yaml
# .github/workflows/deploy.yml
on: { push: { branches: [main] } }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_IP }}
          username: root
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            cd ~/my-agent
            git add -A && git diff --cached --quiet || git commit -m "sync server state [skip ci]"
            git pull --rebase --recurse-submodules && git push
            docker compose up -d --build
```

If you and the bot edit the same memory file, add `memories/**/*.md merge=union` to the agent repo's `.gitattributes` and git keeps both sides' lines instead of a conflict.

### The data directory

`data/` is created on first run and holds server-local state only — the memories live in the agent repo:

- `tars.db` — the SQLite database
- `session_id` — the Claude Code session to resume
- `attachments/`, `renders/` — files received and images produced (a render untouched for 30 days is deleted at boot)
- `prompt_backups/` — `project.md` before each of the bot's edits
- `logs/` — `tars.log`, JSON lines, rotated daily, 7 days kept
- `cc_logs/` — the raw Claude Code output, one pair of files per session; a file untouched for 30 days is deleted at boot
- `mcp.json` — the `--mcp-config` file Claude Code starts with, rewritten at every boot (it holds plugin credentials)

Moving to another server, copy nothing from `data/`: Claude Code won't know the old session id (tars starts a fresh one and tells you), and the history rebuilds from new messages.

## Watching it

- **Logs.** `docker compose logs -f tars` shows `HH:MM:SS LEVEL logger message` lines; `data/logs/tars.log` has the same records as JSON; `/logs` tails it from Telegram; and every ERROR is DMed to the owner.
- **The transcript** in those logs: `[RX]` an accepted inbound message, `[DROP]` a blocked one, `[TX]` the bot's messages, `[EDIT]`/`[DEL]`/`[REACT]` its edits, deletions and reactions; `[CC.user]` the batch sent to Claude, `[CC.tool→]` a tool call, `[CC.tool✓]`/`[CC.tool✗]` its result, `[CC.text]` a stray text block, `[CC.done] action=… reason=…` the end of a turn. Lines are cut at 200 characters unless `TARS_LOG_TRANSCRIPT=full`.

  ```
  21:34:12 INFO  tars.tx    [RX] DM Alice[12345] Alice[12345] m42 | how fast are you
  21:34:13 INFO  tars.cc    [CC.tool→] mcp__tars__telegram_reply_to_message({"chat_id":12345,"reply_to_message_id":42,"text":"Honestly?…"}) id=toolu_01
  21:34:14 INFO  tars.tx    [TX] DM Alice[12345] m43 →m42 | Honestly? Not blazing fast 😅 …
  21:34:14 INFO  tars.cc    [CC.done] action=stop reason=Answered the user's question
  ```

- **Session replay.** `npm run trace` (in Docker: `docker compose exec tars node src/scripts/trace.ts`) renders the bot's whole Claude Code session — every prompt, tool call, result and thinking block — from `~/.claude/projects/`. It finds the bot's session through `data/session_id`, not the newest file, which may be your own Claude Code session in the same directory. `--follow` tails it live, `--list` shows every session, `--max N` cuts long text. Read-only, safe next to the running bot.
- **The raw wire**, `data/cc_logs/<session>.stream.jsonl` and `.stderr.log`: everything Claude Code printed, including events the parser drops — for parser bugs and rate-limit notices.
- **The database:** `sqlite3 data/tars.db "SELECT created_at, tool_name, duration_ms, error FROM tool_calls ORDER BY id DESC LIMIT 20;"`.
- **Ask the bot itself:** `claude --resume $(cat data/session_id) --fork-session` opens its conversation in your own Claude Code — "why did you answer message 591 that way?". Without `--fork-session` you'd write into the live bot's session.

## Troubleshooting

- **`Conflict: terminated by other getUpdates request`.** Another process polls the same bot token. Stop the other one (`docker compose down`, `pkill -f 'node src/main.ts'`).
- **`another tars instance is already running`.** Two bots on one data directory would double-fire reminders and fight over the session, so the second refuses while the first holds `data/.instance.lock`. Stop it, or give this one its own `TARS_DATA_DIR`. The lock dies with the process, even on `kill -9`.
- **Claude crashes at once (`rc=1`, empty stderr).** Usually a session id Claude Code doesn't know — after renaming the folder or moving servers. tars drops it and starts fresh by itself; if it keeps crashing, delete `data/session_id` and restart.
- **An external MCP's tools are missing.** `mcp server <name> did not connect`: its command isn't available in the container — add it in your [image layer](#extra-packages). `mcp <name> skipped (unresolved ${VAR} …)`: a credential in `.env` is empty.
- **`Not logged in · Please run /login`.** The token in `CLAUDE_CODE_OAUTH_TOKEN` is missing or revoked: run `claude setup-token` again, update `.env` and restart.

A quick check after deploying: DM the bot and get a reply; send five messages in a row and see one turn answer them (with `TARS_DEBOUNCE_MS` set); send one mid-turn and see it injected; `kill -9` the `claude` process and see it come back; ask it to run a shell command and see it refuse.
