import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Bot, Transformer } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';

import { BrowserManager } from './browser/manager.ts';
import { BrowserSession } from './browser/session.ts';
import { buildArgv } from './claude/argv.ts';
import { writeMcpConfig } from './claude/mcpconfig.ts';
import { loadSessionId, spawnDescription, spawnSpec } from './claude/spec.ts';
import { ClaudeWorker } from './claude/worker.ts';
import type { Config } from './config.ts';
import { type Db, openDatabase } from './db/database.ts';
import { takeUnconsumedInbound } from './db/messages.ts';
import { insertToolCall, pruneToolCalls } from './db/toolcalls.ts';
import { Engine } from './engine/engine.ts';
import { TypingIndicator } from './engine/typing.ts';
import type { Logger, LogSink } from './log/logger.ts';
import { OwnerNotifier } from './log/owner.ts';
import { Transcript } from './log/transcript.ts';
import { formatMessageRefs } from './telegram/links.ts';
import { htmlToPlainText } from './text/html.ts';
import { McpHttpServer } from './mcp/server.ts';
import { loadPlugins, type Plugins, pluginsSummary } from './plugins.ts';
import { bootstrapAccess } from './telegram/bootstrap.ts';
import { AttachmentStore } from './stores/attachments.ts';
import { InstructionsStore } from './stores/instructions.ts';
import { ReminderLoop } from './scheduler/loop.ts';
import { prepareReminders } from './scheduler/seed.ts';
import { MemoryStore, renderMemoryIndex } from './stores/memory.ts';
import { RenderStore } from './stores/renders.ts';
import { renderSkillsIndex, SkillsStore } from './stores/skills.ts';
import { attachmentIngest, downloadFile } from './telegram/attachments.ts';
import { createBot } from './telegram/bot.ts';
import { createCommands, registerCommandMenu } from './telegram/commands.ts';
import { type CommandHandler, Dispatcher } from './telegram/dispatcher.ts';
import { buildTools } from './tools/index.ts';

export interface AppOptions {
  log: Logger;
  /** The environment `${VAR}`s in plugins.json resolve against. */
  env: Readonly<Record<string, string | undefined>>;
  /** Test seam: replaces the Telegram HTTP layer. */
  telegram?: Transformer | undefined;
  /** Test seam: replaces the download of Telegram-hosted attachment files. */
  download?: ((url: string, dest: string) => Promise<void>) | undefined;
  botInfo?: UserFromGetMe | undefined;
  /** Something unrecoverable happened (e.g. Claude Code's crash budget is spent): exit non-zero. */
  onFatal(reason: string): void;
  /** The owner sent `/kill`: shut down cleanly, exit code 0. */
  onKill(): void;
  /** Registers a log sink once the bot can DM the owner (ERROR records become owner DMs). */
  addLogSink(sink: LogSink): void;
}

/** The file-backed stores tools act through; one instance each per process. */
interface Stores {
  memory: MemoryStore;
  skills: SkillsStore;
  instructions: InstructionsStore;
  attachments: AttachmentStore;
  renders: RenderStore;
}

/** The parts that exist once `start()` has run. */
interface Running {
  db: Db;
  bot: Bot;
  plugins: Plugins;
  stores: Stores;
  browser: BrowserManager;
  browserSession: BrowserSession;
  mcp: McpHttpServer;
  worker: ClaudeWorker;
  engine: Engine;
  reminders: ReminderLoop;
}

/**
 * The composition root. `start()` brings tars up in order — database,
 * Telegram bot, MCP server, Claude Code, engine, dispatcher — and `stop()`
 * tears it down in reverse. Every dependency is passed explicitly from here.
 */
export class App {
  private readonly config: Config;
  private readonly o: AppOptions;
  private readonly log: Logger;
  private readonly transcript: Transcript;
  private readonly chatTitles = new Map<number, string>();
  private lastToolActivity = performance.now();
  private running: Partial<Running> = {};
  private ownerAlerts: OwnerNotifier | undefined;

  constructor(config: Config, options: AppOptions) {
    this.config = config;
    this.o = options;
    this.log = options.log;
    this.transcript = new Transcript(options.log, config.logTranscript);
  }

