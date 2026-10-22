import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/database.ts';
import { Transcript } from '../../src/log/transcript.ts';
import type { ChatMessage } from '../../src/message.ts';
import { createBot } from '../../src/telegram/bot.ts';
import { Dispatcher } from '../../src/telegram/dispatcher.ts';
import { FakeTelegram } from '../fakes/telegram.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

const OWNER = 111;

function setup(access: object = { policy: 'allowlist', allowed_users: [222], allowed_chats: [-100] }, rateLimitPerMin = 20) {
  const dir = tempDir();
  writeFileSync(join(dir, 'access.json'), JSON.stringify(access));
  const fake = new FakeTelegram();
  const bot = createBot('1:t', { network: fake.transformer, botInfo: fake.botInfo });
  const log = memoryLogger();
  const db = openDatabase(join(dir, 'h.db'), log);
  const submitted: ChatMessage[] = [];
  const primed: number[] = [];
  const commands: string[] = [];
  const dispatcher = new Dispatcher({
    bot,
    config: { ownerId: OWNER, accessPath: join(dir, 'access.json'), rateLimitPerMin },
    db,
    engine: { submit: (m) => Promise.resolve(void submitted.push(m)), primeTyping: (c) => void primed.push(c) },
    chatTitles: new Map(),
    transcript: new Transcript(log, 'compact'),
    log,
    commands: (_ctx, c) => Promise.resolve(c.name === 'health' && commands.push(c.name) > 0),
    attachments: () => Promise.resolve(),
  });
  let nextId = 1;
  const send = (chat: { id: number; type: string }, from: number, text: string, extra: object = {}) =>
    bot.handleUpdate({
      update_id: nextId,
      message: { message_id: nextId++, date: Math.floor(Date.now() / 1000), chat, from: { id: from, is_bot: false, first_name: `U${from}` }, text, ...extra },
    } as Update);
  const rows = (table: string) => db.prepare(`SELECT * FROM ${table}`).all();
  return { fake, bot, db, log, dispatcher, submitted, primed, commands, send, rows };
}

const dm = (id: number) => ({ id, type: 'private' });

