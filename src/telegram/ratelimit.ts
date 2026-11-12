import type { Db } from '../db/database.ts';

/** The bucket length; the limit is per user per wall-clock minute. */
const WINDOW_SECONDS = 60;

export type RateDecision = { limited: false } | { limited: true; limit: number; retryAfterS: number; notify: boolean };

/**
 * Per-user DM rate limit with persistent fixed-window counters (they survive
 * restarts). The owner's accounts are exempt. `notify` is true exactly once per user per
 * exhausted window, so the user gets one notice.
 */
export function checkRateLimit(db: Db, opts: { userId: number; ownerIds: readonly number[]; limit: number }, nowSeconds = Date.now() / 1000): RateDecision {
  if (opts.ownerIds.includes(opts.userId)) return { limited: false };
  const now = Math.floor(nowSeconds);
  const bucket = Math.floor(now / WINDOW_SECONDS) * WINDOW_SECONDS;
  db.prepare('DELETE FROM rate_limits WHERE bucket_start < ?').run(bucket - 2 * WINDOW_SECONDS);
  const count = db
    .prepare(
      `INSERT INTO rate_limits(user_id, bucket_start, count, notice_sent) VALUES (?, ?, 1, 0)
       ON CONFLICT(user_id, bucket_start) DO UPDATE SET count = count + 1 RETURNING count`,
    )
    .pluck()
    .get(opts.userId, bucket) as number;
  if (count <= opts.limit) return { limited: false };
  const flipped = db.prepare('UPDATE rate_limits SET notice_sent=1 WHERE user_id=? AND bucket_start=? AND notice_sent=0 RETURNING 1').get(opts.userId, bucket);
  return { limited: true, limit: opts.limit, retryAfterS: Math.max(1, bucket + WINDOW_SECONDS - now), notify: flipped !== undefined };
}
