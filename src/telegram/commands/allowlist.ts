import type { Logger } from '../../log/logger.ts';
import { loadAccess, POLICIES, type Policy, saveAccess } from '../access.ts';

// The access-management commands: each reads `access.json` fresh, edits it
// and returns the reply text. Additions never touch the policy.

/** `/allow <user|group> <id>`: add a DM user or a group (no write when already listed). */
export function allow(path: string, args: string[], log: Logger): string {
  const target = parseTarget(args, 'allow');
  if (typeof target === 'string') return target;
  const access = loadAccess(path, log);
  const ids = access[target.list];
  if (!ids.includes(target.id)) {
    ids.push(target.id);
    saveAccess(path, access);
  }
  return `${target.label} ${target.id} added to allowlist.`;
}

/** `/deny <user|group> <id>`: remove it (every copy, so a hand-made duplicate can't keep it allowed). */
export function deny(path: string, args: string[], log: Logger): string {
  const target = parseTarget(args, 'deny');
  if (typeof target === 'string') return target;
  const access = loadAccess(path, log);
  if (!access[target.list].includes(target.id)) return `${target.label} ${target.id} was not in the allowlist.`;
  access[target.list] = access[target.list].filter((id) => id !== target.id);
  saveAccess(path, access);
  return `${target.label} ${target.id} removed from allowlist.`;
}

/** `/policy <owner_only|allowlist|open>`: always rewrites the file. */
export function setPolicy(path: string, args: string[], log: Logger): string {
  const [policy] = args;
  if (policy === undefined || !POLICIES.includes(policy)) return `Usage: /policy <${POLICIES.join('|')}>`;
  saveAccess(path, { ...loadAccess(path, log), policy: policy as Policy });
  return `Policy set to: ${policy}`;
}

/** `/access`: the policy and both lists. */
export function accessText(path: string, ownerIds: readonly number[], log: Logger): string {
  const access = loadAccess(path, log);
  const list = (ids: number[]) => ids.join(', ') || '(none)';
  return `Policy: ${access.policy}\nAllowed users: ${list(access.allowedUsers)}\nAllowed chats: ${list(access.allowedChats)}\nOwner: ${ownerIds.join(', ')} (always allowed)`;
}

type Target = { list: 'allowedUsers' | 'allowedChats'; label: 'User' | 'Group'; id: number };

/** `<user|group> <id>` → the list and id, or the reply explaining what is wrong. */
function parseTarget(args: string[], verb: string): Target | string {
  const [kind, raw] = args;
  const lower = kind?.toLowerCase();
  if (raw === undefined || (lower !== 'user' && lower !== 'group')) return `Usage: /${verb} <user|group> <id>`;
  const id = /^-?\d+$/.test(raw) ? Number(raw) : undefined;
  // Past 2**53 the id would be saved rounded: refuse it rather than allow someone else.
  if (id === undefined || !Number.isSafeInteger(id)) return 'ID must be a number.';
  return lower === 'user' ? { list: 'allowedUsers', label: 'User', id } : { list: 'allowedChats', label: 'Group', id };
}
