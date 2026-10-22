# Tools

Everything the bot can call, and `plugins.json`, the file that decides what's on.

## tars tools

Always on, served by the local MCP server as `mcp__tars__<name>`. Each is a factory in `src/tools/`, registered in `src/tools/index.ts`; any of them can be hidden with [`builtin_tools_disabled`](#pluginsjson).

### Messaging and media

| Tool | What it does |
|---|---|
| `telegram_send_message` | Send a new text message (Markdown, converted to Telegram HTML) when there's nothing to reply to, e.g. a reminder. A plain text block reaches nobody until the engine rescues it. |
| `telegram_reply_to_message` | Reply to a specific message — the default way to answer anyone. |
| `telegram_edit_message` | Edit one of the bot's earlier messages — no push notification, good for progress updates. |
| `telegram_delete_message` | Delete a message the bot may delete (usually its own). |
| `telegram_add_reaction` | React to a message with an emoji — often better than an "ok" reply in groups. |
| `telegram_create_poll` | Send a poll: regular or quiz, multi-answer, anonymous or not, auto-close, reply-to. |
| `telegram_stop_poll` | Close a poll early and return the tallies. |
| `telegram_read_attachment` | Read a photo or document the user sent. The dispatcher saves attachments under `data/attachments/` and marks them `[attachment: <path> …]`. Images come back as image blocks (the bot sees them), text files as UTF-8, PDFs as their text with `--- page N ---` markers; text and PDFs cap at 64 KiB. Voice notes, audio and video are saved and marked too, but not readable here — pass their path to a transcription MCP (a GIF arrives as a silent video). |
| `telegram_send_memory_document` | Send a memory file as a downloadable document. |
| `render_html` | Render HTML to a PNG in `data/renders/` with headless Chromium — for tables, charts and diffs Markdown can't hold. No network: inline any CSS/JS. |
| `render_latex` | Render a LaTeX expression (without `$$`) to a PNG via KaTeX, loaded from `cdn.jsdelivr.net` only. |
| `telegram_send_photo` | Send a PNG from `data/renders/` as a Telegram photo; pairs with the render and browser tools. |

### Browser

A real headless Chromium for pages `WebFetch` can't handle — JS-rendered, multi-step, form-driven. One warm browser is reused, `browser_navigate` opens a page and every other tool acts on that **same page**, so *search → open a result → grab an image → send it* works. The page and its cookies outlive the turn and are shared by every chat until `browser_reset`, a crash or a restart. Live network is allowed, but private and internal addresses are refused — checked before navigating and again for every response ([security](architecture.md#security-model)).

| Tool | What it does |
|---|---|
| `browser_navigate` | Open a URL and wait for the DOM (~30 s budget). Start here. |
| `browser_back` / `browser_reload` | Go back one entry / reload the page. |
| `browser_reset` | Close the page and clear cookies; the next navigate starts fresh. |
| `browser_click` | Click an element (waits ~10 s for it to be actionable). |
| `browser_fill` | Type into an input or textarea, replacing its content. |
| `browser_press_key` | Press a key (`Enter`, `Tab`, …), optionally in a given field. |
| `browser_select_option` | Pick an option in a native `<select>`. |
| `browser_scroll` | Scroll the page, or an element into view, to load lazy content. |
| `browser_get_text` / `browser_get_html` | The page's (or one element's) visible text / HTML, truncated. |
| `browser_get_attribute` | One attribute of an element — an image's `src`, a link's `href`. |
| `browser_list` | Elements matching a selector, with their text and `href`/`src`. |
| `browser_wait_for` | Wait for an element to appear. |
| `browser_screenshot` | Screenshot the page or an element into `data/renders/`. |
| `browser_download` | Download the file at a URL into `data/renders/` (every redirect hop checked). |

### Memory

| Tool | What it does |
|---|---|
| `memory_list` | Every memory file with its description. |
| `memory_search` | Lines matching any of the query's words, best matches first. |
| `memory_read` | Read a file (cut at 64 KiB). |
| `memory_write` | Create or overwrite a file; it must start with the frontmatter below. 64 KiB cap. |
| `memory_append` | Append to a file's body and refresh its description. |

Every memory is named by its full path, starting with `memories/` — a bare `notes/x.md` is rejected. Overwriting or appending to an existing file needs a `memory_read` of it first in the same session; brand-new files are exempt. There's no delete tool: forgetting means overwriting, real deletion is the operator's. Each file looks like this, so `memory_list` can show what it holds without reading it:

```markdown
---
name: <short human-friendly label>
description: <one line used to find this memory without reading it>
---

<the remembered content>
```

A layout that works well:

