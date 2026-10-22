import type { Bot, Context } from 'grammy';
import type { Message, Update } from 'grammy/types';

import type { Config } from '../config.ts';
import type { Db } from '../db/database.ts';
import { insertMessage, markEdited } from '../db/messages.ts';
import { applyUserReaction } from '../db/reactions.ts';
import { insertUnauthorized, hasRefusal } from '../db/unauthorized.ts';
import { upsertUser } from '../db/users.ts';
import type { Logger } from '../log/logger.ts';
import type { Transcript } from '../log/transcript.ts';
import type { ChatMessage } from '../message.ts';
import { gate, loadAccess } from './access.ts';
import { checkRateLimit } from './ratelimit.ts';
import { chatTitle, commandOf, toChatMessage } from './updates.ts';

/** What the dispatcher hands messages to. */
export interface EnginePort {
  submit(msg: ChatMessage): Promise<void>;
  primeTyping(chatId: number, topic: number | undefined): void;
}

/** Handles a recognised command; true when it was one of ours (and so consumed for everyone). */
export type CommandHandler = (ctx: Context, command: { name: string; args: string[] }) => Promise<boolean>;

/** Adds attachment markers to an allowed message's text (photos, documents, voice, audio, video). */
export type AttachmentIngest = (msg: Message, cm: ChatMessage) => Promise<void>;

export interface DispatcherOptions {
  bot: Bot;
  config: Pick<Config, 'ownerId' | 'accessPath' | 'rateLimitPerMin'>;
  db: Db;
  engine: EnginePort;
  chatTitles: Map<number, string>;
  transcript: Transcript;
  log: Logger;
  commands: CommandHandler;
  attachments: AttachmentIngest;
}

const REFUSAL = 'This is a private assistant. Please contact the owner if you want an access.';

/**
 * The front door: every inbound update goes through the access gate, the
 * DM rate limit and persistence before it reaches the engine. Updates are
 * handled one at a time, in Telegram order.
 */
export class Dispatcher {
  /** Owner `/pause`: drop all inbound messages until `/resume`. In memory only. */
  paused = false;
  private readonly o: DispatcherOptions;
  private readonly log: Logger;

  constructor(options: DispatcherOptions) {
    this.o = options;
    this.log = options.log;
    options.bot.on(['message', 'edited_message'], (ctx) => this.route(ctx));
    options.bot.on('message_reaction', (ctx) => this.onReaction(ctx));
  }

  private async route(ctx: Context): Promise<void> {
    const msg = ctx.message ?? ctx.editedMessage;
    if (!msg) return;
    const command = commandOf(msg, ctx.me.username);
    if (command && (await this.o.commands(ctx, command))) return;
    // Edits that still carry content re-enter as messages (backlog P13).
    if (hasContent(msg)) return this.onMessage(ctx.update, msg);
    if (ctx.editedMessage) this.onEdited(msg);
  }

  private async onMessage(update: Update, msg: Message): Promise<void> {
    const receivedAt = performance.now();
    const cm = toChatMessage(update, msg);
    if (!cm) return;
    cm.receivedAt = receivedAt;
    if (this.paused) return this.log.info(`paused — dropping chat=${cm.chatId} msg=${cm.messageId}`);
    this.log.info(`hot-path stage=receipt chat=${cm.chatId} msg=${cm.messageId} t_ms=0`);
    this.rememberTitle(msg.chat);
    if (!this.allowed(cm, msg.chat.type, true)) return this.onUnauthorized(cm, msg.chat.type);
    if (!(await this.underRateLimit(cm, msg.chat.type))) return;
    await this.o.attachments(msg, cm);
    insertMessage(this.o.db, cm);
    upsertUser(this.o.db, cm);
    this.o.engine.primeTyping(cm.chatId, cm.messageThreadId);
    this.log.info(`hot-path stage=submit chat=${cm.chatId} msg=${cm.messageId} t_ms=${Math.trunc(performance.now() - receivedAt)}`);
    await this.o.engine.submit(cm);
  }

