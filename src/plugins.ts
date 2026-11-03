import { existsSync, readFileSync } from 'node:fs';

import type { Logger } from './log/logger.ts';
import { isRecord } from './text/json.ts';

export type McpTransport = 'stdio' | 'http' | 'sse';

/** One external MCP server from `plugins.json`, `${VAR}`s already substituted. */
export interface McpPlugin {
  name: string;
  type: McpTransport;
  allowedTools: string[];
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
}

export interface Plugins {
  /** Only the groups the file mentions; absent means off. */
  toolGroups: Partial<Record<'bash' | 'code' | 'read' | 'subagents', boolean>>;
  mcps: McpPlugin[];
  skillsDisabled: ReadonlySet<string>;
  builtinToolsDisabled: ReadonlySet<string>;
  /** Folders under `projects/` the bot may edit, relative to it. */
  writableProjects: readonly string[];
}

type Entry = Record<string, unknown>;

const TOP_LEVEL_KEYS = ['builtin_tools_disabled', 'mcps', 'skills_disabled', 'tool_groups', 'writable_projects'];
const TOOL_GROUP_KEYS = ['bash', 'code', 'read', 'subagents'];
const MCP_KEYS = ['allowed_tools', 'args', 'command', 'enabled', 'env', 'headers', 'name', 'type', 'url'];
const MCP_REQUIRED = ['allowed_tools', 'enabled', 'name'];
const TRANSPORTS = ['http', 'sse', 'stdio'];
const STDIO_ONLY = ['args', 'command', 'env'];
const REMOTE_ONLY = ['headers', 'url'];
/** The built-in server's name; an external entry may not shadow it. */
const RESERVED_NAME = 'tars';

/**
 * Load and validate `plugins.json`. A missing file means locked-down defaults;
 * malformed JSON or a schema violation throws (boot must fail loudly). An
 * enabled MCP whose `${VAR}` resolves empty is logged and skipped.
 */
export function loadPlugins(path: string, env: Readonly<Record<string, string | undefined>>, log: Logger): Plugins {
  if (!existsSync(path)) {
    logMissingFile(path, log);
    return { toolGroups: {}, mcps: [], skillsDisabled: new Set(), builtinToolsDisabled: new Set(), writableProjects: [] };
  }
  const data = parseJsonFile(path);
  if (!isRecord(data)) throw new Error(`${path}: top level must be a JSON object`);
  const unknown = Object.keys(data).filter((k) => !TOP_LEVEL_KEYS.includes(k));
  if (unknown.length) throw new Error(`${path}: unknown top-level key(s): ${list(unknown)}; allowed: ${list(TOP_LEVEL_KEYS)}`);
  const toolGroups = validateToolGroups(data.tool_groups, path);
  const mcps = validateMcps(data.mcps, path);
  return {
    toolGroups,
    mcps: buildMcps(mcps, env, log),
    skillsDisabled: validateStringList(data.skills_disabled, path, 'skills_disabled'),
    builtinToolsDisabled: validateStringList(data.builtin_tools_disabled, path, 'builtin_tools_disabled'),
    writableProjects: validateWritable(data.writable_projects, path),
  };
}

/** The boot log line describing what `plugins.json` turned on. */
export function pluginsSummary(plugins: Plugins): string {
  return (
    `plugins loaded: ${plugins.mcps.length} enabled mcp(s), ${plugins.skillsDisabled.size} disabled skill(s), ` +
    `${plugins.builtinToolsDisabled.size} disabled built-in tool(s), tool_groups=${JSON.stringify(plugins.toolGroups)}, ` +
    `writable_projects=${JSON.stringify(plugins.writableProjects)}`
  );
}

function logMissingFile(path: string, log: Logger): void {
  const example = `${path}.example`;
  if (!existsSync(example)) {
    log.info(`no plugins.json at ${path} — using locked-down defaults`);
    return;
  }
  log.error(
    `no plugins.json at ${path} — using locked-down defaults (no external MCPs, no tool groups). ` +
      `Copy the shipped example to enable integrations: cp ${example} ${path}`,
  );
}

function parseJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`could not read ${path}: ${(err as Error).message}`, { cause: err });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path}: invalid JSON: ${(err as Error).message}`, { cause: err });
  }
}

function validateToolGroups(raw: unknown, path: string): Plugins['toolGroups'] {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new Error(`${path}: tool_groups must be an object`);
  const unknown = Object.keys(raw).filter((k) => !TOOL_GROUP_KEYS.includes(k));
  if (unknown.length) throw new Error(`${path}: tool_groups has unknown key(s): ${list(unknown)}; allowed: ${list(TOOL_GROUP_KEYS)}`);
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'boolean') throw new Error(`${path}: tool_groups.${key} must be true/false, got ${JSON.stringify(value)}`);
  }
  return raw;
}

function validateMcps(raw: unknown, path: string): Entry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${path}: mcps must be an array`);
  const seen = new Set<string>();
  return raw.map((entry: unknown, i) => {
    if (!isRecord(entry)) throw new Error(`${path}: mcps[${i}] must be an object`);
    checkKeys(entry, i, path);
    const name = checkName(entry, i, seen, path);
    const transport = checkTransport(entry, name, path);
    checkTransportFields(entry, name, transport, path);
    if (typeof entry.enabled !== 'boolean') throw new Error(`${path}: mcps[${JSON.stringify(name)}].enabled must be true/false`);
    checkAllowedTools(entry, name, path);
    return entry;
  });
}

function checkKeys(entry: Entry, i: number, path: string): void {
  const unknown = Object.keys(entry).filter((k) => !MCP_KEYS.includes(k));
  if (unknown.length) throw new Error(`${path}: mcps[${i}] has unknown key(s): ${list(unknown)}; allowed: ${list(MCP_KEYS)}`);
  const missing = MCP_REQUIRED.filter((k) => !(k in entry));
  if (missing.length) throw new Error(`${path}: mcps[${i}] missing required key(s): ${list(missing)}`);
}

function checkName(entry: Entry, i: number, seen: Set<string>, path: string): string {
  const { name } = entry;
  if (typeof name !== 'string' || !name) throw new Error(`${path}: mcps[${i}].name must be a non-empty string`);
  if (name === RESERVED_NAME) throw new Error(`${path}: mcps[${i}].name ${JSON.stringify(name)} is reserved for the built-in server`);
  if (seen.has(name)) {
    throw new Error(`${path}: mcps has duplicate name ${JSON.stringify(name)}; names become the mcp__<name>__ namespace and must be unique`);
  }
  seen.add(name);
  return name;
}

function checkTransport(entry: Entry, name: string, path: string): McpTransport {
  const transport = entry.type ?? 'stdio';
  if (typeof transport !== 'string' || !TRANSPORTS.includes(transport)) {
    throw new Error(`${path}: mcps[${JSON.stringify(name)}].type must be one of ${list(TRANSPORTS)}; got ${JSON.stringify(transport)}`);
  }
  const present = Object.keys(entry);
  const forbidden = present.filter((k) => (transport === 'stdio' ? REMOTE_ONLY : STDIO_ONLY).includes(k)).sort();
  if (forbidden.length && transport === 'stdio') {
    throw new Error(`${path}: mcps[${JSON.stringify(name)}] is type=stdio but has remote-only key(s) ${list(forbidden)}; use command/args/env, not url/headers`);
  }
  if (forbidden.length) {
    throw new Error(`${path}: mcps[${JSON.stringify(name)}] is type=${transport} but has stdio-only key(s) ${list(forbidden)}; use url/headers, not command/args/env`);
  }
  return transport as McpTransport;
}

function checkTransportFields(entry: Entry, name: string, transport: McpTransport, path: string): void {
  const field = transport === 'stdio' ? 'command' : 'url';
  if (!(field in entry)) throw new Error(`${path}: mcps[${JSON.stringify(name)}] (type=${transport}) requires '${field}'`);
  const value = entry[field];
  if (typeof value !== 'string' || !value) throw new Error(`${path}: mcps[${JSON.stringify(name)}].${field} must be a non-empty string`);
}

function checkAllowedTools(entry: Entry, name: string, path: string): void {
  const allowed = entry.allowed_tools;
  if (!Array.isArray(allowed) || !allowed.length) throw new Error(`${path}: mcps[${JSON.stringify(name)}].allowed_tools must be a non-empty list`);
  allowed.forEach((tool: unknown, j) => {
    if (typeof tool !== 'string' || !tool) {
      throw new Error(`${path}: mcps[${JSON.stringify(name)}].allowed_tools[${j}] must be a non-empty string`);
    }
  });
}

