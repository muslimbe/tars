import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

interface Compose {
  name: string;
  services: Record<string, { image?: string; build?: string; restart?: string; env_file?: string; working_dir?: string; stop_grace_period?: string; command?: string; volumes: string[]; depends_on?: Record<string, { condition: string }> }>;
}

describe('operations contract', () => {
  it('keeps the compose services, mounts and grace period', () => {
    const { name, services } = parse(read('docker-compose.yml')) as Compose;
    expect(name).toBe('tars');
    const init = services['tars-init'];
    expect(init?.image).toBe('alpine:3.19');
    expect(init?.volumes).toEqual(['./:/host']);
    for (const file of ['access.json', 'plugins.json', 'default-reminders.json']) expect(init?.command).toContain(`cp /host/${file}.example /host/${file}`);
    expect(services.tars).toMatchObject({
      build: '.', restart: 'on-failure', env_file: '.env', working_dir: '/app', stop_grace_period: '15s',
      depends_on: { 'tars-init': { condition: 'service_completed_successfully' } },
    });
    expect(services.tars?.volumes).toEqual([
      './data:/app/data', './memories:/app/memories', './prompts:/app/prompts', './skills:/app/skills', './projects:/app/projects:ro',
      '~/.claude:/root/.claude', '~/.claude.json:/root/.claude.json', './access.json:/app/access.json',
      './plugins.json:/app/plugins.json', './default-reminders.json:/app/default-reminders.json:ro',
    ]);
  });

  it('builds an image with tini as PID 1, the Claude Code CLI, Chromium and the app at /app', () => {
    const dockerfile = read('Dockerfile');
    for (const line of [
      'WORKDIR /app',
      'RUN npx playwright install --with-deps chromium',
      'COPY src/ src/',
      'COPY skills/ skills/',
      'COPY plugins.json.example plugins.json* ./',
      'COPY access.json.example access.json* ./',
      'COPY default-reminders.json.example default-reminders.json* ./',
      'VOLUME /app/data',
      'ENTRYPOINT ["/usr/bin/tini", "--"]',
      'CMD ["node", "src/main.ts"]',
    ]) expect(dockerfile).toContain(line);
    expect(dockerfile).toMatch(/^RUN npm ci --omit=dev$/m);
    // A rebuild must not silently change the Claude Code the bot runs on.
    expect(dockerfile).toMatch(/^ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+$/m);
    expect(dockerfile).toContain('RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}');
  });

  it('keeps secrets and runtime data out of the image', () => {
    const ignored = read('.dockerignore').split('\n');
    for (const entry of ['data/', 'prompts/project.md', '.env', '.env.local', '.git/', 'docs/', 'test/', '.claude/', 'node_modules/']) expect(ignored).toContain(entry);
    const gitignored = read('.gitignore').split('\n');
    for (const entry of ['.env', 'access.json', 'plugins.json', 'default-reminders.json', 'data/', 'memories/']) expect(gitignored.some((line) => line.replace(/^\//, '') === entry || line === `${entry}*`)).toBe(true);
  });
});
