import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig, PROJECT_ROOT } from '../src/config.ts';

const REQUIRED = { TELEGRAM_BOT_TOKEN: '1:t', TARS_OWNER_ID: '42', TARS_MODEL: 'm', TARS_EFFORT: 'high' };
const load = (env: Record<string, string> = {}) => loadConfig({ ...REQUIRED, ...env }, '/srv/app');

describe('config', () => {
  it('requires the four core variables and parses the owner id', () => {
    expect(() => loadConfig({}, '/x')).toThrow('missing required environment variable: TELEGRAM_BOT_TOKEN');
    expect(() => loadConfig({ ...REQUIRED, TARS_OWNER_ID: 'abc' }, '/x')).toThrow('TARS_OWNER_ID must be a non-negative integer, got "abc"');
    expect(load()).toMatchObject({ telegramBotToken: '1:t', ownerId: 42, model: 'm', effort: 'high', claudeCodeBin: 'claude' });
  });

  it('treats empty as unset and parses numbers, surrounding spaces allowed', () => {
    expect(load({ TARS_DEBOUNCE_MS: '' }).debounceMs).toBe(0);
    expect(load({ TARS_RATE_LIMIT_PER_MIN: ' 1000 ' }).rateLimitPerMin).toBe(1000);
    expect(() => load({ TARS_RATE_LIMIT_PER_MIN: '1_000' })).toThrow('TARS_RATE_LIMIT_PER_MIN must be a non-negative integer, got "1_000"');
    expect(load({ TARS_RATE_LIMIT_PER_MIN: '0' }).rateLimitPerMin).toBe(0);
    expect(() => load({ TARS_CRASH_LIMIT: '-1' })).toThrow('TARS_CRASH_LIMIT must be a non-negative integer, got "-1"');
    expect(load({ TARS_CRASH_BACKOFF_BASE: '0.5' }).crashBackoffBase).toBe(0.5);
    expect(load({ TARS_LIVENESS_TIMEOUT_SECONDS: '1e3' }).livenessTimeoutSeconds).toBe(1000);
    expect(() => load({ TARS_CRASH_LIMIT: '10.0' })).toThrow('TARS_CRASH_LIMIT must be a non-negative integer, got "10.0"');
    expect(() => load({ TARS_CRASH_BACKOFF_CAP: 'soon' })).toThrow('TARS_CRASH_BACKOFF_CAP must be a positive number, got "soon"');
    // A zero poll interval would spin the liveness check every millisecond.
    expect(() => load({ TARS_LIVENESS_POLL_SECONDS: '0' })).toThrow('TARS_LIVENESS_POLL_SECONDS must be a positive number, got "0"');
  });

  it('reads booleans: 1/true/yes/on and 0/false/no/off; a typo stops boot', () => {
    for (const yes of ['1', 'true', 'YES', ' on ']) expect(load({ TARS_BROWSER_HEADLESS: yes }).browserHeadless).toBe(true);
    for (const no of ['0', 'false', 'no', 'off']) expect(load({ TARS_SELF_REFLECTION_ENABLED: no }).selfReflectionEnabled).toBe(false);
    expect(() => load({ TARS_BROWSER_HEADLESS: 'ture' })).toThrow('TARS_BROWSER_HEADLESS must be true or false, got "ture"');
    expect(load().selfReflectionEnabled).toBe(true);
  });

  it('validates the log level and transcript mode', () => {
    expect(load({ TARS_LOG_LEVEL: 'warn' }).logLevel).toBe('WARNING');
    expect(() => load({ TARS_LOG_LEVEL: 'loud' })).toThrow('unknown log level "loud"');
    expect(load({ TARS_LOG_TRANSCRIPT: 'FULL' }).logTranscript).toBe('full');
    expect(() => load({ TARS_LOG_TRANSCRIPT: 'all' })).toThrow('TARS_LOG_TRANSCRIPT must be "compact" or "full", got "all"');
  });

  it('lets every group message through unless told to keep only the addressed ones', () => {
    expect(load().groupMessages).toBe('all');
    expect(load({ TARS_GROUP_MESSAGES: ' Addressed ' }).groupMessages).toBe('addressed');
    expect(() => load({ TARS_GROUP_MESSAGES: 'mentions' })).toThrow('TARS_GROUP_MESSAGES must be "all" or "addressed", got "mentions"');
  });

  it('reads extra group addressees as a comma-separated list of user ids', () => {
    expect(load().groupAddressees).toEqual([]);
    expect(load({ TARS_GROUP_ADDRESSEES: ' 7580081248, 42 ' }).groupAddressees).toEqual([7580081248, 42]);
    expect(() => load({ TARS_GROUP_ADDRESSEES: '@someone' })).toThrow('TARS_GROUP_ADDRESSEES must be comma-separated user ids, got "@someone"');
  });

  it("lists the owner's other accounts after the main one", () => {
    expect(load()).toMatchObject({ ownerId: 42, ownerIds: [42] });
    expect(load({ TARS_OWNER_ALT_IDS: '7580081248' })).toMatchObject({ ownerId: 42, ownerIds: [42, 7580081248] });
    expect(() => load({ TARS_OWNER_ALT_IDS: '@work' })).toThrow('TARS_OWNER_ALT_IDS must be comma-separated user ids, got "@work"');
  });

  it('derives data paths from TARS_DATA_DIR and operator files from the repo root', () => {
    const config = load({ TARS_DATA_DIR: 'var/data', TARS_ACCESS_PATH: 'conf/access.json' });
    expect(config.dataDir).toBe('/srv/app/var/data');
    expect(config.dbPath).toBe('/srv/app/var/data/tars.db');
    expect(config.sessionIdPath).toBe('/srv/app/var/data/session_id');
    expect(config.logDir).toBe('/srv/app/var/data/logs');
    expect(config.accessPath).toBe('/srv/app/conf/access.json');
    expect(config.pluginsPath).toBe(resolve(PROJECT_ROOT, 'plugins.json'));
    expect(config.memoriesDir).toBe(resolve(PROJECT_ROOT, 'memories'));
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('turns self-reflection on by default at midnight UTC', () => {
    expect(load()).toMatchObject({ selfReflectionEnabled: true, selfReflectionCron: '0 0 * * *' });
    expect(load({ TARS_SELF_REFLECTION_ENABLED: '', TARS_SELF_REFLECTION_CRON: '' })).toMatchObject({ selfReflectionEnabled: true, selfReflectionCron: '0 0 * * *' });
    expect(load({ TARS_SELF_REFLECTION_ENABLED: 'off', TARS_SELF_REFLECTION_CRON: '30 2 * * 1' })).toMatchObject({ selfReflectionEnabled: false, selfReflectionCron: '30 2 * * 1' });
  });
});

