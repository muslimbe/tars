import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

import { buildArgv, FORBIDDEN_FLAG, type SpawnSpec } from '../src/claude/argv.ts';
import { MCP_SERVER_NAME } from '../src/mcp/server.ts';
import { buildTools } from '../src/tools/index.ts';
import { memoryLogger } from './helpers/log.ts';
import { tempDir } from './helpers/tmp.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function spec(over: Partial<SpawnSpec> = {}): SpawnSpec {
  const dir = tempDir();
  mkdirSync(join(dir, 'prompts'));
  writeFileSync(join(dir, 'prompts/system.md'), '# System');
  writeFileSync(join(dir, 'prompts/subagents.md'), '# Subagents\nSubagents are read-only helpers.');
  writeFileSync(join(dir, 'mcp.json'), '{}');
  return {
    binary: 'claude', model: 'm', effort: 'high', ownerIds: [42], systemPromptPath: join(dir, 'prompts/system.md'), projectPromptPath: join(dir, 'prompts/project.md'),
    subagentsPromptPath: join(dir, 'prompts/subagents.md'), mcpConfigPath: join(dir, 'mcp.json'), enableBash: false, enableCode: false, enableRead: false, enableSubagents: false, projectsDir: '/app/projects', writableDirs: [],
    mcpAllowedTools: [], tarsToolNames: ['time_now'], skillsIndex: '', memoryIndex: '', ...over,
  };
}

const flag = (argv: string[], name: string) => (argv[argv.indexOf(name) + 1] ?? '').split(',');
const BASH = ['Bash', 'PowerShell', 'Monitor'];
const CODE = ['Edit', 'Write', 'Read', 'NotebookEdit', 'Glob', 'Grep', 'LSP'];
const READ = ['Read', 'Glob', 'Grep'];
const WRITE = ['Edit', 'Write', 'NotebookEdit', 'LSP'];

describe('security invariant 1: a locked-down claude argv', () => {
  it('allows only the base surface by default and denies every gated tool', () => {
    const argv = buildArgv(spec());
    expect(flag(argv, '--allowedTools')).toEqual(['mcp__tars', 'WebFetch', 'WebSearch']);
    expect(flag(argv, '--disallowedTools')).toEqual([...BASH, ...CODE, 'Agent']);
    expect(flag(argv, '--tools')).not.toEqual(expect.arrayContaining(['Bash']));
    expect(argv).not.toContain(FORBIDDEN_FLAG);
    expect(argv.join(' ')).not.toContain(FORBIDDEN_FLAG);
  });

  it.each([
    ['bash', { enableBash: true }, BASH, [...CODE, 'Agent']],
    ['code', { enableCode: true }, CODE, [...BASH, 'Agent']],
    ['subagents', { enableSubagents: true }, ['Agent'], [...BASH, ...CODE]],
  ] as const)('the %s group unlocks exactly its tools', (_g, over, unlocked, stillDenied) => {
    const argv = buildArgv(spec(over));
    for (const tool of unlocked) {
      expect(flag(argv, '--allowedTools')).toContain(tool);
      expect(flag(argv, '--disallowedTools')).not.toContain(tool);
    }
    for (const tool of stillDenied) expect(flag(argv, '--disallowedTools')).toContain(tool);
  });

  it('allows the read group only under projects/, never as a bare tool name', () => {
    const argv = buildArgv(spec({ enableRead: true }));
    expect(flag(argv, '--tools')).toEqual(expect.arrayContaining(READ));
    for (const tool of WRITE) expect(flag(argv, '--tools')).not.toContain(tool);
    // A bare `Read` lets Claude Code read any file in the container, .env and the database included.
    expect(flag(argv, '--allowedTools')).toEqual(['mcp__tars', 'WebFetch', 'WebSearch', 'Read(//app/projects/**)']);
    for (const tool of READ) expect(flag(argv, '--disallowedTools')).not.toContain(tool);
    expect(flag(argv, '--disallowedTools')).toEqual(expect.arrayContaining([...BASH, ...WRITE, 'Agent']));
  });

  it('allows edits only in the writable folders, which also turn on reading', () => {
    const argv = buildArgv(spec({ writableDirs: ['/app/projects/billing/docs'] }));
    expect(flag(argv, '--tools')).toEqual(expect.arrayContaining([...READ, 'Edit', 'Write']));
    expect(flag(argv, '--allowedTools')).toEqual(['mcp__tars', 'WebFetch', 'WebSearch', 'Read(//app/projects/**)', 'Edit(//app/projects/billing/docs/**)']);
    expect(flag(argv, '--disallowedTools')).toEqual([...BASH, 'NotebookEdit', 'LSP', 'Agent']);
  });

  it('passes exactly the external MCP allow entries it is given', () => {
    const argv = buildArgv(spec({ mcpAllowedTools: ['mcp__github'] }));
    expect(flag(argv, '--allowedTools')).toEqual(['mcp__tars', 'WebFetch', 'WebSearch', 'mcp__github']);
    expect(argv).toContain('--strict-mcp-config');
  });

  it("never loads the host's Claude Code settings, hooks, plugins, CLAUDE.md or auto-memory", () => {
    const argv = buildArgv(spec({}));
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('');
    expect(JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '{}')).toEqual({ autoMemoryEnabled: false });
  });

  it('refuses to build an argv carrying the forbidden flag', () => {
    expect(() => buildArgv(spec({ model: FORBIDDEN_FLAG }))).toThrow(`refusing to build argv containing '${FORBIDDEN_FLAG}'`);
  });
});

