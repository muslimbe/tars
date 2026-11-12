import type { Api, Context } from 'grammy';
import type { InlineKeyboardMarkup, Message, ReplyKeyboardMarkup } from 'grammy/types';

import type { Config } from '../../config.ts';
import type { Logger } from '../../log/logger.ts';
import type { ChatMessage } from '../../message.ts';
import { clip } from '../../text/clip.ts';
import { allow } from './allowlist.ts';

// Access management without ids: `/allow` offers Telegram's own user and
// group pickers, and the first blocked message from a chat reaches the owner
// with buttons to allow or ignore it.

const PICK_USERS = 1;
const PICK_GROUP = 2;

/** Sent as plain text by the keyboard's cancel button; the dispatcher stops it for the owner. */
export const PICKER_CANCEL = '✖️ Cancel';

/** The `/allow` keyboard. Telegram shows these pickers in private chats only. */
export const PICKER: ReplyKeyboardMarkup = {
  keyboard: [
    [
      { text: '👤 Pick users', request_users: { request_id: PICK_USERS, user_is_bot: false, max_quantity: 10, request_name: true } },
      { text: '👥 Pick a group', request_chat: { request_id: PICK_GROUP, chat_is_channel: false, request_title: true } },
    ],
    [{ text: PICKER_CANCEL }],
  ],
  one_time_keyboard: true,
  resize_keyboard: true,
};

export const PICKER_TEXT = 'Who should get access? Pick below, or use /allow <user|group> <id>.';

export interface AccessUi {
  /** The owner picked users or a group on the `/allow` keyboard (a `users_shared` / `chat_shared` message). */
  picked(ctx: Context): Promise<void>;
  /** The owner pressed the keyboard's cancel button: remove the keyboard. Anyone else's identical text goes on (`next`). */
  cancelled(ctx: Context, next: () => Promise<void>): Promise<void>;
  /** A button on a blocked-chat notice was pressed. */
  pressed(ctx: Context): Promise<void>;
  /** The first blocked message from a chat: tell the owner, with buttons. */
  blocked(msg: ChatMessage, chat: { type: string; title?: string | undefined }): Promise<void>;
}

export interface AccessUiDeps {
  api: Api;
  config: Pick<Config, 'ownerId' | 'ownerIds' | 'accessPath'>;
  log: Logger;
}

export function createAccessUi({ api, config, log }: AccessUiDeps): AccessUi {
  const isOwner = (ctx: Context) => config.ownerIds.includes(ctx.from?.id ?? 0);
  return {
    async picked(ctx) {
      if (!isOwner(ctx) || !ctx.msg) return;
      const lines = picks(ctx.msg).map((p) => `${p.name ? `${p.name}: ` : ''}${allow(config.accessPath, [p.kind, String(p.id)], log)}`);
      await ctx.reply(lines.join('\n'), { reply_markup: { remove_keyboard: true } });
    },
    async cancelled(ctx, next) {
      if (!isOwner(ctx)) return next();
      await ctx.reply('Cancelled.', { reply_markup: { remove_keyboard: true } });
    },
    async pressed(ctx) {
      const query = ctx.callbackQuery;
      if (!query || !isOwner(ctx)) return void (await ctx.answerCallbackQuery());
      const outcome = press(query.data ?? '', config.accessPath, log);
      await ctx.answerCallbackQuery({ text: outcome });
      // The notice keeps its text and loses its buttons, so it can't be pressed twice.
      const text = query.message && 'text' in query.message ? query.message.text : undefined;
      if (text !== undefined) await ctx.editMessageText(`${text}\n\n${outcome}`);
    },
    async blocked(msg, chat) {
      await api
        .sendMessage(config.ownerId, noticeText(msg, chat), { reply_markup: noticeButtons(msg, chat) })
        .catch((err: unknown) => log.warn(`blocked-chat notice failed for chat ${msg.chatId}: ${String(err)}`));
    },
  };
}

type Choice = { kind: 'user' | 'group'; id: number; name: string | undefined };

function picks(msg: Message): Choice[] {
  if (msg.users_shared) return msg.users_shared.users.map((u) => ({ kind: 'user', id: u.user_id, name: u.first_name ?? u.username }));
  if (msg.chat_shared) return [{ kind: 'group', id: msg.chat_shared.chat_id, name: msg.chat_shared.title }];
  return [];
}

/** Button data: `allow user <id>`, `allow group <id>` or `ignore`. */
function press(data: string, path: string, log: Logger): string {
  if (data === 'ignore') return '🚫 Ignored.';
  const match = /^allow (user|group) (-?\d+)$/.exec(data);
  return match ? `✅ ${allow(path, [match[1] ?? '', match[2] ?? ''], log)}` : 'Unknown button.';
}

function noticeText(msg: ChatMessage, chat: { type: string; title?: string | undefined }): string {
  const who = `${msg.firstName ?? 'someone'}${msg.username ? ` @${msg.username}` : ''} (${msg.userId})`;
  const said = msg.text ? `«${clip(msg.text, 300)}»` : '(no text)';
  if (chat.type === 'private') return `🔒 ${who} wrote to me but isn't on the allowlist:\n${said}`;
  return `🔒 A message came from the group «${chat.title ?? msg.chatId}» (${msg.chatId}), which isn't on the allowlist.\nFrom ${who}: ${said}`;
}

function noticeButtons(msg: ChatMessage, chat: { type: string }): InlineKeyboardMarkup {
  const target = chat.type === 'private' ? `user ${msg.userId}` : `group ${msg.chatId}`;
  return { inline_keyboard: [[{ text: '✅ Allow', callback_data: `allow ${target}` }, { text: '🚫 Ignore', callback_data: 'ignore' }]] };
}
