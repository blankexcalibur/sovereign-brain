#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { DeveloperMemoryService } from './service.js';
import { DIMENSIONS, VALID_DIMENSIONS, RELATION_TYPES } from './constants.js';
import { copyToClipboard } from './utils/clipboard.js';
import { colors, colorize, boldText, dimText, padRight, formatTable } from './utils/text.js';

const service = new DeveloperMemoryService();

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    const next = argv[i + 1];

    if (cur.startsWith('--')) {
      const key = cur.slice(2);
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(cur);
    }
  }
  return args;
}

function printUsage() {
  const c = colors;
  console.log(`${c.bold}${c.cyan}🧠 Developer Memory CLI${c.reset} — cognitive memory system for developers\n`);
  console.log(`${c.bold}Commands:${c.reset}`);
  console.log(`  ${c.green}add${c.reset}       Add a new memory`);
  console.log(`            ${c.dim}--type <cognitive|code|task|context|episodic> --content "..." [--tags a,b] [--project name] [--file path]${c.reset}`);
  console.log(`  ${c.green}search${c.reset}    Search memories`);
  console.log(`            ${c.dim}--query "..." [--project name] [--type dimension] [--limit 10] [--format json|table|compact]${c.reset}`);
  console.log(`  ${c.green}context${c.reset}   Generate LLM context pack`);
  console.log(`            ${c.dim}--query "..." [--project name] [--target copilot|cursor|claude] [--limit 12] [--out file] [--copy]${c.reset}`);
  console.log(`  ${c.green}insights${c.reset}  View memory analytics`);
  console.log(`            ${c.dim}[--project name] [--format json|table]${c.reset}`);
  console.log(`  ${c.green}compress${c.reset}  Compress stale/long memories`);
  console.log(`            ${c.dim}[--threshold 500] [--limit 30] [--format json|table]${c.reset}`);
  console.log(`  ${c.green}link${c.reset}      Create relationship between memories`);
  console.log(`            ${c.dim}--from <id> --to <id> --relation <type> [--weight 0.5]${c.reset}`);
  console.log(`  ${c.green}export${c.reset}    Export all memories`);
  console.log(`            ${c.dim}[--project name] [--out file] [--format json|markdown]${c.reset}`);
  console.log(`  ${c.green}stats${c.reset}     Detailed system statistics`);
  console.log(`            ${c.dim}[--project name] [--format json|table]${c.reset}`);
  console.log(`  ${c.green}backup${c.reset}    Run a force-native local snapshot`);
  console.log(`            ${c.dim}[--out path/to/backup.db.bak]${c.reset}`);
  console.log(`  ${c.green}dashboard${c.reset} Open the local observability telemetry UI`);
  console.log(`  ${c.green}mesh${c.reset}      E2EE encrypted brain sync`);
  console.log(`            ${c.dim}--export <path> --pass <passphrase>  |  --import <path> --pass <passphrase>${c.reset}`);
  console.log(`  ${c.green}ingest-git${c.reset} Auto-ingest recent git commits as memories`);
  console.log(`            ${c.dim}[--limit 30] [--project name]${c.reset}`);
  console.log(`  ${c.green}ingest-docs${c.reset} Crawl and embed external documentation`);
  console.log(`            ${c.dim}--url "https://docs.example.com" [--project "framework"]${c.reset}`);
  console.log(`  ${c.green}ingest-repo${c.reset} Mass ingestion of an entire local codebase`);
  console.log(`            ${c.dim}--path "./" [--project "my-repo"]${c.reset}`);
  console.log(`  ${c.green}ingest-vision${c.reset} Describe UI screenshots via Local Vision Model`);
  console.log(`            ${c.dim}--image "path/to/ui.png" [--project "frontend"]${c.reset}`);
  console.log(`  ${c.green}install-hook${c.reset}  Install the Git pre-commit architectural guardrail`);
  console.log(`  ${c.green}guard-commit${c.reset}  (Internal use) Run the commit evaluation hook`);
  console.log(`  ${c.green}mcp${c.reset}         Start the Model Context Protocol STDIO server`);
  console.log(`  ${c.green}chat${c.reset}      Ask the local AI about your codebase`);
  console.log(`            ${c.dim}--query "Your question"${c.reset}`);
  console.log(`  ${c.green}digest${c.reset}    Get daily knowledge digest for onboarding`);
  console.log(`  ${c.green}evolve${c.reset}    Run Agentic cleanup to find and refactor duplicated logic`);
  console.log(`            ${c.dim}[--limit 5] [--format json|table]${c.reset}`);
  console.log(`  ${c.green}doctor${c.reset}    Verify all system dependencies and report health`);
  console.log(`  ${c.green}debug${c.reset}     Debug information`);
  console.log(`            ${c.dim}[--format json|table]${c.reset}`);
  console.log(`\n${c.bold}Relation Types:${c.reset} ${Object.values(RELATION_TYPES).join(', ')}`);
}

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getFormat(args) {
  if (args.json) return 'json';
  return args.format || 'table';
}