```
memories/
├── docs/{topic}-{YYYY-MM-DD}.md     # one-off reports
├── notes/
│   ├── groups/{chat_id}.md          # per-group notes
│   ├── users/{telegram_user_id}.md  # per-user notes
│   └── {topic}.md                   # reference notes
└── self/learnings.md                # mistakes and lessons to carry forward
```

### Self-editing

| Tool | What it does |
|---|---|
| `instruction_read` | Read `prompts/project.md`. |
| `instruction_append` | Append a rule to `prompts/project.md`, after a backup to `data/prompt_backups/`. |
| `instruction_rewrite` | Replace `prompts/project.md` whole — the only way to remove a rule. Same backup. |

Owner-only by system-prompt policy; an edit applies the next time `claude` starts. `prompts/system.md` isn't exposed — it ships with tars.

### Skills

| Tool | What it does |
|---|---|
| `skill_list` | Every skill's name and description. The same index is already in the system prompt. |
| `skill_read` | Load a skill's `SKILL.md`. |
| `skill_write` | Create or update `skills/<name>/SKILL.md` — owner-approved only (prompt policy). Validated frontmatter, 256 KiB cap, overwriting needs a `skill_read` first. |

A skill is a directory with a `SKILL.md` following the [Agent Skills spec](https://agentskills.io/specification); `references/`, `scripts/` and `assets/` folders are optional. To add one:

```markdown
---
name: your-skill-name
description: One sentence on what it does AND when to use it (up to 1024 characters).
---

# your-skill-name

The playbook: preconditions, what to read, what to decide, which tools to call.
```

The name must match the directory: lowercase `a-z0-9` and single hyphens. `skill_list` shows it at once; the system prompt's index picks it up at the next `claude` start (a restart, a respawn or `/reset_session`). To run it on a schedule, add a [`default-reminders.json`](deployment.md#default-remindersjson) entry whose `text` is `<skill name="your-skill-name">run</skill>`. A malformed `SKILL.md` is skipped and the boot log says why. See `skills/self-reflection/SKILL.md` for a worked example, and [how skills run](architecture.md#memory-skills-and-self-editing).

### Reminders

| Tool | What it does |
|---|---|
| `reminder_set` | Schedule a reminder: `trigger_at` in UTC ISO 8601 (`2026-10-17T09:00:00Z`), plus `cron_expr` for a recurring one. |
| `reminder_list` | A chat's pending reminders. |
| `reminder_cancel` | Cancel a reminder by id. Seeded reminders are refused. |

### Data and introspection

| Tool | What it does |
|---|---|
| `database_query` | One read-only `SELECT` (or `WITH … SELECT`) over the bot's SQLite: at most 100 rows, text cells cut at 2000 characters, 30 s deadline. `messages` uses `timestamp`, not `created_at`; reactions are JSON — `json_extract(reactions, '$."👍"')`. |
| `database_get_recent_messages` | The latest messages in both directions, oldest first, as TSV. `limit` 20 (max 100); `chat_id` and `before_message_id` page back. |
| `time_now` | The current time in UTC and in the host's timezone. |
| `tool_list` | The tars tools currently available, with their exact `mcp__tars__<name>`. |

## Claude Code built-ins

Passed with the **exclusive** `--tools` flag, so this is exactly what the model can reach (`builtinTools()` in `src/claude/argv.ts`).

| Tool | What it does |
|---|---|
| `WebFetch` / `WebSearch` | Fetch a URL / search the web. The prompt forbids private and internal URLs, but nothing in code enforces it — see [security](architecture.md#security-model). |
| `StructuredOutput` | The turn-end tool (`{action, reason}`); must always be reachable. |
| `ToolSearch`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `WaitForMcpServers` | MCP discovery — idle until an external MCP needs them. |
| `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` | A task checklist for multi-step turns. |

Three groups are off until `tool_groups` turns them on:

| Group | Tools |
|---|---|
| `bash` | `Bash`, `PowerShell`, `Monitor` — shell execution. |
| `code` | `Edit`, `Write`, `Read`, `NotebookEdit`, `Glob`, `Grep`, `LSP` — code work. |
| `subagents` | `Agent` — a subagent with its own context, token-heavy; also loads `prompts/subagents.md`. `SendMessage` becomes reachable too, but isn't auto-approved (backlog P7). |

Left out on purpose: native `Skill` (tars runs skills itself), `CronCreate` and friends (tars has reminders), `AskUserQuestion`, `PushNotification` and `SendUserFile` (dead in a headless Telegram bot), plan-mode and worktree tools, `TaskStop`/`TaskOutput`. To add one, put it in `BASE_BUILTIN_TOOLS` or a group set in `src/claude/argv.ts`.

## plugins.json

One file decides the bot's capabilities. A missing file boots locked down (no groups, no MCPs); a malformed one fails boot with an error naming the problem. Restart after editing; the boot log summarises the result (`plugins loaded: … tool_groups={…}`, then `mcp <name> configured` or `skipped (…)` per MCP).

```jsonc
{
  "tool_groups": { "bash": false, "code": false, "subagents": false },
  "mcps": [
    {                                   // stdio: a local subprocess, auth via env
      "name": "github",
      "type": "stdio",                  // optional, the default
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}" },
      "allowed_tools": ["mcp__github"],
      "enabled": true
    },
    {                                   // http: a remote server, auth via headers ("sse" has the same shape)
      "name": "linear",
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer ${LINEAR_API_KEY}" },
      "allowed_tools": ["mcp__linear"],
      "enabled": true
    }
  ],
  "builtin_tools_disabled": ["telegram_create_poll", "telegram_stop_poll"],
  "skills_disabled": ["render-style"]
}
```

- **`name`** becomes the `mcp__<name>__<tool>` namespace the model sees, so renaming one breaks prompts and memories that mention it. Names are unique, and `tars` is reserved.
- **`name`, `allowed_tools` and `enabled`** are required. `allowed_tools` takes exact tool names (`mcp__linear__create_issue`) or a server prefix (`mcp__linear`).
- **`${VAR}`** pulls a value from `.env` inside `args`, `env`, `url` and `headers` (concatenation works: `${GITLAB_URL}/api/v4`). If any reference is empty, that MCP is skipped at boot and an ERROR names the field.
- **Mixing transports** — `command` on an `http` entry, `url` on a `stdio` one — fails boot.
- **OAuth** isn't managed by tars: give an already-issued token via `${VAR}`, or establish the grant once on the host with Claude Code.
- **`builtin_tools_disabled`** hides tars tools: never registered, never advertised. A name that doesn't exist fails boot with the list of real ones. Nothing is protected — hiding `telegram_send_message` mutes the bot.
- **`skills_disabled`** hides skill directories from `skill_list` and `skill_read`, so a reminder can't invoke them either.

Inside Docker, a stdio server runs in the container: the image has `npx` but not `uvx` — add it, or any other runtime a server needs, in [your own image layer](deployment.md#extra-packages).

### The sample MCPs

`plugins.json.example` ships four entries, all `enabled: false` — starting points, not built-ins:

- **DeepWiki** — `https://mcp.deepwiki.com/mcp` over http, no credentials.
- **Jira** — Atlassian's remote MCP, `https://mcp.atlassian.com/v1/mcp`. Auth is OAuth: run `claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp` once on the host and finish the browser login; the headless bot reuses the grant.
- **GitLab** — [@zereight/mcp-gitlab](https://github.com/zereight/mcp-gitlab) over stdio; set `GITLAB_URL` and `GITLAB_TOKEN`.
- **GitHub** — [@modelcontextprotocol/server-github](https://www.npmjs.com/package/@modelcontextprotocol/server-github) over stdio; set `GITHUB_PERSONAL_ACCESS_TOKEN`. For Enterprise, add `"GITHUB_HOST": "${GITHUB_HOST}"` to the entry's `env` and set it too. Use a **fine-grained** token (<https://github.com/settings/tokens?type=beta>) limited to the repos the bot should touch, with only the permissions it needs — Contents, Issues and Pull requests read & write, Metadata read, Actions only if it should run CI — and an expiry you'll remember to rotate. A classic token can't be limited per repo, so a leak costs far more.

## Adding a tool

A tool is a factory in `src/tools/` that returns `defineTool({ name, description, args, run })` (`src/mcp/tool.ts`). `args` is a zod object: it validates every call and becomes the JSON Schema the model sees, so give each field a `.describe()`.

```ts
// src/tools/echo.ts
import { z } from 'zod';

import { defineTool, type Tool } from '../mcp/tool.ts';

/** `echo`: hands the text back. */
export function echoTool(): Tool {
  return defineTool({
    name: 'echo',
    description: 'Echo a string back to the caller.',
    args: z.object({ text: z.string().describe('What to echo back.') }),
    run: ({ text }) => Promise.resolve({ content: text }),
  });
}
```

Add `echoTool()` to the matching list in `src/tools/index.ts` — its position there is its position in `tools/list`. A tool that needs a service takes just that slice of the `ToolContext` (`src/tools/context.ts`), e.g. `memoryReadTool(ctx.memory)`.

- `content` is all the model sees; `data` goes only to the `tool_calls` audit row.
- Return `{ content, isError: true }` for a failure the model should handle. A thrown error reaches the model too, but is logged as an ERROR, which DMs the owner — keep throws for real malfunctions.
- Tools can't import `node:fs`, `node:child_process` or `playwright` (lint rails); reach files through a store in `src/stores/`.
- Add a test in `test/tools/`, and the tool to the `test/golden/mcp-tools.json` snapshot, which pins every tool's name, description and schema in order.
