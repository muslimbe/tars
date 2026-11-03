import { afterEach, describe, expect, it } from 'vitest';

import { OWNER, testApp } from '../helpers/app.ts';
import { until } from '../helpers/wait.ts';

type TestApp = ReturnType<typeof testApp>;
const running: TestApp[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((t) => t.app.stop()));
});

async function started(): Promise<TestApp> {
  const t = testApp();
  running.push(t);
  await t.app.start();
  await until(() => t.telegram.calls.some((c) => c.method === 'getUpdates'));
  return t;
}

const stdin = (t: TestApp) => t.claudeLog().filter((e) => e.kind === 'stdin').map((e) => e.line ?? '');

describe('Telegram transport', () => {
  it('drops the backlog and long-polls for the four update types only', async () => {
    const t = await started();
    expect(t.telegram.calls.find((c) => c.method === 'deleteWebhook')?.payload).toEqual({ drop_pending_updates: true });
    expect(t.telegram.calls.find((c) => c.method === 'getUpdates')?.payload).toMatchObject({
      timeout: 10,
      allowed_updates: ['message', 'edited_message', 'message_reaction'],
    });
  });

  it('handles one update at a time, in order', async () => {
    const t = await started();
    let release = (_body: string) => {};
    t.files.set('slow', new Promise((resolve) => (release = resolve)));
    const document = { file_id: 'slow', file_unique_id: 'u', file_name: 'a.txt', mime_type: 'text/plain', file_size: 1 };
    t.telegram.message({ id: OWNER.id }, OWNER, '', { text: undefined, caption: 'first', document });
    t.telegram.message({ id: OWNER.id }, OWNER, 'second');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stdin(t)).toEqual([]);
    release('x');
    await until(() => stdin(t).join('\n').includes('second'));
    const wire = stdin(t).join('\n');
    expect(wire.indexOf('first')).toBeLessThan(wire.indexOf('second'));
  });

  it('logs a handler failure and keeps polling', async () => {
    const t = await started();
    t.telegram.fail('sendMessage', 400, 'Bad Request: can\'t parse entities');
    t.telegram.message({ id: OWNER.id }, OWNER, '/health');
    await until(() => t.log.text().includes('ERROR error while handling a Telegram update'));
    t.telegram.message({ id: OWNER.id }, OWNER, 'still there?');
    await t.telegram.waitFor('sendMessage', (p) => p.text === 'echo: still there?', 15_000);
  });

  it('shows typing without a thread id; a failed chat action is only a warning', async () => {
    const t = await started();
    t.telegram.fail('sendChatAction', 429, 'Too Many Requests: retry after 1');
    t.telegram.message({ id: OWNER.id }, OWNER, 'hi');
    await t.telegram.waitFor('sendMessage', (p) => p.text === 'echo: hi', 15_000);
    expect(t.log.text()).toMatch(/WARNING send_chat_action failed for chat 111: /);
    expect(t.telegram.calls.find((c) => c.method === 'sendChatAction')?.payload).toEqual({ chat_id: OWNER.id, action: 'typing' });
  });

  it('shows typing inside the forum topic the message came from', async () => {
    const t = testApp({}, { policy: 'allowlist', allowed_users: [], allowed_chats: [-1001] });
    running.push(t);
    await t.app.start();
    // Typing shows in a group only for a message to the bot.
    t.telegram.message({ id: -1001, title: 'forum', is_forum: true }, OWNER, '@tars_bot hi', { is_topic_message: true, message_thread_id: 7, entities: [{ type: 'mention', offset: 0, length: 9 }] });
    const typing = await t.telegram.waitFor('sendChatAction', (p) => p.chat_id === -1001, 15_000);
    expect(typing.payload).toEqual({ chat_id: -1001, action: 'typing', message_thread_id: 7 });
  });

  it('delivers rescued text as plain text threaded to the message; a failed send is only a warning', async () => {
    const t = await started();
    const id = t.telegram.message({ id: OWNER.id }, OWNER, '#fake text forgotten *answer*\n#fake control {"action":"stop","reason":"x"}');
    const rescued = await t.telegram.waitFor('sendMessage', (p) => p.text === 'forgotten *answer*', 15_000);
    expect(rescued.payload).toEqual({ chat_id: OWNER.id, text: 'forgotten *answer*', reply_parameters: { message_id: id } });
    t.telegram.fail('sendMessage', 403, 'Forbidden: bot was blocked by the user');
    t.telegram.message({ id: OWNER.id }, OWNER, '#fake text lost\n#fake control {"action":"stop","reason":"x"}');
    await until(() => t.log.text().includes(`WARNING error notify failed for chat ${OWNER.id}: `));
  });

  it('retries an owner error DM as plain text when the HTML send fails', async () => {
    const t = await started();
    t.telegram.fail('sendMessage', 400, 'Bad Request: can\'t parse entities');
    t.telegram.message({ id: OWNER.id }, OWNER, '#fake text There is an issue with the selected model\n#fake control {"action":"stop","reason":"x"}');
    const plain = await t.telegram.waitFor('sendMessage', (p) => p.parse_mode === undefined && String(p.text).startsWith('⚠️ ERROR — tars.engine'), 15_000);
    expect(plain.payload.text).toContain('The configured Claude model is unavailable');
    expect(t.log.text()).toContain('WARNING owner HTML DM failed, retrying as plain text: ');
  });

  it('stops polling and confirms the update offset on shutdown', async () => {
    const t = await started();
    running.splice(running.indexOf(t), 1);
    await t.app.stop();
    expect(t.telegram.calls.at(-1)).toMatchObject({ method: 'getUpdates', payload: { limit: 1 } });
    expect(t.log.text().split('\n').at(-1)).toBe('INFO clean shutdown complete');
  });
});
