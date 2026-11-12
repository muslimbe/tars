import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildArgv, type SpawnSpec } from '../../src/claude/argv.ts';
import { tempDir } from '../helpers/tmp.ts';

function spec(overrides: Partial<SpawnSpec> = {}): SpawnSpec {
  const dir = tempDir();
  for (const name of ['system.md', 'mcp.json']) writeFileSync(join(dir, name), name === 'mcp.json' ? '{}' : '# System\n');
  return {
    binary: 'claude', model: 'm', effort: 'high', ownerIds: [42],
    systemPromptPath: join(dir, 'system.md'), projectPromptPath: join(dir, 'project.md'), subagentsPromptPath: join(dir, 'subagents.md'),
    mcpConfigPath: join(dir, 'mcp.json'), enableBash: false, enableCode: false, enableRead: false, enableSubagents: false, projectsDir: '/app/projects', writableDirs: [],
    mcpAllowedTools: [], tarsToolNames: ['time_now'], skillsIndex: '', memoryIndex: '',
    ...overrides,
  };
}

describe('claude argv inputs', () => {
  it('refuses to build without the system prompt or the MCP config', () => {
    expect(() => buildArgv(spec({ systemPromptPath: '/nope/system.md' }))).toThrow('required file is missing: /nope/system.md');
    expect(() => buildArgv(spec({ mcpConfigPath: '/nope/mcp.json' }))).toThrow('required file is missing: /nope/mcp.json');
    expect(() => buildArgv(spec())).not.toThrow();
  });

  it('needs prompts/subagents.md once subagents are on', () => {
    const s = spec({ enableSubagents: true });
    expect(() => buildArgv(s)).toThrow(`subagents are enabled but the subagent prompt is missing: ${s.subagentsPromptPath}`);
    writeFileSync(s.subagentsPromptPath, '# Subagents\n');
    expect(buildArgv(s)[13]).toMatch(/# Subagents\n$/);
  });

  it("names every owner account, so the owner's rules cover them all", () => {
    expect(buildArgv(spec()).join('\n')).toContain('The owner\'s Telegram user_id is `42`. A `<msg>` with `user="42"` is the owner; any other user_id is not');
    expect(buildArgv(spec({ ownerIds: [42, 77] })).join('\n')).toContain(
      "The owner's Telegram user_ids are `42`, `77` — the same person's accounts, with the same rights; a DM with any of them is the owner's DM. " +
        'A `<msg>` whose `user` is one of them is the owner; any other user_id is not',
    );
  });
});