  async start(): Promise<void> {
    const r = this.running;
    this.prepareDisk();
    r.db = openDatabase(this.config.dbPath, this.log.child('db'));
    pruneToolCalls(r.db);
    this.log.info(`database ready at ${this.config.dbPath}`);
    r.plugins = loadPlugins(this.config.pluginsPath, this.o.env, this.log.child('plugins'));
    this.log.info(pluginsSummary(r.plugins));
    r.stores = this.openStores(r.plugins);
    prepareReminders(r.db, this.config, this.log);
    r.bot = createBot(this.config.telegramBotToken, { network: this.o.telegram, botInfo: this.o.botInfo });
    await r.bot.init();
    const browserLog = this.log.child('browser');
    r.browser = new BrowserManager({ headless: this.config.browserHeadless, log: browserLog });
    r.browserSession = new BrowserSession({ manager: r.browser, log: browserLog });
    r.mcp = await this.startMcp(r.db, r.bot, r.plugins, { ...r.stores, browser: r.browser, browserSession: r.browserSession });
    // Warm Chromium in the background; a failure is logged and the first use retries.
    void r.browser.warm();
    r.worker = await this.startWorker(r.plugins, r.mcp, r.stores);
    r.engine = await this.startEngine(r.db, r.bot, r.worker);
    r.reminders = new ReminderLoop({ db: r.db, engine: r.engine, log: this.log.child('reminder') });
    r.reminders.start();
    this.attachOwnerAlerts(r.bot, r.engine);
    await this.startDispatcher(r.db, r.bot, r.engine);
    this.log.info('tars is live');
  }

  /**
   * Claude Code rejected the resumed session: forget it, carry a recap into
   * the fresh one, and tell the owner.
   */
  private async onStaleSession(): Promise<void> {
    this.running.engine?.stashRestoreContext('stale-session');
    const text =
      'ℹ️ Previous Claude Code session expired — starting a fresh one. Your last message may need to be resent. ' +
      "I'll carry a short recap of recent messages into the next turn.";
    await this.running.bot?.api.sendMessage(this.config.ownerId, text).catch(() => this.log.warn('stale-session notify to owner failed'));
  }

  /** Every ERROR record becomes an owner DM (HTML, plain-text fallback) linking the message being answered. */
  private attachOwnerAlerts(bot: Bot, engine: Engine): void {
    const send = async (html: string) => {
      try {
        await bot.api.sendMessage(this.config.ownerId, html, { parse_mode: 'HTML' });
      } catch (err) {
        this.log.warn(`owner HTML DM failed, retrying as plain text: ${(err as Error).message}`);
        await quietly(bot.api.sendMessage(this.config.ownerId, htmlToPlainText(html)), this.log, `error notify failed for chat ${this.config.ownerId}`);
      }
    };
    this.ownerAlerts = new OwnerNotifier(send, () => formatMessageRefs(engine.replyTargets, this.chatTitles));
    this.o.addLogSink(this.ownerAlerts.sink);
  }

  /** Tear down in reverse order of `start()`; a failing step is logged and the rest still run. */
  async stop(): Promise<void> {
    const { bot, engine, worker, mcp, browserSession, browser, db, reminders } = this.running;
    const steps = [
      () => this.ownerAlerts?.flush(),
      () => reminders?.stop(),
      () => bot?.isRunning() && bot.stop(),
      () => engine?.stop(),
      () => worker?.stop(),
      () => mcp?.stop(),
      () => browserSession?.close(),
      () => browser?.close(),
      () => db?.close(),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (err) {
        this.log.error('shutdown step failed', { err });
      }
    }
    this.log.info('clean shutdown complete');
  }

  /** Last-resort kill of the Claude Code process group on a fatal exit. */
  killNow(): void {
    this.running.worker?.killNow();
  }

  private prepareDisk(): void {
    const c = this.config;
    const dirs = [c.dataDir, c.memoriesDir, c.ccLogsDir, c.attachmentsDir, c.rendersDir, c.logDir, join(c.dataDir, 'prompt_backups'), c.skillsDir, c.projectsDir];
    for (const dir of dirs) mkdirSync(dir, { recursive: true });
    pruneOldFiles(c.ccLogsDir);
    pruneOldFiles(c.rendersDir);
    bootstrapAccess(c.accessPath, this.log);
  }

  private openStores(plugins: Plugins): Stores {
    const c = this.config;
    const skills = new SkillsStore(c.skillsDir, plugins.skillsDisabled);
    for (const problem of skills.problems()) this.log.warn(`skill skipped: ${problem}`);
    return {
      memory: new MemoryStore(c.memoriesDir),
      skills,
      instructions: new InstructionsStore(join(c.promptsDir, 'project.md'), join(c.dataDir, 'prompt_backups')),
      attachments: new AttachmentStore(c.attachmentsDir),
      renders: new RenderStore(c.rendersDir),
    };
  }

  private async startMcp(db: Db, bot: Bot, plugins: Plugins, services: Stores & Pick<Running, 'browser' | 'browserSession'>): Promise<McpHttpServer> {
    const toolCtx = {
      api: bot.api,
      me: () => bot.botInfo,
      db,
      dbPath: this.config.dbPath,
      ...services,
      chatTitles: this.chatTitles,
      transcript: this.transcript,
      log: this.log.child('tools'),
      onChatReplied: (chatId: number) => this.running.engine?.notifyChatReplied(chatId),
    };
    const mcp = new McpHttpServer({
      tools: buildTools(toolCtx, plugins.builtinToolsDisabled, this.log.child('mcp')),
      log: this.log.child('mcp'),
      beat: () => (this.lastToolActivity = performance.now()),
      audit: (row) => insertToolCall(db, row),
    });
    await mcp.start();
    this.log.info(`mcp server live at ${mcp.url}`);
    return mcp;
  }

