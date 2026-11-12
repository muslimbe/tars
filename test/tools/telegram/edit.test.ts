import { describe, expect, it } from 'vitest';

import { editMessageTool } from '../../../src/tools/telegram/edit.ts';
import { expectGoldenTool } from '../../golden/tools.ts';
import { call, messageRow, seedMessage, toolContext } from './harness.ts';

describe('telegram_edit_message', () => {
  it('matches the tools/list snapshot', () => {
    expectGoldenTool(editMessageTool(toolContext().ctx));
  });

  it('edits as HTML, logs [EDIT], and marks the row edited and untrusted — no typing stop', async () => {
    const t = toolContext();
    seedMessage(t.db, 111, 7, 'old');
    t.db.prepare('UPDATE messages SET processed=1').run();
    const out = await call(editMessageTool(t.ctx), { chat_id: 111, message_id: 7, text: '**new**' });
    expect(t.fake.sent('editMessageText')[0]?.payload).toEqual({ chat_id: 111, message_id: 7, text: '<b>new</b>', parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    expect(out).toEqual({ content: 'edited message_id=7', data: { message_id: 7, chat_id: 111 } });
    expect(messageRow(t.db, 111, 7)).toMatchObject({ text: '**new**', edited: 1, processed: 0 });
    expect(t.log.text()).toContain('[EDIT] DM Ali[111] m7 | **new**');
    expect(t.replied).toEqual([]);
  });

  it('surfaces a Telegram failure and records nothing', async () => {
    const t = toolContext();
    seedMessage(t.db, 111, 7, 'old');
    t.fake.fail('editMessageText', 400, 'Bad Request: message to edit not found');
    await expect(call(editMessageTool(t.ctx), { chat_id: 111, message_id: 7, text: 'x' })).rejects.toMatchObject({
      name: 'GrammyError',
      message: "Call to 'editMessageText' failed! (400: Bad Request: message to edit not found)",
    });
    expect(messageRow(t.db, 111, 7)).toMatchObject({ text: 'old', edited: 0 });
    expect(t.log.text()).not.toContain('[EDIT]');
  });
});
