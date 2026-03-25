import { DeveloperMemoryService } from './service.js';

const service = new DeveloperMemoryService();

const sampleMemories = [
  {
    dimension: 'code',
    content: 'Fixed queue retry deadlock by adding jittered backoff and lock timeout guard in ingestion worker.',
    tags: 'bug,fix,queue,retry,lock',
    project: 'default',
    filePath: 'src/workers/memoryWorker.js',
    importance: 0.72,
  },
  {
    dimension: 'task',
    content: 'Implement adaptive context pack generation for Copilot, Cursor, and Claude Code outputs.',
    tags: 'task,context,llm,integration',
    project: 'default',
    filePath: 'src/brain/engines/contextEngine.js',
    importance: 0.68,
  },
  {
    dimension: 'cognitive',
    content: 'Use token-efficient context summaries first, then expand into detailed memory lines only when needed.',
    tags: 'insight,token-efficiency,prompting',
    project: 'default',
    importance: 0.75,
  },
  {
    dimension: 'episodic',
    content: 'During smoke tests, natural language context retrieval missed matches until token-based LIKE search was introduced.',
    tags: 'episode,debugging,search,learning',
    project: 'default',
    importance: 0.7,
  },
  {
    dimension: 'context',
    content: 'Current repo state is local-first with SQLite brain, no SaaS deployment assets, and CLI plus VS Code extension integration.',
    tags: 'project-state,local-first,architecture',
    project: 'default',
    importance: 0.8,
  },
];

for (const memory of sampleMemories) {
  service.addMemory(memory);
}

const insights = service.insights('default');
console.log(JSON.stringify({ success: true, seeded: sampleMemories.length, insights }, null, 2));