function printResult(result, format) {
  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result);
  }
}

// ── Commands ─────────────────────────────────────────────────────────

async function cmdAdd(args) {
  const dimension = args.type || args.dimension;
  const content = args.content;

  if (!dimension || !content) {
    throw new Error('add requires --type (or --dimension) and --content');
  }

  if (!VALID_DIMENSIONS.has(dimension)) {
    throw new Error(`add --type must be one of: ${[...VALID_DIMENSIONS].join(', ')}`);
  }

  const memory = await service.addMemory({
    dimension,
    content,
    tags: args.tags || '',
    project: args.project || null,
    filePath: args.file || null,
    importance: asNumber(args.importance, 0.5),
    decayFactor: asNumber(args.decay, 0.985),
    metadata: {
      source: 'cli',
      title: args.title || null,
    },
  });

  const format = getFormat(args);
  if (format === 'json') {
    printResult({ success: true, memory }, 'json');
  } else {
    console.log(`${colors.green}✓${colors.reset} Memory ${colorize(`#${memory.id}`, colors.bold)} added (${colorize(memory.dimension, colors.cyan)})`);
    console.log(`  ${dimText('Summary:')} ${memory.summary}`);
    console.log(`  ${dimText('Tags:')} ${(memory.tags || []).join(', ')}`);
    console.log(`  ${dimText('Importance:')} ${Number(memory.importance).toFixed(2)}`);

    if (memory.conflicts && memory.conflicts.length > 0) {
      console.log(`\n${colors.red}${colors.bold}⚠️  CONFLICT WARNING ⚠️${colors.reset}`);
      console.log(`High similarity to recently added memories from other sources:`);
      for (const c of memory.conflicts) {
        console.log(`  ${colors.yellow}→ [Similarity: ${c.similarity}]${colors.reset} ${c.existingSummary}`);
        console.log(`    ${dimText('Resolution:')} ${c.resolution}`);
      }
    }
  }
}

async function cmdSearch(args) {
  if (!args.query) throw new Error('search requires --query');

  const results = await service.searchMemories({
    query: args.query,
    project: args.project || null,
    dimension: args.type || null,
    limit: asNumber(args.limit, 10),
  });

  const format = getFormat(args);
  if (format === 'json') {
    printResult({ success: true, count: results.length, results }, 'json');
    return;
  }

  if (results.length === 0) {
    console.log(`${colors.yellow}No memories found for "${args.query}"${colors.reset}`);
    return;
  }

  console.log(`${boldText(`Found ${results.length} memories:`)} ${dimText(`(query: "${args.query}")`)}\n`);

  if (format === 'compact') {
    for (const m of results) {
      console.log(`  ${colorize(`[${m.dimension}]`, colors.cyan)} ${m.summary}`);
    }
    return;
  }

  // Table format
  const headers = ['ID', 'Dimension', 'Score', 'Imp', 'Use', 'Summary'];
  const rows = results.map((m) => [
    `#${m.id}`,
    m.dimension,
    m.score.toFixed(3),
    Number(m.importance).toFixed(2),
    m.usage_count,
    (m.summary || '').slice(0, 60),
  ]);
  console.log(formatTable(headers, rows));
}

async function cmdContext(args) {
  if (!args.query) throw new Error('context requires --query');

  const target = String(args.target || 'copilot').toLowerCase();
  if (!['copilot', 'cursor', 'claude'].includes(target)) {
    throw new Error('context --target must be one of: copilot, cursor, claude');
  }

  const context = await service.context({
    query: args.query,
    project: args.project || null,
    target,
    limit: asNumber(args.limit, 12),
  });

  if (args.out) {
    const outputPath = path.resolve(process.cwd(), args.out);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, context.promptPack, 'utf-8');
  }

  if (args.copy) {
    const copied = copyToClipboard(context.promptPack);
    if (!copied) {
      console.error(`${colors.yellow}Warning: failed to copy prompt pack to clipboard.${colors.reset}`);
    } else {
      console.log(`${colors.green}✓${colors.reset} Prompt pack copied to clipboard.`);
    }
  }

  const format = getFormat(args);
  if (format === 'json') {
    printResult({ success: true, ...context }, 'json');
    return;
  }

  console.log(`${boldText(`=== ${target.toUpperCase()} MEMORY CONTEXT PACK ===`)}`);
  console.log(`${dimText(`Tokens: ~${context.estimatedTokens} / ${context.tokenBudget} budget`)}`);
  console.log(`${dimText(`Working context: ${context.currentWorkingContext.length} | Past knowledge: ${context.relevantPastKnowledge.length} | Graph: ${(context.graphRelated || []).length}`)}\n`);
  console.log(context.promptPack);
  if (args.out) {
    console.log(`\n${colors.green}✓${colors.reset} Saved to ${args.out}`);
  }
}

