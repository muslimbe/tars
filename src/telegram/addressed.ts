import type { Message, MessageEntity } from 'grammy/types';

import type { Audience } from '../message.ts';

/** A person whose group messages, mentions and replies reach the model. */
export interface Addressee {
  id: number;
  /** Their @username, when the bot has seen one. */
  username: string | undefined;
}

/** Who a group message can be meant for: the bot, the owner and `TARS_GROUP_ADDRESSEES`. */
export interface Addressees {
  botId: number;
  botUsername: string;
  people: readonly Addressee[];
}

/** Who a group message is for; see `Audience`. */
export function audienceOf(msg: Message, who: Addressees): Audience {
  if (reaches(msg, [who.botId], [who.botUsername])) return 'you';
  const people = who.people.map((p) => p.id);
  if (people.includes(msg.from?.id ?? 0)) return 'context';
  return reaches(msg, people, who.people.map((p) => p.username)) ? 'owner' : 'none';
}

/** A reply to, or a mention of, one of `ids` (by id or by @username). */
function reaches(msg: Message, ids: number[], usernames: (string | undefined)[]): boolean {
  if (repliesTo(msg, ids)) return true;
  const text = msg.text ?? msg.caption ?? '';
  const names = usernames.flatMap((n) => (n ? [`@${n.toLowerCase()}`] : []));
  return (msg.entities ?? msg.caption_entities ?? []).some((e) => mentions(e, text, { ids, names }));
}

function repliesTo(msg: Message, ids: number[]): boolean {
  const reply = msg.reply_to_message;
  // In a forum topic every message replies to the topic's creation notice — not to its author.
  return Boolean(reply && !reply.forum_topic_created && ids.includes(reply.from?.id ?? 0));
}

function mentions(entity: MessageEntity, text: string, who: { ids: number[]; names: string[] }): boolean {
  if (entity.type === 'text_mention') return who.ids.includes(entity.user.id);
  // Entity offsets are UTF-16 units, which is what String#slice counts.
  return entity.type === 'mention' && who.names.includes(text.slice(entity.offset, entity.offset + entity.length).toLowerCase());
}
