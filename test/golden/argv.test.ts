import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildArgv } from '../../src/claude/argv.ts';
import { writeMcpConfig } from '../../src/claude/mcpconfig.ts';
import { loadSessionId, spawnSpec } from '../../src/claude/spec.ts';
import { loadPlugins } from '../../src/plugins.ts';
import { MemoryStore, renderMemoryIndex } from '../../src/stores/memory.ts';
import { renderSkillsIndex, SkillsStore } from '../../src/stores/skills.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';
import { loadGolden } from './load.ts';
import { goldenRegistry } from './tools.ts';

interface Case {
  label: string;
  resume: boolean;
  plugins: unknown;
  env: Record<string, string>;
  argv: string[];
  mcp_config: unknown;
}

const golden = loadGolden<{ cases: Case[] }>('argv.json');

/** The prompt inputs the golden prompts were rendered from. */
function promptInputs(base: string): void {
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), text);
  };
  write('prompts/system.md', '# System\n\nBe helpful. Oʻzbek ✅\n');
  write('prompts/project.md', '# Project\n\nName: Mira\n');
  write('prompts/subagents.md', '# Subagents\n\nUse Agent wisely.\n');
  write('skills/alpha/SKILL.md', '---\nname: alpha\ndescription: First skill — does A\n---\n\nBody of alpha.\n');
  write('skills/beta/SKILL.md', '---\nname: beta\ndescription: Second skill\n---\n\nBody of beta.\n');
  write('memories/notes/references.md', '---\nname: references\ndescription: Useful links\n---\n\n- x\n');
  write('memories/people.md', '---\nname: people\ndescription: Who is who\n---\n\nAlice.\n');
  write('memories/legacy.md', 'no frontmatter at all\n');
}

function argvFor(base: string, c: Case): { argv: string[]; mcpConfig: string } {
  const pluginsPath = join(base, `plugins-${c.label}.json`);
  if (c.plugins !== null) writeFileSync(pluginsPath, JSON.stringify(c.plugins));
  const log = memoryLogger();
  const plugins = loadPlugins(pluginsPath, c.env, log);
  const sessionPath = join(base, `session-${c.label}`);
  if (c.resume) writeFileSync(sessionPath, '11111111-2222-3333-4444-555555555555\n');
  const skills = new SkillsStore(join(base, 'skills'), plugins.skillsDisabled);
  const memory = new MemoryStore(join(base, 'memories'));
  const toolNames = goldenRegistry([...plugins.builtinToolsDisabled]).tools.map((t) => t.name);
  const mcpConfigPath = writeMcpConfig(join(tempDir(), 'mcp.json'), 'http://127.0.0.1:41234/mcp', plugins, log);
  const config = { claudeCodeBin: 'claude', model: 'claude-opus-4-7', effort: 'high', ownerIds: [42], promptsDir: join(base, 'prompts'), projectsDir: join(base, 'projects') };
  const indexes = () => ({ skills: renderSkillsIndex(skills), memory: renderMemoryIndex(memory) });
  const spec = spawnSpec(config, plugins, { mcpConfigPath, toolNames, indexes });
  return { argv: buildArgv(spec(loadSessionId(sessionPath, log))), mcpConfig: mcpConfigPath };
}

describe('claude argv and composed system prompt (golden)', () => {
  it.each(golden.cases.map((c) => [`${c.label}${c.resume ? ' (resume)' : ''}`, c] as const))('%s', (_label, c) => {
    const base = tempDir();
    promptInputs(base);
    const { argv, mcpConfig } = argvFor(base, c);
    const specTmp = dirname(mcpConfig);
    rmSync(specTmp, { recursive: true, force: true });
    expect(argv.map((arg) => arg.replaceAll(specTmp, '<SPEC_TMP>').replaceAll(base, '<ROOT>'))).toEqual(c.argv);
  });

  it('re-reads project.md and re-renders both indexes on every spawn', () => {
    const base = tempDir();
    promptInputs(base);
    const c = golden.cases.find((g) => g.label === 'missing-file' && !g.resume) as Case;
    const spawn = () => argvFor(base, c).argv[13] ?? '';
    expect(spawn()).not.toContain('Name: Sol');
    writeFileSync(join(base, 'prompts/project.md'), '# Project\n\nName: Sol\n');
    writeFileSync(join(base, 'memories/new.md'), '---\nname: new\ndescription: Written since boot\n---\n');
    rmSync(join(base, 'skills/beta'), { recursive: true });
    const prompt = spawn();
    expect(prompt).toContain('Name: Sol');
    expect(prompt).toContain('- `memories/new.md` — Written since boot');
    expect(prompt).not.toContain('**beta**');
  });
});

