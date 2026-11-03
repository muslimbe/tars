import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { tempDir } from '../helpers/tmp.ts';
import { until } from '../helpers/wait.ts';

const TRACE = fileURLToPath(new URL('../../src/scripts/trace.ts', import.meta.url));

/** The inherited environment minus the variables the script reads, plus `extra`. */
function envWith(extra: Record<string, string>): NodeJS.ProcessEnv {
  const { CLAUDE_PROJECT_DIR: _dir, TARS_DATA_DIR: _data, ...rest } = process.env;
  return { ...rest, ...extra };
}

/** A sessions directory and a data directory, and a way to run the script against them. */
function fixture() {
  const root = tempDir();
  const sessions = join(root, 'projects');
  const data = join(root, 'data');
  mkdirSync(sessions);
  mkdirSync(data);
  const env = envWith({ CLAUDE_PROJECT_DIR: sessions, TARS_DATA_DIR: data });
  /** A session file; strings are written as raw lines, anything else as JSON. */
  const write = (name: string, events: unknown[], mtime?: Date) => {
    const path = join(sessions, `${name}.jsonl`);
    writeFileSync(path, `${events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n')}\n`);
    if (mtime) utimesSync(path, mtime, mtime);
    return path;
  };
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [TRACE, ...args], { env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  return { root, sessions: realpathSync(sessions), data: realpathSync(data), env, write, run };
}

const userText = (text: string, timestamp = '2026-06-25T10:00:00Z') => ({ type: 'user', timestamp, message: { role: 'user', content: [{ type: 'text', text }] } });
const BOT = userText('<msg id="1" chat="-100" user="42" name="A" time="10:00">hi</msg>');
const OPERATOR = userText('fix the bug in main.py');
const OLD = new Date(2026, 5, 25, 9, 0);
const NEW = new Date(2026, 5, 25, 10, 31);

const notFound = (data: string) =>
  "could not identify the bot's session. Try one of:\n" +
  '  --session <id>          to specify it explicitly\n' +
  '  --list                  to see all available sessions\n' +
  '  --latest                to use the most recent file regardless\n' +
  `  data/session_id under ${data} is empty/missing.\n`;

describe('choosing the bot session', () => {
  it('prefers the file data/session_id names, even when another one is newer', () => {
    const f = fixture();
    f.write('abc-bot', [BOT], OLD);
    f.write('xyz-operator', [OPERATOR], NEW);
    writeFileSync(join(f.data, 'session_id'), 'abc-bot\n');
    expect(f.run().out).toMatch(/^# session: abc-bot\.jsonl\n/);
  });

  it('otherwise takes the newest file that opens with a Telegram batch', () => {
    const f = fixture();
    f.write('bot', [userText('  <msg id="1">indented</msg>')], OLD);
    f.write('operator', [OPERATOR], NEW);
    expect(f.run().out).toMatch(/^# session: bot\.jsonl\n/);
  });

  it('falls back to the fingerprint when data/session_id names a file that is gone', () => {
    const f = fixture();
    writeFileSync(join(f.data, 'session_id'), 'vanished-sid\n');
    f.write('real-bot', [BOT]);
    expect(f.run().out).toMatch(/^# session: real-bot\.jsonl\n/);
  });

  it('skips user events without text and judges by the first text', () => {
    const f = fixture();
    const toolResult = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } };
    f.write('weird', ['not json', { type: 'assistant', message: { content: [] } }, toolResult, BOT], OLD);
    f.write('human', [userText('debug the test'), BOT], NEW);
    expect(f.run().out).toMatch(/^# session: weird\.jsonl\n/);
  });

  it('gives up with a hint instead of guessing when no file is the bot\'s', () => {
    const f = fixture();
    f.write('operator', [OPERATOR]);
    expect(f.run()).toEqual({ code: 1, out: '', err: notFound(f.data) });
  });

  it('reports a missing sessions directory', () => {
    const f = fixture();
    const missing = join(f.sessions, 'nowhere');
    const run = (...args: string[]) => spawnSync(process.execPath, [TRACE, ...args], { env: { ...f.env, CLAUDE_PROJECT_DIR: missing }, encoding: 'utf8' });
    expect(run()).toMatchObject({ status: 1, stdout: '', stderr: notFound(f.data) });
    expect(run('--list')).toMatchObject({ status: 1, stdout: `no session dir at ${missing}\n` });
  });

  it('--session and --latest pick a file directly, and say when they cannot', () => {
    const f = fixture();
    f.write('bot', [BOT], OLD);
    f.write('operator', [OPERATOR], NEW);
    expect(f.run('--latest').out).toMatch(/^# session: operator\.jsonl\n/);
    expect(f.run('-s', 'bot', '--latest').out).toMatch(/^# session: bot\.jsonl\n/);
    expect(f.run('--session', 'nope')).toEqual({ code: 1, out: '', err: `no session file for id nope under ${f.sessions}\n` });
    const empty = fixture();
    expect(empty.run('--latest')).toEqual({ code: 1, out: '', err: `no session files under ${empty.sessions}\n` });
  });

  it('finds Claude Code\'s directory for the bot\'s working directory, projects/, an emoji counting as two characters', () => {
    const root = tempDir();
    const cwd = join(root, 'my bot😀');
    mkdirSync(cwd);
    const home = join(root, 'home');
    const sessions = join(home, '.claude', 'projects', `${realpathSync(root).replace(/[^A-Za-z0-9]/g, '-')}-my-bot---projects`);
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'sid.jsonl'), `${JSON.stringify(BOT)}\n`);
    const result = spawnSync(process.execPath, [TRACE, '--latest'], { cwd, env: envWith({ HOME: home }), encoding: 'utf8' });
    expect(result.stdout).toContain(`# file:    ${join(sessions, 'sid.jsonl')}\n`);
  });
});

describe('--list', () => {
  it('lists the session files newest first, sizes in KB, the bot marked', () => {
    const f = fixture();
    f.write('bot', [BOT, { type: 'summary', summary: 'x'.repeat(3000) }], OLD);
    f.write('operator', [OPERATOR], NEW);
    writeFileSync(join(f.sessions, 'notes.txt'), 'not a session');
    expect(f.run('--list', '--session', 'operator')).toEqual({
      code: 0,
      out: '2026-06-25 10:31       0 KB  operator\n2026-06-25 09:00       3 KB  bot  ← bot\n',
      err: '',
    });
  });
});

// A session with every kind of event, and how the script renders it.
const at = (second: number) => `2026-06-25T10:31:0${second}.123Z`;
const CORPUS = [
  { type: 'queue-operation', operation: 'enqueue', timestamp: at(0) },
  { type: 'system', subtype: 'init', timestamp: at(0) },
  userText('<msg id="7" chat="42" user="42" name="Ann" time="10:31">hi\nthere</msg>', at(1)),
  {
    type: 'assistant',
    timestamp: at(2),
    message: {
      content: [
        { type: 'thinking', thinking: 'plan the reply' },
        { type: 'text', text: '' },
        { type: 'tool_use', id: 'toolu_0123456789', name: 'mcp__tars__telegram_send_message', input: { chat_id: 42, text: 'héllo 😀' } },
      ],
    },
  },
  { type: 'user', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_0123456789', content: [{ type: 'text', text: 'sent' }, { type: 'text', text: 'message_id=43' }] }] } },
  { type: 'user', timestamp: at(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', is_error: true, content: 'Error executing tool x: boom' }] } },
  { type: 'assistant', timestamp: at(5), message: { content: [{ type: 'text', text: 'stray text' }] } },
  userText('<error>You replied with plain text.</error>', at(6)),
  userText('just a note', at(7)),
  { type: 'result', timestamp: at(8), result: '{"action":"stop","reason":"Answered the question"}' },
  { type: 'result', timestamp: at(9), result: 'not json' },
  'not json at all',
  { type: 'summary', summary: 'x' },
];
const RENDERED = [
  '2026-06-25 10:31:01  ← user (telegram batch)',
  '             <msg id="7" chat="42" user="42" name="Ann" time="10:31">hi',
  '             there</msg>',
  '2026-06-25 10:31:02  → thinking: plan the reply',
  '2026-06-25 10:31:02  → tool_use: mcp__tars__telegram_send_message({"chat_id":42,"text":"héllo 😀"}) id=toolu_01',
  '2026-06-25 10:31:03  ← tool_result ✓ id=toolu_01: sent message_id=43',
  '2026-06-25 10:31:04  ← tool_result ✗ id=toolu_9: Error executing tool x: boom',
  '2026-06-25 10:31:05  → assistant text: stray text',
  '2026-06-25 10:31:06  ← engine correction: <error>You replied with plain text.</error>',
  '2026-06-25 10:31:07  ← user: just a note',
  '2026-06-25 10:31:08  ✦ turn done: action=stop reason=Answered the question',
  '',
  '2026-06-25 10:31:09  ✦ turn done: not json',
  '',
];
const RENDERED_MAX_12 = [
  '2026-06-25 10:31:01  ← user (telegram batch)',
  '             <msg id="7" …[+46]',
  '             there</msg>',
  '2026-06-25 10:31:02  → thinking: plan the rep…[+2]',
  '2026-06-25 10:31:02  → tool_use: mcp__tars__telegram_send_message({"chat_id":4…[+19]) id=toolu_01',
  '2026-06-25 10:31:03  ← tool_result ✓ id=toolu_01: sent message…[+6]',
  '2026-06-25 10:31:04  ← tool_result ✗ id=toolu_9: Error execut…[+16]',
  '2026-06-25 10:31:05  → assistant text: stray text',
  '2026-06-25 10:31:06  ← engine correction: <error>You r…[+31]',
  '2026-06-25 10:31:07  ← user: just a note',
  '2026-06-25 10:31:08  ✦ turn done: action=stop reason=Answered the…[+9]',
  '',
  '2026-06-25 10:31:09  ✦ turn done: not json',
  '',
];

describe('rendering', () => {
  it('replays a session as a readable transcript', () => {
    const f = fixture();
    const path = f.write('s', CORPUS);
    const header = `# session: s.jsonl\n# file:    ${join(f.sessions, 's.jsonl')}\n# size:    ${statSync(path).size} bytes\n\n`;
    expect(f.run('--session', 's')).toEqual({ code: 0, out: `${header}${RENDERED.join('\n')}\n`, err: '' });
  });

  it('--max cuts long text to N characters and counts what was cut', () => {
    const f = fixture();
    f.write('s', CORPUS);
    expect(f.run('--session', 's', '--max', '12').out.split('\n').slice(4).join('\n')).toBe(`${RENDERED_MAX_12.join('\n')}\n`);
  });

  it('--help lists the options; a bad command line exits 2 with a hint', () => {
    const f = fixture();
    const help = f.run('--help');
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/^Usage: npm run trace -- \[options\]\n[^]*\n {6}--latest {6}use the newest session file, whoever it belongs to\n/);
    expect(f.run('--max', 'abc')).toEqual({ code: 2, out: '', err: 'trace: --max must be a whole number, got "abc"\nRun with --help for the options.\n' });
    const bogus = f.run('--bogus');
    expect(bogus).toMatchObject({ code: 2, out: '' });
    expect(bogus.err).toMatch(/^trace: .*--bogus.*\nRun with --help for the options\.\n$/);
  });
});

describe('--follow', () => {
  it('prints what is there, then each appended event once complete, until Ctrl+C', async () => {
    const f = fixture();
    const path = f.write('live', [userText('<msg id="1">hi</msg>', at(1))]);
    const child = spawn(process.execPath, [TRACE, '--session', 'live', '--follow'], { env: f.env });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    await until(() => out.includes('<msg id="1">hi</msg>'), 10_000);
    const second = JSON.stringify(userText('second', at(2)));
    appendFileSync(path, second.slice(0, 25));
    await sleep(1200); // a poll or two see only half of the event
    appendFileSync(path, `${second.slice(25)}\nnot json\n${JSON.stringify(userText('third', at(3)))}\n`);
    await until(() => out.includes('third'), 10_000);
    child.kill('SIGINT');
    expect(await exited).toBe(0);
    expect(out).toBe(
      [
        '# following: live.jsonl (Ctrl+C to stop)',
        '',
        '2026-06-25 10:31:01  ← user (telegram batch)',
        '             <msg id="1">hi</msg>',
        '2026-06-25 10:31:02  ← user: second',
        '2026-06-25 10:31:03  ← user: third',
        '',
        '# stopped following',
        '',
      ].join('\n'),
    );
  });
});
