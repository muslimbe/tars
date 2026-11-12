import type { Api } from 'grammy';

import type { Logger } from '../log/logger.ts';

/** How long an answer is trusted: someone who leaves a group loses DM access within this window. */
const TTL_MS = 60_000;

export interface GroupMembersOptions {
  api: Api;
  log: Logger;
}

/**
 * Who belongs to the allowed groups, asked from Telegram. Answers are
 * remembered for a minute so a chatty member, or a stranger flooding DMs,
 * doesn't cost an API call per message.
 */
export class GroupMembers {
  private readonly api: Api;
  private readonly log: Logger;
  private readonly cache = new Map<number, { member: boolean; until: number }>();

  constructor(options: GroupMembersOptions) {
    this.api = options.api;
    this.log = options.log;
  }

  async isMember(userId: number, chatIds: readonly number[]): Promise<boolean> {
    const hit = this.cache.get(userId);
    if (hit && hit.until > Date.now()) return hit.member;
    const member = await this.inAny(userId, chatIds);
    this.cache.set(userId, { member, until: Date.now() + TTL_MS });
    return member;
  }

  private async inAny(userId: number, chatIds: readonly number[]): Promise<boolean> {
    for (const chatId of chatIds) if (await this.inChat(chatId, userId)) return true;
    return false;
  }

  private async inChat(chatId: number, userId: number): Promise<boolean> {
    try {
      const m = await this.api.getChatMember(chatId, userId);
      return m.status === 'creator' || m.status === 'administrator' || m.status === 'member' || (m.status === 'restricted' && m.is_member);
    } catch (err) {
      this.log.warn(`membership check failed for user ${userId} in chat ${chatId}`, { err });
      return false;
    }
  }
}
