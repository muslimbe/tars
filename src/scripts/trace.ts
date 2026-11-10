// Replay or follow the bot's Claude Code session as a readable transcript of
// each turn ("what was it thinking when it replied X?"). Claude Code keeps
// every session as JSONL in ~/.claude/projects/<cwd slug>/<session id>.jsonl;
// this only reads it, so it is safe to run next to the live bot.
//
//   node src/scripts/trace.ts [--session ID] [--follow] [--max N] [--list] [--latest]
//
// Environment: CLAUDE_PROJECT_DIR overrides the sessions directory;
// TARS_DATA_DIR (default ./data) locates data/session_id. No .env loading.

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { cpSlice } from '../text/clip.ts';
import { asText, isRecord } from '../text/json.ts';

type Json = Record<string, unknown>;
type Renderer = (event: Json, ts: string, max: number) => string[];

interface Options {
  session: string | undefined;
  follow: boolean;
  max: number;
  list: boolean;
  latest: boolean;
}

/** The sessions directory and the tars data directory. */
interface Where {
  sessions: string;
  data: string;
}

const HELP = `Usage: npm run trace -- [options]

Replay or follow the bot's Claude Code session. By default it picks the bot's
session via data/session_id, not the newest file (which may be your own Claude
Code session in the same directory).

Options:
  -s, --session ID  a specific session id (overrides --latest and the bot session finder)
  -f, --follow      keep printing new events, like tail -f
      --max N       cut long text blocks to N characters (0 = no limit)
  -l, --list        list the session files and exit
      --latest      use the newest session file, whoever it belongs to
  -h, --help        show this help`;

const noBotSession = (dataDir: string) => `could not identify the bot's session. Try one of:
  --session <id>          to specify it explicitly
  --list                  to see all available sessions
  --latest                to use the most recent file regardless
  data/session_id under ${dataDir} is empty/missing.`;

/** Event types with a rendering; bookkeeping (`queue-operation`, `summary`, `system`) and unknown types print nothing. */
const RENDERERS = new Map<string, Renderer>([
  ['user', renderUser],
  ['assistant', renderAssistant],
  ['result', renderResult],
]);

process.exitCode = await main(process.argv.slice(2), process.env);

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const opts = parseCli(argv);
  if (typeof opts === 'number') return opts;
  const where = { sessions: sessionsDir(env.CLAUDE_PROJECT_DIR), data: realPath(env.TARS_DATA_DIR || './data') };
  if (opts.list) return list(where);
  const path = pickSession(opts, where);
  if (!path) return 1;
  if (opts.follow) await follow(path, opts.max);
  else replay(path, opts.max);
  return 0;
}

/** The options, or the exit code once `--help` or a usage error has been printed. */
function parseCli(argv: string[]): Options | number {
  let values;
  try {
    const options = {
      session: { type: 'string', short: 's' },
      follow: { type: 'boolean', short: 'f' },
      max: { type: 'string' },
      list: { type: 'boolean', short: 'l' },
      latest: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    } as const;
    values = parseArgs({ args: argv, options }).values;
  } catch (err) {
    return usageError((err as Error).message);
  }
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const max = Number(values.max ?? 0);
  if (!Number.isInteger(max)) return usageError(`--max must be a whole number, got ${JSON.stringify(values.max)}`);
  return { session: values.session, follow: values.follow === true, max, list: values.list === true, latest: values.latest === true };
}

function usageError(message: string): number {
  console.error(`trace: ${message}\nRun with --help for the options.`);
  return 2;
}

/**
 * Claude Code's directory for the bot's sessions: `~/.claude/projects/` plus
 * its working directory (`projects/` under the repo root, where trace runs)
 * with every non-alphanumeric UTF-16 unit turned into `-` (an emoji becomes
 * two dashes, as Claude Code writes it).
 */
function sessionsDir(override: string | undefined): string {
  if (override) return realPath(override.replace(/^~(?=$|\/)/, homedir()));
  return join(homedir(), '.claude', 'projects', realPath('projects').replace(/[^A-Za-z0-9]/g, '-'));
}

