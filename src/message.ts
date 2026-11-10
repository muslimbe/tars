import type { InputFlag } from './text/normalize.ts';

/**
 * Who a group message is for, shown to the model as `<msg for="…">`:
 * `you` — it mentions or replies to the bot; `context` — the owner (or a `TARS_GROUP_ADDRESSEES` account)
 * wrote it without that; `owner` — someone else mentions or replies to one of those; `none` — anything else,
 * which `TARS_GROUP_MESSAGES=addressed` drops.
 */
export type Audience = 'you' | 'owner' | 'context' | 'none';

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
  /** Group messages only: who it's for, rendered as `for=`. Typing shows only for `you`. Not a DB column. */
  audience?: Audience | undefined;
}

/** Typing shows for DMs and for group messages to the bot — not while it may well stay silent. */
export const showsTyping = (m: ChatMessage): boolean => m.audience === undefined || m.audience === 'you';
