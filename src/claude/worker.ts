import { rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Config } from '../config.ts';
import type { Logger } from '../log/logger.ts';
import type { Transcript } from '../log/transcript.ts';
import { isRecord } from '../text/json.ts';
import { FORBIDDEN_FLAG } from './argv.ts';
import { ToolErrorBreaker } from './breaker.ts';
import { WireCapture } from './capture.ts';
import { type ChildExit, type ChildProcess, spawnChild } from './child.ts';
import { failedMcpServers, relayError, userLine } from './events.ts';
import { type AbortReason, Turn, type TurnResult } from './turn.ts';

/** Stderr text meaning the `--resume` id is unusable (verified against claude 2.1.138). */
const STALE_SESSION_PATTERNS = ['No conversation found with session ID', '--resume requires a valid session ID'];

type Limits = Pick<
  Config,
  | 'livenessTimeoutSeconds' | 'livenessPollSeconds' | 'toolErrorMaxCount' | 'toolErrorWindowSeconds'
  | 'crashBackoffBase' | 'crashBackoffCap' | 'crashLimit' | 'crashWindowSeconds' | 'sessionIdPath' | 'ccLogsDir' | 'projectsDir'
>;

export interface WorkerOptions {
  /** Argv for a spawn resuming `sessionId` (fresh when undefined); prompt files are re-read each time. */
  argv(sessionId: string | undefined): string[];
  /** Fields of the "spawning claude" log line. */
  describe: { model: string; enabled: string[]; mcpTools: number };
  sessionId: string | undefined;
  config: Limits;
  /** `performance.now()` of the last tars MCP tool activity — busy, not wedged. */
  lastToolActivity(): number;
  log: Logger;
  transcript: Transcript;
  /** Exactly one per turn: the model's own ending, or an abort sentinel. */
  onResult(result: TurnResult): void;
  onStaleSession(staleId: string): Promise<void>;
  /** The crash budget is spent; the app must exit so its supervisor restarts it. */
  onGiveUp(crashCount: number): void;
}

/**
 * Owns the one `claude` child: spawns it, feeds it stream-json, turns its
 * output into `TurnResult`s, and keeps it alive — respawning (with the
 * current session) after crashes with exponential backoff, after its own
 * aborts (tool-error breaker, liveness watchdog, session reset), and with a
 * fresh session when Claude Code rejects a stale `--resume` id.
 */
export class ClaudeWorker {
  private child: ChildProcess | undefined;
  private ready = deferred<ChildProcess>();
  private sessionId: string | undefined;
  /** The id the current child was started with (`--resume`), for stale-session detection. */
  private resumed: string | undefined;
  private childStderr: string[] = [];
  private reportedServers = new Set<string>();
  private turn: Turn | undefined;
  /**
   * The current turn's first message until Claude Code starts the turn (its
   * `system/init`): events before that belong to an earlier turn, and a stale
   * session that never started it hands it to the fresh one.
   */
  private opening: string | undefined;
  private lastEventAt = performance.now();
  private intentional: AbortReason | undefined;
  private crashTimes: number[] = [];
  private liveness: NodeJS.Timeout | undefined;
  private readonly stopping = new AbortController();
  private readonly breaker: ToolErrorBreaker;
  private readonly capture: WireCapture;
  private readonly o: WorkerOptions;
  private readonly log: Logger;

  constructor(options: WorkerOptions) {
    this.o = options;
    this.log = options.log;
    this.sessionId = options.sessionId;
    this.breaker = new ToolErrorBreaker(options.config.toolErrorMaxCount, options.config.toolErrorWindowSeconds);
    this.capture = new WireCapture(options.config.ccLogsDir, options.log);
  }

  /** First spawn; rejects (failing boot) when `claude` can't be started. */
  async start(): Promise<void> {
    const child = this.spawn();
    await child.spawned;
    this.liveness = setInterval(() => this.checkLiveness(), this.o.config.livenessPollSeconds * 1000);
  }

  /** Start a turn: one stream-json user message. Waits out a respawn in progress. */
  async send(text: string): Promise<void> {
    const child = await this.whenReady();
    this.turn = new Turn(this.log, this.o.transcript);
    this.opening = text;
    this.lastEventAt = performance.now();
    this.breaker.reset();
    this.o.transcript.ccUser(text);
    await this.write(child, text);
  }

  /** Add a message to the running turn; false when there is none to join (the caller re-buffers). */
  async inject(text: string): Promise<boolean> {
    const child = this.child;
    if (!child || !this.turn) return false;
    this.o.transcript.ccUser(text);
    return this.write(child, text);
  }

