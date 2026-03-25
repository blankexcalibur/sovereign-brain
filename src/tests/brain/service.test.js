import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';

// Bypass ONNX Runtime VM Context Bug
jest.unstable_mockModule('@xenova/transformers', () => {
  return {
    env: { localModelPath: '', allowRemoteModels: false },
    pipeline: jest.fn().mockResolvedValue(async (text) => {
      const data = new globalThis.Float32Array(384).fill(0.1);
      return Object.assign(data, { data });
    })
  };
});

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-service-test-'));
const dbPath = path.join(tempDir, 'brain.db');
process.env.MEMORY_BRAIN_DB_PATH = dbPath;

const { DeveloperMemoryService } = await import('../../brain/service.js');

describe('DeveloperMemoryService', () => {
  let service;

  beforeAll(() => {
    service = new DeveloperMemoryService();
  });

  afterAll(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test('adds and searches memories across dimensions', async () => {
    const added = await service.addMemory({
      dimension: 'code',
      content: 'Implemented retry backoff for queue consumer with lock protection',
      tags: 'bug,fix,queue,retry',
      project: 'test-project',
      importance: 0.6,
    });

    expect(added.id).toBeDefined();
    expect(added.dimension).toBe('code');

    const results = await service.searchMemories({
      query: 'queue retry backoff',
      project: 'test-project',
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(added.id);
    expect(results[0].score).toBeGreaterThan(0);
  });

  test('builds context packs with llmContext and promptPack', async () => {
    await service.addMemory({
      dimension: 'task',
      content: 'Need to improve reliability of ingestion queue processing.',
      tags: 'task,queue,reliability',
      project: 'test-project',
      importance: 0.7,
    });

    const context = await service.context({
      query: 'improve queue reliability',
      project: 'test-project',
      target: 'copilot',
      limit: 8,
    });

    expect(typeof context.promptPack).toBe('string');
    expect(typeof context.llmContext).toBe('string');
    expect(context.projectIntelligenceSummary).toContain('Total Memories');
    expect(context.relevantPastKnowledge.length + context.currentWorkingContext.length).toBeGreaterThan(0);
    expect(typeof context.estimatedTokens).toBe('number');
    expect(typeof context.tokenBudget).toBe('number');
  });

  test('returns insights and debug stats', () => {
    const insights = service.insights('test-project');
    expect(insights.totals.total).toBeGreaterThan(0);
    expect(insights.topTags).toBeDefined();

    const debug = service.debug();
    expect(debug.memoryCount).toBeGreaterThan(0);
    expect(debug.orphanRelationshipCount).toBeGreaterThanOrEqual(0);
    expect(debug.clusterCount).toBeGreaterThanOrEqual(0);
  });



  test('clustering groups related memories', async () => {
    await service.addMemory({
      dimension: 'code',
      content: 'Authentication module uses JWT tokens with RSA256 signing for sessions',
      tags: 'auth,jwt,security',
      project: 'test-project',
      importance: 0.6,
    });

    await service.addMemory({
      dimension: 'code',
      content: 'OAuth2 integration with Google uses JWT token exchange and RSA keys',
      tags: 'auth,oauth,jwt',
      project: 'test-project',
      importance: 0.5,
    });

    const clusterResult = await service.cluster();
    expect(typeof clusterResult.newClusters).toBe('number');
    expect(typeof clusterResult.assigned).toBe('number');
  });

  test('link creates manual relationships', async () => {
    const m1 = await service.addMemory({ dimension: 'code', content: 'Bug in auth token refresh', tags: 'bug,auth', project: 'test-project' });
    const m2 = await service.addMemory({ dimension: 'code', content: 'Fixed token refresh by adding retry', tags: 'fix,auth', project: 'test-project' });

    const linkResult = service.link(m1.id, m2.id, 'bug_fix_pair', 0.95);
    expect(linkResult.success).toBe(true);
    expect(linkResult.fromId).toBe(m1.id);
    expect(linkResult.toId).toBe(m2.id);

    const graph = service.getGraph(m1.id, 1);
    expect(graph.length).toBeGreaterThan(0);
  });

  test('export returns structured data', () => {
    const exported = service.exportAll('test-project');
    expect(exported.memories).toBeDefined();
    expect(exported.relationships).toBeDefined();
    expect(exported.clusters).toBeDefined();
    expect(exported.exportedAt).toBeDefined();
    expect(exported.memories.length).toBeGreaterThan(0);
  });

  test('stats returns comprehensive statistics', () => {
    const stats = service.stats('test-project');
    expect(stats.memoryCount).toBeGreaterThan(0);
    expect(stats.insights).toBeDefined();
    expect(stats.dimensionBreakdown).toBeDefined();
  });

  test('pattern engine detects languages and frameworks', async () => {
    const added = await service.addMemory({
      dimension: 'code',
      content: 'React component using useEffect and useState for async await data fetching with express API backend',
      tags: '',
      project: 'test-project',
      filePath: 'src/components/DataFetcher.tsx',
      importance: 0.5,
    });

    expect(added.tags).toContain('react');
    expect(added.tags).toContain('async');
    expect(added.tags).toContain('file:tsx');
    expect(added.tags).toContain('lang:typescript');
  });

  test('context packs differ by target', async () => {
    const copilot = await service.context({ query: 'auth', target: 'copilot', limit: 4 });
    const claude = await service.context({ query: 'auth', target: 'claude', limit: 4 });
    const cursor = await service.context({ query: 'auth', target: 'cursor', limit: 4 });

    expect(copilot.promptPack).toContain('Copilot');
    expect(claude.promptPack).toContain('<system>');
    expect(cursor.promptPack).toContain('Cursor');
  });
});
