import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { Worker } from 'worker_threads';
import { logger } from '../utils/logger.js';
import { ASTParser } from './ASTParser.js';

export class RepoEngine {
  constructor(service) {
    this.service = service;
    // AST Parser identical to what powers the WatcherEngine
    this.parser = new ASTParser();
    this.isProcessing = false;
    
    // Core exclusions to prevent V8 lockups or scanning garbage data
    this.ignoredPaths = [
      /(^|[\/\\])\../, // dotfiles like .git, .env
      /node_modules/,
      /dist/,
      /build/,
      /\.memory-brain/,
      /package-lock\.json/,
      /yarn\.lock/,
      /coverage/,
      /\.jpg|\.png|\.svg|\.ico|\.mp4|\.pdf/i
    ];
  }

  /**
   * Mass bulk-ingestion of a local directory, fully converting source code into structural vector memories.
   */
  async ingestRepo(dirPath, projectName = 'repo') {
    if (this.isProcessing) throw new Error('Repo Engine is currently busy running a bulk ingestion pipeline.');
    this.isProcessing = true;
    
    try {
      await this.parser.init();
      logger.info(`🌐 Repo Eater triggered. Scanning ${dirPath} for mass structural ingestion...`);
      const files = await this._walkDir(dirPath);
      
      const validCode = ['.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.cs', '.php', '.md'];
      const validFiles = files.filter(f => validCode.includes(path.extname(f).toLowerCase()));
      
      logger.info(`Found ${validFiles.length} valid source files to ingest into ${projectName}.`);
      let totalMemories = 0;
      let skippedMemories = 0;
      
      for (const file of validFiles) {
        try {
          const stats = await fs.stat(file);
          if (stats.size > 200 * 1024) {
            logger.warn(`Skipping massive file (>${Math.round(stats.size/1024)}KB): ${file}`);
            continue;
          }

          const content = await fs.readFile(file, 'utf-8');
          const ext = path.extname(file).toLowerCase();
          
          let chunks = [];
          
          if (ext === '.md') {
            chunks = [content.slice(0, 4000)]; // Simple boundary cutoff
          } else {
            try {
              // Phase 58: Offload mass Tree-Sitter AST processing to asynchronous Worker thread
              chunks = await this.parseASTAsync(content, ext);
            } catch (err) {
              logger.warn(`Worker AST failure on ${file}, falling back to RegExp mapping.`);
            }
            if (!chunks || chunks.length === 0) {
               // Fallback to RegEx logic if parser bindings fail
               chunks = this._fallbackChunk(content);
            }
          }
          
          for (const chunk of chunks) {
            const memoryContent = `File: ${path.relative(process.cwd(), file)}\n\n${chunk}`;
            const hash = crypto.createHash('md5').update(memoryContent).digest('hex');
            
            // O(1) Duplicate checks!
            const existing = this.service.repository.getMemoryByHash(hash);
            if (existing) {
               skippedMemories++;
               continue;
            }
            
            let gitTemporal = null;
            try {
               const util = await import('util');
               const exec = util.promisify((await import('child_process')).exec);
               const { stdout } = await exec(`git log -1 --pretty=format:"%H|||%an|||%s" "${file}"`);
               if (stdout) {
                 const [gHash, gAuthor, gMsg] = stdout.split('|||');
                 gitTemporal = { hash: gHash, author: gAuthor, message: gMsg };
               }
            } catch(e) {}
            
            await this.service.addMemory({
              dimension: ext === '.md' ? 'cognitive' : 'code',
              content: memoryContent,
              tags: `${projectName}, mass-ingest, ${ext.slice(1)}`,
              project: projectName,
              filePath: file,
              hash: hash,
              importance: 0.5,
              metadata: gitTemporal ? { source: 'repo-eater', git: gitTemporal } : { source: 'repo-eater' }
            });
            totalMemories++;
            
            // Critical i3 V8 Memory Protection: Prevent ONNX silent leaks
            if (global.gc && totalMemories % 50 === 0) {
               global.gc();
            }
          }
        } catch (err) {
          logger.warn(`Failed to ingest file ${file}: ${err.message}`);
        }
      }
      
      logger.info(`✅ Repo Eater completed. Added ${totalMemories} new structural memories. Skipped ${skippedMemories} duplicates.`);
      return { totalFiles: validFiles.length, memoriesAdded: totalMemories, skipped: skippedMemories };
    } finally {
      this.isProcessing = false;
    }
  }

  async parseASTAsync(content, ext) {
    return new Promise((resolve, reject) => {
      const workerPath = path.join(process.cwd(), 'src/brain/workers/astWorker.js');
      const worker = new Worker(workerPath, { workerData: { content, ext } });
      worker.on('message', resolve);
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
      });
    });
  }

  _fallbackChunk(code) {
    const chunks = [];
    const blockRegex = /(class\s+\w+|function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>))/g;
    
    let match;
    let lastIndex = 0;
    while ((match = blockRegex.exec(code)) !== null) {
      if (lastIndex !== match.index && lastIndex !== 0) {
        chunks.push(code.slice(lastIndex, match.index).trim());
      }
      lastIndex = match.index;
    }
    if (lastIndex < code.length) {
      chunks.push(code.slice(lastIndex).trim());
    }
    return chunks.filter(c => c.length > 50 && c.length < 5000);
  }

  async _walkDir(dir) {
    let results = [];
    const list = await fs.readdir(dir, { withFileTypes: true });
    
    for (const dirent of list) {
       const fullPath = path.resolve(dir, dirent.name);
       if (this.ignoredPaths.some(regex => regex.test(fullPath))) continue;
       
       if (dirent.isDirectory()) {
          const res = await this._walkDir(fullPath);
          results = results.concat(res);
       } else {
          results.push(fullPath);
       }
    }
    return results;
  }
}