async function cmdInsights(args) {
  const insights = service.insights(args.project || null);
  const format = getFormat(args);

  if (format === 'json') {
    printResult({ success: true, insights }, 'json');
    return;
  }

  console.log(boldText('=== MEMORY INSIGHTS ===\n'));

  // Totals
  console.log(`  ${colorize('Total Memories:', colors.cyan)} ${insights.totals.total || 0}`);
  console.log(`  ${colorize('Avg Importance:', colors.cyan)} ${Number(insights.totals.avgImportance || 0).toFixed(2)}`);
  console.log(`  ${colorize('Total Usage:', colors.cyan)} ${insights.totals.totalUsage || 0}`);
  console.log(`  ${colorize('Relationships:', colors.cyan)} ${insights.relationshipCount || 0}`);
  console.log(`  ${colorize('Clusters:', colors.cyan)} ${insights.clusterCount || 0}`);

  // Compression
  if (insights.compressionStats) {
    console.log(`  ${colorize('Compressed:', colors.cyan)} ${insights.compressionStats.compressed || 0} / ${(insights.compressionStats.compressed || 0) + (insights.compressionStats.uncompressed || 0)}`);
  }

  // By Dimension
  if (insights.byDimension.length > 0) {
    console.log(`\n${boldText('By Dimension:')}`);
    const headers = ['Dimension', 'Count', 'Avg Importance', 'Total Usage'];
    const rows = insights.byDimension.map((d) => [
      d.dimension, d.count,
      Number(d.avgImportance || 0).toFixed(2),
      d.totalUsage || 0,
    ]);
    console.log(formatTable(headers, rows));
  }

  // Top Tags
  if (insights.topTags && insights.topTags.length > 0) {
    console.log(`\n${boldText('Top Tags:')}`);
    const tagParts = insights.topTags.map((t) => `${colorize(t.tag, colors.magenta)}(${t.count})`);
    console.log(`  ${tagParts.join('  ')}`);
  }
}

async function cmdCompress(args) {
  const result = await service.compress({
    minContentLength: asNumber(args.threshold, 500),
    limit: asNumber(args.limit, 30),
  });

  const format = getFormat(args);
  if (format === 'json') {
    printResult({ success: true, ...result }, 'json');
    return;
  }

  console.log(`${colors.green}✓${colors.reset} Compression complete: ${result.compressed} memories compressed (${result.candidates} candidates found)`);
}

