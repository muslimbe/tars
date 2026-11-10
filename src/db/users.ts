import type { ChatMessage } from '../message.ts';
import { type Db, sqliteTime } from './database.ts';

/** Create or refresh the sender's per-chat `users` row from one inbound message. */
export function upsertUser(db: Db, msg: ChatMessage): void {
  const at = sqliteTime(msg.timestamp);
  db.prepare(
    `INSERT INTO users(chat_id, user_id, username, first_name, join_date, last_message_date, message_count)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(chat_id, user_id) DO UPDATE SET
       username=excluded.username, first_name=excluded.first_name,
       last_message_date=excluded.last_message_date, message_count=message_count+1`,
  ).run(msg.chatId, msg.userId, msg.username ?? null, msg.firstName ?? null, at, at);
}

/** The user's most recent @username in any chat, if they have one. */
export function latestUsername(db: Db, userId: number): string | undefined {
  const row = db.prepare('SELECT username FROM users WHERE user_id = ? AND username IS NOT NULL ORDER BY last_message_date DESC LIMIT 1').get(userId) as { username: string } | undefined;
  return row?.username;
}
