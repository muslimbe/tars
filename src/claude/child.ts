import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:os';
import { createInterface } from 'node:readline';

/** How a child ended. `code` follows asyncio: a negative signal number when killed. */
export interface ChildExit {
  code: number | null;
  /** Set when the process could not be started at all (e.g. ENOENT). */
  error?: Error | undefined;
}

export interface ChildProcess {
  /** Resolves once the process is running; rejects when it could not start (e.g. ENOENT). */
  readonly spawned: Promise<void>;
  /** Resolves once the process has exited and both output streams are drained. */
  readonly exited: Promise<ChildExit>;
  /** Write one line to stdin, honouring backpressure. Throws when stdin is gone. */
  write(line: string): Promise<void>;
  /** SIGTERM the whole process group, SIGKILL after 5 s, resolve on exit. */
  kill(): Promise<void>;
  /** Immediate SIGKILL of the group, for fatal-exit paths that can't wait. */
  killNow(): void;
}

/**
 * Spawn `argv` in `cwd`, in its own process group (Claude Code starts MCP servers, which
 * must die with it), and stream stdout/stderr line by line. The environment is
 * inherited unchanged. This is the only module allowed to spawn processes.
 */
export function spawnChild(argv: readonly string[], cwd: string, onStdout: (line: string) => void, onStderr: (line: string) => void): ChildProcess {
  const [command = '', ...args] = argv;
  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  // A dead child turns writes into EPIPE "error" events; unhandled, they would crash the app.
  child.stdin.on('error', () => {});
  const out = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const err = createInterface({ input: child.stderr, crlfDelay: Infinity });
  out.on('line', onStdout);
  err.on('line', onStderr);
  const { spawned, exited } = lifecycle(child);
  let done = false;
  void exited.then(() => (done = true));

  const signalGroup = (signal: NodeJS.Signals) => {
    if (done || child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  };

  return {
    spawned,
    exited,
    async write(line) {
      if (done || !child.stdin.writable) throw new Error('claude stdin is closed');
      if (!child.stdin.write(line)) await Promise.race([once(child.stdin, 'drain'), exited]);
    },
    async kill() {
      signalGroup('SIGTERM');
      const timer = setTimeout(() => signalGroup('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    },
    killNow: () => signalGroup('SIGKILL'),
  };
}

function lifecycle(child: ChildProcessWithoutNullStreams): { spawned: Promise<void>; exited: Promise<ChildExit> } {
  const exited = new Promise<ChildExit>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code, signal) => resolve({ code: code ?? (signal ? -constants.signals[signal] : null) }));
  });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  spawned.catch(() => {}); // the failure also resolves `exited`; callers that care await `spawned`
  return { spawned, exited };
}
