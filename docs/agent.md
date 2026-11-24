# Coding tasks on your own computer

Ask the bot in Telegram to do a Jira task, and a Claude agent on your
computer does the work and opens a pull request. The work runs on the
`claude` login on that computer, not on the bot's account.

## How a task flows

1. You write to the bot: "do BIL-123 in billing". It reads the issue and
   writes instructions for the agent (`agent_task_create`).
2. You get the full instructions with **▶️ Boshlash** (run) and
   **✖️ Bekor qilish** (cancel) buttons, on
   the main account or on `TARS_AGENT_APPROVER_ID`.
   Nothing runs until an owner account presses Boshlash. This check is in code,
   not in the prompt, so nobody can talk the bot into running something on
   your computer.
3. `agent/tars-agent.ps1` on your computer asks the bot every 10 seconds
   for approved tasks. When one comes, it opens a fresh git worktree of the
   repo, so your own checkout is never touched, and runs `claude -p` there.
   The agent branches from the upstream default branch, commits, pushes to
   your fork and opens a PR to upstream.
4. The agent's report and the PR link come back, and the bot tells you.
   It also gives you a command that opens the agent's Claude session on your
   computer, so you can read everything it did.
5. To go on, tell the bot: "fix the review comments on BIL-123", or answer
   the agent's question. The bot resumes the same session in the same
   worktree (`agent_task_continue`), and the agent pushes to the same PR.
   Follow-ups need no button, since you approved the task already; you
   still get each follow-up's text.

To pick the Claude model, name it: "do BIL-123 in billing with opus". The
approval message shows `Model: opus`, and the agent runs `claude --model opus`.
Without a name it uses the default of the `claude` login on your computer. A
follow-up keeps the task's model unless you name another one.

Your computer only makes outbound HTTPS calls. Nothing on it listens for
connections. While it is off, approved tasks wait in the queue.

The agent runs without asking for permission, because it has to run tests
and `gh` unattended. Read the instructions before you press Boshlash.

## Server setup

1. Set `TARS_AGENT_TOKEN` in `.env` (`openssl rand -hex 32`) and recreate
   the container.
2. Publish the port to localhost only, in `docker-compose.override.yml`:

   ```yaml
   services:
     tars:
       ports:
         - "127.0.0.1:8787:8787"
   ```

3. Put HTTPS in front of it, for example with Caddy. Use `handle` blocks:
   Caddy runs `respond` before `reverse_proxy` whatever the order in the file.

   ```
   lia.example.com {
       handle /agent/* {
           reverse_proxy localhost:8787
       }
       handle {
           respond 404
       }
   }
   ```

## Computer setup (Windows)

1. Check that `claude` and `gh` work in PowerShell, and that you are
   logged in to both (`claude`, then `gh auth login`).
2. Save the token in `%USERPROFILE%\.tars-agent-token`, on one line.
3. Copy `agent/tars-agent.ps1` anywhere and run it:

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File tars-agent.ps1
   ```

   Projects are looked up in `D:\projects\<repo>`. Change that with
   `-ProjectsDir`, and the server with `-Server`.

To start it at every logon:

```
schtasks /Create /TN "tars agent" /SC ONLOGON /TR "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File C:\path\to\tars-agent.ps1"
```

## When something goes wrong

- Tasks are in the `agent_tasks` table: `awaiting` (no button yet),
  `approved`, `running`, `done`, `failed`, `cancelled`.
- A task stays `running` if the script is stopped in the middle of it.
- Worktrees stay in `D:\projects\.lia-worktrees\`, one per task, so a
  session can be continued. Remove the ones you're done with, from the repo:
  `git worktree remove D:\projects\.lia-worktrees\billing-5`. While a
  worktree exists, its branch can't be checked out elsewhere.
