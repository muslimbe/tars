import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type AgentTaskOutcome, claimAgentTask, decideAgentTask, fetchAgentTask, finishAgentTask, insertAgentTask, insertFollowUp } from '../../src/db/agent-tasks.ts';
import { openDatabase } from '../../src/db/database.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

const outcome = (o: Partial<AgentTaskOutcome>): AgentTaskOutcome => ({ ok: true, result: 'r', prUrl: undefined, sessionId: undefined, worktree: undefined, resume: undefined, ...o });

function setup() {
  const db = openDatabase(join(tempDir(), 'a.db'), memoryLogger());
  const insert = (title = 'Fix', model?: string) => insertAgentTask(db, { chatId: 1, repo: 'billing', jiraKey: undefined, title, prompt: 'do it', model });
  return { db, insert };
}

describe('agent_tasks table', () => {
  it('a new task waits for the owner', () => {
    const { insert } = setup();
    expect(insert()).toMatchObject({ id: 1, chat_id: 1, repo: 'billing', jira_key: null, status: 'awaiting', result: null, model: null });
  });

  it('is decided once: run or cancel, never both', () => {
    const { db, insert } = setup();
    const { id } = insert();
    expect(decideAgentTask(db, id, false)).toBe(true);
    expect(decideAgentTask(db, id, true)).toBe(false);
    expect(claimAgentTask(db)).toBeUndefined();
  });

  it('hands out approved tasks oldest first, each once', () => {
    const { db, insert } = setup();
    const first = insert('first');
    const second = insert('second');
    insert('never approved');
    decideAgentTask(db, second.id, true);
    decideAgentTask(db, first.id, true);
    expect(claimAgentTask(db)).toMatchObject({ title: 'first', status: 'running' });
    expect(claimAgentTask(db)).toMatchObject({ title: 'second', status: 'running' });
    expect(claimAgentTask(db)).toBeUndefined();
  });

  it('closes only a running task', () => {
    const { db, insert } = setup();
    const { id } = insert();
    expect(finishAgentTask(db, id, outcome({}))).toBeUndefined();
    decideAgentTask(db, id, true);
    claimAgentTask(db);
    expect(finishAgentTask(db, id, outcome({ ok: false, result: 'tests fail' }))).toMatchObject({ status: 'failed', result: 'tests fail', pr_url: null });
    expect(finishAgentTask(db, id, outcome({ result: 'again' }))).toBeUndefined();
  });

  it('a follow-up is approved at once, resumes the parent session, and keeps what its report leaves out', () => {
    const { db, insert } = setup();
    const { id } = insert('Fix', 'opus');
    decideAgentTask(db, id, true);
    claimAgentTask(db);
    const parent = finishAgentTask(db, id, outcome({ prUrl: 'https://pr/1', sessionId: 's-1', worktree: 'D:\\w', resume: 'go' }));
    if (!parent) throw new Error('parent did not finish');
    const follow = insertFollowUp(db, parent, 'more', undefined);
    expect(follow).toMatchObject({ parent_id: id, status: 'approved', prompt: 'more', session_id: 's-1', worktree: 'D:\\w', pr_url: 'https://pr/1', model: 'opus' });
    expect(claimAgentTask(db)).toMatchObject({ id: follow.id, status: 'running' });
    finishAgentTask(db, follow.id, outcome({ result: 'did more' }));
    expect(fetchAgentTask(db, follow.id)).toMatchObject({ status: 'done', result: 'did more', pr_url: 'https://pr/1', session_id: 's-1', resume: 'go' });
    expect(insertFollowUp(db, parent, 'faster', 'sonnet')).toMatchObject({ model: 'sonnet' });
  });
});
