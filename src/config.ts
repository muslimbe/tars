import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { Level } from './log/logger.ts';

/** The repository root: prompts/, skills/, memories/ and the operator's JSON files live here. */
export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface Config {
  telegramBotToken: string;
  /** The owner's main account: notices, reminders and blocked-chat alerts go here. */
  ownerId: number;
  /** Every account with owner rights: `ownerId` first, then `TARS_OWNER_ALT_IDS`. */
  ownerIds: readonly number[];
  model: string;
  effort: string;
  claudeCodeBin: string;
  dataDir: string;
  selfReflectionEnabled: boolean;
  /** UTC cron for the daily self-reflection reminder. */
  selfReflectionCron: string;
  debounceMs: number;
  /** Per-user DM messages per minute; the owner and groups are exempt. */
  rateLimitPerMin: number;
  /** `addressed`: a group message reaches the model only if the owner wrote it, or it mentions or replies to the bot or the owner. */
  groupMessages: 'all' | 'addressed';
  /** More user ids `addressed` treats like the owner; no owner rights. */
  groupAddressees: readonly number[];
  attachmentMaxBytes: number;
  toolErrorMaxCount: number;
  toolErrorWindowSeconds: number;
  livenessTimeoutSeconds: number;
  livenessPollSeconds: number;
  crashBackoffBase: number;
  crashBackoffCap: number;
  crashLimit: number;
  crashWindowSeconds: number;
  browserHeadless: boolean;
  logLevel: Level;
  logTranscript: 'compact' | 'full';
  dbPath: string;
  sessionIdPath: string;
  ccLogsDir: string;
  attachmentsDir: string;
  rendersDir: string;
  logDir: string;
  accessPath: string;
  memoriesDir: string;
  committedRemindersPath: string;
  pluginsPath: string;
  promptsDir: string;
  skillsDir: string;
  /** Claude Code's working directory, so the `read` tool group reaches only this folder. */
  projectsDir: string;
}

// An empty variable counts as unset.
const optional = z.string().optional().transform((raw) => (raw === '' ? undefined : raw));

const required = (name: string) =>
  optional.refine((raw) => raw !== undefined, `missing required environment variable: ${name}`).transform((raw) => raw ?? '');

const text = (fallback: string) => optional.transform((raw) => raw ?? fallback);

/** A non-negative integer setting; with no `fallback` it is required. */
const int = (name: string, fallback?: number) =>
  optional.transform((raw, ctx) => {
    if (raw === undefined && fallback !== undefined) return fallback;
    if (raw === undefined) {
      ctx.addIssue({ code: 'custom', message: `missing required environment variable: ${name}` });
      return z.NEVER;
    }
    if (/^\+?\d+$/.test(raw.trim())) return Number(raw);
    ctx.addIssue({ code: 'custom', message: `${name} must be a non-negative integer, got ${JSON.stringify(raw)}` });
    return z.NEVER;
  });

/** A duration or window in seconds: zero would spin a timer, so it must be positive. */
const float = (name: string, fallback: number) =>
  optional.transform((raw, ctx) => {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
    ctx.addIssue({ code: 'custom', message: `${name} must be a positive number, got ${JSON.stringify(raw)}` });
    return z.NEVER;
  });

/** `1/true/yes/on` or `0/false/no/off`, any case; a typo stops boot instead of silently meaning false. */
const bool = (name: string, fallback: boolean) =>
  optional.transform((raw, ctx) => {
    if (raw === undefined) return fallback;
    const value = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    ctx.addIssue({ code: 'custom', message: `${name} must be true or false, got ${JSON.stringify(raw)}` });
    return z.NEVER;
  });

const LOG_LEVELS: Record<string, Level> = { DEBUG: 'DEBUG', NOTSET: 'DEBUG', INFO: 'INFO', WARNING: 'WARNING', WARN: 'WARNING', ERROR: 'ERROR', CRITICAL: 'CRITICAL', FATAL: 'CRITICAL' };

const logLevel = text('INFO').transform((raw, ctx) => {
  const level = LOG_LEVELS[raw.toUpperCase()];
  if (level) return level;
  ctx.addIssue({ code: 'custom', message: `unknown log level ${JSON.stringify(raw)}` });
  return z.NEVER;
});

const logTranscript = text('compact').transform((raw, ctx) => {
  const value = raw.trim().toLowerCase();
  if (value === 'compact' || value === 'full') return value;
  ctx.addIssue({ code: 'custom', message: `TARS_LOG_TRANSCRIPT must be "compact" or "full", got ${JSON.stringify(value)}` });
  return z.NEVER;
});

const groupMessages = text('all').transform((raw, ctx) => {
  const value = raw.trim().toLowerCase();
  if (value === 'all' || value === 'addressed') return value;
  ctx.addIssue({ code: 'custom', message: `TARS_GROUP_MESSAGES must be "all" or "addressed", got ${JSON.stringify(value)}` });
  return z.NEVER;
});

const userIds = (name: string) =>
  optional.transform((raw, ctx) => {
    const ids = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const bad = ids.filter((s) => !/^\d+$/.test(s));
    if (!bad.length) return ids.map(Number);
    ctx.addIssue({ code: 'custom', message: `${name} must be comma-separated user ids, got ${JSON.stringify(raw)}` });
    return z.NEVER;
  });

