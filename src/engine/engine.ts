import { classifyFailure, type FailureClass, failureMessage } from '../claude/failures.ts';
import type { TurnResult } from '../claude/turn.ts';
import type { Db } from '../db/database.ts';
import { markConsumed, markProcessed, type MessageKey } from '../db/messages.ts';
import type { Logger } from '../log/logger.ts';
import { type ChatMessage, showsTyping } from '../message.ts';
import { chunkText } from '../text/chunk.ts';
import { clip } from '../text/clip.ts';
import { formatBatch, type History } from './envelope.ts';
import { abnormalOutcome, type AbnormalOutcome, HEARTBEAT_NUDGE, normalOutcome, type NormalOutcome, SILENT_STOP_NUDGE } from './outcome.ts';
import { buildRestoredContext } from './restore.ts';
import type { TypingIndicator } from './typing.ts';

export interface EngineWorker {
  send(text: string): Promise<void>;
  /** False when no turn is running to join; the engine keeps the batch for the next turn. */
  inject(text: string): Promise<boolean>;
  resetSession(): Promise<void>;
}

/** Deferred effects of a submitted message, run when the turn that consumed it ends. */
export interface TurnHooks {
  /** Claude Code processed the turn (reminders advance or close). */
  onSuccess?: () => Promise<void>;
  /** The turn was discarded before Claude Code finished it (reminders re-arm). */
  onFailure?: () => Promise<void>;
}

export interface EngineOptions {
  worker: EngineWorker;
  db: Db;
  debounceMs: number;
  typing: TypingIndicator;
  /** A plain message straight through the bot (bypassing MCP); never throws. */
  notify(chatId: number, text: string, replyTo?: number): Promise<void>;
  log: Logger;
}

interface Turn {
  /** Chats of the kick batch's human messages — who is waiting on this turn. */
  activeChats: Set<number>;
  /** Per waiting chat, its latest human message: where rescued text threads, what owner alerts link. */
  replyTargets: Map<number, ChatMessage>;
  startedAt: number;
  consumed: MessageKey[];
  hadRestoredContext: boolean;
  heartbeats: number;
  silentStopRetried: boolean;
  awaitingReply: boolean;
}

/** Synthetic reminders carry message id 0: nobody is waiting on them. */
const humans = (batch: readonly ChatMessage[]) => batch.filter((m) => m.messageId > 0);

/**
 * The turn controller: batches inbound messages (debounced), runs one Claude
 * Code turn at a time, injects messages that arrive mid-turn into it, and
 * decides what each turn's ending means — finish, continue after a
 * heartbeat, re-engage a silent stop, rescue undelivered text, or recover
 * from an abort, crash or API rejection.
 */
export class Engine {
  private pending: ChatMessage[] = [];
  private pendingHooks: TurnHooks[] = [];
  private turnHooks: TurnHooks[] = [];
  private processing = false;
  /** A result is being applied to its turn; the next turn waits for it (they share the turn state). */
  private handling = false;
  private opening: Promise<void> = Promise.resolve();
  private turn: Turn = newTurn([]);
  private restore: string | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private results: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly o: EngineOptions;
  private readonly log: Logger;
  private readonly history: History;

  constructor(options: EngineOptions) {
    this.o = options;
    this.log = options.log;
    this.history = { db: options.db, log: options.log };
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Seconds the current turn has been running; undefined when idle. */
  get turnElapsedSeconds(): number | undefined {
    return this.processing ? (performance.now() - this.turn.startedAt) / 1000 : undefined;
  }

  /** The messages the current (or last) turn answers — linked from owner error DMs. */
  get replyTargets(): ReadonlyMap<number, ChatMessage> {
    return this.turn.replyTargets;
  }

  async submit(msg: ChatMessage, hooks: TurnHooks = {}): Promise<void> {
    this.pending.push(msg);
    if (hooks.onSuccess || hooks.onFailure) this.pendingHooks.push(hooks);
    if (this.processing) return this.injectPending();
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.kickInBackground(), this.o.debounceMs);
  }

  /** The worker finished (or aborted) a turn. Results are handled one at a time, in order. */
  onResult(result: TurnResult): void {
    if (this.stopped) return;
    this.results = this.results.then(() => this.handle(result)).catch((err: unknown) => this.log.error('engine failed to handle a turn result', { err }));
  }

  primeTyping(chatId: number, topic: number | undefined): void {
    this.o.typing.prime(chatId, topic);
  }

  notifyChatReplied(chatId: number): void {
    this.o.typing.replied(chatId);
  }

  /** Build the `<restored_context>` digest now; the next turn opens with it. */
  stashRestoreContext(reason: string): void {
    this.restore = buildRestoredContext(this.o.db, reason);
  }

  async resetSession(): Promise<void> {
    await this.o.worker.resetSession();
  }