  /** Owner-requested fresh session: drop the id and respawn without `--resume`. */
  async resetSession(): Promise<void> {
    this.log.warn(`session reset: dropping session_id=${this.sessionId ?? 'none'}, respawning fresh`);
    this.sessionId = undefined;
    rmSync(this.o.config.sessionIdPath, { force: true });
    if (this.turn) this.emit(this.turn.abort('session-reset'));
    await this.killChild('session-reset');
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    clearInterval(this.liveness);
    this.ready.reject(new Error('claude worker stopped'));
    await this.child?.kill();
    this.capture.close();
  }

  /** Last-resort SIGKILL of the child's process group, for fatal exits. */
  killNow(): void {
    this.child?.killNow();
  }

  private spawn(): ChildProcess {
    const argv = this.o.argv(this.sessionId);
    if (argv.includes(FORBIDDEN_FLAG)) throw new Error(`${FORBIDDEN_FLAG} found in argv at spawn time — refusing to start`);
    const { model, enabled, mcpTools } = this.o.describe;
    this.log.info(`spawning claude (model=${model}, enabled=${enabled.length ? JSON.stringify(enabled) : '[base only]'}, mcp_tools=${mcpTools})`);
    this.capture.open(this.sessionId);
    this.resumed = argv.includes('--resume') ? this.sessionId : undefined;
    this.childStderr = [];
    this.reportedServers = new Set();
    this.intentional = undefined;
    const child = spawnChild(argv, this.o.config.projectsDir, (line) => this.onStdout(line), (line) => this.onStderr(line));
    this.child = child;
    child.spawned.then(() => {
      if (this.child !== child) return;
      this.ready.resolve(child);
      if (this.turn && this.opening !== undefined) void this.write(child, this.opening);
    }, () => {});
    child.exited.then((exit) => this.onExit(child, exit)).catch((err: unknown) => this.log.error('claude supervisor failed', { err }));
    return child;
  }

  private onStdout(line: string): void {
    this.capture.writeStream(line);
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.log.debug(`cc stdout non-json line: ${JSON.stringify(line.slice(0, 200))}`);
      return;
    }
    this.lastEventAt = performance.now();
    if (!isRecord(event)) return;
    try {
      this.handleEvent(event);
    } catch (err) {
      this.log.error('failed to handle a cc stdout event', { err });
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    if (event.type !== 'user') relayError(event, this.log);
    if (event.type === 'system' && event.subtype === 'init') return this.onInit(event);
    const turn = this.turn;
    // No turn collecting (a dying session's stray events), or this turn's init
    // hasn't arrived yet (the tail of a prior Claude Code turn): drop.
    if (!turn || this.opening !== undefined) return;
    if (event.type === 'assistant') turn.addAssistant(event);
    else if (event.type === 'user') this.onToolResults(turn.toolResults(event));
    else if (event.type === 'result') this.emit(turn.finish(event));
  }

  private onInit(event: Record<string, unknown>): void {
    this.opening = undefined;
    if (typeof event.session_id === 'string') this.learnSession(event.session_id);
    for (const { name, status } of failedMcpServers(event)) {
      if (this.reportedServers.has(name)) continue;
      this.reportedServers.add(name);
      this.log.error(`mcp server ${name} did not connect (status=${status}) — its tools won't be available this session`);
    }
  }

  /** Remember (and persist) the session so restarts and respawns resume it. */
  private learnSession(id: string): void {
    this.log.info(`cc session id ${id}`);
    this.capture.sessionKnown(id);
    if (id === this.sessionId) return;
    this.sessionId = id;
    try {
      writeFileSync(this.o.config.sessionIdPath, id);
    } catch (err) {
      this.log.warn(`could not persist session id: ${(err as Error).message}`);
    }
  }

  private onToolResults(errors: boolean[]): void {
    for (const isError of errors) {
      if (!isError) {
        this.breaker.reset();
      } else if (this.breaker.recordError()) {
        const why = `cc tool-error circuit breaker tripped (reason=count): ${this.breaker.describe()}. Terminating to trigger respawn.`;
        return this.abortTurn('tool-error-limit', why);
      }
    }
  }

  private onStderr(raw: string): void {
    const line = raw.trimEnd();
    this.childStderr = [...this.childStderr, line].slice(-10);
    this.turn?.stderr.push(line);
    this.capture.writeStderr(line);
    if (line) this.log.warn(`cc stderr: ${line}`);
  }

  private checkLiveness(): void {
    if (!this.child || !this.turn) return;
    const timeout = this.o.config.livenessTimeoutSeconds;
    const silence = (performance.now() - Math.max(this.lastEventAt, this.o.lastToolActivity())) / 1000;
    if (silence <= timeout) return;
    const why = `cc subprocess wedged mid-turn: no activity for ${silence.toFixed(0)}s (timeout=${timeout.toFixed(0)}s). Terminating to trigger respawn.`;
    this.abortTurn('liveness-wedge', why);
  }

