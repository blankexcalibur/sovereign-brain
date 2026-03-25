import { DEFAULTS, VALID_DIMENSIONS } from './constants.js';
import { MemoryRepository } from './repository.js';
import { AdaptiveEngine } from './engines/adaptiveEngine.js';
import { RankingEngine } from './engines/rankingEngine.js';
import { PatternEngine } from './engines/patternEngine.js';
import { ContextEngine } from './engines/contextEngine.js';
import { EmbeddingEngine } from './engines/embeddingEngine.js';
import { AgentEngine } from './engines/agentEngine.js';
import { RepoEngine } from './engines/repoEngine.js';

import { parseTags, summarizeContent, uniqueTags } from './utils/text.js';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import path from 'path';
import { EventEmitter } from 'events';

export class DeveloperMemoryService extends EventEmitter {
  constructor() {
    super();
    this.repository = new MemoryRepository();
    this.adaptive = new AdaptiveEngine(this.repository);
    this.ranking = new RankingEngine();
    this.patterns = new PatternEngine();
    this.contextEngine = new ContextEngine(this.repository, this.ranking);
    this.embeddingEngine = new EmbeddingEngine();

    this.agentEngine = new AgentEngine(this);
    this.repoEngine = new RepoEngine(this);
  }

  async addMemory(input) {
    if (!VALID_DIMENSIONS.has(input.dimension)) {
      throw new Error(`Invalid memory dimension: ${input.dimension}`);
    }
    if (!input.content || String(input.content).trim().length < 3) {
      throw new Error('Memory content must be at least 3 characters');
    }

    const tags = uniqueTags([
      ...parseTags(input.tags || ''),
      ...this.patterns.extract(input.content, input.filePath || ''),
    ]);

    const summary = summarizeContent(input.content, 260);

    const clamp = (val, min, max, fallback) => {
      const n = Number(val);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
    };

    // Extract semantic embedding asynchronously via Xenova ONNX WASM model
    const semanticText = `${input.dimension} ${summary} ${tags.join(' ')}`;
    const embedding = await this.embeddingEngine.embed(semanticText);

    const memory = this.repository.addMemory({
      dimension: input.dimension,
      content: input.content,
      summary,
      tags,
      project: input.project || null,
      filePath: input.filePath || null,
      importance: clamp(input.importance, 0.0, 1.0, DEFAULTS.importance),
      usageCount: 0,
      decayFactor: clamp(input.decayFactor, 0.5, 1.0, DEFAULTS.decayFactor),
      metadata: input.metadata || {},
      embedding,
    });

    this.adaptive.autoLink(memory);

    // ── Conflict Detection (Team Mode) ──────────────────────
    // Scan recent memories for high-similarity entries that may indicate
    // contradictory decisions across different agents/developers.
    let conflicts = [];
    if (embedding) {
      try {
        conflicts = this._detectConflicts(memory, embedding);
      } catch { /* Non-critical — don't block memory creation */ }
    }

    // Broadcast telemetry to DHT mesh nodes (unless this chunk came from the mesh itself)
    if (!input._isSync) {
      this.emit('memory_added', memory);
    }

    return { ...memory, conflicts };
  }

  /**
   * Detect potential conflicts between a newly added memory and recent entries.
   * Finds memories with high semantic similarity (>0.85) added within the last hour
   * that may represent contradictory decisions from different team members.
   */
  _detectConflicts(newMemory, embedding, windowMs = 3600000) {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const recentMemories = this.repository.listRecentSince(cutoff, newMemory.project, 100);

    const conflicts = [];
    for (const existing of recentMemories) {
      if (existing.id === newMemory.id) continue;
      if (!existing.embedding) continue;

      const similarity = this.embeddingEngine.vectorCosineSimilarity(embedding, existing.embedding);
      if (similarity > 0.85) {
        conflicts.push({
          existingMemoryId: existing.id,
          existingSummary: existing.summary,
          existingContent: existing.content.substring(0, 200),
          similarity: Math.round(similarity * 100) / 100,
          createdAt: existing.created_at,
          resolution: 'Review both memories — high similarity suggests potential duplication or contradiction.',
        });
      }
    }
    return conflicts;
  }

