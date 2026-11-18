import type { Api } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';

import type { AgentTaskDeps } from './agents.ts';
import type { BrowserManager } from '../browser/manager.ts';
import type { BrowserSession } from '../browser/session.ts';
import type { Db } from '../db/database.ts';
import type { Logger } from '../log/logger.ts';
import type { Transcript } from '../log/transcript.ts';
import type { AttachmentStore } from '../stores/attachments.ts';
import type { InstructionsStore } from '../stores/instructions.ts';
import type { MemoryStore } from '../stores/memory.ts';
import type { RenderStore } from '../stores/renders.ts';
import type { SkillsStore } from '../stores/skills.ts';

/** The services tools act through. Each tool factory takes only the slice it uses. */
export interface ToolContext {
  api: Api;
  /** The bot's own identity, known once the bot has initialised. */
  me(): UserFromGetMe;
  db: Db;
  /** The SQLite file; `database_query` opens its own read-only connection on it in a worker thread. */
  dbPath: string;
  /** One store per process: its read-before-write record must be shared by every tool. */
  memory: MemoryStore;
  skills: SkillsStore;
  instructions: InstructionsStore;
  attachments: AttachmentStore;
  renders: RenderStore;
  /** The warm Chromium renders use, and the one browsing session the browser tools share. */
  browser: BrowserManager;
  browserSession: BrowserSession;
  /** Chat display names seen by the dispatcher, for transcript lines. */
  chatTitles: ReadonlyMap<number, string>;
  transcript: Transcript;
  log: Logger;
  /** A chat got its reply: the engine stops that chat's typing indicator. */
  onChatReplied(chatId: number): void;
  /** Set when the agent on the owner's computer is configured (`TARS_AGENT_TOKEN`). */
  agents?: AgentTaskDeps | undefined;
}