  /** Cut the running turn short; the engine alerts the owner about it, so this is only a warning. */
  private abortTurn(reason: AbortReason, why: string): void {
    this.log.warn(why);
    if (this.turn) this.emit(this.turn.abort(reason));
    void this.killChild(reason);
  }

  private emit(result: TurnResult): void {
    this.turn = undefined;
    this.opening = undefined;
    this.o.onResult(result);
  }

  private async killChild(reason: AbortReason): Promise<void> {
    if (!this.child) return;
    this.renewReady(); // a send from here on waits for the respawned child, not this dying one
    this.intentional = reason;
    await this.child.kill();
  }

  private async onExit(child: ChildProcess, exit: ChildExit): Promise<void> {
    if (this.child !== child) return;
    this.child = undefined;
    this.capture.close();
    this.renewReady();
    if (this.stopping.signal.aborted) return;
    const rc = exit.code ?? 'none';
    const intentional = this.intentional;
    this.intentional = undefined;
    if (intentional) {
      this.log.info(`cc subprocess exited rc=${rc} on intentional ${intentional} — respawning`);
      return this.respawnAfter(this.o.config.crashBackoffBase);
    }
    return this.onCrash(exit, rc);
  }

  /** The child died on its own: drop a stale session (its unstarted turn moves on), or abort the turn and respawn with backoff. */
  private async onCrash(exit: ChildExit, rc: number | string): Promise<void> {
    if (exit.error) this.log.error(`claude could not be started: ${exit.error.message}`);
    const stale = this.resumed !== undefined && this.childStderr.some((line) => STALE_SESSION_PATTERNS.some((p) => line.includes(p)));
    if (stale) return this.recoverStale(this.resumed as string);
    const crashedTurn = this.turn;
    if (crashedTurn) this.emit(crashedTurn.abort('crash'));
    const exited = `cc subprocess exited rc=${rc}; recent stderr=${JSON.stringify(this.childStderr.slice(-5))}`;
    // The engine alerts the owner about a crashed turn; an idle crash is the worker's to report.
    if (crashedTurn) this.log.warn(exited);
    else this.log.error(exited);
    return this.recoverCrash();
  }

  private async recoverStale(staleId: string): Promise<void> {
    this.log.warn(`cc subprocess rejected stale session_id=${staleId}; dropping it and respawning with a fresh session`);
    this.sessionId = undefined;
    rmSync(this.o.config.sessionIdPath, { force: true });
    await this.o.onStaleSession(staleId).catch((err: unknown) => this.log.debug('on_stale_session callback failed', { err }));
    return this.respawnAfter(this.o.config.crashBackoffBase);
  }

  /** Respawn with exponential backoff, or give up once the crash budget for the window is spent. */
  private async recoverCrash(): Promise<void> {
    const { crashBackoffBase, crashBackoffCap, crashLimit, crashWindowSeconds } = this.o.config;
    const now = performance.now();
    this.crashTimes = [...this.crashTimes.filter((t) => now - t < crashWindowSeconds * 1000), now];
    if (this.crashTimes.length >= crashLimit) return this.o.onGiveUp(this.crashTimes.length);
    const attempt = this.crashTimes.length;
    const backoff = Math.min(crashBackoffCap, crashBackoffBase * 2 ** (attempt - 1));
    this.log.warn(`respawning cc in ${backoff.toFixed(1)}s (attempt ${attempt})`);
    return this.respawnAfter(backoff);
  }

  private async respawnAfter(seconds: number): Promise<void> {
    await sleep(seconds * 1000, undefined, { signal: this.stopping.signal }).catch(() => {});
    if (this.stopping.signal.aborted) return;
    try {
      this.spawn();
    } catch (err) {
      this.log.error('claude respawn failed', { err });
      return this.recoverCrash();
    }
  }

  /** Swap in a pending `ready`; whoever still waits on the old one follows it to the next child. */
  private renewReady(): void {
    const next = deferred<ChildProcess>();
    this.ready.resolve(next.promise);
    this.ready = next;
  }

  private async whenReady(): Promise<ChildProcess> {
    if (this.stopping.signal.aborted) throw new Error('claude worker stopped');
    return this.ready.promise;
  }

  /** Write one stream-json user message; a dead child surfaces through its exit, not here. */
  private async write(child: ChildProcess, text: string): Promise<boolean> {
    try {
      await child.write(userLine(text));
      return true;
    } catch {
      this.log.warn('inject failed: stdin closed; queueing for next turn');
      return false;
    }
  }
}

function deferred<T>(): PromiseWithResolvers<T> {
  const d = Promise.withResolvers<T>();
  d.promise.catch(() => {});
  return d;
}