  async searchMemories({ query, project = null, dimension = null, limit = DEFAULTS.limit }) {
    this.adaptive.applyDecay();

    // 1. Fire Parallel Promises for FTS and Dense Embeddings
    const searchLimit = Math.max(limit * 4, 30);
    const ftsPromise = Promise.resolve(this.repository.searchFTS(query, project, dimension, searchLimit));
    const embeddingPromise = this.embeddingEngine.embed(query);

    const [ftsCandidates, queryEmbedding] = await Promise.all([ftsPromise, embeddingPromise]);

    // 2. Pseudo-Relevance Feedback (PRF) Query Expansion (on FTS)
    let finalFtsCandidates = [...ftsCandidates];
    if (ftsCandidates.length > 0 && query.trim().split(/\s+/).length < 5) {
      const topTags = uniqueTags(ftsCandidates.slice(0, 3).flatMap(c => c.tags || [])).slice(0, 3);
      if (topTags.length > 0) {
        const expandedQuery = `${query} ${topTags.join(' ')}`;
        const expandedCandidates = this.repository.searchFTS(expandedQuery, project, dimension, Math.max(limit * 2, 20));
        
        const seen = new Set(finalFtsCandidates.map(c => c.id));
        for (const c of expandedCandidates) {
          if (!seen.has(c.id)) {
            finalFtsCandidates.push(c);
            seen.add(c.id);
          }
        }
      }
    }

    // 3. Dense Vector Neighborhood Scan (Semantic Proximity)
    let semanticCandidates = [];
    if (queryEmbedding) {
      if (this.embeddingEngine.hnswAvailable && this.embeddingEngine.hnswNextLabel > 0) {
        // O(1) Instant C++ Graph Search
        const neighbors = this.embeddingEngine.searchKnn(queryEmbedding, searchLimit * 2);
        if (neighbors && neighbors.length > 0) {
          for (const n of neighbors) {
            const m = this.repository.getMemoryById(n.memoryId);
            if (m) {
              if (dimension && m.dimension !== dimension) continue;
              if (project && m.project !== project) continue; // Strict RBAC Namespace isolation
              semanticCandidates.push({ ...m, _sim: n.score });
            }
          }
        }
      } 
      
      // Fallback to linear scan if HNSW wasn't loaded or yielded no results
      if (semanticCandidates.length === 0) {
        const memoryPool = this.repository.listRecentByProject(project, 5000);
        for (const m of memoryPool) {
          if (dimension && m.dimension !== dimension) continue;
          if (!m.embedding) continue;
          
          const sim = this.embeddingEngine.vectorCosineSimilarity(queryEmbedding, m.embedding);
          if (sim > 0.35) {
             semanticCandidates.push({ ...m, _sim: sim });
          }
        }
        semanticCandidates.sort((a, b) => b._sim - a._sim);
      }
      
      semanticCandidates = semanticCandidates.slice(0, searchLimit);
    }

    // 4. Hybrid Reciprocal Rank Fusion (RRF)
    const ranked = this.ranking.fuseAndRank(finalFtsCandidates, semanticCandidates, limit);

    // 5. Reinforce usage network
    for (const memory of ranked) {
      this.adaptive.reinforce(memory.id, memory.score);
    }

    return ranked;
  }

  async context({ query, project = null, target = 'copilot', limit = 12 }) {
    this.adaptive.applyDecay();

    // Use our new async semantic-backed search generator
    const ranked = await this.searchMemories({ query, project, dimension: null, limit: Math.max(limit * 4, 30) });

    // V10 Enterprise GraphRAG: Triplet Blast-Radius Traversal
    const graphContext = [];
    const seenIds = new Set(ranked.map(m => m.id));
    
    // Spider out 1 degree from the top 3 high-confidence hits to pull direct hard relational architecture
    for (const anchor of ranked.slice(0, 3)) {
      const edges = this.repository.getAssociations(anchor.id, 5);
      for (const edgeMem of edges) {
        if (!seenIds.has(edgeMem.id) && (!project || edgeMem.project === project)) {
           // We found a hard relational Graph edge that semantic vectors missed!
           edgeMem.score = anchor.score * 0.95; 
           edgeMem._isGraphEdge = true;
           graphContext.push(edgeMem);
           seenIds.add(edgeMem.id);
        }
      }
    }

    if (graphContext.length > 0) {
      ranked.push(...graphContext);
      ranked.sort((a, b) => b.score - a.score); // Re-fuse the graph edges into the list
    }

    const contextPayload = this.contextEngine.build({ query, project, target, limit, preRankedMemories: ranked });
    const touched = [
      ...contextPayload.currentWorkingContext,
      ...contextPayload.relevantPastKnowledge,
    ];

    for (const memory of touched) {
      this.adaptive.reinforce(memory.id, 1);
    }



    return contextPayload;
  }



  insights(project = null) {
    this.adaptive.applyDecay();
    return this.repository.getInsights(project);
  }

  debug() {
    this.adaptive.applyDecay();
    return this.repository.debugStats();
  }

  // ── Thread Pool Offloading ───────────────────────────────────────

  _runWorker(type, options = {}) {
    return new Promise((resolve, reject) => {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const workerPath = path.join(__dirname, 'workers', 'intelligence.worker.js');
      const worker = new Worker(workerPath);

      worker.on('message', (msg) => {
        if (msg.success) resolve(msg.result);
        else reject(new Error(msg.error));
        worker.terminate();
      });

      worker.on('error', (err) => reject(err));
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
      });

      worker.postMessage({ type, options });
    });
  }



  /**
   * Run memory clustering to group related memories via Worker Thread.
   */
  async cluster() {
    return this._runWorker('cluster');
  }

  /**
   * Create a manual relationship between two memories.
   */
  link(fromId, toId, relationType, weight = 0.5) {
    this.repository.addRelationship(fromId, toId, relationType, weight);
    return { success: true, fromId, toId, relationType, weight };
  }

  /**
   * Get the relationship graph for a memory.
   */
  getGraph(memoryId, depth = 1) {
    return this.repository.getMemoryGraph([memoryId], depth, 20);
  }

  /**
   * Export all memories, optionally filtered by project.
   */
  exportAll(project = null) {
    return {
      memories: this.repository.exportAll(project),
      relationships: this.repository.getRelationshipsAll(),
      clusters: this.repository.listClusters(),
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * Get detailed statistics for the memory system.
   */
  stats(project = null) {
    const insights = this.repository.getInsights(project);
    const debug = this.repository.debugStats();

    return {
      ...debug,
      insights,
    };
  }

  /**
   * Run a native SQLite snapshot copy into the designated path
   */
  async backup(destinationPath) {
    return this.repository.backup(destinationPath);
  }

  /**
   * Gracefully close underlying repository connections.
   */
  close() {
    if (this.repository) {
      this.repository.close();
    }
  }
}
