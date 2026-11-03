import type { Message } from 'grammy/types';
import { describe, expect, it } from 'vitest';

import { isAddressed } from '../../src/telegram/addressed.ts';

// The owner (111) and their second account (444), which has no @username.
const WHO = { botId: 999, botUsername: 'Tars_Bot', people: [{ id: 111, username: 'boss' }, { id: 444, username: undefined }] };
const user = (id: number) => ({ id, is_bot: false, first_name: `U${id}` });

function msg(text: string, extra: Partial<Message> = {}): Message {
  return { message_id: 1, date: 1, chat: { id: -100, type: 'supergroup', title: 'G' }, from: user(222), text, ...extra };
}

const mention = (text: string, name: string) => msg(text, { entities: [{ type: 'mention', offset: text.indexOf(name), length: name.length }] });

describe('isAddressed', () => {
  it('passes everything the owner or their second account writes', () => {
    expect(isAddressed(msg('just talking', { from: user(111) }), WHO)).toBe(true);
    expect(isAddressed(msg('from the work account', { from: user(444) }), WHO)).toBe(true);
  });

  it('passes an @-mention of the bot or the owner, in any case', () => {
    expect(isAddressed(mention('hey @tars_bot, a question', '@tars_bot'), WHO)).toBe(true);
    expect(isAddressed(mention('@BOSS payment failed', '@BOSS'), WHO)).toBe(true);
    expect(isAddressed(mention('ask @someone_else', '@someone_else'), WHO)).toBe(false);
  });

  it('counts mention offsets in UTF-16 units, emoji included', () => {
    expect(isAddressed(mention('😀😀 @boss', '@boss'), WHO)).toBe(true);
  });

  it('passes a mention in a caption', () => {
    const text = 'screenshot for @boss';
    const photo = msg('', { text: undefined, caption: text, caption_entities: [{ type: 'mention', offset: 15, length: 5 }] });
    expect(isAddressed(photo, WHO)).toBe(true);
  });

  it('passes a tag of a user without a username by id', () => {
    const tagged = (id: number) => msg('Boss, look', { entities: [{ type: 'text_mention', offset: 0, length: 4, user: user(id) }] });
    expect(isAddressed(tagged(111), WHO)).toBe(true);
    expect(isAddressed(tagged(444), WHO)).toBe(true);
    expect(isAddressed(tagged(333), WHO)).toBe(false);
  });

  it('ignores a mention of someone whose username is not known yet', () => {
    expect(isAddressed(mention('@boss help', '@boss'), { ...WHO, people: [{ id: 111, username: undefined }] })).toBe(false);
  });

  it('passes a reply to the bot or one of the people, not to anyone else', () => {
    const replyTo = (id: number) => msg('agreed', { reply_to_message: msg('earlier', { from: user(id) }) as Message['reply_to_message'] });
    expect(isAddressed(replyTo(999), WHO)).toBe(true);
    expect(isAddressed(replyTo(111), WHO)).toBe(true);
    expect(isAddressed(replyTo(444), WHO)).toBe(true);
    expect(isAddressed(replyTo(333), WHO)).toBe(false);
  });

  it('does not take a forum topic opened by the owner as a reply to the owner', () => {
    const notice = msg('', { text: undefined, from: user(111), forum_topic_created: { name: 'Bugs', icon_color: 0 } }) as Message['reply_to_message'];
    expect(isAddressed(msg('chatter in the topic', { reply_to_message: notice }), WHO)).toBe(false);
  });

  it('drops plain chatter', () => {
    expect(isAddressed(msg('lunch at one?'), WHO)).toBe(false);
  });
});
