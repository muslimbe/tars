import type { InputFlag } from './text/normalize.ts';

/** A Telegram message normalised for the engine — inbound and outbound alike. */
export interface ChatMessage {
  chatId: number;
  messageId: number;
  userId: number;
  username?: string | undefined;
  firstName?: string | undefined;
  direction: 'in' | 'out';
  timestamp: Date;
  text: string;
  replyToId?: number | undefined;
  replyToText?: string | undefined;
  /** Forum topic id; only set for real topic messages. Not a DB column — it survives in `rawUpdateJson`. */
  messageThreadId?: number | undefined;
  rawUpdateJson?: string | undefined;
  /** `performance.now()` when the dispatcher first saw it; hot-path latency logs only. */
  receivedAt?: number | undefined;
  /** Input-normalisation transforms that fired; rendered as the envelope's `flags=`. */
  inputFlags?: ReadonlySet<InputFlag> | undefined;
  /** A group message that neither mentions nor replies to the bot: no typing indicator, the bot may well stay silent. */
  quiet?: boolean | undefined;
}
