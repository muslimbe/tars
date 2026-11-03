import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/database.ts';
import { insertMessage, markProcessed } from '../../src/db/messages.ts';
import { formatBatch } from '../../src/engine/envelope.ts';
import { buildRestoredContext, sanitizeForCc } from '../../src/engine/restore.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';
import { type GoldenMsg, loadGolden, toChatMessage } from './load.ts';

interface Golden {
  as_xml: { batch: GoldenMsg[]; out: string }[];
  with_context: { batch: GoldenMsg[]; out: string }[];
  with_context_db_rows: GoldenMsg[];
  restored: { case: string; out: string | null }[];
  restored_history: GoldenMsg[];
}

const golden = loadGolden<Golden>('envelope.json');
const utils = loadGolden<{ sanitize_for_cc: { in: string; cap: number; out: string }[] }>('utils.json');

describe('XML envelope (golden)', () => {
  it.each(golden.as_xml.map((c, i) => [i, c] as const))('batch %i without history', (_i, c) => {
    expect(formatBatch(c.batch.map(toChatMessage))).toBe(c.out);
  });

  it('marks who a group message is for, after the other attributes', () => {
    const m = { chatId: -100, messageId: 7, userId: 222, firstName: 'Jasur', direction: 'in' as const, timestamp: new Date('2026-01-01T10:00:00Z'), text: '@boss help', replyToId: 3 };
    expect(formatBatch([{ ...m, audience: 'owner' }])).toBe('<msg id="7" chat="-100" user="222" name="Jasur" time="10:00" reply_to="3" for="owner">\n@boss help\n</msg>');
    expect(formatBatch([m])).not.toContain(' for=');
  });

  it('expands reply chains from history', () => {
    const db = openDatabase(join(tempDir(), 'h.db'), memoryLogger());
    for (const row of golden.with_context_db_rows) insertMessage(db, toChatMessage(row));
    for (const c of golden.with_context) expect(formatBatch(c.batch.map(toChatMessage), { db, log: memoryLogger() })).toBe(c.out);
  });
});

describe('restored context (golden)', () => {
  it('sanitizes digest text', () => {
    for (const c of utils.sanitize_for_cc) expect(sanitizeForCc(c.in, c.cap)).toBe(c.out);
  });

  it('builds the digest from committed history only', () => {
    const db = openDatabase(join(tempDir(), 'r.db'), memoryLogger());
    const [empty, ...cases] = golden.restored;
    expect(buildRestoredContext(db, empty?.case ?? '')).toBe(empty?.out ?? undefined);
    for (const row of golden.restored_history) insertMessage(db, toChatMessage(row));
    markProcessed(db, [[700, 1], [700, 4], [-1007, 5]]);
    for (const c of cases) expect(buildRestoredContext(db, c.case)).toBe(c.out);
  });
});

describe('reply-chain lookup failure', () => {
  it('is logged and rendered as Telegram\'s inline parent', () => {
    const db = openDatabase(join(tempDir(), 'f.db'), memoryLogger());
    db.close();
    const log = memoryLogger();
    const reply = { chatId: 1, messageId: 5, userId: 1, firstName: 'A', direction: 'in' as const, timestamp: new Date('2026-01-01T09:26:00Z'), text: 'x', replyToId: 4, replyToText: 'parent' };
    expect(formatBatch([reply], { db, log })).toContain('<parent id="4" source="telegram_inline">parent</parent>');
    expect(log.text()).toContain('ERROR reply chain lookup failed for 5');
  });
});