/** Absolute, with symlinks resolved as far as the path exists. */
function realPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(realPath(parent), basename(absolute));
}

/** Which file to show: `--session`, else `--latest`, else the bot's; the reason goes to stderr when there is none. */
function pickSession(opts: Options, where: Where): string | undefined {
  if (opts.session) {
    const path = resolve(where.sessions, `${opts.session}.jsonl`);
    if (existsSync(path)) return path;
    console.error(`no session file for id ${opts.session} under ${where.sessions}`);
    return undefined;
  }
  if (opts.latest) {
    const latest = existsSync(where.sessions) ? sessionFiles(where.sessions)[0] : undefined;
    if (!latest) console.error(`no session files under ${where.sessions}`);
    return latest;
  }
  const bot = findBotSession(where);
  if (!bot) console.error(noBotSession(where.data));
  return bot;
}

/**
 * The bot's session — not simply the newest file, which may be the operator's
 * own Claude Code session in the same directory: the one `data/session_id`
 * names when its file exists, else the newest that opens with a Telegram batch.
 */
function findBotSession(where: Where): string | undefined {
  if (!existsSync(where.sessions)) return undefined;
  const idFile = join(where.data, 'session_id');
  const id = existsSync(idFile) ? readFileSync(idFile, 'utf8').trim() : '';
  const named = resolve(where.sessions, `${id}.jsonl`);
  if (id && existsSync(named)) return named;
  return sessionFiles(where.sessions).find(looksLikeBotSession);
}

/** The bot's first user text is an engine envelope, `<msg …>`; user events without text (tool results) don't decide. */
function looksLikeBotSession(path: string): boolean {
  let lines: string[];
  try {
    lines = readFileSync(path, 'utf8').split('\n');
  } catch {
    return false; // unreadable, e.g. a directory named *.jsonl
  }
  for (const line of lines) {
    const event = parse(line);
    const text = event?.type === 'user' ? contentBlocks(event).find((block) => block.type === 'text') : undefined;
    if (text) return asText(text.text ?? '').trimStart().startsWith('<msg ');
  }
  return false;
}

