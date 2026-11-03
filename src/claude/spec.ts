import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Config } from '../config.ts';
import type { Logger } from '../log/logger.ts';
import type { Plugins } from '../plugins.ts';
import type { SpawnSpec } from './argv.ts';

/** Everything `buildArgv` needs except the session, which changes as the worker learns it. */
export function spawnSpec(
  config: Pick<Config, 'claudeCodeBin' | 'model' | 'effort' | 'ownerId' | 'promptsDir' | 'projectsDir'>,
  plugins: Pick<Plugins, 'toolGroups' | 'mcps' | 'writableProjects'>,
  wiring: { mcpConfigPath: string; toolNames: readonly string[]; indexes: () => { skills: string; memory: string } },
): (sessionId: string | undefined) => SpawnSpec {
  const groups = plugins.toolGroups;
  return (sessionId) => {
    const { skills, memory } = wiring.indexes();
    return {
      binary: config.claudeCodeBin,
      model: config.model,
      effort: config.effort,
      ownerId: config.ownerId,
      systemPromptPath: join(config.promptsDir, 'system.md'),
      projectPromptPath: join(config.promptsDir, 'project.md'),
      subagentsPromptPath: join(config.promptsDir, 'subagents.md'),
      mcpConfigPath: wiring.mcpConfigPath,
      sessionId,
      enableBash: Boolean(groups.bash),
      enableCode: Boolean(groups.code),
      enableRead: Boolean(groups.read),
      projectsDir: config.projectsDir,
      writableDirs: plugins.writableProjects.map((dir) => join(config.projectsDir, dir)),
      enableSubagents: Boolean(groups.subagents),
      mcpAllowedTools: plugins.mcps.flatMap((m) => m.allowedTools),
      tarsToolNames: wiring.toolNames,
      // Rendered per spawn, so a reset or respawn sees memory written since boot.
      skillsIndex: skills,
      memoryIndex: memory,
    };
  };
}

/** The session to `--resume` at boot: `data/session_id`, if it holds one. */
export function loadSessionId(path: string, log: Logger): string | undefined {
  if (!existsSync(path)) return undefined;
  const id = readFileSync(path, 'utf8').trim() || undefined;
  if (id) log.info(`resuming cc session ${id}`);
  return id;
}

/** The fields of the worker's "spawning claude" log line. */
export function spawnDescription(model: string, plugins: Pick<Plugins, 'toolGroups' | 'mcps'>): { model: string; enabled: string[]; mcpTools: number } {
  const enabled = (['bash', 'code', 'read', 'subagents'] as const).filter((group) => plugins.toolGroups[group]);
  return { model, enabled, mcpTools: plugins.mcps.flatMap((m) => m.allowedTools).length };
}
