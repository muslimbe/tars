import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/database.ts';
import { formatJson } from '../../src/log/sinks.ts';
import { Transcript } from '../../src/log/transcript.ts';
import type { ChatMessage } from '../../src/message.ts';
import { createBot } from '../../src/telegram/bot.ts';
import { createCommands, registerCommandMenu } from '../../src/telegram/commands.ts';
import { createAccessUi } from '../../src/telegram/commands/access-ui.ts';
import { type CommandHandler, Dispatcher } from '../../src/telegram/dispatcher.ts';
import { GroupMembers } from '../../src/telegram/members.ts';
import { FakeTelegram } from '../fakes/telegram.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

const OWNER = 111;
const STRANGER = 333;
const COMMANDS = ['kill', 'reset_session', 'pause', 'resume', 'health', 'audit', 'logs', 'allow', 'deny', 'policy', 'access'];
const RESET_REPLY =
  'Session cleared — Claude restarted with a fresh context. Chat history and memories are preserved; a short recap of recent messages will be carried into the next turn.';

type Chat = { id: number; type: string; title?: string; is_forum?: boolean };
const dm = (id: number): Chat => ({ id, type: 'private' });
const GROUP: Chat = { id: -100123, type: 'supergroup', title: 'Team' };

/** A bot wired the way the app wires it: the real dispatcher, with the commands paused through it. */
function setup(access: object = { policy: 'owner_only', allowed_users: [], allowed_chats: [] }) {
  const dir = tempDir();
  const accessPath = join(dir, 'access.json');
  writeFileSync(accessPath, `${JSON.stringify(access, null, 2)}\n`);
  const fake = new FakeTelegram();
  const bot = createBot('1:t', { network: fake.transformer, botInfo: fake.botInfo });
  const log = memoryLogger();
  const db = openDatabase(join(dir, 'h.db'), log);
  const engine = {
    pendingCount: 0,
    turnElapsedSeconds: undefined as number | undefined,
    calls: [] as string[],
    submitted: [] as ChatMessage[],
    submit: (m: ChatMessage) => Promise.resolve(void engine.submitted.push(m)),
    primeTyping: () => undefined,
    stashRestoreContext: (reason: string) => void engine.calls.push(`stash ${reason}`),
    resetSession: () => Promise.resolve(void engine.calls.push('reset')),
  };
  const kills: string[] = [];
  const config = { ownerId: OWNER, accessPath, rateLimitPerMin: 20, groupMessages: 'all' as const, groupAddressees: [], dataDir: dir, memoriesDir: join(dir, 'memories'), logDir: join(dir, 'logs') };
  let commands: CommandHandler = () => Promise.resolve(false);
  const dispatcher = new Dispatcher({
    bot,
    config,
    db,
    engine,
    chatTitles: new Map(),
    transcript: new Transcript(log, 'compact'),
    log: log.child('telegram'),
    commands: (ctx, command) => commands(ctx, command),
    accessUi: createAccessUi({ api: bot.api, config, log: log.child('telegram') }),
    members: new GroupMembers({ api: bot.api, log }),
    attachments: () => Promise.resolve(),
  });
  commands = createCommands({ config, db, engine, pause: dispatcher, log: log.child('telegram'), kill: () => void kills.push('kill') });
  let nextId = 1;
  /** Deliver a text message the way Telegram does: a leading `/command` carries its `bot_command` entity. */
  const send = (text: string, opts: { chat?: Chat; from?: number; extra?: object; edited?: boolean } = {}) => {
    const id = nextId++;
    const command = /^\/\w+(@\w+)?/.exec(text)?.[0];
    const entities = command ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {};
    const from = { id: opts.from ?? OWNER, is_bot: false, first_name: 'Ann' };
    const message = { message_id: id, date: 1_750_000_000, chat: opts.chat ?? dm(opts.from ?? OWNER), from, text, ...entities, ...opts.extra };
    return bot.handleUpdate((opts.edited ? { update_id: id, edited_message: { ...message, edit_date: 1_750_000_001 } } : { update_id: id, message }) as Update);
  };
  const replies = () => fake.sent().map((c) => String(c.payload.text));
  const writeLog = (content: string) => {
    mkdirSync(config.logDir, { recursive: true });
    writeFileSync(join(config.logDir, 'tars.log'), content);
  };
  return { dir, accessPath, fake, bot, log, db, engine, kills, dispatcher, send, replies, writeLog };
}