const ENV = z.object({
  TELEGRAM_BOT_TOKEN: required('TELEGRAM_BOT_TOKEN'),
  TARS_OWNER_ID: int('TARS_OWNER_ID'),
  TARS_OWNER_ALT_IDS: userIds('TARS_OWNER_ALT_IDS'),
  TARS_MODEL: required('TARS_MODEL'),
  TARS_EFFORT: required('TARS_EFFORT'),
  CLAUDE_CODE_BIN: text('claude'),
  TARS_DATA_DIR: text('./data'),
  TARS_SELF_REFLECTION_ENABLED: bool('TARS_SELF_REFLECTION_ENABLED', true),
  TARS_SELF_REFLECTION_CRON: text('0 0 * * *'),
  TARS_DEBOUNCE_MS: int('TARS_DEBOUNCE_MS', 0),
  TARS_RATE_LIMIT_PER_MIN: int('TARS_RATE_LIMIT_PER_MIN', 20),
  TARS_GROUP_MESSAGES: groupMessages,
  TARS_GROUP_ADDRESSEES: userIds('TARS_GROUP_ADDRESSEES'),
  TARS_ATTACHMENT_MAX_BYTES: int('TARS_ATTACHMENT_MAX_BYTES', 20_000_000),
  TARS_TOOL_ERROR_MAX_COUNT: int('TARS_TOOL_ERROR_MAX_COUNT', 10),
  TARS_TOOL_ERROR_WINDOW_SECONDS: float('TARS_TOOL_ERROR_WINDOW_SECONDS', 600),
  TARS_LIVENESS_TIMEOUT_SECONDS: float('TARS_LIVENESS_TIMEOUT_SECONDS', 600),
  TARS_LIVENESS_POLL_SECONDS: float('TARS_LIVENESS_POLL_SECONDS', 30),
  TARS_CRASH_BACKOFF_BASE: float('TARS_CRASH_BACKOFF_BASE', 2),
  TARS_CRASH_BACKOFF_CAP: float('TARS_CRASH_BACKOFF_CAP', 64),
  TARS_CRASH_LIMIT: int('TARS_CRASH_LIMIT', 10),
  TARS_CRASH_WINDOW_SECONDS: float('TARS_CRASH_WINDOW_SECONDS', 600),
  TARS_BROWSER_HEADLESS: bool('TARS_BROWSER_HEADLESS', true),
  TARS_LOG_LEVEL: logLevel,
  TARS_LOG_TRANSCRIPT: logTranscript,
  TARS_ACCESS_PATH: optional,
  TARS_REMINDERS_PATH: optional,
  TARS_PLUGINS_PATH: optional,
  TARS_MEMORIES_DIR: optional,
});

/**
 * Parse and validate the environment once, at boot. Relative paths resolve
 * against the working directory. Throws one error
 * listing every problem.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>, cwd: string = process.cwd()): Readonly<Config> {
  const parsed = ENV.safeParse(env);
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join('\n'));
  const e = parsed.data;
  return Object.freeze({
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    ownerId: e.TARS_OWNER_ID,
    ownerIds: [e.TARS_OWNER_ID, ...e.TARS_OWNER_ALT_IDS],
    model: e.TARS_MODEL,
    effort: e.TARS_EFFORT,
    claudeCodeBin: e.CLAUDE_CODE_BIN,
    selfReflectionEnabled: e.TARS_SELF_REFLECTION_ENABLED,
    selfReflectionCron: e.TARS_SELF_REFLECTION_CRON,
    debounceMs: e.TARS_DEBOUNCE_MS,
    rateLimitPerMin: e.TARS_RATE_LIMIT_PER_MIN,
    groupMessages: e.TARS_GROUP_MESSAGES,
    groupAddressees: e.TARS_GROUP_ADDRESSEES,
    attachmentMaxBytes: e.TARS_ATTACHMENT_MAX_BYTES,
    toolErrorMaxCount: e.TARS_TOOL_ERROR_MAX_COUNT,
    toolErrorWindowSeconds: e.TARS_TOOL_ERROR_WINDOW_SECONDS,
    livenessTimeoutSeconds: e.TARS_LIVENESS_TIMEOUT_SECONDS,
    livenessPollSeconds: e.TARS_LIVENESS_POLL_SECONDS,
    crashBackoffBase: e.TARS_CRASH_BACKOFF_BASE,
    crashBackoffCap: e.TARS_CRASH_BACKOFF_CAP,
    crashLimit: e.TARS_CRASH_LIMIT,
    crashWindowSeconds: e.TARS_CRASH_WINDOW_SECONDS,
    browserHeadless: e.TARS_BROWSER_HEADLESS,
    logLevel: e.TARS_LOG_LEVEL,
    logTranscript: e.TARS_LOG_TRANSCRIPT,
    ...paths(e, cwd),
  });
}

/** Data paths under TARS_DATA_DIR; operator files at the repo root unless overridden. */
function paths(e: z.infer<typeof ENV>, cwd: string) {
  const dataDir = resolve(cwd, e.TARS_DATA_DIR);
  const fromRoot = (override: string | undefined, name: string) => (override ? resolve(cwd, override) : resolve(PROJECT_ROOT, name));
  return {
    dataDir,
    dbPath: resolve(dataDir, 'tars.db'),
    sessionIdPath: resolve(dataDir, 'session_id'),
    ccLogsDir: resolve(dataDir, 'cc_logs'),
    attachmentsDir: resolve(dataDir, 'attachments'),
    rendersDir: resolve(dataDir, 'renders'),
    logDir: resolve(dataDir, 'logs'),
    accessPath: fromRoot(e.TARS_ACCESS_PATH, 'access.json'),
    memoriesDir: fromRoot(e.TARS_MEMORIES_DIR, 'memories'),
    committedRemindersPath: fromRoot(e.TARS_REMINDERS_PATH, 'default-reminders.json'),
    pluginsPath: fromRoot(e.TARS_PLUGINS_PATH, 'plugins.json'),
    promptsDir: resolve(PROJECT_ROOT, 'prompts'),
    skillsDir: resolve(PROJECT_ROOT, 'skills'),
    projectsDir: resolve(PROJECT_ROOT, 'projects'),
  };
}