  /** An edit carrying no text, caption or file (e.g. a live-location update). */
  private onEdited(msg: Message): void {
    this.rememberTitle(msg.chat);
    const userId = msg.from?.id ?? 0;
    if (!this.allowed({ chatId: msg.chat.id, userId }, msg.chat.type, false)) return;
    markEdited(this.o.db, [msg.chat.id, msg.message_id], msg.text ?? '');
    const author = msg.from ? { id: msg.from.id, name: msg.from.first_name || msg.from.username } : {};
    this.o.transcript.inboundEdit({ chatId: msg.chat.id, title: this.o.chatTitles.get(msg.chat.id) }, author, { messageId: msg.message_id, text: msg.text ?? '' });
  }

  /** A user's reaction change on a message we store (anonymous admin reactions carry no user). */
  private onReaction(ctx: Context): void {
    const evt = ctx.messageReaction;
    if (!evt?.user) return;
    this.rememberTitle(evt.chat);
    if (!this.allowed({ chatId: evt.chat.id, userId: evt.user.id }, evt.chat.type, false)) return;
    const emojis = (list: typeof evt.new_reaction) => list.flatMap((r) => (r.type === 'emoji' ? [r.emoji] : []));
    applyUserReaction(this.o.db, [evt.chat.id, evt.message_id], { userId: evt.user.id, oldEmoji: emojis(evt.old_reaction), newEmoji: emojis(evt.new_reaction) });
  }

  /** Hot-reload `access.json` and decide; `log` writes the `[RX]`/`[DROP]` transcript line. */
  allowed(cm: Pick<ChatMessage, 'chatId' | 'userId'> & Partial<ChatMessage>, chatType: string | undefined, log: boolean): boolean {
    const ok = gate(loadAccess(this.o.config.accessPath, this.log), this.o.config.ownerId, { chatId: cm.chatId, userId: cm.userId, chatType });
    if (log) {
      const chat = { chatId: cm.chatId, title: this.o.chatTitles.get(cm.chatId), chatType };
      const user = { id: cm.userId, name: cm.firstName || cm.username };
      this.o.transcript.inbound(chat, user, { messageId: cm.messageId ?? 0, text: cm.text ?? '', replyToId: cm.replyToId }, ok);
    }
    return ok;
  }

  /** Denied: record it, and in a DM send the one-time refusal. Groups stay silent. */
  private async onUnauthorized(cm: ChatMessage, chatType: string): Promise<void> {
    const reply = chatType === 'private' && !hasRefusal(this.o.db, cm.chatId);
    insertUnauthorized(this.o.db, cm, chatType, reply);
    if (!reply) return;
    await this.o.bot.api.sendMessage(cm.chatId, REFUSAL).catch(() => this.log.warn(`unauthorized refusal send failed for chat ${cm.chatId}`));
  }

  /** Per-user DM limit (groups and the owner are exempt); one notice per exhausted minute. */
  private async underRateLimit(cm: ChatMessage, chatType: string): Promise<boolean> {
    if (chatType !== 'private') return true;
    const decision = checkRateLimit(this.o.db, { userId: cm.userId, ownerId: this.o.config.ownerId, limit: this.o.config.rateLimitPerMin });
    if (!decision.limited) return true;
    if (decision.notify) {
      const text = `⏳ You're sending messages too fast (${decision.limit}/min). Try again in ~${decision.retryAfterS}s.`;
      await this.o.bot.api.sendMessage(cm.chatId, text).catch(() => this.log.warn(`rate-limit notice send failed for user ${cm.userId}`));
    }
    return false;
  }

  rememberTitle(chat: Message['chat']): void {
    const title = chatTitle(chat);
    if (title) this.o.chatTitles.set(chat.id, title);
  }
}

/** Text, a caption, or a file the attachment step saves: what the message pipeline handles. */
const hasContent = (msg: Message) => Boolean(msg.text || msg.caption || msg.photo?.length || msg.document || msg.voice || msg.audio || msg.video || msg.video_note);