/** A JSON log record as the log file holds it. */
const logLine = (msg: string) => formatJson({ time: new Date(Date.UTC(2026, 5, 25, 10, 31)), level: 'INFO', name: 'tars.engine', msg });

describe('owner gate and routing', () => {
  it('consumes all 11 commands from anyone, anywhere, but answers only the owner', async () => {
    const t = setup();
    t.writeLog(`${logLine('secret event')}\n`);
    for (const name of COMMANDS) await t.send(`/${name} user 5`, { from: STRANGER });
    for (const name of COMMANDS) await t.send(`/${name}@tars_bot user 6`, { from: STRANGER, chat: GROUP });
    expect(t.fake.calls.filter((c) => c.method !== 'getMe')).toEqual([]);
    expect(t.engine.submitted).toEqual([]);
    expect(t.engine.calls).toEqual([]);
    expect(t.kills).toEqual([]);
    expect(t.dispatcher.paused).toBe(false);
    expect(JSON.parse(readFileSync(t.accessPath, 'utf8'))).toEqual({ policy: 'owner_only', allowed_users: [], allowed_chats: [] });
    expect(t.db.prepare('SELECT COUNT(*) FROM unauthorized_messages').pluck().get()).toBe(0);
  });

  it('leaves any other /word to the message pipeline', async () => {
    const t = setup();
    for (const text of ['/start', '/help', '/usage', '/reset', '/constructor', '/__proto__', '/kill@other_bot']) await t.send(text);
    expect(t.engine.submitted.map((m) => m.text)).toEqual(['/start', '/help', '/usage', '/reset', '/constructor', '/__proto__', '/kill@other_bot']);
    expect(t.kills).toEqual([]);
  });

  it('quotes the command in groups but not in DMs, and answers inside the forum topic', async () => {
    const t = setup();
    await t.send('/access');
    await t.send('/access@tars_bot', { chat: GROUP });
    await t.send('/access', { chat: { ...GROUP, is_forum: true }, extra: { is_topic_message: true, message_thread_id: 77 } });
    const [inDm, inGroup, inTopic] = t.fake.sent().map((c) => c.payload);
    expect(inDm).toMatchObject({ chat_id: OWNER });
    expect(inDm?.reply_parameters).toBeUndefined();
    expect(inDm?.message_thread_id).toBeUndefined();
    expect(inGroup).toMatchObject({ chat_id: GROUP.id, reply_parameters: { message_id: 2 } });
    expect(inTopic).toMatchObject({ chat_id: GROUP.id, reply_parameters: { message_id: 3 }, message_thread_id: 77 });
  });

  it('runs a command again when its message is edited, in any case', async () => {
    const t = setup();
    await t.send('/ACCESS');
    await t.send('/access', { edited: true });
    expect(t.replies()).toHaveLength(2);
  });
});

