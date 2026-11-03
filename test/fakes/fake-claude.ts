#!/usr/bin/env node
// A stand-in for the `claude` CLI, selected through CLAUDE_CODE_BIN. It speaks
// the stream-json protocol on stdin/stdout, connects to the tars MCP server
// named in --mcp-config as a real MCP client, and plays the scenario that
// `#fake <command> <args>` lines inside each user message ask for:
//
//   tool <name> <json>  call any tars tool
//   text <text>         an assistant text block (never delivered by itself)
//   control <json>      end with this raw StructuredOutput input
//   tool-errors <n>     n failing tool calls
//   api-error <text>    end with an is_error result
//   stderr <text>       write a stderr line
//   raw <line>          write <line> to stdout as is
//   late <line>         write <line> to stdout right after the turn's result
//   sleep <ms>          pause (lets the harness inject a message mid-turn)
//   hang | crash        never finish the turn | exit(3) mid-turn
//
// A message with no directives is answered with `echo: <text>`. Env knobs:
// FAKE_CLAUDE_LOG (JSONL record of argv, stdin and tool calls; FAKE_CLAUDE_PROBE is
// recorded with the argv to prove the environment is inherited, and so is the cwd),
// FAKE_CLAUDE_STALE (reject any --resume id), FAKE_CLAUDE_MCP_FAIL
// (report the tars server as failed). The silent-stop nudge is answered with skip.
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const resumeId = flag('--resume');
const sessionId = resumeId ?? randomUUID();
const record = (entry: Record<string, unknown>) => {
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};
const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ...event, session_id: sessionId })}\n`);

record({ kind: 'argv', argv, probe: process.env.FAKE_CLAUDE_PROBE, cwd: process.cwd() });
if (resumeId && process.env.FAKE_CLAUDE_STALE) {
  // Like the real CLI, it takes a moment to reject the id, never reading the turn written to it meanwhile.
  await sleep(300);
  process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
  process.exit(1);
}

let client: Client | undefined;
async function mcp(): Promise<Client> {
  if (client) return client;
  const config = JSON.parse(readFileSync(flag('--mcp-config') ?? '', 'utf8')) as { mcpServers: { tars: { url: string } } };
  const next = new Client({ name: 'fake-claude', version: '1.0.0' });
  await next.connect(new StreamableHTTPClientTransport(new URL(config.mcpServers.tars.url)));
  client = next;
  return next;
}

interface Envelope {
  text: string;
  chatId?: number;
  messageId?: number;
  topic?: number;
}

/** The first `<msg>` (or `<reminder>`) of a user message: where replies go. */
function envelopeOf(text: string): Envelope {
  const msg = /<msg ([^>]*)>\n([\s\S]*?)\n<\/msg>/.exec(text);
  if (msg) {
    const attrs: Record<string, string> = Object.fromEntries([...(msg[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1] ?? '', m[2] ?? '']));
    const topic = attrs.topic === undefined ? undefined : Number(attrs.topic);
    return { messageId: Number(attrs.id), chatId: Number(attrs.chat), topic, text: msg[2] ?? '' };
  }
  const reminder = /<reminder id="\d+" chat_id="(-?\d+)"[^>]*>([\s\S]*?)<\/reminder>/.exec(text);
  if (reminder) return { chatId: Number(reminder[1]), text: reminder[2] ?? '' };
  return { text };
}

let toolSeq = 0;
async function callTool(name: string, args: Record<string, unknown>): Promise<boolean> {
  const id = `toolu_fake${String(++toolSeq).padStart(4, '0')}`;
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: `mcp__tars__${name}`, input: args }] } });
  let isError = true;
  let content: unknown;
  try {
    const result = await (await mcp()).callTool({ name, arguments: args });
    isError = Boolean(result.isError);
    content = result.content;
  } catch (err) {
    content = [{ type: 'text', text: String(err) }];
  }
  record({ kind: 'tool', name, args, isError, content });
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
  return !isError;
}

interface TurnState {
  action: Record<string, unknown> | undefined;
  apiError: string | undefined;
  lastChat: number | undefined;
  late: string[];
}

/** Run one message's directives; returns false when the turn must not end (hang). */
async function play(message: string, state: TurnState): Promise<boolean> {
  const env = envelopeOf(message);
  if (env.chatId !== undefined) state.lastChat = env.chatId;
  const directives = message.split('\n').flatMap((line) => {
    const m = /^#fake (\S+) ?(.*)$/.exec(line.trim());
    return m ? [[m[1] ?? '', m[2] ?? ''] as const] : [];
  });
  if (message.includes('You returned action "stop" but sent nothing')) {
    state.action = { action: 'skip', reason: 'nudged' };
    return true;
  }
  if (message.includes('Continue the task you just reported on')) {
    if (state.lastChat !== undefined) await callTool('telegram_send_message', { chat_id: state.lastChat, text: 'done' });
    state.action = { action: 'stop', reason: 'finished' };
    return true;
  }
  if (!directives.length) return defaultReply(env, state);
  for (const [cmd, arg] of directives) if (!(await directive(cmd, arg, state))) return false;
  return true;
}

async function defaultReply(env: Envelope, state: TurnState): Promise<boolean> {
  if (env.chatId === undefined) {
    state.action = { action: 'stop', reason: 'nothing to do' };
    return true;
  }
  const args = env.messageId === undefined
    ? { chat_id: env.chatId, text: `echo: ${env.text}` }
    : { chat_id: env.chatId, reply_to_message_id: env.messageId, text: `echo: ${env.text}` };
  await callTool(env.messageId === undefined ? 'telegram_send_message' : 'telegram_reply_to_message', args);
  state.action = { action: 'stop', reason: 'replied' };
  return true;
}

async function directive(cmd: string, arg: string, state: TurnState): Promise<boolean> {
  switch (cmd) {
    case 'tool': {
      const [name = '', ...json] = arg.split(' ');
      await callTool(name, JSON.parse(json.join(' ') || '{}') as Record<string, unknown>);
      state.action ??= { action: 'stop', reason: 'tool called' };
      return true;
    }
    case 'text':
      emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: arg }] } });
      state.action = { action: 'stop', reason: 'wrote text' };
      return true;
    case 'control':
      state.action = JSON.parse(arg) as Record<string, unknown>;
      return true;
    case 'tool-errors':
      for (let i = 0; i < Number(arg); i++) await callTool('memory_read', { path: '../outside' });
      return true;
    case 'api-error':
      state.apiError = arg;
      return true;
    case 'stderr':
      process.stderr.write(`${arg}\n`);
      return true;
    case 'raw':
      process.stdout.write(`${arg}\n`);
      return true;
    case 'late':
      state.late.push(arg);
      return true;
    case 'sleep':
      await sleep(Number(arg));
      return true;
    case 'hang':
      return false;
    case 'crash':
      process.exit(3);
  }
  throw new Error(`unknown #fake directive: ${cmd}`);
}

