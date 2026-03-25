import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { jest } from '@jest/globals';

jest.unstable_mockModule('@xenova/transformers', () => {
  return {
    env: { localModelPath: '', allowRemoteModels: false },
    pipeline: jest.fn().mockResolvedValue(async (text) => {
      const data = new globalThis.Float32Array(384).fill(0.1);
      return Object.assign(data, { data });
    })
  };
});

function runCli(args, env) {
  return execFileSync('node', ['src/brain/cli.js', ...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf-8',
  });
}

describe('brain CLI', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cli-test-'));
  const dbPath = path.join(tempDir, 'brain.db');
  const env = { ...process.env, MEMORY_BRAIN_DB_PATH: dbPath };

  afterAll(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test('add -> search -> context -> insights -> debug flow', () => {
    const addOut = runCli([
      'add',
      '--type', 'code',
      '--content', 'CLI test memory about queue retry fix',
      '--tags', 'bug,fix,queue',
      '--project', 'cli-test',
      '--json',
    ], env);
    const addJson = JSON.parse(addOut);
    expect(addJson.success).toBe(true);
    expect(addJson.memory.id).toBeDefined();

    const searchOut = runCli([
      'search',
      '--query', 'queue retry fix',
      '--project', 'cli-test',
      '--json',
    ], env);
    const searchJson = JSON.parse(searchOut);
    expect(searchJson.success).toBe(true);
    expect(searchJson.count).toBeGreaterThan(0);

    const contextOut = runCli([
      'context',
      '--query', 'improve queue reliability',
      '--project', 'cli-test',
      '--target', 'copilot',
      '--json',
    ], env);
    const contextJson = JSON.parse(contextOut);
    expect(contextJson.success).toBe(true);
    expect(contextJson.promptPack).toContain('Copilot');

    const insightsOut = runCli([
      'insights',
      '--project', 'cli-test',
      '--json',
    ], env);
    const insightsJson = JSON.parse(insightsOut);
    expect(insightsJson.success).toBe(true);
    expect(insightsJson.insights.totals.total).toBeGreaterThan(0);

    const debugOut = runCli(['debug', '--json'], env);
    const debugJson = JSON.parse(debugOut);
    expect(debugJson.success).toBe(true);
    expect(debugJson.debug.memoryCount).toBeGreaterThan(0);
  });


  test('stats command returns comprehensive statistics', () => {
    const out = runCli(['stats', '--json', '--project', 'cli-test'], env);
    const json = JSON.parse(out);
    expect(json.success).toBe(true);
    expect(json.stats.memoryCount).toBeGreaterThan(0);
    expect(json.stats.insights).toBeDefined();
  });

  test('link command creates relationships', () => {
    // Add two memories
    const m1 = JSON.parse(runCli([
      'add', '--type', 'code', '--content', 'Auth bug in token refresh', '--tags', 'bug,auth', '--json',
    ], env));
    const m2 = JSON.parse(runCli([
      'add', '--type', 'code', '--content', 'Fixed token refresh retry', '--tags', 'fix,auth', '--json',
    ], env));

    const linkOut = runCli([
      'link', '--from', String(m1.memory.id), '--to', String(m2.memory.id),
      '--relation', 'bug_fix_pair', '--weight', '0.9', '--json',
    ], env);
    const linkJson = JSON.parse(linkOut);
    expect(linkJson.success).toBe(true);
  });

  test('export command outputs data', () => {
    const out = runCli(['export', '--project', 'cli-test'], env);
    const json = JSON.parse(out);
    expect(json.memories.length).toBeGreaterThan(0);
    expect(json.exportedAt).toBeDefined();
  });
});
