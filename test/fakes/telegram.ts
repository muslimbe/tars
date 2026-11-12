import type { Transformer } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';

import { until } from '../helpers/wait.ts';

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

interface Person {
  id: number;
  first_name: string;
  username?: string;
}

/**
 * A local stand-in for the Telegram Bot API. Install `transformer` first on a
 * bot's API (it never calls the network); every call is recorded, sends get
 * fresh message ids, and `getUpdates` serves what tests push.
 */
export class FakeTelegram {
  readonly calls: ApiCall[] = [];
  readonly botInfo: UserFromGetMe = {
    id: 999,
    is_bot: true,
    first_name: 'Tars',
    username: 'tars_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
  } as UserFromGetMe;
  private readonly queue: Update[] = [];
  /** Per method, the next calls' outcomes: a failure, or undefined to let that call through. */
  private readonly failures = new Map<string, ({ error_code: number; description: string } | undefined)[]>();
  private readonly results = new Map<string, unknown[]>();
  private updateId = 1;
  private messageId = 5000;
  private wake: (() => void) | undefined;

  readonly transformer: Transformer = async (_prev, method, payload, signal) => {
    this.calls.push({ method, payload: payload });
    const failure = this.failures.get(method)?.shift();
    if (failure) return { ok: false, ...failure } as never;
    const scripted = this.results.get(method)?.shift();
    if (scripted !== undefined) return { ok: true, result: scripted } as never;
    if (method === 'getUpdates') return { ok: true, result: await this.nextUpdates(signal as AbortSignal | undefined) } as never;
    return { ok: true, result: this.answer(method, payload) } as never;
  };

  /** Make the next `method` call — or the one after `after` successful calls — fail like the real API would. */
  fail(method: string, error_code: number, description: string, after = 0): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), ...Array<undefined>(after).fill(undefined), { error_code, description }]);
  }

  /** Answer the next `method` call with `result` instead of the default answer. */
  respond(method: string, result: unknown): void {
    this.results.set(method, [...(this.results.get(method) ?? []), result]);
  }

  push(update: Omit<Update, 'update_id'>): void {
    this.queue.push({ update_id: this.updateId++, ...update });
    this.wake?.();
  }

  /** Push a text message; returns its message id. */
  message(chat: { id: number; type?: string; title?: string; is_forum?: boolean }, from: Person, text: string, extra: Record<string, unknown> = {}): number {
    const id = ++this.messageId;
    const type = chat.type ?? (chat.id > 0 ? 'private' : 'supergroup');
    const fullChat = type === 'private' ? { id: chat.id, type, first_name: from.first_name } : { ...chat, type };
    // Telegram marks a leading /command with a bot_command entity.
    const command = /^\/\S+/.exec(text)?.[0];
    const entities = command ? [{ type: 'bot_command', offset: 0, length: command.length }] : undefined;
    this.push({ message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: fullChat, from: { is_bot: false, ...from }, text, entities, ...extra } } as never);
    return id;
  }

  sent(method = 'sendMessage'): ApiCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  async waitFor(method: string, predicate: (payload: Record<string, unknown>) => boolean = () => true, timeoutMs = 5000): Promise<ApiCall> {
    return until(() => this.calls.find((c) => c.method === method && predicate(c.payload)), timeoutMs);
  }

  private async nextUpdates(signal: AbortSignal | undefined): Promise<Update[]> {
    if (!this.queue.length) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        const timer = setTimeout(resolve, 250);
        signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
      });
    }
    return this.queue.splice(0);
  }

  private answer(method: string, payload: Record<string, unknown>): unknown {
    const chat = { id: payload.chat_id, type: Number(payload.chat_id) > 0 ? 'private' : 'supergroup' };
    const date = Math.floor(Date.now() / 1000);
    switch (method) {
      case 'getMe':
        return this.botInfo;
      case 'sendMessage':
        return { message_id: ++this.messageId, date, chat, text: payload.text, from: this.botInfo };
      case 'sendPhoto':
      case 'sendDocument':
        return { message_id: ++this.messageId, date, chat, from: this.botInfo };
      case 'sendPoll': {
        const options = (payload.options as { text: string }[]).map((o) => ({ text: o.text, voter_count: 0 }));
        const poll = { id: `poll${this.messageId + 1}`, question: payload.question, options, total_voter_count: 0, is_closed: false, is_anonymous: payload.is_anonymous ?? true, type: payload.type ?? 'regular', allows_multiple_answers: payload.allows_multiple_answers ?? false };
        return { message_id: ++this.messageId, date, chat, from: this.botInfo, poll };
      }
      case 'getFile':
        return { file_id: payload.file_id, file_unique_id: `u-${String(payload.file_id)}`, file_path: `files/${String(payload.file_id)}` };
      case 'editMessageText':
        return { message_id: payload.message_id, date, chat, text: payload.text };
      case 'getChatMember':
        return { status: 'left', user: { id: payload.user_id, is_bot: false, first_name: 'U' } };
      case 'stopPoll':
        return { id: 'poll', question: 'q', options: [], total_voter_count: 0, is_closed: true, is_anonymous: true, type: 'regular', allows_multiple_answers: false };
      default:
        return true;
    }
  }
}