const inbox: string[] = [];
let wake: (() => void) | undefined;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  record({ kind: 'stdin', line });
  const parsed = JSON.parse(line) as { message: { content: { text: string }[] } };
  inbox.push(parsed.message.content.map((part) => part.text).join(''));
  wake?.();
});
lines.on('close', () => process.exit(0));

async function nextMessage(): Promise<string> {
  while (!inbox.length) await new Promise<void>((resolve) => (wake = resolve));
  return inbox.shift() as string;
}

async function mcpStatus(): Promise<string> {
  if (process.env.FAKE_CLAUDE_MCP_FAIL) return 'failed';
  return mcp().then(
    () => 'connected',
    () => 'failed',
  );
}

/** One Claude Code turn per stdin message; messages arriving mid-turn are folded into it. */
async function main(): Promise<void> {
  for (;;) {
    const first = await nextMessage();
    emit({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'tars', status: await mcpStatus() }], model: flag('--model') });
    const state: TurnState = { action: undefined, apiError: undefined, lastChat: undefined, late: [] };
    let message: string | undefined = first;
    while (message !== undefined) {
      if (!(await play(message, state))) await new Promise(() => {});
      message = inbox.shift();
    }
    if (state.action) {
      emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_so${++toolSeq}`, name: 'StructuredOutput', input: state.action }] } });
    }
    emit({ type: 'result', subtype: 'success', is_error: Boolean(state.apiError), result: state.apiError ?? '', total_cost_usd: 0 });
    for (const line of state.late) process.stdout.write(`${line}\n`);
  }
}

void main();