describe('/pause, /resume, /kill, /reset_session', () => {
  it('/pause drops every inbound message until /resume, and /health shows it', async () => {
    const t = setup();
    await t.send('/pause now');
    await t.send('dropped while paused');
    await t.send('/health');
    await t.send('/resume');
    await t.send('delivered');
    const [paused, health, resumed] = t.replies();
    expect(paused).toBe('⏸ paused — messages dropped until /resume');
    expect(health).toContain('\n- status: ⏸ PAUSED (dropping messages)\n');
    expect(resumed).toBe('▶ resumed');
    expect(t.engine.submitted.map((m) => m.text)).toEqual(['delivered']);
    expect(t.db.prepare('SELECT text FROM messages').pluck().all()).toEqual(['delivered']);
    expect(t.log.text()).toContain('WARNING /pause received from owner; dropping inbound messages');
    expect(t.log.text()).toContain('WARNING /resume received from owner; forwarding inbound messages');
  });

  it('/kill says goodbye, then shuts down — even when the goodbye cannot be sent', async () => {
    const t = setup();
    await t.send('/kill now');
    expect(t.replies()).toEqual(['Shutting down…']);
    expect(t.kills).toEqual(['kill']);
    t.fake.fail('sendMessage', 403, 'Forbidden: bot was blocked by the user');
    await t.send('/kill');
    expect(t.kills).toEqual(['kill', 'kill']);
    expect(t.log.text()).toContain('WARNING /kill received from owner; shutting down');
  });

  it('/reset_session stashes a recap, resets in-process and acknowledges', async () => {
    const t = setup();
    await t.send('/reset_session please');
    expect(t.engine.calls).toEqual(['stash owner-reset', 'reset']);
    expect(t.replies()).toEqual([RESET_REPLY]);
    expect(t.kills).toEqual([]);
    expect(t.log.text()).toContain('WARNING /reset_session received from owner; respawning cc with a fresh session');
  });

  it('/reset_session ignores a lost acknowledgement; a failed reset propagates unacknowledged', async () => {
    const t = setup();
    t.fake.fail('sendMessage', 400, 'Bad Request: chat not found');
    await t.send('/reset_session');
    expect(t.engine.calls).toEqual(['stash owner-reset', 'reset']);
    t.engine.resetSession = () => Promise.reject(new Error('worker gone'));
    await expect(t.send('/reset_session')).rejects.toThrow('worker gone');
    expect(t.replies()).toEqual([RESET_REPLY]);
  });
});

describe('/health', () => {
  it('reads a fresh install', async () => {
    const t = setup();
    await t.send('/health');
    expect(t.fake.sent()[0]?.payload).toMatchObject({
      parse_mode: 'Markdown',
      text: [
        '*tars health*',
        '- status: active',
        '- last bot send: `(none yet)` UTC',
        '- self-reflection reminder: MISSING (will re-seed on restart)',
        '- rate-limit notices fired (lifetime): 0',
        '- current turn: idle',
        '- queued messages: 0',
      ].join('\n'),
    });
  });

  it('shows the last send, the newest self-reflection row, notices and the running turn', async () => {
    const t = setup();
    const insertMsg = t.db.prepare("INSERT INTO messages(chat_id, message_id, user_id, direction, timestamp, text) VALUES (1, ?, 9, ?, ?, 'x')");
    insertMsg.run(1, 'out', '2026-06-25 10:31:00');
    insertMsg.run(2, 'out', '2026-06-24 09:00:00');
    insertMsg.run(3, 'in', '2026-06-26 00:00:00');
    const insertReminder = t.db.prepare("INSERT INTO reminders(chat_id, user_id, text, trigger_at, cron_expr, status, created_at, auto_seed_key) VALUES (1, 1, 'r', ?, ?, ?, 'now', ?)");
    insertReminder.run('2026-06-25 00:00:00', '0 0 * * *', 'pending', 'self-reflection-default');
    insertReminder.run('2026-06-26 00:00:00', '0 0 * * *', 'processing', 'self-reflection-default');
    insertReminder.run('2026-06-27 00:00:00', null, 'pending', 'other');
    t.db.exec('INSERT INTO rate_limits(user_id, bucket_start, count, notice_sent) VALUES (1, 60, 25, 1), (2, 60, 21, 1), (3, 60, 3, 0)');
    Object.assign(t.engine, { turnElapsedSeconds: 2.5, pendingCount: 3 });
    await t.send('/health');
    Object.assign(t.engine, { turnElapsedSeconds: 3.5 });
    t.db.exec("UPDATE reminders SET cron_expr = NULL WHERE status = 'processing'");
    await t.send('/health');
    const [first, second] = t.replies();
    expect(first).toBe(
      [
        '*tars health*',
        '- status: active',
        '- last bot send: `2026-06-25 10:31:00` UTC',
        '- self-reflection reminder: processing (cron `0 0 * * *`, next `2026-06-26 00:00:00` UTC)',
        '- rate-limit notices fired (lifetime): 2',
        '- current turn: running for 3s',
        '- queued messages: 3',
      ].join('\n'),
    );
    expect(second).toContain('- self-reflection reminder: processing (cron `none`, next `2026-06-26 00:00:00` UTC)\n');
    expect(second).toContain('- current turn: running for 4s\n');
  });

  it('puts a failing query on its own line', async () => {
    const t = setup();
    t.db.exec('DROP TABLE messages; DROP TABLE reminders; DROP TABLE rate_limits');
    await t.send('/health');
    expect(t.replies()[0]).toBe(
      [
        '*tars health*',
        '- status: active',
        '- last bot send: query error (no such table: messages)',
        '- self-reflection reminder: query error (no such table: reminders)',
        '- rate-limit notices: query error (no such table: rate_limits)',
        '- current turn: idle',
        '- queued messages: 0',
      ].join('\n'),
    );
  });
});

