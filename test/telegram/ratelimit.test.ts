import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/database.ts';
import { checkRateLimit } from '../../src/telegram/ratelimit.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

const open = () => openDatabase(join(tempDir(), 'h.db'), memoryLogger());
const OWNER = 1;

describe('DM rate limit', () => {
  it('counts per user per wall-clock minute, notifies once, and prunes old buckets on every check', () => {
    const db = open();
    const check = (userId: number, now: number) => checkRateLimit(db, { userId, ownerIds: [OWNER], limit: 2 }, now);
    expect(check(7, 6000.9)).toEqual({ limited: false });
    expect(check(7, 6010)).toEqual({ limited: false });
    expect(check(8, 6010)).toEqual({ limited: false });
    expect(check(7, 6015)).toEqual({ limited: true, limit: 2, retryAfterS: 45, notify: true });
    expect(check(7, 6059)).toEqual({ limited: true, limit: 2, retryAfterS: 1, notify: false });
    expect(check(7, 6060)).toEqual({ limited: false });
    db.prepare('INSERT INTO rate_limits(user_id, bucket_start, count, notice_sent) VALUES (9, 5000, 1, 0)').run();
    check(7, 6061);
    expect(db.prepare('SELECT count(*) FROM rate_limits WHERE user_id = 9').pluck().get()).toBe(0);
    check(7, 6062);
    const buckets = db.prepare('SELECT user_id, bucket_start, count, notice_sent FROM rate_limits ORDER BY user_id, bucket_start').raw().all();
    expect(buckets).toEqual([[7, 6000, 4, 1], [7, 6060, 3, 1], [8, 6000, 1, 0]]);
  });

  it('exempts the owner (no row at all), and a zero limit refuses every other DM', () => {
    const db = open();
    expect(checkRateLimit(db, { userId: OWNER, ownerIds: [OWNER], limit: 0 }, 100)).toEqual({ limited: false });
    expect(db.prepare('SELECT count(*) FROM rate_limits').pluck().get()).toBe(0);
    expect(checkRateLimit(db, { userId: 5, ownerIds: [OWNER], limit: 0 }, 100)).toMatchObject({ limited: true, notify: true });
  });
});