async function cmdLink(args) {
  const fromId = asNumber(args.from, null);
  const toId = asNumber(args.to, null);
  const relation = args.relation;

  if (!fromId || !toId || !relation) {
    throw new Error('link requires --from <id> --to <id> --relation <type>');
  }

  const validRelations = new Set(Object.values(RELATION_TYPES));
  if (!validRelations.has(relation)) {
    throw new Error(`Invalid relation type. Valid: ${[...validRelations].join(', ')}`);
  }

  const result = service.link(fromId, toId, relation, asNumber(args.weight, 0.5));
  const format = getFormat(args);

  if (format === 'json') {
    printResult(result, 'json');
    return;
  }

  console.log(`${colors.green}✓${colors.reset} Linked memory #${fromId} → #${toId} (${colorize(relation, colors.cyan)}, weight=${asNumber(args.weight, 0.5)})`);
}

async function cmdExport(args) {
  const exported = service.exportAll(args.project || null);
  const format = args.format || 'json';

  if (args.out) {
    const outputPath = path.resolve(process.cwd(), args.out);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    if (format === 'markdown') {
      const md = exportAsMarkdown(exported);
      await fs.writeFile(outputPath, md, 'utf-8');
    } else {
      await fs.writeFile(outputPath, JSON.stringify(exported, null, 2), 'utf-8');
    }
    console.log(`${colors.green}✓${colors.reset} Exported ${exported.memories.length} memories to ${args.out}`);
    return;
  }

  if (format === 'markdown') {
    console.log(exportAsMarkdown(exported));
  } else {
    printResult(exported, 'json');
  }
}

function exportAsMarkdown(data) {
  const lines = [
    `# Memory Export`,
    `_Exported: ${data.exportedAt}_`,
    `_Memories: ${data.memories.length} | Relationships: ${data.relationships.length} | Clusters: ${data.clusters.length}_`,
    '',
  ];

  const byDimension = {};
  for (const m of data.memories) {
    if (!byDimension[m.dimension]) byDimension[m.dimension] = [];
    byDimension[m.dimension].push(m);
  }

  for (const [dim, memories] of Object.entries(byDimension)) {
    lines.push(`## ${dim.charAt(0).toUpperCase() + dim.slice(1)} (${memories.length})`);
    for (const m of memories) {
      const tags = (m.tags || []).join(', ');
      lines.push(`### #${m.id} — ${m.summary}`);
      lines.push(`- **Importance:** ${Number(m.importance).toFixed(2)} | **Usage:** ${m.usage_count} | **Tags:** ${tags}`);
      if (m.file_path) lines.push(`- **File:** \`${m.file_path}\``);
      if (m.project) lines.push(`- **Project:** ${m.project}`);
      lines.push(`- **Created:** ${m.created_at}`);
      lines.push('');
      lines.push(m.content);
      lines.push('');
    }
  }

  return lines.join('\n');
}

async function cmdStats(args) {
  const stats = service.stats(args.project || null);
  const format = getFormat(args);

  if (format === 'json') {
    printResult({ success: true, stats }, 'json');
    return;
  }

  console.log(boldText('=== SYSTEM STATISTICS ===\n'));

  const headers = ['Metric', 'Value'];
  const rows = [
    ['DB Path', stats.dbPath],
    ['Memories', stats.memoryCount],
    ['Relationships', stats.relationshipCount],
    ['Clusters', stats.clusterCount],
    ['Events', stats.eventCount],
    ['Compressed', stats.compressedMemoryCount],
    ['Avg Importance', stats.averageImportance],
    ['Stale (90d)', stats.staleMemoryCount90d],
    ['Orphan Rels', stats.orphanRelationshipCount],
    ['Near-Duplicates', stats.duplicateCount],
  ];
  console.log(formatTable(headers, rows));

  if (stats.dimensionBreakdown.length > 0) {
    console.log(`\n${boldText('Dimension Breakdown:')}`);
    const dimHeaders = ['Dimension', 'Count'];
    const dimRows = stats.dimensionBreakdown.map((d) => [d.dimension, d.count]);
    console.log(formatTable(dimHeaders, dimRows));
  }

  if (stats.duplicates.length > 0) {
    console.log(`\n${boldText('Potential Duplicates:')}`);
    for (const dup of stats.duplicates) {
      console.log(`  ${colors.yellow}!${colors.reset} #${dup.memoryA.id} ↔ #${dup.memoryB.id} (similarity=${dup.similarity.toFixed(3)}, ${dup.dimension})`);
    }
  }
}