describe('/audit', () => {
  it('reads a fresh install', async () => {
    const t = setup();
    await t.send('/audit');
    expect(t.fake.sent()[0]?.payload).toMatchObject({
      parse_mode: 'Markdown',
      text: '*tars audit*\n*recent tool failures:* none\n*prompt backups:* (none yet)\n*memory footprint:* 0 bytes under `memories/`',
    });
  });

  it('lists the five newest failures, counts .md backups and sums memory bytes', async () => {
    const t = setup();
    const insert = t.db.prepare("INSERT INTO tool_calls(tool_name, args_json, error, created_at) VALUES (?, '{}', ?, ?)");
    insert.run('ok_tool', null, '2026-06-25 09:00:00');
    insert.run('empty_error', '', '2026-06-25 09:00:01');
    for (let i = 1; i <= 6; i++) insert.run(`tool_${i}`, i === 6 ? `${'x'.repeat(79)}😀 and more` : `ValueError: boom ${i}`, `2026-06-25 10:00:0${i}`);
    const backups = join(t.dir, 'prompt_backups');
    mkdirSync(join(backups, 'dir.md'), { recursive: true });
    for (const name of ['a.md', 'b.md', 'c.txt', '.md']) writeFileSync(join(backups, name), 'x');
    const memories = join(t.dir, 'memories');
    mkdirSync(join(memories, 'nested', '.deep'), { recursive: true });
    writeFileSync(join(memories, 'a.md'), 'a'.repeat(1000));
    writeFileSync(join(memories, 'nested', '.deep', 'b.md'), 'b'.repeat(168));
    const outside = join(t.dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'big.md'), 'c'.repeat(5000));
    writeFileSync(join(outside, 'small.md'), 'd'.repeat(66));
    symlinkSync(outside, join(memories, 'linked-dir'));
    symlinkSync(join(outside, 'small.md'), join(memories, 'linked-file.md'));
    await t.send('/audit');
    expect(t.replies()[0]).toBe(
      [
        '*tars audit*',
        '*recent tool failures:*',
        `  • \`2026-06-25 10:00:06\` tool_6 — ${'x'.repeat(79)}😀`,
        '  • `2026-06-25 10:00:05` tool_5 — ValueError: boom 5',
        '  • `2026-06-25 10:00:04` tool_4 — ValueError: boom 4',
        '  • `2026-06-25 10:00:03` tool_3 — ValueError: boom 3',
        '  • `2026-06-25 10:00:02` tool_2 — ValueError: boom 2',
        `*prompt backups:* 2 file(s) in \`${backups}\``,
        '*memory footprint:* 1,234 bytes under `memories/`',
      ].join('\n'),
    );
  });

  it('reports a section it cannot read instead of failing', async () => {
    const t = setup();
    t.db.exec('DROP TABLE tool_calls');
    writeFileSync(join(t.dir, 'prompt_backups'), 'not a directory');
    await t.send('/audit');
    const lines = t.replies()[0]?.split('\n');
    expect(lines?.[1]).toBe('*recent tool failures:* query error (no such table: tool_calls)');
    expect(lines?.[2]).toMatch(/^\*prompt backups:\* error \(ENOTDIR: .+\)$/);
    expect(lines?.[3]).toBe('*memory footprint:* 0 bytes under `memories/`');
  });
});

