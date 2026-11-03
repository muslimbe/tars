import type { Message, MessageEntity } from 'grammy/types';

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

/**
 * True when a group message is the bot's business under `TARS_GROUP_MESSAGES=addressed`:
 * one of the people wrote it, or it mentions or replies to the bot or one of them.
 */
export function isAddressed(msg: Message, who: Addressees): boolean {
  const people = who.people.map((p) => p.id);
  const ids = [who.botId, ...people];
  return people.includes(msg.from?.id ?? 0) || repliesTo(msg, ids) || mentionsAny(msg, who, ids);
}

function repliesTo(msg: Message, ids: number[]): boolean {
  const reply = msg.reply_to_message;
  // In a forum topic every message replies to the topic's creation notice — not to its author.
  return Boolean(reply && !reply.forum_topic_created && ids.includes(reply.from?.id ?? 0));
}

function mentionsAny(msg: Message, who: Addressees, ids: number[]): boolean {
  const text = msg.text ?? msg.caption ?? '';
  const names = [who.botUsername, ...who.people.map((p) => p.username)].flatMap((n) => (n ? [`@${n.toLowerCase()}`] : []));
  return (msg.entities ?? msg.caption_entities ?? []).some((e) => mentions(e, text, { ids, names }));
}

function mentions(entity: MessageEntity, text: string, who: { ids: number[]; names: string[] }): boolean {
  if (entity.type === 'text_mention') return who.ids.includes(entity.user.id);
  // Entity offsets are UTF-16 units, which is what String#slice counts.
  return entity.type === 'mention' && who.names.includes(text.slice(entity.offset, entity.offset + entity.length).toLowerCase());
}
