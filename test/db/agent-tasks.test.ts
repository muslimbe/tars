import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { claimAgentTask, decideAgentTask, finishAgentTask, insertAgentTask } from '../../src/db/agent-tasks.ts';
import { openDatabase } from '../../src/db/database.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

function setup() {
  const db = openDatabase(join(tempDir(), 'a.db'), memoryLogger());
  const insert = (title = 'Fix') => insertAgentTask(db, { chatId: 1, repo: 'billing', jiraKey: undefined, title, prompt: 'do it' });
  return { db, insert };
}

describe('agent_tasks table', () => {
  it('a new task waits for the owner', () => {
    const { insert } = setup();
    expect(insert()).toMatchObject({ id: 1, chat_id: 1, repo: 'billing', jira_key: null, status: 'awaiting', result: null });
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
    expect(finishAgentTask(db, id, { ok: true, result: 'r', prUrl: undefined })).toBeUndefined();
    decideAgentTask(db, id, true);
    claimAgentTask(db);
    expect(finishAgentTask(db, id, { ok: false, result: 'tests fail', prUrl: undefined })).toMatchObject({ status: 'failed', result: 'tests fail', pr_url: null });
    expect(finishAgentTask(db, id, { ok: true, result: 'again', prUrl: undefined })).toBeUndefined();
  });
});