describe('dispatcher', () => {
  it('persists an allowed DM, primes typing and submits it', async () => {
    const t = setup();
    await t.send(dm(OWNER), OWNER, 'hello');
    expect(t.submitted.map((m) => m.text)).toEqual(['hello']);
    expect(t.primed).toEqual([OWNER]);
    expect(t.rows('messages')).toMatchObject([{ chat_id: OWNER, message_id: 1, text: 'hello', consumed: 0, processed: 0 }]);
    expect(t.rows('users')).toMatchObject([{ chat_id: OWNER, user_id: OWNER, message_count: 1 }]);
    expect(t.log.text()).toContain(`[RX] DM [${OWNER}] U${OWNER}[${OWNER}] m1 | hello`);
  });

  it('drops a stranger: no message row, one refusal per chat, groups stay silent', async () => {
    const t = setup();
    await t.send(dm(333), 333, 'hi');
    await t.send(dm(333), 333, 'hi again');
    await t.send({ id: -999, type: 'supergroup' }, 333, 'group hi');
    expect(t.submitted).toEqual([]);
    expect(t.rows('messages')).toEqual([]);
    expect(t.fake.sent().map((c) => [c.payload.chat_id, c.payload.text])).toEqual([[333, 'This is a private assistant. Please contact the owner if you want an access.']]);
    expect(t.rows('unauthorized_messages')).toMatchObject([{ chat_id: 333, refusal_sent: 1 }, { chat_id: 333, refusal_sent: 0 }, { chat_id: -999, refusal_sent: 0, chat_type: 'supergroup' }]);
    expect(t.log.text()).toContain('[DROP] DM [333] U333[333] m1 (chat not allowed) | hi');
  });

  it('rate-limits DMs per user with one notice; groups and the owner are exempt', async () => {
    const t = setup({ policy: 'open', allowed_users: [], allowed_chats: [] }, 2);
    for (let i = 0; i < 4; i++) await t.send(dm(222), 222, `m${i}`);
    for (let i = 0; i < 4; i++) await t.send({ id: -100, type: 'supergroup' }, 222, `g${i}`);
    for (let i = 0; i < 4; i++) await t.send(dm(OWNER), OWNER, `o${i}`);
    expect(t.submitted.map((m) => m.text)).toEqual(['m0', 'm1', 'g0', 'g1', 'g2', 'g3', 'o0', 'o1', 'o2', 'o3']);
    const notices = t.fake.sent().filter((c) => String(c.payload.text).startsWith('⏳'));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload.text).toMatch(/^⏳ You're sending messages too fast \(2\/min\)\. Try again in ~\d+s\.$/);
  });

  it('drops everything while paused, without a trace', async () => {
    const t = setup();
    t.dispatcher.paused = true;
    await t.send(dm(OWNER), OWNER, 'ignored');
    expect(t.submitted).toEqual([]);
    expect(t.rows('messages')).toEqual([]);
    expect(t.log.text()).toContain(`paused — dropping chat=${OWNER} msg=1`);
  });

  it('consumes registered commands before the gate', async () => {
    const t = setup();
    await t.send(dm(333), 333, '/health', { entities: [{ type: 'bot_command', offset: 0, length: 7 }] });
    expect(t.commands).toEqual(['health']);
    expect(t.rows('unauthorized_messages')).toEqual([]);
  });

  it('treats an edited text message as a new message', async () => {
    const t = setup();
    await t.send(dm(OWNER), OWNER, 'first');
    await t.bot.handleUpdate({ update_id: 50, edited_message: { message_id: 1, date: 1_700_000_000, edit_date: 1_700_000_100, chat: dm(OWNER), from: { id: OWNER, is_bot: false, first_name: 'O' }, text: 'edited' } } as Update);
    expect(t.submitted.map((m) => [m.messageId, m.text])).toEqual([[1, 'first'], [1, 'edited']]);
    expect(t.rows('messages')).toMatchObject([{ message_id: 1, text: 'edited', edited: 0 }]);
  });

  it('records reactions from allowed users on stored messages', async () => {
    const t = setup();
    await t.send(dm(OWNER), OWNER, 'react to me');
    const reaction = (old: string[], next: string[]) =>
      t.bot.handleUpdate({
        update_id: 60,
        message_reaction: { chat: dm(OWNER), message_id: 1, user: { id: OWNER, is_bot: false, first_name: 'O' }, date: 1, old_reaction: old.map((emoji) => ({ type: 'emoji', emoji })), new_reaction: next.map((emoji) => ({ type: 'emoji', emoji })) },
      } as Update);
    await reaction([], ['👍']);
    await reaction(['👍'], ['❤️']);
    expect(t.db.prepare('SELECT reactions FROM messages').pluck().get()).toBe('{"❤️":[111]}');
  });

  it('forwards every group message from an allowed chat, bots included', async () => {
    const t = setup();
    await t.bot.handleUpdate({ update_id: 70, message: { message_id: 5, date: 1, chat: { id: -100, type: 'supergroup', title: 'G' }, from: { id: 999_000, is_bot: true, first_name: 'Bot' }, text: 'beep' } });
    expect(t.submitted.map((m) => m.text)).toEqual(['beep']);
  });

  it('takes text, captions and files (voice included); a sticker without a caption is ignored', async () => {
    const t = setup();
    await t.send(dm(222), 222, '', { text: undefined, sticker: { file_id: 's', file_unique_id: 's', type: 'regular', width: 1, height: 1, is_animated: false, is_video: false } });
    expect(t.submitted).toEqual([]);
    expect(t.rows('messages')).toEqual([]);
    await t.send(dm(222), 222, '', { text: undefined, voice: { file_id: 'v', file_unique_id: 'v', duration: 1 } });
    await t.send(dm(222), 222, '', { text: undefined, caption: 'listen', voice: { file_id: 'v', file_unique_id: 'v', duration: 1 } });
    expect(t.submitted.map((m) => m.text)).toEqual(['', 'listen']);
  });

  it('logs the receipt (denied senders too) and the submit with its latency', async () => {
    const t = setup();
    await t.send(dm(333), 333, 'stranger');
    await t.send(dm(222), 222, 'friend');
    const lines = t.log.text().split('\n').filter((l) => l.includes('hot-path'));
    expect(lines[0]).toBe('INFO hot-path stage=receipt chat=333 msg=1 t_ms=0');
    expect(lines[1]).toBe('INFO hot-path stage=receipt chat=222 msg=2 t_ms=0');
    expect(lines[2]).toMatch(/^INFO hot-path stage=submit chat=222 msg=2 t_ms=\d+$/);
  });

  it('applies a content-less edit from an allowed chat as an empty text, silently ignoring others', async () => {
    const t = setup();
    await t.send(dm(222), 222, 'original');
    const edit = (chat: { id: number; type: string }, from: number, messageId: number) =>
      t.bot.handleUpdate({
        update_id: 99,
        edited_message: { message_id: messageId, date: 0, edit_date: 1, chat, from: { id: from, is_bot: false, first_name: `U${from}` }, sticker: { file_id: 's', file_unique_id: 's', type: 'regular', width: 1, height: 1, is_animated: false, is_video: false } },
      } as Update);
    await edit(dm(222), 222, 1);
    expect(t.rows('messages')).toEqual([expect.objectContaining({ message_id: 1, text: '', edited: 1, processed: 0 })]);
    expect(t.log.text()).toContain('[RX↺]');
    await edit(dm(333), 333, 7);
    expect(t.log.text().match(/\[RX↺\]/g)).toHaveLength(1);
    expect(t.submitted).toHaveLength(1);
  });
});
