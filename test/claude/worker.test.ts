import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TurnResult } from '../../src/claude/turn.ts';
import { ClaudeWorker, type WorkerOptions } from '../../src/claude/worker.ts';
import { Transcript } from '../../src/log/transcript.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';
import { until } from '../helpers/wait.ts';

const FAKE = fileURLToPath(new URL('../fakes/fake-claude.ts', import.meta.url));

const LIMITS = {
  livenessTimeoutSeconds: 600,
  livenessPollSeconds: 30,
  toolErrorMaxCount: 3,
  toolErrorWindowSeconds: 300,
  crashBackoffBase: 0.05,
  crashBackoffCap: 0.2,
  crashLimit: 10,
  crashWindowSeconds: 600,
};

const workers: ClaudeWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
  vi.unstubAllEnvs();
});

function harness(overrides: Partial<WorkerOptions> & { limits?: Partial<typeof LIMITS> } = {}) {
  const dir = tempDir();
  const mcpConfig = join(dir, 'mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { tars: { type: 'http', url: 'http://127.0.0.1:9/mcp' } } }));
  const fakeLog = join(dir, 'fake.jsonl');
  vi.stubEnv('FAKE_CLAUDE_LOG', fakeLog);
  const log = memoryLogger();
  const results: TurnResult[] = [];
  const events = { staleIds: [] as string[], gaveUp: [] as number[] };
  const worker = new ClaudeWorker({
    argv: (sid) => [FAKE, '--mcp-config', mcpConfig, ...(sid ? ['--resume', sid] : [])],
    describe: { model: 'claude-test', enabled: [], mcpTools: 0 },
    sessionId: undefined,
    config: { ...LIMITS, ...overrides.limits, sessionIdPath: join(dir, 'session_id'), ccLogsDir: join(dir, 'cc_logs'), projectsDir: dir },
    lastToolActivity: () => 0,
    log,
    transcript: new Transcript(log, 'compact'),
    onResult: (r) => results.push(r),
    onStaleSession: (id) => {
      events.staleIds.push(id);
      return Promise.resolve();
    },
    onGiveUp: (n) => void events.gaveUp.push(n),
    ...overrides,
  });
  workers.push(worker);
  const spawns = () =>
    existsSync(fakeLog)
      ? readFileSync(fakeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; argv?: string[]; pid: number; probe?: string; cwd?: string }).filter((e) => e.kind === 'argv')
      : [];
  return { worker, results, events, log, dir, spawns, nextResult: (n = results.length + 1) => until(() => results[n - 1]) };
}

const control = (action: string, reason = 'test') => `#fake control ${JSON.stringify({ action, reason })}`;

