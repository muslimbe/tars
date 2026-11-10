import type { ChatMessage } from '../message.ts';
import { type Db, sqliteTime } from './database.ts';

/** Days a denied message is kept; strangers can't grow the table without bound. */
const RETENTION_DAYS = 30;

/** Log a message that failed the access gate (pruning old rows first). */
export function insertUnauthorized(db: Db, msg: ChatMessage, chatType: string | undefined, refusalSent: boolean): void {
  db.prepare(`DELETE FROM unauthorized_messages WHERE timestamp < datetime('now', '-${RETENTION_DAYS} days')`).run();
  db.prepare(
    `INSERT INTO unauthorized_messages (chat_id, chat_type, message_id, user_id, username, first_name, timestamp, text, refusal_sent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(msg.chatId, chatType ?? null, msg.messageId, msg.userId, msg.username ?? null, msg.firstName ?? null, sqliteTime(msg.timestamp), msg.text, refusalSent ? 1 : 0);
}

/** Whether the one-time "private assistant" reply already went to this chat. */
export const hasRefusal = (db: Db, chatId: number): boolean =>
  db.prepare('SELECT 1 FROM unauthorized_messages WHERE chat_id=? AND refusal_sent=1 LIMIT 1').get(chatId) !== undefined;

/** Whether this chat already has a blocked message on record (within the retention window). */
export const hasUnauthorized = (db: Db, chatId: number): boolean =>
  db.prepare('SELECT 1 FROM unauthorized_messages WHERE chat_id=? LIMIT 1').get(chatId) !== undefined;
