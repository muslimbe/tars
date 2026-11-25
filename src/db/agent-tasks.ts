import { type Db, sqliteTime } from './database.ts';

/** An `agent_tasks` row as `SELECT *` returns it. */
export interface AgentTaskRow {
  id: number;
  chat_id: number;
  repo: string;
  jira_key: string | null;
  title: string;
  prompt: string;
  status: 'awaiting' | 'approved' | 'running' | 'done' | 'failed' | 'cancelled';
  result: string | null;
  pr_url: string | null;
  created_at: string;
  finished_at: string | null;
  /** A follow-up: the task whose session it continues. */
  parent_id: number | null;
  /** The agent's Claude session: copied from the parent for a follow-up, reported when the task finishes. */
  session_id: string | null;
  worktree: string | null;
  /** A command that opens the session on the owner's computer. */
  resume: string | null;
  /** The Claude model to run with; null for the computer's default. */
  model: string | null;
  /** How hard the agent thinks (`claude --effort`); null for the computer's default. */
  effort: AgentEffort | null;
}

export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

export interface NewAgentTask {
  chatId: number;
  repo: string;
  jiraKey: string | undefined;
  title: string;
  prompt: string;
  model: string | undefined;
  effort: AgentEffort | undefined;
}

/** What a follow-up says, and the model or effort it switches to; the parent's are kept otherwise. */
export interface FollowUp {
  prompt: string;
  model: string | undefined;
  effort: AgentEffort | undefined;
}

/** A task waiting for the owner's button. */
export function insertAgentTask(db: Db, t: NewAgentTask): AgentTaskRow {
  return db
    .prepare('INSERT INTO agent_tasks (chat_id, repo, jira_key, title, prompt, model, effort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *')
    .get(t.chatId, t.repo, t.jiraKey ?? null, t.title, t.prompt, t.model ?? null, t.effort ?? null, sqliteTime(new Date())) as AgentTaskRow;
}

export function fetchAgentTask(db: Db, id: number): AgentTaskRow | undefined {
  return db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) as AgentTaskRow | undefined;
}

/** A follow-up message for a finished task's session: approved at once, since the owner approved the conversation. */
export function insertFollowUp(db: Db, parent: AgentTaskRow, f: FollowUp): AgentTaskRow {
  return db
    .prepare(
      `INSERT INTO agent_tasks (chat_id, repo, jira_key, title, prompt, status, pr_url, created_at, parent_id, session_id, worktree, resume, model, effort)
       VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      parent.chat_id, parent.repo, parent.jira_key, parent.title, f.prompt, parent.pr_url, sqliteTime(new Date()),
      parent.id, parent.session_id, parent.worktree, parent.resume, f.model ?? parent.model, f.effort ?? parent.effort,
    ) as AgentTaskRow;
}

/** The owner's answer: awaiting → approved or cancelled. False when the task was already decided. */
export function decideAgentTask(db: Db, id: number, run: boolean): boolean {
  const status = run ? 'approved' : 'cancelled';
  return db.prepare("UPDATE agent_tasks SET status = ? WHERE id = ? AND status = 'awaiting'").run(status, id).changes > 0;
}

/** The oldest approved task, moved to `running` in the same transaction, or undefined when none waits. */
export function claimAgentTask(db: Db): AgentTaskRow | undefined {
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM agent_tasks WHERE status = 'approved' ORDER BY id LIMIT 1").get() as AgentTaskRow | undefined;
    if (!row) return undefined;
    db.prepare("UPDATE agent_tasks SET status = 'running' WHERE id = ?").run(row.id);
    return { ...row, status: 'running' as const };
  })();
}

export interface AgentTaskOutcome {
  ok: boolean;
  result: string;
  /** Each kept when the report leaves it out (a follow-up's PR is its parent's). */
  prUrl: string | undefined;
  sessionId: string | undefined;
  worktree: string | undefined;
  resume: string | undefined;
}

/** running → done or failed. Returns the finished row, or undefined when the task isn't running. */
export function finishAgentTask(db: Db, id: number, o: AgentTaskOutcome): AgentTaskRow | undefined {
  return db
    .prepare(
      `UPDATE agent_tasks SET status = ?, result = ?, finished_at = ?, pr_url = COALESCE(?, pr_url),
         session_id = COALESCE(?, session_id), worktree = COALESCE(?, worktree), resume = COALESCE(?, resume)
       WHERE id = ? AND status = 'running' RETURNING *`,
    )
    .get(o.ok ? 'done' : 'failed', o.result, sqliteTime(new Date()), o.prUrl ?? null, o.sessionId ?? null, o.worktree ?? null, o.resume ?? null, id) as AgentTaskRow | undefined;
}
