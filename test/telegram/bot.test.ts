import { describe, expect, it } from 'vitest';

import { createBot } from '../../src/telegram/bot.ts';
import { FakeTelegram } from '../fakes/telegram.ts';

describe('bot', () => {
  it('sends and edits text without link previews', async () => {
    const fake = new FakeTelegram();
    const bot = createBot('1:t', { network: fake.transformer, botInfo: fake.botInfo });
    await bot.api.sendMessage(1, 'see https://example.com', { parse_mode: 'HTML' });
    await bot.api.editMessageText(1, 2, 'now https://example.org');
    await bot.api.sendPhoto(1, 'file-id');
    expect(fake.calls.map((c) => [c.method, c.payload.link_preview_options])).toEqual([
      ['sendMessage', { is_disabled: true }],
      ['editMessageText', { is_disabled: true }],
      ['sendPhoto', undefined],
    ]);
    expect(fake.sent()[0]?.payload).toMatchObject({ chat_id: 1, text: 'see https://example.com', parse_mode: 'HTML' });
  });
});
