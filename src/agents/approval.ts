import type { Api, Context } from 'grammy';

import type { Db } from '../db/database.ts';
import { type AgentTaskRow, decideAgentTask } from '../db/agent-tasks.ts';
import type { Logger } from '../log/logger.ts';

/** Button data on an approval message. */
export const APPROVAL_BUTTON = /^agent (run|cancel) (\d+)$/;

export interface AgentApprovalOptions {
  api: Api;
  db: Db;
  /** The owner account that gets the approval messages; any owner account may press. */
  agentApproverId: number;
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
    const buttons = [[{ text: '▶️ Boshlash', callback_data: `agent run ${task.id}` }, { text: '✖️ Bekor qilish', callback_data: `agent cancel ${task.id}` }]];
    await this.o.api.sendMessage(this.o.agentApproverId, approvalText(task), { reply_markup: { inline_keyboard: buttons } });
  }

  /** A follow-up needs no button, but the owner still sees what the agent was told. */
  async announce(task: AgentTaskRow): Promise<void> {
    await this.o.api.sendMessage(this.o.agentApproverId, `↪️ Agent davomi #${task.id} (vazifa #${task.parent_id}) — ${task.repo}\n${modelLine(task)}\n${task.prompt}`);
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
    if (!id) return 'Nomaʼlum tugma.';
    const run = action === 'run';
    if (!decideAgentTask(this.o.db, Number(id), run)) return 'Bu vazifa allaqachon hal qilingan.';
    this.o.log.info(`agent task #${id} ${run ? 'approved' : 'cancelled'} by ${from}`);
    return run ? '▶️ Tasdiqlandi — kompyuteringizdagi agent uni bir daqiqa ichida oladi.' : '✖️ Bekor qilindi.';
  }
}

function approvalText(t: AgentTaskRow): string {
  const jira = t.jira_key ? `Jira: ${t.jira_key}\n` : '';
  return `🤖 Agent vazifasi #${t.id} — ${t.repo}\n${jira}${modelLine(t)}${t.title}\n\n${t.prompt}`;
}

const modelLine = (t: AgentTaskRow): string => (t.model ? `Model: ${t.model}\n` : '');