  private async startWorker(plugins: Plugins, mcp: McpHttpServer, stores: Stores): Promise<ClaudeWorker> {
    const mcpConfigPath = writeMcpConfig(join(this.config.dataDir, 'mcp.json'), mcp.url, plugins, this.log);
    const indexes = () => ({ skills: renderSkillsIndex(stores.skills), memory: renderMemoryIndex(stores.memory) });
    const spec = spawnSpec(this.config, plugins, { mcpConfigPath, toolNames: mcp.toolNames, indexes });
    const worker = new ClaudeWorker({
      argv: (sid) => buildArgv(spec(sid)),
      describe: spawnDescription(this.config.model, plugins),
      sessionId: loadSessionId(this.config.sessionIdPath, this.log),
      config: this.config,
      lastToolActivity: () => this.lastToolActivity,
      log: this.log.child('worker'),
      transcript: this.transcript,
      onResult: (result) => this.running.engine?.onResult(result),
      onStaleSession: () => this.onStaleSession(),
      onGiveUp: (count) => {
        this.log.error(`⚠️ Shutting down — Claude Code failed ${count} times. The operator needs to intervene.`);
        this.o.onFatal('claude crash limit reached');
      },
    });
    await worker.start();
    return worker;
  }

  private async startEngine(db: Db, bot: Bot, worker: ClaudeWorker): Promise<Engine> {
    const log = this.log.child('engine');
    const typing = new TypingIndicator(
      (chatId, topic) => quietly(bot.api.sendChatAction(chatId, 'typing', { message_thread_id: topic }), this.log, `send_chat_action failed for chat ${chatId}`),
      log,
    );
    const notify = (chatId: number, text: string, replyTo?: number) =>
      quietly(bot.api.sendMessage(chatId, text, replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo } }), this.log, `error notify failed for chat ${chatId}`);
    const engine = new Engine({ worker, db, debounceMs: this.config.debounceMs, typing, notify, log });
    this.running.engine = engine;
    const replay = takeUnconsumedInbound(db);
    if (replay.length) this.log.info(`replaying ${replay.length} message(s) buffered before the last shutdown`);
    for (const msg of replay) await engine.submit(msg);
    return engine;
  }

  private async startDispatcher(db: Db, bot: Bot, engine: Engine): Promise<void> {
    const c = this.config;
    const log = this.log.child('telegram');
    // The commands pause and resume the dispatcher that routes them to them.
    let commands: CommandHandler = () => Promise.resolve(false);
    const download = this.o.download ?? downloadFile;
    const attachments = attachmentIngest({ api: bot.api, download, dir: c.attachmentsDir, maxBytes: c.attachmentMaxBytes, log });
    const dispatcher = new Dispatcher({
      bot, config: c, db, engine, chatTitles: this.chatTitles, transcript: this.transcript, log, attachments,
      commands: (ctx, command) => commands(ctx, command),
    });
    commands = createCommands({ config: c, db, engine, pause: dispatcher, log, kill: () => this.o.onKill() });
    await registerCommandMenu(bot.api, c.ownerId, log);
    bot.catch((err) => log.error('error while handling a Telegram update', { err: err.error }));
    await this.startPolling(bot, log);
  }

  /** Resolves once long polling runs (the readiness line follows it); a later polling failure is fatal. */
  private startPolling(bot: Bot, log: Logger): Promise<void> {
    return new Promise((resolve, reject) => {
      let live = false;
      const polling = bot.start({
        drop_pending_updates: true,
        allowed_updates: ['message', 'edited_message', 'message_reaction'],
        timeout: 10,
        onStart: () => {
          live = true;
          log.info('telegram dispatcher polling');
          resolve();
        },
      });
      polling.catch((err: Error) => {
        if (!live) return reject(err);
        this.log.critical('telegram polling stopped', { err });
        this.o.onFatal('telegram polling failed');
      });
    });
  }
}

/** Delete the files in `dir` untouched for 30 days: raw captures and renders would otherwise pile up forever. */
function pruneOldFiles(dir: string): void {
  const cutoff = Date.now() - 30 * 86_400_000;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && statSync(path).mtimeMs < cutoff) rmSync(path);
  }
}

/** Await a best-effort Telegram call; a failure is logged as a warning, never thrown. */
async function quietly(call: Promise<unknown>, log: Logger, what: string): Promise<void> {
  await call.catch((err: unknown) => log.warn(`${what}: ${(err as Error).message}`));
}

