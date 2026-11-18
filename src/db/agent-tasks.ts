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
}

export interface NewAgentTask {
  chatId: number;
  repo: string;
  jiraKey: string | undefined;
  title: string;
  prompt: string;
}

/** A task waiting for the owner's button. */
export function insertAgentTask(db: Db, t: NewAgentTask): AgentTaskRow {
  return db
    .prepare('INSERT INTO agent_tasks (chat_id, repo, jira_key, title, prompt, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
    .get(t.chatId, t.repo, t.jiraKey ?? null, t.title, t.prompt, sqliteTime(new Date())) as AgentTaskRow;
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
  prUrl: string | undefined;
}

/** running → done or failed. Returns the finished row, or undefined when the task isn't running. */
export function finishAgentTask(db: Db, id: number, o: AgentTaskOutcome): AgentTaskRow | undefined {
  return db
    .prepare("UPDATE agent_tasks SET status = ?, result = ?, pr_url = ?, finished_at = ? WHERE id = ? AND status = 'running' RETURNING *")
    .get(o.ok ? 'done' : 'failed', o.result, o.prUrl ?? null, sqliteTime(new Date()), id) as AgentTaskRow | undefined;
}