/** Relative folders under `projects/`: no absolute paths, `..`, globs or empty segments. */
function validateWritable(raw: unknown, path: string): string[] {
  const dirs = [...validateStringList(raw, path, 'writable_projects')];
  for (const dir of dirs) {
    const segments = dir.split('/');
    if (segments.some((s) => !s || s === '.' || s === '..' || /[*?[\]{}]/.test(s))) {
      throw new Error(`${path}: writable_projects entry ${JSON.stringify(dir)} must be a plain folder path under projects/, like "billing/docs"`);
    }
  }
  return dirs;
}

function validateStringList(raw: unknown, path: string, key: string): ReadonlySet<string> {
  if (raw === undefined || raw === null) return new Set();
  if (!Array.isArray(raw)) throw new Error(`${path}: ${key} must be an array`);
  raw.forEach((item: unknown, i) => {
    if (typeof item !== 'string' || !item) throw new Error(`${path}: ${key}[${i}] must be a non-empty string`);
  });
  return new Set(raw as string[]);
}

/** Substitute `${VAR}`s in each enabled entry; skip (and log) disabled or unresolved ones. */
function buildMcps(entries: Entry[], env: Readonly<Record<string, string | undefined>>, log: Logger): McpPlugin[] {
  const out: McpPlugin[] = [];
  for (const entry of entries) {
    const name = entry.name as string;
    if (!entry.enabled) {
      log.info(`mcp ${name} skipped (disabled in plugins.json)`);
      continue;
    }
    const result = interpolate(entry, env);
    if (typeof result === 'string') log.error(`mcp ${name} skipped (unresolved \${VAR} in ${result})`);
    else out.push(result);
  }
  return out;
}

/** The interpolated plugin, or the name of the first field with an unresolved `${VAR}`. */
function interpolate(entry: Entry, env: Readonly<Record<string, string | undefined>>): McpPlugin | string {
  const name = entry.name as string;
  const type = (entry.type ?? 'stdio') as McpTransport;
  const base = { name, type, allowedTools: entry.allowed_tools as string[], args: [], env: {}, headers: {} };
  if (type !== 'stdio') {
    const url = substitute(entry.url as string, env);
    if (url === undefined) return 'url';
    const headers = substituteMap(entry.headers, env, name, 'headers');
    return typeof headers === 'string' ? headers : { ...base, url, headers };
  }
  const args = substituteArgs(entry.args, env, name);
  if (typeof args === 'string') return args;
  const childEnv = substituteMap(entry.env, env, name, 'env');
  return typeof childEnv === 'string' ? childEnv : { ...base, command: entry.command as string, args, env: childEnv };
}

function substituteArgs(raw: unknown, env: Readonly<Record<string, string | undefined>>, name: string): string[] | string {
  if (!raw) return [];
  if (!Array.isArray(raw)) throw new Error(`mcps[${JSON.stringify(name)}].args must be a list of strings`);
  const out: string[] = [];
  for (const [i, arg] of raw.entries()) {
    if (typeof arg !== 'string') throw new Error(`mcps[${JSON.stringify(name)}].args[${i}] must be a string`);
    const value = substitute(arg, env);
    if (value === undefined) return `args[${i}]`;
    out.push(value);
  }
  return out;
}

function substituteMap(raw: unknown, env: Readonly<Record<string, string | undefined>>, name: string, field: string): Record<string, string> | string {
  if (!raw) return {};
  if (!isRecord(raw) || Object.values(raw).some((v) => typeof v !== 'string')) {
    throw new Error(`mcps[${JSON.stringify(name)}].${field} entries must be string→string`);
  }
  const out: Record<string, string> = {};
  for (const [key, template] of Object.entries(raw as Record<string, string>)) {
    const value = substitute(template, env);
    if (value === undefined) return `${field}[${key}]`;
    out[key] = value;
  }
  return out;
}

/** Replace every `${VAR}`; undefined when any referenced variable is unset or empty. */
function substitute(template: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  let missing = false;
  const out = template.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_m, key: string) => {
    const value = env[key] ?? '';
    if (!value) missing = true;
    return value;
  });
  return missing ? undefined : out;
}

const list = (items: readonly string[]) => JSON.stringify([...items].sort());
