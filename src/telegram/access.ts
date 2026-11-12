import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

import type { Logger } from '../log/logger.ts';

export type Policy = 'owner_only' | 'allowlist' | 'open';

/** `access.json`: who may DM the bot and which groups it serves. */
export interface Access {
  policy: Policy;
  allowedUsers: number[];
  allowedChats: number[];
}

export const POLICIES: readonly string[] = ['owner_only', 'allowlist', 'open'];
const DEFAULTS = (): Access => ({ policy: 'owner_only', allowedUsers: [], allowedChats: [] });

/**
 * Read `access.json` fresh (hand edits apply on the next message). Missing →
 * owner-only defaults; unreadable or malformed → the file is moved aside as
 * `<name>.corrupt-<unix>.json` and the defaults apply (fail closed).
 */
export function loadAccess(path: string, log: Logger): Access {
  if (!existsSync(path)) return DEFAULTS();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('top level must be a JSON object');
  } catch (err) {
    return moveAside(path, err, log);
  }
  const record = raw as Record<string, unknown>;
  let policy = record.policy ?? 'owner_only';
  if (typeof policy !== 'string' || !POLICIES.includes(policy)) {
    log.warn(`invalid policy ${JSON.stringify(policy)} in access.json, defaulting to owner_only`);
    policy = 'owner_only';
  }
  return { policy: policy as Policy, allowedUsers: ids(record.allowed_users), allowedChats: ids(record.allowed_chats) };
}

function moveAside(path: string, err: unknown, log: Logger): Access {
  const aside = join(dirname(path), `${basename(path, extname(path))}.corrupt-${Math.floor(Date.now() / 1000)}.json`);
  log.warn(`corrupt access.json, renaming to ${basename(aside)}: ${(err as Error).message}`);
  try {
    renameSync(path, aside);
  } catch {
    // e.g. EBUSY on a single-file bind mount: the defaults still apply.
  }
  return DEFAULTS();
}

/** Integers, or strings of digits; anything else is dropped. */
function ids(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((v: unknown) => {
    if (typeof v === 'number' && Number.isInteger(v)) return [v];
    if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return [Number(v)];
    return [];
  });
}

/**
 * Write atomically (tmp file + rename). A single-file Docker bind mount
 * rejects rename with EBUSY; then the file is written in place.
 */
export function saveAccess(path: string, access: Access): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload = `${JSON.stringify({ policy: access.policy, allowed_users: access.allowedUsers, allowed_chats: access.allowedChats }, null, 2)}\n`;
  const tmp = join(dirname(path), `${basename(path, extname(path))}.tmp`);
  writeFileSync(tmp, payload);
  try {
    renameSync(tmp, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EBUSY') throw err;
    writeFileSync(path, payload);
    rmSync(tmp, { force: true });
  }
}

/**
 * Should an inbound message be accepted? DMs are decided by sender, groups
 * by chat. The owner's accounts are always allowed in DMs, never automatically in groups.
 */
export function gate(access: Access, ownerIds: readonly number[], from: { chatId: number; userId: number; chatType: string | undefined }): boolean {
  const isGroup = from.chatType === 'group' || from.chatType === 'supergroup' || from.chatType === 'channel';
  if (access.policy === 'owner_only') return !isGroup && ownerIds.includes(from.userId);
  if (access.policy === 'open') return true;
  if (isGroup) return access.allowedChats.includes(from.chatId);
  return ownerIds.includes(from.userId) || access.allowedUsers.includes(from.userId);
}
