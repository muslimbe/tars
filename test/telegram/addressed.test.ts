import type { Message } from 'grammy/types';
import { describe, expect, it } from 'vitest';

import { audienceOf } from '../../src/telegram/addressed.ts';

// The owner (111) and their second account (444), which has no @username.
const WHO = { botId: 999, botUsername: 'Tars_Bot', people: [{ id: 111, username: 'boss' }, { id: 444, username: undefined }] };
const user = (id: number) => ({ id, is_bot: false, first_name: `U${id}` });

function msg(text: string, extra: Partial<Message> = {}): Message {
  return { message_id: 1, date: 1, chat: { id: -100, type: 'supergroup', title: 'G' }, from: user(222), text, ...extra };
}

const mention = (text: string, name: string, from = 222) => msg(text, { from: user(from), entities: [{ type: 'mention', offset: text.indexOf(name), length: name.length }] });
const replyTo = (id: number, from = 222) => msg('agreed', { from: user(from), reply_to_message: msg('earlier', { from: user(id) }) as Message['reply_to_message'] });

describe('audienceOf', () => {
  it('is "you" for a mention of or a reply to the bot, whoever writes it', () => {
    expect(audienceOf(mention('hey @tars_bot, a question', '@tars_bot'), WHO)).toBe('you');
    expect(audienceOf(mention('@TARS_BOT look', '@TARS_BOT', 111), WHO)).toBe('you');
    expect(audienceOf(replyTo(999), WHO)).toBe('you');
  });

  it('is "context" for anything else the owner or their second account writes', () => {
    expect(audienceOf(msg('just talking', { from: user(111) }), WHO)).toBe('context');
    expect(audienceOf(mention('ask @someone_else', '@someone_else', 444), WHO)).toBe('context');
  });

  it('is "owner" when someone else mentions or replies to one of the people', () => {
    expect(audienceOf(mention('@BOSS payment failed', '@BOSS'), WHO)).toBe('owner');
    expect(audienceOf(replyTo(111), WHO)).toBe('owner');
    expect(audienceOf(replyTo(444), WHO)).toBe('owner');
  });

  it('is "none" for chatter that reaches nobody', () => {
    expect(audienceOf(msg('lunch at one?'), WHO)).toBe('none');
    expect(audienceOf(mention('ask @someone_else', '@someone_else'), WHO)).toBe('none');
    expect(audienceOf(replyTo(333), WHO)).toBe('none');
  });

  it('counts mention offsets in UTF-16 units, emoji included', () => {
    expect(audienceOf(mention('😀😀 @boss', '@boss'), WHO)).toBe('owner');
  });

  it('reads a mention in a caption', () => {
    const photo = msg('', { text: undefined, caption: 'screenshot for @boss', caption_entities: [{ type: 'mention', offset: 15, length: 5 }] });
    expect(audienceOf(photo, WHO)).toBe('owner');
  });

  it('matches a tag of a user without a username by id', () => {
    const tagged = (id: number) => msg('Look', { entities: [{ type: 'text_mention', offset: 0, length: 4, user: user(id) }] });
    expect(audienceOf(tagged(999), WHO)).toBe('you');
    expect(audienceOf(tagged(444), WHO)).toBe('owner');
    expect(audienceOf(tagged(333), WHO)).toBe('none');
  });

  it('ignores a mention of someone whose username is not known yet', () => {
    expect(audienceOf(mention('@boss help', '@boss'), { ...WHO, people: [{ id: 111, username: undefined }] })).toBe('none');
  });

  it('does not take a forum topic opened by the owner as a reply to the owner', () => {
    const notice = msg('', { text: undefined, from: user(111), forum_topic_created: { name: 'Bugs', icon_color: 0 } }) as Message['reply_to_message'];
    expect(audienceOf(msg('chatter in the topic', { reply_to_message: notice }), WHO)).toBe('none');
  });
});
