import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { z } from 'zod';

import type { Db } from '../db/database.ts';
import { type AgentTaskRow, claimAgentTask, finishAgentTask } from '../db/agent-tasks.ts';
import type { Logger } from '../log/logger.ts';
import { clip } from '../text/clip.ts';
import { agentPrompt, prUrlOf } from './tasks.ts';

const MAX_BODY_BYTES = 1_000_000;
/** The report goes into the model's input whole; a runaway one is cut. */
const MAX_REPORT_CHARS = 8000;

const RESULT = z.object({
  ok: z.boolean(),
  summary: z.string(),
  // Where the session can be continued; absent when the task failed before claude ran.
  session_id: z.string().regex(/^[0-9a-f-]{36}$/).optional(),
  worktree: z.string().max(500).optional(),
  resume: z.string().max(1000).optional(),
});

export interface AgentServerOptions {
  db: Db;
  /** The shared secret the agent sends as `Authorization: Bearer <token>`. */
  token: string;
  port: number;
  log: Logger;
  /** A task finished: Lia reports it. */
  onFinished(task: AgentTaskRow): Promise<void>;
}

/**
 * Where the agent on the owner's computer picks up approved tasks and reports
 * them done. It polls out to us, so nothing on that computer listens:
 * `POST /agent/claim` hands over the oldest approved task (204 when none),
 * `POST /agent/tasks/<id>/result` closes it.
 */
export class AgentServer {
  private readonly o: AgentServerOptions;
  private readonly secret: Buffer;
  private http: Server | undefined;

  constructor(options: AgentServerOptions) {
    this.o = options;
    this.secret = digest(`Bearer ${options.token}`);
  }

  get port(): number {
    return (this.http?.address() as AddressInfo).port;
  }

  async start(): Promise<void> {
    const http = createServer((req, res) => void this.handle(req, res));
    http.listen(this.o.port);
    await once(http, 'listening');
    this.http = http;
    this.o.log.info(`agent server listening on port ${this.port}`);
  }

  async stop(): Promise<void> {
    this.http?.closeAllConnections();
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
    this.http = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const [status, body] = await this.route(req);
      res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }).end(body === undefined ? undefined : JSON.stringify(body));
    } catch (err) {
      this.o.log.error('agent server request failed', { err });
      res.writeHead(500).end();
    }
  }

  private async route(req: IncomingMessage): Promise<[number, unknown?]> {
    if (!timingSafeEqual(digest(req.headers.authorization ?? ''), this.secret)) return [401];
    if (req.method !== 'POST') return [405];
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/agent/claim') return this.claim();
    const id = /^\/agent\/tasks\/(\d+)\/result$/.exec(path)?.[1];
    return id ? this.finish(Number(id), await readBody(req)) : [404];
  }

  private claim(): [number, unknown?] {
    const task = claimAgentTask(this.o.db);
    if (!task) return [204];
    this.o.log.info(`agent task #${task.id} claimed`);
    const session = task.parent_id === null ? {} : { session_id: task.session_id, worktree: task.worktree };
    return [200, { id: task.id, repo: task.repo, title: task.title, prompt: agentPrompt(task), ...session }];
  }

  private finish(id: number, body: string | undefined): [number, unknown?] {
    const parsed = body === undefined ? undefined : RESULT.safeParse(safeJson(body));
    if (!parsed?.success) return [400, { error: 'expected {"ok": boolean, "summary": string, "session_id"?, "worktree"?, "resume"?}' }];
    const { ok, summary, session_id: sessionId, worktree, resume } = parsed.data;
    const task = finishAgentTask(this.o.db, id, { ok, result: clip(summary, MAX_REPORT_CHARS), prUrl: prUrlOf(summary), sessionId, worktree, resume });
    if (!task) return [409, { error: `task #${id} is not running` }];
    this.o.log.info(`agent task #${id} ${task.status}`);
    this.o.onFinished(task).catch((err: unknown) => this.o.log.error(`reporting agent task #${id} failed`, { err }));
    return [200, {}];
  }
}

const digest = (text: string): Buffer => createHash('sha256').update(text).digest();

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The request body as UTF-8, or undefined when it is over the cap. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