  /** Ends the engine: no further turns or results; buffered rows stay unconsumed for the boot replay. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.debounce);
    this.o.typing.stop();
    // A claimed reminder stays `processing` in the DB; the next boot re-arms it.
    this.pendingHooks = [];
    this.turnHooks = [];
  }

  /** A turn nobody awaits: only the worker's shutdown may cut its opening send short, and that is expected. */
  private kickInBackground(): void {
    this.kick().catch((err: unknown) => {
      if (!this.stopped) this.log.error('engine failed to start a turn', { err });
    });
  }

  private async kick(): Promise<void> {
    if (!this.pending.length || this.processing || this.handling || this.stopped) return;
    const batch = this.takePending();
    this.turn = newTurn(batch);
    const restore = this.restore;
    this.restore = undefined;
    this.turn.hadRestoredContext = restore !== undefined;
    const xml = formatBatch(batch, this.history);
    this.log.info(`starting turn with ${batch.length} msgs`);
    await this.sendTurn(restore === undefined ? xml : `${restore}\n${xml}`, batch);
  }

  /** Open or continue the turn with one message; injections wait until it has gone out. */
  private async sendTurn(text: string, batch: readonly ChatMessage[]): Promise<void> {
    this.processing = true;
    this.opening = this.open(text, batch);
    await this.opening;
  }

  private async open(text: string, batch: readonly ChatMessage[]): Promise<void> {
    await this.o.typing.start(new Set(humans(batch).filter(showsTyping).map((m) => m.chatId)));
    this.logHotPath('worker-send', batch, this.turn.activeChats);
    await this.o.worker.send(text);
    this.markConsumed(batch);
  }

  /** Deliver messages to the running turn — never before its opening send went out. */
  private async injectPending(): Promise<void> {
    await this.opening;
    if (!this.processing || !this.pending.length) return;
    const hooks = this.pendingHooks;
    const batch = this.takePending();
    this.turn.awaitingReply ||= humans(batch).length > 0;
    if (!(await this.o.worker.inject(formatBatch(batch, this.history)))) return this.requeue(batch, hooks);
    this.markConsumed(batch);
    // The dispatcher already showed typing for the human messages; reminders get none.
    this.logHotPath('inject', batch, new Set(batch.map((m) => m.chatId)));
  }

  /** The turn ended before an injection landed: keep the batch for the next turn. */
  private requeue(batch: ChatMessage[], hooks: TurnHooks[]): void {
    this.pending.unshift(...batch);
    this.turnHooks = this.turnHooks.filter((h) => !hooks.includes(h));
    this.pendingHooks.unshift(...hooks);
    if (!this.processing) this.kickInBackground();
  }

  private takePending(): ChatMessage[] {
    const batch = this.pending;
    this.pending = [];
    this.turnHooks.push(...this.pendingHooks);
    this.pendingHooks = [];
    return batch;
  }

  private markConsumed(batch: readonly ChatMessage[]): void {
    const keys = humans(batch).map((m) => [m.chatId, m.messageId] as const);
    this.turn.consumed.push(...keys);
    markConsumed(this.o.db, keys);
  }

  private async handle(result: TurnResult): Promise<void> {
    this.processing = false;
    this.handling = true;
    this.o.typing.stop();
    try {
      const abnormal = abnormalOutcome(result);
      if (abnormal) await this.applyAbnormal(abnormal, result);
      else await this.applyNormal(normalOutcome(result, this.turn), result);
    } finally {
      this.handling = false;
    }
    if (!this.processing && this.pending.length) await this.kick();
  }

  private async applyAbnormal(outcome: AbnormalOutcome, result: TurnResult): Promise<void> {
    switch (outcome.kind) {
      case 'session-reset':
        this.log.info('turn aborted: session reset requested by owner');
        return this.endTurn('failure');
      case 'crashed':
        this.log.error(`⚠️ Claude Code crashed mid-turn and is restarting: ${result.stderrTail.at(-1) || 'exited unexpectedly'}`);
        return this.endTurn('failure');
      case 'aborted':
        return this.onAborted(result, outcome.reason);
      case 'api-classified':
        this.log.error(failureMessage(outcome.failure));
        return this.endTurn('success');
      case 'api-reset':
        return this.onApiReset(result);
    }
  }

  private async applyNormal(outcome: NormalOutcome, result: TurnResult): Promise<void> {
    this.logTurnDone(result);
    switch (outcome.kind) {
      case 'dropped-text':
        return this.onDroppedText(result, outcome.failure);
      case 'heartbeat':
        return this.continueAfterHeartbeat();
      case 'silent-stop-retry':
        return this.retrySilentStop();
      case 'finish':
        return this.finish(result);
    }
  }

  private logTurnDone(result: TurnResult): void {
    this.log.info(`turn done (action=${result.control?.action ?? 'none'}, dropped_text=${result.droppedText}, text_blocks=${result.textBlocks.length})`);
    const stderrFailure = classifyFailure(result.stderrTail);
    if (stderrFailure) this.log.error(failureMessage(stderrFailure));
  }

  /** The model wrote its reply as plain text: deliver it — unless it is really a known failure. */
  private async onDroppedText(result: TurnResult, failure: FailureClass | undefined): Promise<void> {
    if (failure) this.log.error(failureMessage(failure));
    else await this.deliverText(result.textBlocks.join('\n\n'));
    return this.endTurn('success');
  }

