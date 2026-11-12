import { join } from 'node:path';

import type { Api, Context } from 'grammy';
import type { ParseMode } from 'grammy/types';

import type { Config } from '../config.ts';
import type { Db } from '../db/database.ts';
import type { Logger } from '../log/logger.ts';
import { PICKER, PICKER_TEXT } from './commands/access-ui.ts';
import { accessText, allow, deny, setPolicy } from './commands/allowlist.ts';
import { auditText } from './commands/audit.ts';
import { healthText, type TurnState } from './commands/health.ts';
import { logQuotes } from './commands/logs.ts';
import type { CommandHandler } from './dispatcher.ts';

export interface CommandDeps {
  config: Pick<Config, 'ownerIds' | 'accessPath' | 'dataDir' | 'memoriesDir' | 'logDir'>;
  db: Db;
  engine: TurnState & {
    stashRestoreContext(reason: string): void;
    resetSession(): Promise<void>;
  };
  /** The dispatcher's switch: while paused, every inbound message is dropped. */
  pause: { paused: boolean };
  /** `tars.telegram`. */
  log: Logger;
  /** What `/kill` triggers once the owner has been answered: a clean shutdown, exit code 0. */
  kill(): void;
}

type Command = (ctx: Context, args: string[], deps: CommandDeps) => Promise<void>;

const RESET_REPLY =
  'Session cleared — Claude restarted with a fresh context. Chat history and memories are preserved; ' +
  'a short recap of recent messages will be carried into the next turn.';

/** The owner commands, in `/` menu order. */
const COMMANDS: { command: string; description: string; run: Command }[] = [
  { command: 'health', description: 'quick health readout', run: (ctx, _args, d) => reply(ctx, healthText(d.db, d.engine, d.pause.paused), 'Markdown') },
  { command: 'audit', description: 'recent failures, backups, memory footprint', run: (ctx, _args, d) => reply(ctx, auditText(d.db, d.config), 'Markdown') },
  { command: 'logs', description: 'tail recent log lines: /logs [N]', run: (ctx, args, d) => logs(ctx, join(d.config.logDir, 'tars.log'), args) },
  { command: 'access', description: 'show access policy', run: (ctx, _args, d) => reply(ctx, accessText(d.config.accessPath, d.config.ownerIds, d.log)) },
  { command: 'allow', description: 'add to allowlist: pick, or /allow <user|group> <id>', run: (ctx, args, d) => allowCommand(ctx, args, d) },
  { command: 'deny', description: 'remove from allowlist: /deny <user|group> <id>', run: (ctx, args, d) => reply(ctx, deny(d.config.accessPath, args, d.log)) },
  { command: 'policy', description: 'set policy: /policy <owner_only|allowlist|open>', run: (ctx, args, d) => reply(ctx, setPolicy(d.config.accessPath, args, d.log)) },
  { command: 'pause', description: 'drop inbound messages until /resume', run: (ctx, _args, d) => pause(ctx, d) },
  { command: 'resume', description: 're-enable message forwarding', run: (ctx, _args, d) => resume(ctx, d) },
  { command: 'kill', description: 'stop the bot', run: (ctx, _args, d) => kill(ctx, d) },
  { command: 'reset_session', description: 'fresh Claude session (history kept)', run: (ctx, _args, d) => resetSession(ctx, d) },
];

/**
 * The owner commands. Any of these 11 is consumed whoever sends it, wherever
 * (no access gate, no pause, never reaches the model) and only the owner gets
 * an answer; any other `/word` is left to the message pipeline.
 */
export function createCommands(deps: CommandDeps): CommandHandler {
  return async (ctx, { name, args }) => {
    const command = COMMANDS.find((c) => c.command === name);
    if (!command) return false;
    if (deps.config.ownerIds.includes(ctx.from?.id ?? 0)) await command.run(ctx, args, deps);
    return true;
  };
}

/**
 * Show the owner commands in the owner's own chats only (nobody else gets a
 * menu). Run at startup before polling; a failure is logged and startup goes on.
 */
export async function registerCommandMenu(api: Api, ownerIds: readonly number[], log: Logger): Promise<void> {
  const commands = COMMANDS.map(({ command, description }) => ({ command, description }));
  for (const chatId of ownerIds) {
    try {
      await api.setMyCommands(commands, { scope: { type: 'chat', chat_id: chatId } });
    } catch (err) {
      log.error(`failed to register owner-scoped bot commands for ${chatId}`, { err });
    }
  }
}

/** Bare `/allow` in the owner's DM offers Telegram's user and group pickers; with arguments it adds by id. */
async function allowCommand(ctx: Context, args: string[], deps: CommandDeps): Promise<void> {
  if (args.length || ctx.chat?.type !== 'private') return reply(ctx, allow(deps.config.accessPath, args, deps.log));
  await ctx.reply(PICKER_TEXT, { reply_markup: PICKER });
}

async function kill(ctx: Context, deps: CommandDeps): Promise<void> {
  deps.log.warn('/kill received from owner; shutting down');
  // Best effort: a goodbye that fails to send must not keep the bot running.
  await reply(ctx, 'Shutting down…').catch(() => undefined);
  deps.kill();
}

async function resetSession(ctx: Context, deps: CommandDeps): Promise<void> {
  deps.log.warn('/reset_session received from owner; respawning cc with a fresh session');
  deps.engine.stashRestoreContext('owner-reset');
  await deps.engine.resetSession();
  // The reset is done; an acknowledgement that fails to send must not read as a failed reset.
  await reply(ctx, RESET_REPLY).catch(() => undefined);
}

async function pause(ctx: Context, deps: CommandDeps): Promise<void> {
  deps.pause.paused = true;
  deps.log.warn('/pause received from owner; dropping inbound messages');
  await reply(ctx, '⏸ paused — messages dropped until /resume');
}

async function resume(ctx: Context, deps: CommandDeps): Promise<void> {
  deps.pause.paused = false;
  deps.log.warn('/resume received from owner; forwarding inbound messages');
  await reply(ctx, '▶ resumed');
}

async function logs(ctx: Context, path: string, args: string[]): Promise<void> {
  const quotes = logQuotes(path, args);
  if (!quotes.length) return reply(ctx, 'no logs yet');
  for (const quote of quotes) await reply(ctx, quote, 'HTML');
}

/**
 * Answer in the command's chat: quoting the command in groups (not in DMs),
 * inside its forum topic.
 */
async function reply(ctx: Context, text: string, parseMode?: ParseMode): Promise<void> {
  const msg = ctx.msg;
  const quote = msg && msg.chat.type !== 'private' ? { reply_parameters: { message_id: msg.message_id } } : {};
  await ctx.reply(text, parseMode ? { ...quote, parse_mode: parseMode } : quote);
}