async function cmdBackup(args) {
  const defaultPath = path.join(process.cwd(), '.memory-brain', 'backups', `brain-${new Date().toISOString().replace(/[:.]/g, '-')}.db.bak`);
  const backupPath = args.out || defaultPath;
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await service.backup(backupPath);
  
  const format = getFormat(args);
  if (format === 'json') {
    printResult({ success: true, backupPath }, 'json');
  } else {
    console.log(`${colors.green}✓${colors.reset} Database backed up safely to ${backupPath}`);
  }
}

async function cmdDashboard(args) {
  try {
    const tokenPath = path.join(process.cwd(), '.memory-brain', '.daemon_token');
    const token = (await fs.readFile(tokenPath, 'utf-8')).trim();
    const url = `http://127.0.0.1:31337/dashboard?token=${token}`;
    
    console.log(`${colors.cyan}Opening Telemetry Dashboard: ${url}${colors.reset}`);
    const { exec } = await import('child_process');
    const start = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    exec(`${start} "${url}"`);
  } catch (err) {
    throw new Error('Daemon token missing. Ensure the background daemon is running before opening the dashboard.');
  }
}

async function cmdDebug(args) {
  const debug = service.debug();
  const format = getFormat(args);
  printResult({ success: true, debug }, format === 'json' ? 'json' : undefined);
}



async function cmdIngestGit(args) {
  const { GitEngine } = await import('./engines/gitEngine.js');
  const git = new GitEngine(service);
  const limit = asNumber(args.limit, 30);
  const project = args.project || null;
  const result = await git.ingestRecentCommits(limit, project);
  const format = getFormat(args);
  if (format === 'json') {
    printResult({ success: true, ...result }, 'json');
  } else {
    console.log(`${colors.green}✓${colors.reset} Ingested ${result.ingested} commits as episodic memories (${result.skipped} duplicates skipped)`);
  }
}

