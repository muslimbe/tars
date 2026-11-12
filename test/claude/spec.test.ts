import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadSessionId, spawnDescription, spawnSpec } from '../../src/claude/spec.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

describe('spawn spec helpers', () => {
  it('resumes the session saved in data/session_id, if it holds one', () => {
    const dir = tempDir();
    const path = join(dir, 'session_id');
    const log = memoryLogger();
    expect(loadSessionId(path, log)).toBeUndefined();
    writeFileSync(path, '  \n');
    expect(loadSessionId(path, log)).toBeUndefined();
    writeFileSync(path, 'abc-123\n');
    expect(loadSessionId(path, log)).toBe('abc-123');
    expect(log.text()).toBe('INFO resuming cc session abc-123');
  });

  it('resolves writable_projects under the projects folder', () => {
    const config = { claudeCodeBin: 'claude', model: 'm', effort: 'high', ownerIds: [1], promptsDir: '/app/prompts', projectsDir: '/app/projects' };
    const plugins = { toolGroups: { read: true }, mcps: [], writableProjects: ['billing/docs'] };
    const s = spawnSpec(config, plugins, { mcpConfigPath: '/x/mcp.json', toolNames: [], indexes: () => ({ skills: '', memory: '' }) })(undefined);
    expect(s).toMatchObject({ enableRead: true, projectsDir: '/app/projects', writableDirs: ['/app/projects/billing/docs'] });
  });

  it('describes a spawn by model, enabled groups and external MCP tool count', () => {
    const mcps = [{ allowedTools: ['mcp__a', 'mcp__b'] }, { allowedTools: ['mcp__c'] }] as never;
    expect(spawnDescription('opus', { toolGroups: { bash: true, code: false, subagents: true }, mcps })).toEqual({ model: 'opus', enabled: ['bash', 'subagents'], mcpTools: 3 });
    expect(spawnDescription('opus', { toolGroups: {}, mcps: [] })).toEqual({ model: 'opus', enabled: [], mcpTools: 0 });
  });
});