describe('/logs', () => {
  it('replies with the recent lines, compactly rendered', async () => {
    const t = setup();
    t.writeLog(`${logLine('first event')}\n${logLine('second event')}\n`);
    await t.send('/logs');
    expect(t.fake.sent().map((c) => c.payload)).toMatchObject([
      { text: '<blockquote>10:31:00 INFO tars.engine | first event\n10:31:00 INFO tars.engine | second event</blockquote>', parse_mode: 'HTML' },
    ]);
  });

  it('escapes the log text inside the HTML blockquote', async () => {
    const t = setup();
    t.writeLog(`${logLine(`boom in <module> & "quoted" 'single'`)}\n`);
    await t.send('/logs');
    expect(t.replies()).toEqual(['<blockquote>10:31:00 INFO tars.engine | boom in &lt;module&gt; &amp; &quot;quoted&quot; &#x27;single&#x27;</blockquote>']);
  });

  it('renders JSON records compactly, and anything else verbatim', async () => {
    const t = setup();
    const record = formatJson({ time: new Date(Date.UTC(2026, 5, 25, 11, 2, 3)), level: 'ERROR', name: 'tars.telegram', msg: 'send failed', err: new Error('boom') });
    const odd = ['not json at all', '123', '[1, 2]', '{}', '{"ts": "garbage", "level": null, "msg": "m"}', '{"ts": 5, "msg": {"a": [true]}}'];
    t.writeLog([record, ...odd].join('\r\n'));
    await t.send('/logs 10');
    expect(t.replies()).toEqual([
      [
        '<blockquote>11:02:03 ERROR tars.telegram | send failed',
        'not json at all',
        '123',
        '[1, 2]',
        '   | ',
        'garbage null  | m',
        '5   | {&quot;a&quot;:[true]}</blockquote>',
      ].join('\n'),
    ]);
  });

  it('bare /logs sends one quote of the newest lines that fit, starting at a line', async () => {
    const t = setup();
    t.writeLog(Array.from({ length: 400 }, (_, i) => `${logLine(`event number ${i}`)}\n`).join(''));
    await t.send('/logs');
    const replies = t.replies();
    expect(replies).toHaveLength(1);
    const text = replies[0] ?? '';
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain('event number 399');
    expect(text).not.toContain('event number 0');
    expect(text).toMatch(/^<blockquote>10:31:00 INFO tars\.engine \| event number \d+\n/);
  });

  it('bare /logs counts UTF-16 units, so emoji-heavy logs still fit one message', async () => {
    const t = setup();
    t.writeLog(Array.from({ length: 200 }, (_, i) => `${logLine(`${'😀'.repeat(30)} ${i}`)}\n`).join(''));
    await t.send('/logs');
    const text = t.replies()[0] ?? '';
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain(`${'😀'.repeat(30)} 199</blockquote>`);
    expect(text.isWellFormed()).toBe(true);
  });

  it('/logs N tails N lines (1–200, not a number → 50) and splits them across quotes', async () => {
    const t = setup();
    t.writeLog(Array.from({ length: 250 }, (_, i) => `${logLine(`event ${i} ${'.'.repeat(100)}`)}\n`).join(''));
    /** The lines one command showed, and in how many messages. */
    const shown = async (command: string) => {
      const before = t.fake.sent().length;
      await t.send(command);
      const texts = t.fake.sent().slice(before).map((c) => String(c.payload.text));
      for (const text of texts) expect(text).toMatch(/^<blockquote>[^]{1,4071}<\/blockquote>$/);
      return { lines: texts.map((text) => text.slice('<blockquote>'.length, -'</blockquote>'.length)).join('\n').split('\n'), messages: texts.length };
    };
    expect((await shown('/logs 3')).lines).toEqual([247, 248, 249].map((i) => `10:31:00 INFO tars.engine | event ${i} ${'.'.repeat(100)}`));
    expect((await shown('/logs 10 extra args')).lines).toHaveLength(10);
    expect((await shown('/logs abc')).lines).toHaveLength(50);
    expect((await shown('/logs 0')).lines).toHaveLength(1);
    expect((await shown('/logs -5')).lines).toHaveLength(50);
    const all = await shown('/logs 999');
    expect(all.lines).toHaveLength(200);
    expect(all.lines[0]).toContain('event 50 ');
    expect(all.messages).toBeGreaterThan(5);
  });

  it('says so when there is no log yet', async () => {
    const t = setup();
    await t.send('/logs');
    t.writeLog('');
    await t.send('/logs 5');
    expect(t.fake.sent().map((c) => [c.payload.text, c.payload.parse_mode])).toEqual([
      ['no logs yet', undefined],
      ['no logs yet', undefined],
    ]);
  });
});

