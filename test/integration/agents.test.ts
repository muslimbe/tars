import { once } from 'node:events';
import { createServer } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { OWNER, testApp } from '../helpers/app.ts';
import { until } from '../helpers/wait.ts';

type TestApp = ReturnType<typeof testApp>;
const running: TestApp[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((t) => t.app.stop()));
});

const TOKEN = 'agent-token-'.padEnd(40, 'x');
const STRANGER = { id: 222, first_name: 'Eve' };

async function freePort(): Promise<number> {
  const server = createServer().listen(0);
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  server.close();
  return port;
}

async function started() {
  const port = await freePort();
  const t = testApp({ TARS_AGENT_TOKEN: TOKEN, TARS_AGENT_PORT: String(port) });
  running.push(t);
  await t.app.start();
  const post = (path: string, body: object = {}, token = TOKEN) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const press = (from: { id: number; first_name: string }, data: string) =>
    t.telegram.push({
      callback_query: { id: `q${from.id}`, from: { is_bot: false, ...from }, chat_instance: 'c', data, message: { message_id: 9, date: 1, chat: { id: OWNER.id, type: 'private', first_name: 'O' }, text: '🤖 Agent task #1' } },
    } as never);
  return { ...t, post, press };
}

const CREATE = `#fake tool agent_task_create {"chat_id": ${OWNER.id}, "repo": "billing", "jira_key": "BIL-7", "title": "Fix rounding", "prompt": "Round totals half up."}`;

describe('agent tasks, end to end', () => {
  it('runs a task only after an owner presses Run, then hands the report to the model', async () => {
    const t = await started();
    t.telegram.message({ id: OWNER.id }, OWNER, CREATE);
    const approval = await t.telegram.waitFor('sendMessage', (p) => String(p.text).startsWith('🤖 Agent task #1'), 15_000);
    expect(approval.payload).toMatchObject({
      chat_id: OWNER.id,
      text: '🤖 Agent task #1 — billing\nJira: BIL-7\nFix rounding\n\nRound totals half up.',
      reply_markup: { inline_keyboard: [[{ callback_data: 'agent run 1' }, { callback_data: 'agent cancel 1' }]] },
    });
    expect((await t.post('/agent/claim')).status).toBe(204);

    t.press(STRANGER, 'agent run 1');
    await t.telegram.waitFor('answerCallbackQuery', (p) => p.callback_query_id === `q${STRANGER.id}`);
    expect((await t.post('/agent/claim')).status).toBe(204);

    t.press(OWNER, 'agent run 1');
    await t.telegram.waitFor('editMessageText', (p) => String(p.text).endsWith('▶️ Approved — the agent on your computer will pick it up.'));
    const claim = await t.post('/agent/claim');
    const task = (await claim.json()) as { id: number; repo: string; prompt: string };
    expect(task).toMatchObject({ id: 1, repo: 'billing' });
    expect(task.prompt).toContain('Round totals half up.');
    expect(task.prompt).toContain('`lia/bil-7-1`');
    expect((await t.post('/agent/claim')).status).toBe(204);

    const report = await t.post('/agent/tasks/1/result', { ok: true, summary: 'Rounded <half up>.\nPR: https://github.com/acme/billing/pull/5' });
    expect(report.status).toBe(200);
    const stdin = await until(() => t.claudeLog().find((e) => e.kind === 'stdin' && e.line?.includes('agent_result')));
    expect(stdin.line).toContain(
      `<agent_result task=\\"1\\" chat_id=\\"${OWNER.id}\\" repo=\\"billing\\" status=\\"done\\" pr=\\"https://github.com/acme/billing/pull/5\\">Rounded &lt;half up&gt;.`,
    );
    expect((await t.post('/agent/tasks/1/result', { ok: true, summary: 'again' })).status).toBe(409);
  });

  it('a cancelled task never reaches the agent, and a second press changes nothing', async () => {
    const t = await started();
    t.telegram.message({ id: OWNER.id }, OWNER, CREATE);
    await t.telegram.waitFor('sendMessage', (p) => String(p.text).startsWith('🤖 Agent task #1'), 15_000);
    t.press(OWNER, 'agent cancel 1');
    await t.telegram.waitFor('editMessageText', (p) => String(p.text).endsWith('✖️ Cancelled.'));
    t.press(OWNER, 'agent run 1');
    await t.telegram.waitFor('editMessageText', (p) => String(p.text).endsWith('Already decided.'));
    expect((await t.post('/agent/claim')).status).toBe(204);
  });

  it('turns away a wrong token and a malformed report', async () => {
    const t = await started();
    expect((await t.post('/agent/claim', {}, 'wrong')).status).toBe(401);
    expect((await t.post('/agent/tasks/1/result', { ok: 'yes' })).status).toBe(400);
    expect((await t.post('/agent/tasks/1/result', { ok: true, summary: 'x' })).status).toBe(409);
  });

  it('offers no agent tool without a token', async () => {
    const t = testApp();
    running.push(t);
    await t.app.start();
    expect(t.log.text()).not.toContain('agent_task_create');
    expect(t.log.text()).not.toContain('agent server');
  });
});
