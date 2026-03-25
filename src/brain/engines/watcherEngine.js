import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { ASTParser } from './ASTParser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const astWorkerPath = path.join(__dirname, '../workers/astWorker.js');

export class WatcherEngine {
  constructor(service) {
    this.service = service;
    this.active = false;
    this.pending = new Map();
    this.parser = new ASTParser();

    // i3 Protection: Push brutal Regex and AST calculations to Core 2
    this.astWorker = new Worker(astWorkerPath);
    this.workerCallbacks = new Map();
    
    this.astWorker.on('message', (msg) => {
      const cb = this.workerCallbacks.get(msg.id);
      if (cb) {
        if (msg.error) cb.reject(new Error(msg.error));
        else cb.resolve(msg.chunks);
        this.workerCallbacks.delete(msg.id);
      }
    });
  }

  parseASTAsync(code, ext) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      this.workerCallbacks.set(id, { resolve, reject });
      this.astWorker.postMessage({ id, code, ext });
    });
  }

  async start() {
    if (this.active) return;
    this.active = true;
    
    try {
      await this.parser.init();
      const { default: chokidar } = await import('chokidar');
      const cwd = process.cwd();
      
      this.watcher = chokidar.watch(cwd, {
        ignored: [
          /(^|[\/\\])\../, // ignore dotfiles
          /node_modules/,
          /dist/,
          /build/,
          /\.memory-brain/,
          /\.git/,
          /package-lock\.json/,
          /coverage/
        ],
        persistent: true,
        ignoreInitial: true,
      });

      this.watcher.on('change', async (filePath) => {
        // Debounce saves by 5 seconds
        if (this.pending.has(filePath)) clearTimeout(this.pending.get(filePath));
        this.pending.set(filePath, setTimeout(async () => {
          try {
            await this.ingestFile(filePath);
          } catch (err) {
            logger.error(`WatcherEngine failed on ${filePath}: ${err.message}`);
          }
          this.pending.delete(filePath);
        }, 5000));
      });

      logger.info('👁️ Ambient Intelligence Watcher activated on workspace.');
    } catch (err) {
      logger.error('Failed to initialize WatcherEngine. Is chokidar installed?');
    }
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.active = false;
      logger.info('Ambient Watcher deactivated.');
    }
  }

  async ingestFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const validCode = ['.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.cs', '.php', '.md'];
    if (!validCode.includes(ext)) return;

    const stats = await fs.stat(filePath);
    if (stats.size > 100 * 1024) return; // Skip massive monolithic files > 100KB

    const content = await fs.readFile(filePath, 'utf-8');
    // Non-blocking offloaded execution
    const chunks = await this.parseASTAsync(content, ext);

    for (const chunk of chunks) {
      const hash = crypto.createHash('md5').update(chunk).digest('hex');
      const tags = ['auto-ingest', ext.slice(1), `hash_${hash}`];
      
      // Simple exact hash duplication check (avoids running full searches during fast saves)
      const existingId = this.service.repository.getMemoryByHash(hash);
      if (existingId) continue; // Already ingested this exact chunk

      let gitTemporal = null;
      try {
         const util = await import('util');
         const exec = util.promisify((await import('child_process')).exec);
         const { stdout } = await exec(`git log -1 --pretty=format:"%H|||%an|||%s" "${filePath}"`);
         if (stdout) {
           const [gHash, gAuthor, gMsg] = stdout.split('|||');
           gitTemporal = { hash: gHash, author: gAuthor, message: gMsg };
         }
      } catch(e) {} // Not a git repo or no history
      
      const mem = await this.service.addMemory({
        dimension: ext === '.md' ? 'cognitive' : 'code',
        content: `File: ${path.relative(process.cwd(), filePath)}\n\n${chunk}`,
        tags: tags.join(','),
        hash: hash,
        filePath: filePath,
        importance: 0.3, // Background ambient memories start lower priority until used
        metadata: gitTemporal ? { git: gitTemporal } : {}
      });
      logger.info(`Auto-ingested new logic block from ${path.basename(filePath)}`);

      // Enterprise GraphRAG Zero-Compute Triplet Extraction
      if (mem && ['.js', '.ts', '.jsx', '.tsx', '.py'].includes(ext)) {
        this.extractTriplets(chunk, mem.id).catch(() => {});
      }
    }
  }

  /**
   * Generates Microsoft GraphRAG Triplets natively via AST Regex matching
   * Costs 0% CPU compared to LLM extraction, incredibly resilient.
   */
  async extractTriplets(codeChunk, sourceMemoryId) {
    try {
      const importRegex = /import\s+.*?from\s+['"](.*?)['"]|require\s*\(\s*['"](.*?)['"]\s*\)|from\s+([\w.]+)\s+import|import\s+([\w.]+)/g;
      let match;
      while ((match = importRegex.exec(codeChunk)) !== null) {
        const importPath = match[1] || match[2] || match[3] || match[4];
        if (!importPath) continue;

        const entityName = importPath.split('/').pop().replace(/\.\w+$/, '');
        if (entityName.length < 3) continue;

        const targets = await this.service.searchMemories({ query: entityName, limit: 1, dimension: 'code' });
        if (targets && targets.length > 0 && targets[0].id !== sourceMemoryId) {
          this.service.repository.addRelationship(sourceMemoryId, targets[0].id, 'imports_from', 0.9);
        }
      }
    } catch (e) {
      // Best-effort silent extraction failure
    }
  }
}