describe('access management', () => {
  it('/allow adds a user or group once and leaves the policy alone', async () => {
    const t = setup();
    await t.send('/allow user 5');
    await t.send('/allow GROUP -100123 extra');
    const saved = readFileSync(t.accessPath, 'utf8');
    expect(saved).toBe('{\n  "policy": "owner_only",\n  "allowed_users": [\n    5\n  ],\n  "allowed_chats": [\n    -100123\n  ]\n}\n');
    writeFileSync(t.accessPath, saved.replace(/\n\s*/g, ''));
    await t.send('/allow user 5');
    expect(readFileSync(t.accessPath, 'utf8')).toBe(saved.replace(/\n\s*/g, ''));
    expect(t.replies()).toEqual(['User 5 added to allowlist.', 'Group -100123 added to allowlist.', 'User 5 added to allowlist.']);
  });

  it('/allow and /deny explain what is wrong with their arguments', async () => {
    const t = setup();
    for (const verb of ['allow', 'deny']) {
      for (const args of [' user', ' 5 user', ' chat 5']) await t.send(`/${verb}${args}`);
      for (const id of ['abc', '1e3', '0x10', '12abc', '1_0', '+5', '99999999999999999999']) await t.send(`/${verb} user ${id}`);
    }
    await t.send('/deny');
    await t.send('/allow', { chat: GROUP });
    const usage = (verb: string) => [...Array<string>(3).fill(`Usage: /${verb} <user|group> <id>`), ...Array<string>(7).fill('ID must be a number.')];
    expect(t.replies()).toEqual([...usage('allow'), ...usage('deny'), 'Usage: /deny <user|group> <id>', 'Usage: /allow <user|group> <id>']);
    expect(JSON.parse(readFileSync(t.accessPath, 'utf8'))).toEqual({ policy: 'owner_only', allowed_users: [], allowed_chats: [] });
  });

  it("bare /allow in the owner's DM offers Telegram's user and group pickers, and a pick is allowed", async () => {
    const t = setup();
    await t.send('/allow');
    const keyboard = t.fake.sent()[0]?.payload.reply_markup as { keyboard: { text: string; request_users?: object; request_chat?: object }[][] };
    expect(t.replies()).toEqual(['Who should get access? Pick below, or use /allow <user|group> <id>.']);
    expect(keyboard.keyboard[0]?.map((b) => [b.text, Boolean(b.request_users), Boolean(b.request_chat)])).toEqual([['👤 Pick users', true, false], ['👥 Pick a group', false, true]]);
    expect(keyboard.keyboard[1]?.map((b) => b.text)).toEqual(['✖️ Cancel']);
    await t.send('', { extra: { text: undefined, users_shared: { request_id: 1, users: [{ user_id: 5, first_name: 'Jasur' }, { user_id: 6 }] } } });
    await t.send('', { extra: { text: undefined, chat_shared: { request_id: 2, chat_id: -100777, title: 'Support' } } });
    await t.send('', { from: STRANGER, extra: { text: undefined, users_shared: { request_id: 1, users: [{ user_id: 9 }] } } });
    expect(JSON.parse(readFileSync(t.accessPath, 'utf8'))).toEqual({ policy: 'owner_only', allowed_users: [5, 6], allowed_chats: [-100777] });
    expect(t.replies().slice(1)).toEqual(['Jasur: User 5 added to allowlist.\nUser 6 added to allowlist.', 'Support: Group -100777 added to allowlist.']);
    expect(t.fake.sent()[1]?.payload.reply_markup).toEqual({ remove_keyboard: true });
  });

  it("the picker's cancel button removes the keyboard for the owner; anyone else's same text is a normal message", async () => {
    const t = setup({ policy: 'allowlist', allowed_users: [STRANGER], allowed_chats: [] });
    await t.send('✖️ Cancel');
    expect(t.fake.sent().map((c) => [c.payload.text, c.payload.reply_markup])).toEqual([['Cancelled.', { remove_keyboard: true }]]);
    expect(t.engine.submitted).toEqual([]);
    await t.send('✖️ Cancel', { from: STRANGER });
    expect(t.engine.submitted.map((m) => m.text)).toEqual(['✖️ Cancel']);
  });

  it('/deny removes the id (every copy) and says when it was not there', async () => {
    const t = setup({ policy: 'allowlist', allowed_users: [5, 7, 5], allowed_chats: [-100] });
    await t.send('/deny user 5');
    await t.send('/deny user 5');
    await t.send('/deny group -100');
    expect(t.replies()).toEqual(['User 5 removed from allowlist.', 'User 5 was not in the allowlist.', 'Group -100 removed from allowlist.']);
    expect(JSON.parse(readFileSync(t.accessPath, 'utf8'))).toEqual({ policy: 'allowlist', allowed_users: [7], allowed_chats: [] });
  });

  it('/policy sets one of the three policies, case-sensitively', async () => {
    const t = setup({ policy: 'owner_only', allowed_users: [5], allowed_chats: [] });
    await t.send('/policy');
    await t.send('/policy OPEN');
    await t.send('/policy open now');
    expect(t.replies()).toEqual(['Usage: /policy <owner_only|allowlist|open>', 'Usage: /policy <owner_only|allowlist|open>', 'Policy set to: open']);
    expect(JSON.parse(readFileSync(t.accessPath, 'utf8'))).toEqual({ policy: 'open', allowed_users: [5], allowed_chats: [] });
  });

  it('/access shows the policy, both lists and the owner, re-reading access.json each time', async () => {
    const t = setup();
    await t.send('/access');
    writeFileSync(t.accessPath, JSON.stringify({ policy: 'allowlist', allowed_users: [5, '7'], allowed_chats: [-100] }));
    await t.send('/access anything');
    expect(t.replies()).toEqual([
      `Policy: owner_only\nAllowed users: (none)\nAllowed chats: (none)\nOwner: ${OWNER} (always allowed)`,
      `Policy: allowlist\nAllowed users: 5, 7\nAllowed chats: -100\nOwner: ${OWNER} (always allowed)`,
    ]);
  });
});