  private async onAborted(result: TurnResult, reason: string): Promise<void> {
    this.log.error(`⚠️ Hit an internal error and had to restart mid-task (${reason}). Please resend the last message.`);
    if (result.textBlocks.length) await this.deliverText(result.textBlocks.join('\n\n'));
    return this.endTurn('success');
  }

  /**
   * The API rejected the turn and nothing classifies it (usage-policy refusal,
   * context overflow): the session history is poisoned, so tell the chats and
   * start fresh — with a recap, unless the recap itself opened the failed turn.
   */
  private async onApiReset(result: TurnResult): Promise<void> {
    this.log.error(`turn failed with API error: ${result.apiError ?? ''}`);
    const notice = this.prepareApiErrorReset();
    for (const chatId of this.turn.activeChats) {
      await this.o.notify(chatId, `${notice}\n\nDetails:\n${clip((result.apiError ?? '').trim(), 400)}`);
      this.log.info(`sent error notification to chat ${chatId}`);
    }
    await this.endTurn('success');
    await this.resetSession();
  }

  private prepareApiErrorReset(): string {
    const head = '⚠️ Claude rejected that request and the turn failed. ';
    if (this.turn.hadRestoredContext) {
      this.log.warn('restored digest preceded this api_error; next session starts plain');
      return `${head}I've started a completely fresh session — the recent recap could not be carried over (it may itself have caused the failure). Please rephrase and resend.`;
    }
    this.stashRestoreContext('api-error');
    return `${head}I've started a fresh session and will carry a short recap of the recent conversation into it. Please rephrase and resend.`;
  }

  /** The model posted a status and isn't done: keep the logical turn going. */
  private async continueAfterHeartbeat(): Promise<void> {
    this.turn.heartbeats++;
    const batch = this.takePending();
    this.turn.awaitingReply ||= humans(batch).length > 0;
    await this.sendTurn(batch.length ? formatBatch(batch, this.history) : HEARTBEAT_NUDGE, batch);
  }

  private async retrySilentStop(): Promise<void> {
    this.turn.silentStopRetried = true;
    this.log.warn('silent stop with a DM waiting — re-engaging CC to reply or confirm skip');
    await this.sendTurn(SILENT_STOP_NUDGE, []);
  }

  /** A clean ending: the only place a turn's messages become trusted (`processed=1`). */
  private async finish(result: TurnResult): Promise<void> {
    const action = result.control?.action;
    if (action === 'skip' && result.droppedText) {
      this.log.warn(`skip turn produced undelivered text — discarded as internal narration: ${JSON.stringify(result.textBlocks)}`);
    }
    if (this.turn.silentStopRetried && action === 'stop' && !result.userVisibleAction) {
      this.log.warn('silent stop persisted after re-engagement — user got no reply');
    }
    markProcessed(this.o.db, this.turn.consumed);
    return this.endTurn('success');
  }

  /** Text the model wrote but never sent: deliver it to every waiting chat, threaded to its message. */
  private async deliverText(text: string): Promise<void> {
    if (!text.trim()) return;
    const chunks = chunkText(text);
    for (const chatId of this.turn.activeChats) {
      const replyTo = this.turn.replyTargets.get(chatId)?.messageId;
      for (const chunk of chunks) await this.o.notify(chatId, chunk, replyTo);
      this.log.info(`delivered dropped text to chat ${chatId} (${chunks.length} chunk(s))`);
    }
  }

  private async endTurn(how: 'success' | 'failure'): Promise<void> {
    this.turn.activeChats.clear();
    const hooks = this.turnHooks;
    this.turnHooks = [];
    if (how === 'failure' && hooks.length) this.log.info(`reverting ${hooks.length} turn callback(s) on worker failure — caller will retry`);
    for (const hook of hooks) {
      const run = how === 'success' ? hook.onSuccess : hook.onFailure;
      await run?.().catch((err: unknown) => this.log.error(`turn-${how} callback failed`, { err }));
    }
  }

  private logHotPath(stage: string, batch: readonly ChatMessage[], chats: ReadonlySet<number>): void {
    const now = performance.now();
    const oldest = Math.min(now, ...batch.flatMap((m) => (m.receivedAt === undefined ? [] : [m.receivedAt])));
    const sorted = [...chats].sort((a, b) => a - b);
    this.log.info(`hot-path stage=${stage} chats=${JSON.stringify(sorted)} msgs=${batch.length} t_ms=${Math.trunc(now - oldest)}`);
  }
}

function newTurn(batch: readonly ChatMessage[]): Turn {
  const people = humans(batch);
  return {
    activeChats: new Set(people.map((m) => m.chatId)),
    replyTargets: new Map(people.map((m) => [m.chatId, m] as const)),
    startedAt: performance.now(),
    consumed: [],
    hadRestoredContext: false,
    heartbeats: 0,
    silentStopRetried: false,
    awaitingReply: people.length > 0,
  };
}

