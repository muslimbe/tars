import type { Api, Context } from 'grammy';

import type { Db } from '../db/database.ts';
import { type AgentTaskRow, decideAgentTask } from '../db/agent-tasks.ts';
import type { Logger } from '../log/logger.ts';

/** Button data on an approval message. */
export const APPROVAL_BUTTON = /^agent (run|cancel) (\d+)$/;

export interface AgentApprovalOptions {
  api: Api;
  db: Db;
  /** The owner's main account gets the approval messages; any owner account may press. */
  ownerId: number;
  ownerIds: readonly number[];
  log: Logger;
}

/**
 * Nothing reaches the owner's computer on the model's word alone: every task
 * waits for an owner to read its full text and press Run. The model can be
 * talked into proposing a task; only an owner's button approves it.
 */
export class AgentApproval {
  private readonly o: AgentApprovalOptions;

  constructor(options: AgentApprovalOptions) {
    this.o = options;
  }

  /** Show the owner the whole task with Run / Cancel buttons. */
  async propose(task: AgentTaskRow): Promise<void> {
    const buttons = [[{ text: '▶️ Run', callback_data: `agent run ${task.id}` }, { text: '✖️ Cancel', callback_data: `agent cancel ${task.id}` }]];
    await this.o.api.sendMessage(this.o.ownerId, approvalText(task), { reply_markup: { inline_keyboard: buttons } });
  }

  /** A Run / Cancel button was pressed. */
  async pressed(ctx: Context): Promise<void> {
    const query = ctx.callbackQuery;
    const from = ctx.from?.id ?? 0;
    if (!query?.data || !this.o.ownerIds.includes(from)) return void (await ctx.answerCallbackQuery());
    const outcome = this.decide(query.data, from);
    await ctx.answerCallbackQuery({ text: outcome });
    // The message keeps its text and loses its buttons, so it can't be pressed twice.
    if (query.message && 'text' in query.message) await ctx.editMessageText(`${query.message.text}\n\n${outcome}`);
  }

  private decide(data: string, from: number): string {
    const [, action, id] = APPROVAL_BUTTON.exec(data) ?? [];
    if (!id) return 'Unknown button.';
    const run = action === 'run';
    if (!decideAgentTask(this.o.db, Number(id), run)) return 'Already decided.';
    this.o.log.info(`agent task #${id} ${run ? 'approved' : 'cancelled'} by ${from}`);
    return run ? '▶️ Approved — the agent on your computer will pick it up.' : '✖️ Cancelled.';
  }
}

function approvalText(t: AgentTaskRow): string {
  const jira = t.jira_key ? `Jira: ${t.jira_key}\n` : '';
  return `🤖 Agent task #${t.id} — ${t.repo}\n${jira}${t.title}\n\n${t.prompt}`;
}
