#!/usr/bin/env node
/**
 * Sovereign Memory Daemon — Unified Entry Point
 * 
 * This is the single file users interact with.
 * - `node index.js` → boots the daemon + MCP server
 * - `node index.js --mcp` → MCP-only mode (for Claude Desktop)
 * - First run auto-detects and ingests the current project
 */
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const command = args[0];

// ── Route: MCP-only mode (Claude Desktop / Cursor) ──────────
if (command === '--mcp' || command === 'mcp') {
  await import('./src/brain/mcp.js');
}

// ── Route: Install Claude Desktop config ─────────────────────
else if (command === 'install-claude') {
  const claudeConfigDir = process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Roaming', 'Claude')
    : path.join(os.homedir(), 'Library', 'Application Support', 'Claude');

  const configPath = path.join(claudeConfigDir, 'claude_desktop_config.json');
  
  // Determine the exact command to run this server
  const nodeExecutable = process.execPath;
  const entryPoint = path.resolve(__dirname, 'index.js');

  let config = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch { config = {}; }

  if (!config.mcpServers) config.mcpServers = {};

  config.mcpServers['local-brain'] = {
    command: nodeExecutable,
    args: [entryPoint, '--mcp'],
  };

  if (!fs.existsSync(claudeConfigDir)) {
    fs.mkdirSync(claudeConfigDir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log('✅ Claude Desktop configured successfully!');
  console.log(`   Config written to: ${configPath}`);
  console.log('   Restart Claude Desktop to activate the local brain.');
  console.log('');
  console.log('   Available MCP tools:');
  console.log('   • search_memory — Semantic + keyword hybrid search');
  console.log('   • add_memory — Store knowledge persistently');
  console.log('   • build_context — Generate LLM-optimized context packs');
  console.log('   • get_stats — Brain health metrics');
  console.log('   • find_duplicates — Detect code duplication');
}

// ── Route: CLI Commands ────────────────────────────────────────
else if (['add', 'search', 'context', 'insights', 'link', 'export', 'stats', 'backup', 'debug', 'ingest-git', 'ingest-repo', 'digest', 'doctor', '--help', '-h', '--version', '-v', '-V'].includes(command)) {
  // We don't want to boot the daemon for CLI one-offs, we just execute the CLI module
  await import('./src/brain/cli.js');
}

// ── Route: Default — Boot the Daemon ─────────────────────────
else {
  const brainDir = path.join(process.cwd(), '.memory-brain');
  const firstRunFlag = path.join(brainDir, '.initialized');

  // Boot the daemon
  await import('./src/brain/daemon.js');

  // First-run auto-ingestion
  if (!fs.existsSync(firstRunFlag)) {
    console.log('');
    console.log('🧠 First run detected! Auto-indexing your project...');
    console.log('   This may take a minute on large repositories.');
    console.log('');

    try {
      const { DeveloperMemoryService } = await import('./src/brain/service.js');
      const { RepoEngine } = await import('./src/brain/engines/repoEngine.js');
      
      const service = new DeveloperMemoryService();
      const repo = new RepoEngine(service);
      
      const cwd = process.cwd();
      const result = await repo.ingestDirectory(cwd);
      
      console.log(`✅ Auto-ingestion complete: ${result?.ingested || 0} code memories indexed.`);
      console.log('   Your brain is now live. Open Claude Desktop or use the CLI.');
      
      // Mark as initialized so we don't re-ingest on every boot
      if (!fs.existsSync(brainDir)) fs.mkdirSync(brainDir, { recursive: true });
      fs.writeFileSync(firstRunFlag, new Date().toISOString());
    } catch (err) {
      console.error(`⚠️ Auto-ingestion failed (you can manually run: node src/brain/cli.js ingest-repo ./)`);
      console.error(`   Error: ${err.message}`);
    }
  }
}