describe('security invariant 2: one MCP namespace', () => {
  it('names the server tars and keeps tool names bare', () => {
    expect(MCP_SERVER_NAME).toBe('tars');
    const tools = buildTools({ log: memoryLogger() } as never, new Set(), memoryLogger());
    for (const tool of tools) {
      expect(tool.name).not.toContain('__');
      expect(tool.name.startsWith('mcp_')).toBe(false);
    }
  });
});

describe('security invariants 5 and 6: structural import rails', () => {
  const eslint = new ESLint({ cwd: ROOT, overrideConfig: tseslint.configs.disableTypeChecked, ruleFilter: ({ ruleId }) => ruleId === 'no-restricted-imports' });
  const errors = async (code: string, file: string) => (await eslint.lintText(code, { filePath: join(ROOT, file) }))[0]?.messages.map((m) => m.message) ?? [];

  it('lets only the Claude worker spawn processes', async () => {
    expect(await errors("import { spawn } from 'node:child_process';\n", 'src/tools/probe.ts')).toEqual([expect.stringContaining('Only src/claude/child.ts may spawn processes.')]);
    expect(await errors("import { exec } from 'child_process';\n", 'src/engine/probe.ts')).toEqual([expect.stringContaining('Only src/claude/child.ts may spawn processes.')]);
    expect(await errors("import { spawn } from 'node:child_process';\n", 'src/claude/child.ts')).toEqual([]);
  });

  it('keeps tools off the filesystem (stores only)', async () => {
    expect(await errors("import { readFileSync } from 'node:fs';\n", 'src/tools/probe.ts')).toEqual([expect.stringContaining('Tools must go through a store in src/stores/')]);
    expect(await errors("import { readFile } from 'fs/promises';\n", 'src/tools/browser/probe.ts')).toHaveLength(1);
    expect(await errors("import { readFileSync } from 'node:fs';\n", 'src/stores/probe.ts')).toEqual([]);
  });

  it('keeps Chromium in src/browser', async () => {
    expect(await errors("import { chromium } from 'playwright';\n", 'src/tools/probe.ts')).toHaveLength(1);
    expect(await errors("import { chromium } from 'playwright';\n", 'src/browser/probe.ts')).toEqual([]);
  });

  it('the codebase obeys them', async () => {
    const results = await eslint.lintFiles(['src/**/*.ts']);
    expect(results.flatMap((r) => r.messages.map((m) => `${r.filePath}: ${m.message}`))).toEqual([]);
  });
});