describe('ClaudeWorker', () => {
  it('runs a turn and hands back the control action', async () => {
    const h = harness();
    await h.worker.start();
    await h.worker.send(control('stop', 'replied'));
    const result = await h.nextResult();
    expect(result.control).toEqual({ action: 'stop', reason: 'replied' });
    expect(result.droppedText).toBe(false);
    expect(result.abortedReason).toBeUndefined();
    expect(h.log.text()).toContain('spawning claude (model=claude-test, enabled=[base only], mcp_tools=0)');
  });

  it('flags text that reached nobody as dropped', async () => {
    const h = harness();
    await h.worker.start();
    await h.worker.send(`#fake text the answer\n${control('stop')}`);
    expect(await h.nextResult()).toMatchObject({ textBlocks: ['the answer'], droppedText: true, userVisibleAction: false });
  });

  it('learns the session id from init and persists it', async () => {
    const h = harness();
    await h.worker.start();
    await h.worker.send(control('stop'));
    await h.nextResult();
    expect(readFileSync(join(h.dir, 'session_id'), 'utf8')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports a crash mid-turn and respawns resuming the same session', async () => {
    const h = harness();
    await h.worker.start();
    await h.worker.send(control('stop'));
    await h.nextResult();
    const session = readFileSync(join(h.dir, 'session_id'), 'utf8');
    await h.worker.send(`#fake text half an answer\n#fake crash`);
    expect(await h.nextResult()).toMatchObject({ abortedReason: 'crash', textBlocks: ['half an answer'] });
    await until(() => h.spawns()[1]);
    expect(h.spawns()[1]?.argv).toEqual(expect.arrayContaining(['--resume', session]));
    expect(h.log.text()).toContain('respawning cc in 0.1s (attempt 1)');
  });

  it('gives up (so the app can exit) once the crash budget is spent', async () => {
    const h = harness({ limits: { crashLimit: 2 } });
    await h.worker.start();
    await h.worker.send('#fake crash');
    await h.nextResult();
    await h.worker.send('#fake crash');
    await until(() => h.events.gaveUp[0]);
    expect(h.events.gaveUp).toEqual([2]);
  });

  it('recovers from a stale --resume id with a fresh session', async () => {
    vi.stubEnv('FAKE_CLAUDE_STALE', '1');
    const h = harness({ sessionId: 'dead-session' });
    await h.worker.start();
    await until(() => h.events.staleIds[0]);
    expect(h.events.staleIds).toEqual(['dead-session']);
    await h.worker.send(control('stop'));
    await h.nextResult();
    expect(h.spawns()[1]?.argv).not.toContain('--resume');
    expect(h.log.text()).toContain('cc subprocess rejected stale session_id=dead-session');
  });

  it('hands a turn written to a stale session over to the fresh one instead of losing it', async () => {
    vi.stubEnv('FAKE_CLAUDE_STALE', '1');
    const h = harness({ sessionId: 'dead-session' });
    await h.worker.start();
    await h.worker.send(control('stop', 'made it'));
    expect(await h.nextResult()).toMatchObject({ control: { reason: 'made it' } });
    const errors = h.log.records.filter((r) => r.level === 'ERROR' && !r.msg.startsWith('mcp server tars did not connect'));
    expect(errors.map((r) => r.msg)).toEqual([]);
  });

  it('trips the tool-error breaker, keeping the partial text', async () => {
    const h = harness();
    await h.worker.start();
    await h.worker.send(`#fake text partial\n#fake tool-errors 3\n${control('stop')}`);
    expect(await h.nextResult()).toMatchObject({ abortedReason: 'tool-error-limit', textBlocks: ['partial'] });
    expect(h.log.text()).toContain('cc tool-error circuit breaker tripped (reason=count): 3 errors in');
    await until(() => h.spawns()[1]);
    expect(h.log.text()).toMatch(/cc subprocess exited rc=\S+ on intentional tool-error-limit — respawning/);
  });

  it('leaves the alert for a turn cut short to the engine: a crash, wedge or breaker trip logs no worker ERROR', async () => {
    const h = harness({ limits: { livenessTimeoutSeconds: 0.3, livenessPollSeconds: 0.1 } });
    await h.worker.start();
    await h.worker.send('#fake crash');
    await h.nextResult();
    await h.worker.send('#fake hang');
    await h.nextResult(2);
    await h.worker.send(`#fake tool-errors 3\n${control('stop')}`);
    expect(await h.nextResult(3)).toMatchObject({ abortedReason: 'tool-error-limit' });
    // The harness's MCP server is unreachable on purpose; that error is not about the turn.
    const errors = h.log.records.filter((r) => r.level === 'ERROR' && !r.msg.startsWith('mcp server tars did not connect'));
    expect(errors.map((r) => r.msg)).toEqual([]);
  });

  it('kills a wedged turn on liveness timeout', async () => {
    const h = harness({ limits: { livenessTimeoutSeconds: 0.3, livenessPollSeconds: 0.1 } });
    await h.worker.start();
    await h.worker.send('#fake hang');
    expect(await h.nextResult()).toMatchObject({ abortedReason: 'liveness-wedge' });
    expect(h.log.text()).toContain('cc subprocess wedged mid-turn');
  });

  it('resets the session mid-turn and respawns fresh; a send in the gap waits', async () => {
    const h = harness();
    await h.worker.start();
    await h.worker.send(control('stop'));
    await h.nextResult();
    await h.worker.send('#fake hang');
    await h.worker.resetSession();
    expect(await h.nextResult(2)).toMatchObject({ abortedReason: 'session-reset' });
    expect(existsSync(join(h.dir, 'session_id'))).toBe(false);
    await h.worker.send(control('stop', 'after reset'));
    expect((await h.nextResult(3)).control?.reason).toBe('after reset');
    expect(h.spawns()[1]?.argv).not.toContain('--resume');
  });

  it('holds a send issued while the reset kills the child for the fresh one', async () => {
    const h = harness();
    await h.worker.start();
    await h.worker.send('#fake hang');
    const reset = h.worker.resetSession();
    await h.worker.send(control('stop', 'after reset'));
    await reset;
    expect((await h.nextResult(2)).control?.reason).toBe('after reset');
  });

  it('keeps a send waiting across a respawn that fails to start', async () => {
    let spawned = 0;
    const h = harness({ argv: (sid) => (++spawned === 2 ? ['/nonexistent/claude-binary'] : [FAKE, ...(sid ? ['--resume', sid] : [])]) });
    await h.worker.start();
    await h.worker.send('#fake crash');
    await h.nextResult();
    await h.worker.send(control('stop', 'survived'));
    expect((await h.nextResult(2)).control?.reason).toBe('survived');
    expect(spawned).toBe(3);
  });

  it('folds an injected message into the running turn', async () => {
    const h = harness();
    await h.worker.start();
    await h.worker.send(`#fake sleep 300\n${control('stop')}`);
    expect(await h.worker.inject('#fake text from the follow-up')).toBe(true);
    const result = await h.nextResult();
    expect(result.textBlocks).toEqual(['from the follow-up']);
    expect(h.results).toHaveLength(1);
    expect(await h.worker.inject('late')).toBe(false);
  });

  it('carries only the stderr of its own turn', async () => {
    const h = harness();
    await h.worker.start();
    // stderr and stdout are separate pipes; give the line time to land before the result.
    await h.worker.send(`#fake stderr rate limit reached\n#fake sleep 100\n${control('stop')}`);
    expect((await h.nextResult()).stderrTail).toEqual(['rate limit reached']);
    await h.worker.send(control('stop'));
    expect((await h.nextResult(2)).stderrTail).toEqual([]);
  });

  it('surfaces an API-rejected turn', async () => {
    const h = harness();
    await h.worker.start();
    await h.worker.send('#fake api-error Usage Policy violation');
    expect((await h.nextResult()).apiError).toBe('Usage Policy violation');
  });

  it('reports a failed MCP server once per process, not every turn', async () => {
    vi.stubEnv('FAKE_CLAUDE_MCP_FAIL', '1');
    const h = harness();
    await h.worker.start();
    await h.worker.send(control('stop'));
    await h.nextResult();
    await h.worker.send(control('stop'));
    await h.nextResult(2);
    expect(h.log.records.filter((r) => r.msg.startsWith('mcp server tars did not connect (status=failed)'))).toHaveLength(1);
  });

  it('fails start when claude cannot be spawned', async () => {
    const h = harness({ argv: () => ['/nonexistent/claude-binary'] });
    await expect(h.worker.start()).rejects.toThrow(/ENOENT/);
  });

  it('stops by killing the child', async () => {
    const h = harness();
    await h.worker.start();
    await until(() => h.spawns()[0]);
    const pid = h.spawns()[0]?.pid as number;
    await h.worker.stop();
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  it('never treats an idle child as wedged', async () => {
    const h = harness({ limits: { livenessTimeoutSeconds: 0.2, livenessPollSeconds: 0.05 } });
    await h.worker.start();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(h.log.text()).not.toContain('wedged');
    expect(h.spawns()).toHaveLength(1);
  });

  it('forgets earlier tool errors after a successful tool call', async () => {
    const h = harness();
    await h.worker.start();
    const ok = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ok', content: 'fine' }] } });
    await h.worker.send(`#fake tool-errors 2\n#fake raw ${ok}\n#fake tool-errors 2\n${control('stop')}`);
    const result = await h.nextResult();
    expect(result.abortedReason).toBeUndefined();
    expect(result.control?.action).toBe('stop');
  });

  it('skips non-JSON lines and ignores events it has no use for', async () => {
    const h = harness();
    await h.worker.start();
    const lines = ['not json at all', '{"type":"stream_event","event":{}}', '{"type":"system","subtype":"api_retry","error":"overloaded"}'];
    await h.worker.send(`${lines.map((l) => `#fake raw ${l}`).join('\n')}\n#fake text still here\n${control('stop')}`);
    expect(await h.nextResult()).toMatchObject({ textBlocks: ['still here'], control: { action: 'stop' } });
    expect(h.log.text()).toContain('DEBUG cc stdout non-json line: "not json at all"');
    expect(h.log.text()).toContain('WARNING cc reported error in system/api_retry event: error=overloaded');
  });

  it('hands claude the whole environment', async () => {
    vi.stubEnv('FAKE_CLAUDE_PROBE', 'inherited');
    const h = harness();
    await h.worker.start();
    await until(() => h.spawns()[0]);
    expect(h.spawns()[0]?.probe).toBe('inherited');
  });

  it('runs claude in the projects directory, the only place its read tools reach', async () => {
    const h = harness();
    await h.worker.start();
    await until(() => h.spawns()[0]);
    expect(h.spawns()[0]?.cwd).toBe(realpathSync(h.dir));
  });

  it('drops events that arrive when no turn is collecting', async () => {
    const h = harness();
    await h.worker.start();
    const stray = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'stray' }] } });
    await h.worker.send(`#fake late ${stray}\n${control('stop')}`);
    await h.nextResult();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await h.worker.send(control('stop'));
    expect((await h.nextResult(2)).textBlocks).toEqual([]);
  });
});