async function cmdDigest(args) {
  const limit = asNumber(args.limit, 5);
  const digest = service.repository.getDigest(limit);
  const format = getFormat(args);
  if (format === 'json') {
    printResult({ success: true, digest }, 'json');
    return;
  }
  console.log(boldText('=== 🧠 Daily Knowledge Digest ===\n'));
  if (digest.length === 0) {
    console.log(`${colors.yellow}No anchor memories found yet. Add more memories to build the knowledge graph.${colors.reset}`);
    return;
  }
  for (const m of digest) {
    console.log(`  ${colorize(`[${m.dimension}]`, colors.cyan)} ${colorize(`#${m.id}`, colors.bold)} (links: ${m.linkCount}, imp: ${Number(m.importance).toFixed(2)})`);
    console.log(`    ${dimText(m.summary || m.content.slice(0, 80))}`);
    console.log();
  }
}

async function cmdDoctor() {
  const checks = [];

  // 1. SQLite
  try {
    const count = service.repository.db.prepare('SELECT COUNT(*) as c FROM memories').get().c;
    checks.push({ name: 'SQLite Database', status: 'OK', detail: `${count} memories stored` });
  } catch (err) {
    checks.push({ name: 'SQLite Database', status: 'FAIL', detail: err.message });
  }

  // 2. Git
  try {
    const { execSync } = await import('child_process');
    const version = execSync('git --version', { encoding: 'utf-8' }).trim();
    checks.push({ name: 'Git', status: 'OK', detail: version });
  } catch {
    checks.push({ name: 'Git', status: 'WARN', detail: 'Not found. Auto-ingestion unavailable.' });
  }

  // 3. ONNX Transformers
  try {
    await import('@xenova/transformers');
    checks.push({ name: 'ONNX Transformers', status: 'OK', detail: '@xenova/transformers loaded' });
  } catch {
    checks.push({ name: 'ONNX Transformers', status: 'FAIL', detail: 'Not installed. Run: npm install @xenova/transformers' });
  }

  // 4. HNSW
  try {
    await import('hnswlib-node');
    checks.push({ name: 'HNSW Vector Engine', status: 'OK', detail: 'hnswlib-node available' });
  } catch {
    checks.push({ name: 'HNSW Vector Engine', status: 'WARN', detail: 'Not installed. Using linear fallback. Run: npm install hnswlib-node' });
  }

  // 5. Chokidar
  try {
    await import('chokidar');
    checks.push({ name: 'File Watcher', status: 'OK', detail: 'chokidar available' });
  } catch {
    checks.push({ name: 'File Watcher', status: 'WARN', detail: 'Not installed. Ambient ingestion unavailable.' });
  }

  // 6. Daemon
  try {
    const http = await import('http');
    const alive = await new Promise((resolve) => {
      const req = http.default.get('http://127.0.0.1:31337/ping', (res) => resolve(res.statusCode === 200));
      req.on('error', () => resolve(false));
    });
    checks.push({ name: 'Background Daemon', status: alive ? 'OK' : 'OFFLINE', detail: alive ? 'Running on port 31337' : 'Not running' });
  } catch {
    checks.push({ name: 'Background Daemon', status: 'OFFLINE', detail: 'Not running' });
  }

  console.log(boldText('\n=== 🩺 Local Brain Doctor ===\n'));
  for (const check of checks) {
    const icon = check.status === 'OK' ? `${colors.green}✓` : check.status === 'WARN' ? `${colors.yellow}⚠` : `${colors.red}✗`;
    console.log(`  ${icon} ${check.name}${colors.reset}: ${dimText(check.detail)}`);
  }
  const failCount = checks.filter(c => c.status === 'FAIL').length;
  console.log(`\n${failCount === 0 ? `${colors.green}All systems nominal.` : `${colors.red}${failCount} critical issue(s) detected.`}${colors.reset}\n`);
}



async function cmdIngestRepo(args) {
  if (!args.path) throw new Error('ingest-repo requires --path <directory>');
  const targetPath = path.resolve(process.cwd(), args.path);
  const project = args.project || path.basename(targetPath);
  
  const result = await service.repoEngine.ingestRepo(targetPath, project);
  console.log(`${colors.green}✓${colors.reset} Mass AST codebase ingestion complete. Added ${result.memoriesAdded} memories from ${result.totalFiles} files.`);
}







// ── Main ─────────────────────────────────────────────────────────────

const VALID_DIM_VALUES = new Set(Object.values(DIMENSIONS));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  if (command === 'add') {
    const dim = args.type || args.dimension;
    if (!dim || !VALID_DIM_VALUES.has(dim)) {
      throw new Error(`add --type must be one of: ${[...VALID_DIM_VALUES].join(', ')}`);
    }
  }

  switch (command) {
    case 'add':
      await cmdAdd(args);
      break;
    case 'search':
      await cmdSearch(args);
      break;
    case 'context':
      await cmdContext(args);
      break;
    case 'insights':
      await cmdInsights(args);
      break;
    case 'link':
      await cmdLink(args);
      break;
    case 'export':
      await cmdExport(args);
      break;
    case 'stats':
      await cmdStats(args);
      break;
    case 'backup':
      await cmdBackup(args);
      break;
    case 'debug':
      await cmdDebug(args);
      break;
    case 'ingest-git':
      await cmdIngestGit(args);
      break;
    case 'ingest-repo':
      await cmdIngestRepo(args);
      break;
    case 'digest':
      await cmdDigest(args);
      break;
    case 'doctor':
      await cmdDoctor(args);
      break;

    default:
      throw new Error(`Unknown command: ${command}. Run with --help for usage.`);
  }
}

main().catch((err) => {
  console.error(`${colors.red}Error:${colors.reset} ${err.message}`);
  process.exit(1);
});