describe('command menu', () => {
  it('registers the 11 commands for the owner chat only; a failure is logged, not thrown', async () => {
    const fake = new FakeTelegram();
    const bot = createBot('1:t', { network: fake.transformer, botInfo: fake.botInfo });
    const log = memoryLogger();
    await registerCommandMenu(bot.api, OWNER, log);
    expect(fake.sent('setMyCommands').map((c) => c.payload)).toEqual([
      {
        commands: [
          { command: 'health', description: 'quick health readout' },
          { command: 'audit', description: 'recent failures, backups, memory footprint' },
          { command: 'logs', description: 'tail recent log lines: /logs [N]' },
          { command: 'access', description: 'show access policy' },
          { command: 'allow', description: 'add to allowlist: pick, or /allow <user|group> <id>' },
          { command: 'deny', description: 'remove from allowlist: /deny <user|group> <id>' },
          { command: 'policy', description: 'set policy: /policy <owner_only|allowlist|open>' },
          { command: 'pause', description: 'drop inbound messages until /resume' },
          { command: 'resume', description: 're-enable message forwarding' },
          { command: 'kill', description: 'stop the bot' },
          { command: 'reset_session', description: 'fresh Claude session (history kept)' },
        ],
        scope: { type: 'chat', chat_id: OWNER },
      },
    ]);
    fake.fail('setMyCommands', 400, 'Bad Request: BOT_COMMAND_INVALID');
    await registerCommandMenu(bot.api, OWNER, log);
    expect(log.records.at(-1)).toMatchObject({ level: 'ERROR', msg: 'failed to register owner-scoped bot commands' });
  });
});
