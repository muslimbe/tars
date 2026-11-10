import type { Db } from '../db/database.ts';
import { type ChainRow, fetchReplyChain } from '../db/messages.ts';
import type { Logger } from '../log/logger.ts';
import type { ChatMessage } from '../message.ts';
import { escapeAttr, escapeXml } from '../text/xml.ts';

/** How many hops of a reply chain the envelope shows. */
const REPLY_DEPTH = 3;

/** Where reply-chain parents come from; a failed lookup is logged and rendered as no chain. */
export interface History {
  db: Db;
  log: Logger;
}

/**
 * Render a batch as the `<msg>` XML envelope the model reads, with each
 * reply's parents (from our own history, or Telegram's inline copy when we
 * don't have the row) nested inside it. Without history, no chains.
 */
export function formatBatch(messages: readonly ChatMessage[], history?: History): string {
  return messages.map((m) => formatMessage(m, history ? replyChain(m, history) : '')).join('\n');
}

/** One `<msg>`; a synthetic reminder (id 0) already is a complete `<reminder>` and passes through. */
function formatMessage(m: ChatMessage, parentsXml: string): string {
  if (m.messageId === 0) return m.text;
  const name = m.firstName || m.username || String(m.userId);
  const time = m.timestamp.toISOString().slice(11, 16);
  const topic = m.messageThreadId === undefined ? '' : ` topic="${m.messageThreadId}"`;
  const reply = m.replyToId === undefined ? '' : ` reply_to="${m.replyToId}"`;
  const flags = m.inputFlags?.size ? ` flags="${[...m.inputFlags].sort().join(',')}"` : '';
  const audience = m.audience === undefined ? '' : ` for="${m.audience}"`;
  return (
    `<msg id="${m.messageId}" chat="${m.chatId}" user="${m.userId}" name="${escapeAttr(name)}" time="${time}"${topic}${reply}${flags}${audience}>\n` +
    `${parentsXml}${escapeXml(m.text)}\n</msg>`
  );
}

function replyChain(m: ChatMessage, history: History): string {
  if (m.replyToId === undefined) return '';
  const chain = lookupChain(m, m.replyToId, history);
  if (chain.length) {
    const parents = chain.map(
      (p) =>
        `  <parent id="${p.message_id}" user="${p.user_id}" name="${escapeAttr(p.first_name || p.username || String(p.user_id))}" ` +
        `direction="${p.direction}" time="${p.timestamp}">${escapeXml(p.text || '')}</parent>`,
    );
    return ['<reply_chain>', ...parents, '</reply_chain>\n'].join('\n');
  }
  if (!m.replyToText) return '';
  return `<reply_chain>\n  <parent id="${m.replyToId}" source="telegram_inline">${escapeXml(m.replyToText)}</parent>\n</reply_chain>\n`;
}

function lookupChain(m: ChatMessage, replyToId: number, { db, log }: History): ChainRow[] {
  try {
    return fetchReplyChain(db, m.chatId, replyToId, REPLY_DEPTH);
  } catch (err) {
    log.error(`reply chain lookup failed for ${m.messageId}`, { err });
    return [];
  }
}
