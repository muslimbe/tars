import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../../src/db/database.ts';
import { Transcript } from '../../../src/log/transcript.ts';
import { createBot } from '../../../src/telegram/bot.ts';
import { replyToMessageTool, sendMessageTool } from '../../../src/tools/telegram/send.ts';
import { FakeTelegram } from '../../fakes/telegram.ts';
import { expectGoldenTool } from '../../golden/tools.ts';
import { memoryLogger } from '../../helpers/log.ts';
import { tempDir } from '../../helpers/tmp.ts';

function setup() {
  const fake = new FakeTelegram();
  const bot = createBot('1:t', { network: fake.transformer, botInfo: fake.botInfo });
  const log = memoryLogger();
  const db = openDatabase(join(tempDir(), 'h.db'), log);
  const replied: number[] = [];
  const ctx = { api: bot.api, me: () => fake.botInfo, db, chatTitles: new Map([[111, 'Ali']]), transcript: new Transcript(log, 'compact'), log, onChatReplied: (c: number) => void replied.push(c) };
  return { fake, db, log, replied, send: sendMessageTool(ctx), reply: replyToMessageTool(ctx) };
}

describe('telegram_send_message / telegram_reply_to_message', () => {
  it('match the tools/list snapshot', () => {
    const t = setup();
    expectGoldenTool(t.send);
    expectGoldenTool(t.reply);
  });

  it('sends Markdown as HTML into the topic and reports the id', async () => {
    const t = setup();
    const out = await t.send.run({ chat_id: -100, text: '**hi**', reply_to_message_id: null, message_thread_id: 7 });
    expect(t.fake.sent()[0]?.payload).toEqual({ chat_id: -100, text: '<b>hi</b>', parse_mode: 'HTML', message_thread_id: 7, link_preview_options: { is_disabled: true } });
    expect(out).toEqual({ content: 'sent message_id=5001', data: { message_id: 5001, message_ids: [5001], chat_id: -100 } });
    expect(t.replied).toEqual([-100]);
  });

  it('splits long text, threads only the first chunk, and records every chunk', async () => {
    const t = setup();
    const text = `${'a'.repeat(4000)}\n\n${'b'.repeat(100)}`;
    const out = await t.reply.run({ chat_id: 111, reply_to_message_id: 42, text });
    const payloads = t.fake.sent().map((c) => c.payload);
    expect(payloads.map((p) => p.reply_parameters)).toEqual([{ message_id: 42 }, undefined]);
    expect(out.content).toBe('sent 2 chunks: message_ids=[5001, 5002]');
    expect(t.db.prepare('SELECT message_id, direction, user_id, reply_to_id, length(text) AS n FROM messages ORDER BY rowid').all()).toEqual([
      { message_id: 5001, direction: 'out', user_id: 999, reply_to_id: 42, n: 4000 },
      { message_id: 5002, direction: 'out', user_id: 999, reply_to_id: null, n: 100 },
    ]);
    expect(t.log.text()).toContain('[TX] DM Ali[111] m5001 →m42 | ');
  });

  it('keeps every chunk of a long reply in the forum topic of the message it answers', async () => {
    const t = setup();
    t.fake.respond('sendMessage', { message_id: 5001, date: 0, chat: { id: -100, type: 'supergroup', title: 'g' }, is_topic_message: true, message_thread_id: 7 });
    await t.reply.run({ chat_id: -100, reply_to_message_id: 42, text: `${'a'.repeat(4000)}\n\n${'b'.repeat(100)}` });
    expect(t.fake.sent().map((c) => c.payload.message_thread_id)).toEqual([undefined, 7]);
  });

  it('reports which chunks went out when a later one fails, so only the rest is resent', async () => {
    const t = setup();
    t.fake.fail('sendMessage', 400, 'Bad Request: message is too long', 1);
    const out = await t.send.run({ chat_id: 111, text: `${'a'.repeat(4000)}\n\n${'b'.repeat(100)}`, reply_to_message_id: null, message_thread_id: null });
    expect(out).toEqual({
      content: "sent 1 of 2 chunks (message_ids=[5001]), then failed: Call to 'sendMessage' failed! (400: Bad Request: message is too long)",
      isError: true,
      data: { message_id: 5001, message_ids: [5001], chat_id: 111 },
    });
  });

  it('keeps a long code block a code block in every chunk', async () => {
    const t = setup();
    const code = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');
    await t.send.run({ chat_id: 111, text: `\`\`\`py\n${code}\n\`\`\``, reply_to_message_id: null, message_thread_id: null });
    const texts = t.fake.sent().map((c) => String(c.payload.text));
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) expect(text).toMatch(/^<pre><code class="language-py">/);
  });

  it('surfaces Telegram failures and keeps delivered chunks', async () => {
    const t = setup();
    t.fake.fail('sendMessage', 400, 'Bad Request: message text is empty');
    await expect(t.send.run({ chat_id: 111, text: '', reply_to_message_id: null, message_thread_id: null })).rejects.toMatchObject({
      name: 'GrammyError',
      message: "Call to 'sendMessage' failed! (400: Bad Request: message text is empty)",
    });
    const long = `${'a'.repeat(4000)}\n\n${'b'.repeat(10)}`;
    t.fake.calls.length = 0;
    const fake = t.fake;
    fake.fail('sendMessage', 403, 'Forbidden: bot was blocked by the user');
    await expect(t.send.run({ chat_id: 111, text: long, reply_to_message_id: null, message_thread_id: null })).rejects.toMatchObject({
      name: 'GrammyError',
      message: "Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)",
    });
  });
});
