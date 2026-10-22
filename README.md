<p align="center">
  <img src="assets/tars-logo.jpg" alt="tars" width="700">
</p>

<p align="center">
  <b>tars</b> is a framework for running your own persistent AI companion on Telegram — one you fully own, control, can extend, one that learns from you.
</p>

---

tars is a harness around Claude Code: it keeps one long-running Claude Code session behind a Telegram bot, gives it memory, reminders, a browser and whatever tools you plug in, and supervises it so it stays up. Not a chatbot — an agent that remembers, runs scheduled work, reviews its own mistakes and acts on your behalf.

The name comes from TARS, the robot in *Interstellar*. tars is the harness; each bot you run is an instance with its own name and persona — Mira, say — set in `prompts/project.md`.

You own everything: the memories, the playbooks, the MCP connections, the logs. Nothing goes through a third-party product, every decision the bot made can be read back, and its rules can be changed from a DM.

The goal is a [Jarvis](https://www.youtube.com/watch?v=Qav7NJIsKL4&t=2s) — an AI that lives with you, monitors what matters and acts on your behalf. tars is the foundation.

## What it does

- **Talks on Telegram** — DMs and groups, where it joins in when it has something useful to say. Replies, edits, reactions and polls; reads photos, documents and PDFs; renders HTML and LaTeX to images.
- **Remembers** — markdown memory files it reads, searches and writes, plus the whole chat history in SQLite.
- **Learns** — writes corrections down as they happen; a daily self-reflection pass proposes new rules for your approval.
- **Works on a schedule** — one-shot and cron reminders, and recurring tasks that ship with the bot.
- **Uses the web** — search and fetch, and a real headless browser for pages that need clicking.
- **Grows** — skills (markdown playbooks), any MCP server (GitHub, Jira, Notion, your own), and opt-in shell, code editing and subagents.
- **Can't** — generate images; send voice or video, or read stickers and GIFs; moderate groups; make calls. Inbound voice, audio and video are saved for a transcription MCP to read.

## Quick start

You need Docker and the Claude Code CLI, a bot token from @BotFather, and a Claude token from `claude setup-token` (it opens a browser and prints `sk-ant-oat01-…`; a Claude subscription or API account both work).

```bash
git clone https://github.com/Bayramooov/tars && cd tars
cp .env.example .env && nano .env      # TELEGRAM_BOT_TOKEN, TARS_OWNER_ID (from @userinfobot), CLAUDE_CODE_OAUTH_TOKEN, TARS_MODEL, TARS_EFFORT
cp prompts/project.md.example prompts/project.md && nano prompts/project.md   # the bot's name, language and persona
docker compose up -d --build           # the first run seeds access.json, plugins.json and default-reminders.json
docker compose logs -f                 # wait for "tars is live", then DM your bot
```

Without Docker: Node.js 24, then `npm ci`, `npx playwright install chromium` (for the render and browser tools) and `npm start`.

A tars checkout is the way to try it. For a bot you keep — its persona, memories and config in git, running on a server — use an agent repo: [docs/deployment.md](docs/deployment.md).

## Docs

- [docs/architecture.md](docs/architecture.md) — how tars works and why: one message end to end, how turns end and fail, memory and skills, the security model.
- [docs/tools.md](docs/tools.md) — every tool, and `plugins.json` for tool groups and external MCPs.
- [docs/deployment.md](docs/deployment.md) — running an instance: the agent repo, configuration, servers, monitoring, troubleshooting.
- [docs/backlog.md](docs/backlog.md) — known issues with a proposed fix.

## Development

Node.js 24 + TypeScript, no build step: Node runs `src/*.ts` directly.

```bash
npm run check    # typecheck + lint + tests
```

The tests run the whole bot against a fake Telegram and a fake `claude` CLI ([test/fakes/](test/fakes/)), so nothing real is called; the render and browser tests drive a real Chromium (`npx playwright install chromium` once). [.claude/CLAUDE.md](.claude/CLAUDE.md) is the working agreement for anyone changing the code, human or Claude.

## License

MIT — see [LICENSE](LICENSE). tars is built and maintained by Sardor Bayramov.
