import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeMcpConfig } from '../src/claude/mcpconfig.ts';
import { loadPlugins, pluginsSummary } from '../src/plugins.ts';
import { loadGolden } from './golden/load.ts';
import { memoryLogger } from './helpers/log.ts';
import { tempDir } from './helpers/tmp.ts';

interface ArgvGolden {
  cases: { label: string; resume: boolean; plugins: unknown; env: Record<string, string>; mcp_config: { mcpServers: Record<string, unknown> } }[];
  errors: { label: string; plugins: unknown; message?: string; ok?: boolean }[];
}

const golden = loadGolden<ArgvGolden>('argv.json');
const EXAMPLE = JSON.parse(readFileSync(new URL('../plugins.json.example', import.meta.url), 'utf8')) as unknown;

function write(data: unknown): string {
  const path = join(tempDir(), 'plugins.json');
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data === 'EXAMPLE' ? EXAMPLE : data));
  return path;
}

describe('plugins.json (golden)', () => {
  it.each(golden.cases.filter((c) => !c.resume).map((c) => [c.label, c] as const))('%s → mcp.json', (_label, c) => {
    const log = memoryLogger();
    const path = c.plugins === null ? join(tempDir(), 'missing.json') : write(c.plugins);
    const plugins = loadPlugins(path, c.env, log);
    const written = JSON.parse(readFileSync(writeMcpConfig(join(tempDir(), 'mcp.json'), 'http://127.0.0.1:41234/mcp', plugins, log), 'utf8')) as unknown;
    expect(written).toEqual(c.mcp_config);
  });

  it.each(golden.errors.map((e) => [e.label, e] as const))('%s', (label, e) => {
    const path = write(e.plugins);
    const load = () => loadPlugins(path, {}, memoryLogger());
    // JSON.parse words its errors differently across Node versions.
    if (label === 'not-json') return expect(load).toThrow(`${path}: invalid JSON: `);
    if (e.ok) return expect(load).not.toThrow();
    expect(load).toThrow(e.message?.replace(`<ROOT>/bad-${label}.json`, path));
  });

  it('rejects non-list args and non-object env or headers on enabled entries, even empty ones; missing or null means none', () => {
    const load = (extra: object) => loadPlugins(write({ mcps: [{ name: 'a', command: 'x', allowed_tools: ['mcp__a'], enabled: true, ...extra }] }), {}, memoryLogger());
    for (const args of ['abc', {}]) expect(() => load({ args })).toThrow('mcps["a"].args must be a list of strings');
    for (const env of [['x'], []]) expect(() => load({ env })).toThrow('mcps["a"].env entries must be string→string');
    const http = { name: 'a', type: 'http', url: 'http://x', headers: [], allowed_tools: ['mcp__a'], enabled: true };
    expect(() => loadPlugins(write({ mcps: [http] }), {}, memoryLogger())).toThrow('mcps["a"].headers entries must be string→string');
    for (const none of [{}, { args: null, env: null }, { args: [], env: {} }]) expect(load(none).mcps[0]).toMatchObject({ args: [], env: {} });
  });

  it('takes writable_projects as plain folders under projects/ and refuses anything that could escape it', () => {
    const load = (writable_projects: unknown) => loadPlugins(write({ writable_projects }), {}, memoryLogger());
    expect(load(['billing/docs', 'notes']).writableProjects).toEqual(['billing/docs', 'notes']);
    expect(load(undefined).writableProjects).toEqual([]);
    for (const bad of ['../data', '/etc', 'billing/../..', 'billing/*', 'billing//docs', './billing', 'docs/']) {
      expect(() => load([bad])).toThrow(`writable_projects entry ${JSON.stringify(bad)} must be a plain folder path under projects/`);
    }
    expect(() => load('billing')).toThrow('writable_projects must be an array');
  });

  it('boots locked-down without a file, pointing at the example', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'plugins.json.example'), '{}');
    const log = memoryLogger();
    expect(loadPlugins(join(dir, 'plugins.json'), {}, log)).toEqual({ toolGroups: {}, mcps: [], skillsDisabled: new Set(), builtinToolsDisabled: new Set(), writableProjects: [] });
    expect(log.text()).toContain(`ERROR no plugins.json at ${join(dir, 'plugins.json')} — using locked-down defaults`);
  });

  it('logs and skips an MCP whose ${VAR} is unset', () => {
    const log = memoryLogger();
    const plugins = loadPlugins(write({ mcps: [{ name: 'gh', command: 'npx', env: { T: '${GH}' }, allowed_tools: ['mcp__gh'], enabled: true }] }), {}, log);
    expect(plugins.mcps).toEqual([]);
    expect(log.text()).toContain('ERROR mcp gh skipped (unresolved ${VAR} in env[T])');
  });

  it('reports only the first unresolved location: args by index, then env by key; url, then headers', () => {
    const log = memoryLogger();
    const stdio = { name: 's', command: 'x', args: ['ok', '${A}'], env: { K: '${B}' }, allowed_tools: ['mcp__s'], enabled: true };
    const http = { name: 'h', type: 'http', url: 'https://${C}/mcp', headers: { H: '${D}' }, allowed_tools: ['mcp__h'], enabled: true };
    loadPlugins(write({ mcps: [stdio, http] }), {}, log);
    expect(log.text()).toBe('ERROR mcp s skipped (unresolved ${VAR} in args[1])\nERROR mcp h skipped (unresolved ${VAR} in url)');
  });

  it('summarises what it loaded for the boot log', () => {
    const plugins = loadPlugins(write({ tool_groups: { bash: true, code: false }, skills_disabled: ['x'], builtin_tools_disabled: ['time_now', 'tool_list'], writable_projects: ['billing/docs'] }), {}, memoryLogger());
    expect(pluginsSummary(plugins)).toBe('plugins loaded: 0 enabled mcp(s), 1 disabled skill(s), 2 disabled built-in tool(s), tool_groups={"bash":true,"code":false}, writable_projects=["billing/docs"]');
    expect(pluginsSummary(loadPlugins(write({}), {}, memoryLogger()))).toContain('tool_groups={}');
  });
});

