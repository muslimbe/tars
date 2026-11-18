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
      callback_query: { id: `q${from.id}`, from: { is_bot: false, ...from }, chat_instance: 'c', data, message: { message_id: 9, date: 1, chat: { id: OWNER.id, type: 'private', first_name: 'O' }, text: '🤖 Agent vazifasi #1' } },
    } as never);
  return { ...t, post, press };
}

const CREATE = `#fake tool agent_task_create {"chat_id": ${OWNER.id}, "repo": "billing", "jira_key": "BIL-7", "title": "Fix rounding", "prompt": "Round totals half up."}`;

describe('agent tasks, end to end', () => {
  it('runs a task only after an owner presses Run, then hands the report to the model', async () => {
    const t = await started();
    t.telegram.message({ id: OWNER.id }, OWNER, CREATE);
    const approval = await t.telegram.waitFor('sendMessage', (p) => String(p.text).startsWith('🤖 Agent vazifasi #1'), 15_000);
    expect(approval.payload).toMatchObject({
      chat_id: OWNER.id,
      text: '🤖 Agent vazifasi #1 — billing\nJira: BIL-7\nFix rounding\n\nRound totals half up.',
      reply_markup: { inline_keyboard: [[{ callback_data: 'agent run 1' }, { callback_data: 'agent cancel 1' }]] },
    });
    expect((await t.post('/agent/claim')).status).toBe(204);

    t.press(STRANGER, 'agent run 1');
    await t.telegram.waitFor('answerCallbackQuery', (p) => p.callback_query_id === `q${STRANGER.id}`);
    expect((await t.post('/agent/claim')).status).toBe(204);

    t.press(OWNER, 'agent run 1');
    await t.telegram.waitFor('editMessageText', (p) => String(p.text).endsWith('▶️ Tasdiqlandi — kompyuteringizdagi agent uni bir daqiqa ichida oladi.'));
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
    await t.telegram.waitFor('sendMessage', (p) => String(p.text).startsWith('🤖 Agent vazifasi #1'), 15_000);
    t.press(OWNER, 'agent cancel 1');
    await t.telegram.waitFor('editMessageText', (p) => String(p.text).endsWith('✖️ Bekor qilindi.'));
    t.press(OWNER, 'agent run 1');
    await t.telegram.waitFor('editMessageText', (p) => String(p.text).endsWith('Bu vazifa allaqachon hal qilingan.'));
    expect((await t.post('/agent/claim')).status).toBe(204);
  });

  it('a follow-up resumes the finished session without a button, and the owner sees it', async () => {
    const t = await started();
    t.telegram.message({ id: OWNER.id }, OWNER, CREATE);
    await t.telegram.waitFor('sendMessage', (p) => String(p.text).startsWith('🤖 Agent vazifasi #1'), 15_000);
    t.press(OWNER, 'agent run 1');
    await t.telegram.waitFor('editMessageText');
    await t.post('/agent/claim');
    const session = { session_id: '71a8c4bf-677a-4e36-b9b4-f5c5d4f48d32', worktree: 'D:\\projects\\.lia-worktrees\\billing-1', resume: 'claude --resume 71a8c4bf' };
    await t.post('/agent/tasks/1/result', { ok: true, summary: 'Which rounding for negatives?', ...session });
    await until(() => t.claudeLog().some((e) => e.kind === 'stdin' && e.line?.includes('agent_result')));

    t.telegram.message({ id: OWNER.id }, OWNER, '#fake tool agent_task_continue {"task_id": 1, "message": "Half away from zero."}');
    const notice = await t.telegram.waitFor('sendMessage', (p) => String(p.text).startsWith('↪️'), 15_000);
    expect(notice.payload).toMatchObject({ chat_id: OWNER.id, text: '↪️ Agent davomi #2 (vazifa #1) — billing\n\nHalf away from zero.' });
    expect(notice.payload.reply_markup).toBeUndefined();
    const follow = (await (await t.post('/agent/claim')).json()) as Record<string, string | number>;
    expect(follow).toMatchObject({ id: 2, repo: 'billing', session_id: session.session_id, worktree: session.worktree });
    expect(follow.prompt).toContain('Half away from zero.');

    await t.post('/agent/tasks/2/result', { ok: true, summary: 'Done.', ...session });
    const stdin = await until(() => t.claudeLog().find((e) => e.kind === 'stdin' && e.line?.includes('continues=')));
    expect(stdin.line).toContain('<agent_result task=\\"2\\" continues=\\"1\\"');
    expect(stdin.line).toContain('resume=\\"claude --resume 71a8c4bf\\"');
  });

  it('will not continue a task that has not finished', async () => {
    const t = await started();
    t.telegram.message({ id: OWNER.id }, OWNER, CREATE);
    await t.telegram.waitFor('sendMessage', (p) => String(p.text).startsWith('🤖 Agent vazifasi #1'), 15_000);
    t.telegram.message({ id: OWNER.id }, OWNER, '#fake tool agent_task_continue {"task_id": 1, "message": "go on"}');
    const call = await until(() => t.claudeLog().find((e) => e.kind === 'tool' && e.name === 'agent_task_continue') as { isError?: boolean; content?: unknown } | undefined);
    expect(call.isError).toBe(true);
    expect(JSON.stringify(call.content)).toContain('agent task #1 is awaiting; only a finished task can be continued');
    expect(t.telegram.sent().some((c) => String(c.payload.text).startsWith('↪️'))).toBe(false);
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
