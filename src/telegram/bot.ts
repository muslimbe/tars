import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { Bot, type Transformer } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';

export interface BotOptions {
  /** Replaces the HTTP layer (tests install a fake Bot API here). */
  network?: Transformer | undefined;
  botInfo?: UserFromGetMe | undefined;
}

/**
 * The grammY bot shared by the dispatcher and every tool. Outbound calls are
 * throttled to Telegram's limits (30/s overall,
 * 20/min per group) and a 429 is retried after Telegram's `retry_after`.
 * Link previews are off: links show as plain text (owner's choice).
 */
export function createBot(token: string, options: BotOptions = {}): Bot {
  const bot = new Bot(token, options.botInfo ? { botInfo: options.botInfo } : {});
  // Transformers installed later wrap earlier ones: the network sits innermost.
  if (options.network) bot.api.config.use(options.network);
  bot.api.config.use(noLinkPreviews);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  bot.api.config.use(
    apiThrottler({
      global: { reservoir: 30, reservoirRefreshAmount: 30, reservoirRefreshInterval: 1000 },
      group: { reservoir: 20, reservoirRefreshAmount: 20, reservoirRefreshInterval: 60_000 },
      out: {},
    }),
  );
  return bot;
}

const noLinkPreviews: Transformer = (prev, method, payload, signal) =>
  prev(method, method === 'sendMessage' || method === 'editMessageText' ? { ...payload, link_preview_options: { is_disabled: true } } : payload, signal);
