import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type Access, gate, loadAccess, saveAccess } from '../../src/telegram/access.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

const OWNER = 1;
const access = (policy: Access['policy'], allowedUsers: number[] = [], allowedChats: number[] = []): Access => ({ policy, allowedUsers, allowedChats });
const dm = (userId: number) => ({ chatId: userId, userId, chatType: 'private' });
const group = (chatId: number, userId = 7) => ({ chatId, userId, chatType: 'supergroup' });

describe('access gate', () => {
  it('owner_only lets only the owner DM and blocks every group', () => {
    expect(gate(access('owner_only'), [OWNER], dm(OWNER))).toBe(true);
    expect(gate(access('owner_only'), [OWNER], dm(2))).toBe(false);
    expect(gate(access('owner_only', [], [-100]), [OWNER], group(-100, OWNER))).toBe(false);
  });

  it("lets the owner's other accounts DM like the owner, but not into groups", () => {
    const owners = [OWNER, 9];
    expect(gate(access('owner_only'), owners, dm(9))).toBe(true);
    expect(gate(access('allowlist'), owners, dm(9))).toBe(true);
    expect(gate(access('allowlist', [], [-100]), owners, group(-200, 9))).toBe(false);
  });

  it('allowlist decides DMs by user and groups by chat; open allows all', () => {
    const a = access('allowlist', [2], [-100]);
    expect(gate(a, [OWNER], dm(OWNER))).toBe(true);
    expect(gate(a, [OWNER], dm(2))).toBe(true);
    expect(gate(a, [OWNER], dm(3))).toBe(false);
    expect(gate(a, [OWNER], group(-100))).toBe(true);
    expect(gate(a, [OWNER], group(-200, OWNER))).toBe(false);
    expect(gate(a, [OWNER], { chatId: 3, userId: 2, chatType: undefined })).toBe(true);
    expect(gate(access('open'), [OWNER], group(-999, 5))).toBe(true);
  });
});

describe('access.json', () => {
  it('defaults when missing and keeps integer ids, digit strings included', () => {
    const dir = tempDir();
    expect(loadAccess(join(dir, 'access.json'), memoryLogger())).toEqual(access('owner_only'));
    writeFileSync(join(dir, 'access.json'), JSON.stringify({ policy: 'allowlist', allowed_users: [5, '6', ' 7 ', true, 1.5, null, 'x'], allowed_chats: ['-100123'], extra: 1 }));
    expect(loadAccess(join(dir, 'access.json'), memoryLogger())).toEqual(access('allowlist', [5, 6, 7], [-100123]));
  });

  it('falls back to owner_only on an invalid policy', () => {
    const path = join(tempDir(), 'access.json');
    writeFileSync(path, JSON.stringify({ policy: 'yolo' }));
    const log = memoryLogger();
    expect(loadAccess(path, log).policy).toBe('owner_only');
    expect(log.text()).toContain('WARNING invalid policy "yolo" in access.json, defaulting to owner_only');
  });

  it.each(['{not json', '[1, 2]'])('moves a corrupt file aside and fails closed (%s)', (body) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'access.json'), body);
    const log = memoryLogger();
    expect(loadAccess(join(dir, 'access.json'), log)).toEqual(access('owner_only'));
    expect(readdirSync(dir).some((name) => /^access\.corrupt-\d+\.json$/.test(name))).toBe(true);
    expect(existsSync(join(dir, 'access.json'))).toBe(false);
    expect(log.text()).toMatch(/WARNING corrupt access\.json, renaming to access\.corrupt-\d+\.json: /);
  });

  it('saves atomically as indented JSON', () => {
    const dir = tempDir();
    saveAccess(join(dir, 'access.json'), access('allowlist', [5], []));
    expect(readFileSync(join(dir, 'access.json'), 'utf8')).toBe('{\n  "policy": "allowlist",\n  "allowed_users": [\n    5\n  ],\n  "allowed_chats": []\n}\n');
    expect(existsSync(join(dir, 'access.tmp'))).toBe(false);
  });
});
