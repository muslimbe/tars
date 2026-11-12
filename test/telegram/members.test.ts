import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBot } from '../../src/telegram/bot.ts';
import { GroupMembers } from '../../src/telegram/members.ts';
import { FakeTelegram } from '../fakes/telegram.ts';
import { memoryLogger } from '../helpers/log.ts';

function setup() {
  const fake = new FakeTelegram();
  const bot = createBot('1:t', { network: fake.transformer, botInfo: fake.botInfo });
  const log = memoryLogger();
  return { fake, log, members: new GroupMembers({ api: bot.api, log }) };
}

const member = (status: string, extra: object = {}) => ({ status, user: { id: 5, is_bot: false, first_name: 'U' }, ...extra });

afterEach(() => {
  vi.useRealTimers();
});

describe('group members', () => {
  it.each([
    ['creator', {}, true],
    ['administrator', {}, true],
    ['member', {}, true],
    ['restricted', { is_member: true }, true],
    ['restricted', { is_member: false }, false],
    ['left', {}, false],
    ['kicked', {}, false],
  ])('counts %s %o as a member: %s', async (status, extra, expected) => {
    const t = setup();
    t.fake.respond('getChatMember', member(status, extra));
    expect(await t.members.isMember(5, [-100])).toBe(expected);
  });

  it('asks each group until one has the user', async () => {
    const t = setup();
    t.fake.respond('getChatMember', member('left'));
    t.fake.respond('getChatMember', member('member'));
    expect(await t.members.isMember(5, [-100, -200, -300])).toBe(true);
    expect(t.fake.sent('getChatMember').map((c) => c.payload.chat_id)).toEqual([-100, -200]);
  });

  it('remembers an answer for a minute, then asks again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t = setup();
    t.fake.respond('getChatMember', member('member'));
    expect(await t.members.isMember(5, [-100])).toBe(true);
    vi.advanceTimersByTime(59_000);
    expect(await t.members.isMember(5, [-100])).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(await t.members.isMember(5, [-100])).toBe(false);
    expect(t.fake.sent('getChatMember')).toHaveLength(2);
  });

  it('logs a failed check and treats it as not a member', async () => {
    const t = setup();
    t.fake.fail('getChatMember', 400, 'Bad Request: chat not found');
    expect(await t.members.isMember(5, [-100])).toBe(false);
    expect(t.log.text()).toContain('WARNING membership check failed for user 5 in chat -100');
  });
});