/** The `*.jsonl` files in `dir`, newest first. */
function sessionFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => ({ path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((file) => file.path);
}

/** `--list`: every session file, newest first, the bot's marked. */
function list(where: Where): number {
  if (!existsSync(where.sessions)) {
    console.log(`no session dir at ${where.sessions}`);
    return 1;
  }
  const bot = findBotSession(where);
  const botStem = bot && basename(bot, '.jsonl');
  for (const path of sessionFiles(where.sessions)) {
    const { mtime, size } = statSync(path);
    const stem = basename(path, '.jsonl');
    console.log(`${localMinute(mtime)}  ${String(Math.floor(size / 1024)).padStart(6)} KB  ${stem}${stem === botStem ? '  ← bot' : ''}`);
  }
  return 0;
}

function localMinute(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function replay(path: string, max: number): void {
  console.log(`# session: ${basename(path)}`);
  console.log(`# file:    ${path}`);
  console.log(`# size:    ${statSync(path).size} bytes`);
  console.log('');
  printEvents(readFileSync(path, 'utf8'), max);
}

/** Print what is there, then poll every 0.5 s for appended events until Ctrl+C. */
async function follow(path: string, max: number): Promise<void> {
  console.log(`# following: ${basename(path)} (Ctrl+C to stop)`);
  console.log('');
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  const fd = openSync(path, 'r');
  let offset = 0;
  let pending = Buffer.alloc(0);
  try {
    while (!stop.signal.aborted) {
      const appended = readFrom(fd, offset);
      offset += appended.length;
      const data = Buffer.concat([pending, appended]);
      // Only complete lines: an event caught mid-write waits for its newline.
      const end = data.lastIndexOf(0x0a) + 1;
      printEvents(data.subarray(0, end).toString('utf8'), max);
      pending = data.subarray(end);
      await sleep(500, undefined, { signal: stop.signal }).catch(() => undefined); // Ctrl+C ends the wait
    }
  } finally {
    closeSync(fd);
  }
  console.log('');
  console.log('# stopped following');
}

/** The bytes appended to `fd` past `offset`. */
function readFrom(fd: number, offset: number): Buffer {
  const appended = Buffer.alloc(Math.max(0, fstatSync(fd).size - offset));
  return appended.subarray(0, readSync(fd, appended, 0, appended.length, offset));
}

/** Render each JSONL line; lines that are not JSON objects print nothing. */
function printEvents(text: string, max: number): void {
  for (const line of text.split('\n')) {
    const event = parse(line);
    if (event) for (const out of renderEvent(event, max)) console.log(out);
  }
}

function renderEvent(event: Json, max: number): string[] {
  const render = typeof event.type === 'string' ? RENDERERS.get(event.type) : undefined;
  if (!render) return [];
  const timestamp = event.timestamp;
  return render(event, (typeof timestamp === 'string' ? timestamp : '').slice(0, 19).replaceAll('T', ' '), max);
}

function renderUser(event: Json, ts: string, max: number): string[] {
  return contentBlocks(event).flatMap((block) => {
    if (block.type === 'text') return renderUserText(asText(block.text ?? ''), ts, max);
    if (block.type === 'tool_result') return [renderToolResult(block, ts, max)];
    return [];
  });
}

/** A Telegram batch (one line per envelope line), an engine correction, or plain text. */
function renderUserText(text: string, ts: string, max: number): string[] {
  if (text.startsWith('<msg ')) return [`${ts}  ← user (telegram batch)`, ...text.split('\n').map((line) => `             ${trunc(line, max)}`)];
  if (text.startsWith('<error>')) return [`${ts}  ← engine correction: ${trunc(text, max)}`];
  return [`${ts}  ← user: ${trunc(text, max)}`];
}

function renderToolResult(block: Json, ts: string, max: number): string {
  const mark = block.is_error ? '✗' : '✓';
  return `${ts}  ← tool_result ${mark} id=${short(block.tool_use_id ?? '')}: ${trunc(toolResultText(block.content), max)}`;
}

/** A tool result's content: a string, or text blocks joined by spaces. */
function toolResultText(content: unknown): string {
  if (Array.isArray(content)) return content.map((part) => asText(isRecord(part) ? (part.text ?? '') : part)).join(' ');
  if (content === undefined || content === null) return '';
  return asText(content);
}

function renderAssistant(event: Json, ts: string, max: number): string[] {
  return contentBlocks(event).flatMap((block) => {
    if (block.type === 'text') return block.text ? [`${ts}  → assistant text: ${trunc(asText(block.text), max)}`] : [];
    if (block.type === 'thinking') return [`${ts}  → thinking: ${trunc(asText(block.thinking ?? ''), max)}`];
    if (block.type === 'tool_use') return [renderToolUse(block, ts, max)];
    return [];
  });
}

function renderToolUse(block: Json, ts: string, max: number): string {
  const input = JSON.stringify(block.input ?? {});
  return `${ts}  → tool_use: ${asText(block.name ?? '?')}(${trunc(input, max)}) id=${short(block.id ?? '')}`;
}

/** The turn's final result — the `{action, reason}` control JSON when it decodes to one — then a blank line. */
function renderResult(event: Json, ts: string, max: number): string[] {
  const result = decoded(event.result);
  const line = isRecord(result)
    ? `${ts}  ✦ turn done: action=${asText(result.action ?? '?')} reason=${trunc(asText(result.reason ?? ''), max)}`
    : `${ts}  ✦ turn done: ${trunc(asText(result), max)}`;
  return [line, ''];
}

function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** `max` characters (code points) and how many were cut; `max <= 0` keeps everything. */
function trunc(text: string, max: number): string {
  if (max <= 0) return text;
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max).join('')}…[+${points.length - max}]`;
}

/** The first 8 characters of an id. */
function short(id: unknown): string {
  return cpSlice(asText(id), 8).text;
}

/** One JSONL line as an object; undefined for anything else. */
function parse(line: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The object blocks of `event.message.content` (anything else there is skipped). */
function contentBlocks(event: Json): Json[] {
  const message = event.message;
  const content = isRecord(message) ? message.content : undefined;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}
