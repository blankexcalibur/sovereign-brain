import { tfidfCosineSimilarity } from '../utils/text.js';
import { SCORING_WEIGHTS } from '../constants.js';

function recencyScore(lastUsedAt) {
  const ageMs = Date.now() - new Date(lastUsedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.exp(-ageDays / 30);
}

function usageScore(usageCount) {
  // Logarithmic scaling to prevent dominance by very high-usage memories
  return Math.min(1.0, Math.log2(1 + usageCount) / 10);
}

export class RankingEngine {
  constructor(weights = SCORING_WEIGHTS) {
    this.weights = weights;
  }

  scoreMemory(memory, relevance) {
    const importance = Number(memory.importance || 0.5);
    const recency = recencyScore(memory.last_used_at || memory.updated_at || memory.created_at);
    const usage = usageScore(memory.usage_count || 0);

    const score =
      relevance * this.weights.relevance +
      importance * this.weights.importance +
      recency * this.weights.recency +
      usage * this.weights.usage;

    return { ...memory, score, relevance, recency, usage };
  }

  /**
   * Rank memories with diversity bonus — penalizes too many
   * results from the same dimension to ensure varied context.
   */
  rank(memories, query, limit = 10) {
    let minRank = 0;
    let maxRank = -Infinity;
    let hasRank = false;

    // FTS5 BM25 rank is negative (lower is better)
    for (const m of memories) {
      if (typeof m.rank === 'number') {
        hasRank = true;
        if (m.rank < minRank) minRank = m.rank;
        if (m.rank > maxRank) maxRank = m.rank;
      }
    }
    const rankRange = maxRank - minRank;

    const scored = memories.map((m) => {
      let relevance = 0;
      if (hasRank && typeof m.rank === 'number') {
        relevance = rankRange === 0 ? 1.0 : (maxRank - m.rank) / rankRange;
      } else {
        relevance = tfidfCosineSimilarity(query, `${m.content} ${(m.tags || []).join(' ')}`);
      }
      return this.scoreMemory(m, relevance);
    });

    scored.sort((a, b) => b.score - a.score);

    // Apply diversity re-ranking: penalize successive same-dimension results
    const result = [];
    const dimensionCounts = new Map();

    for (const mem of scored) {
      const dimCount = dimensionCounts.get(mem.dimension) || 0;
      const diversityPenalty = dimCount * 0.03;
      const adjustedScore = mem.score - diversityPenalty;
      result.push({ ...mem, score: adjustedScore, originalScore: mem.score });
      dimensionCounts.set(mem.dimension, dimCount + 1);
    }

    result.sort((a, b) => b.score - a.score);
    return result.slice(0, limit);
  }

  /**
   * Reciprocal Rank Fusion (RRF) for Hybrid Search.
   * Combines Sparse (BM25) and Dense (Vector) ranked lists into a single superior context.
   */
  fuseAndRank(ftsMemories, vectorMemories, limit = 10, rrfK = 60) {
    const memoryMap = new Map();

    const processList = (list, isFts) => {
      list.forEach((m, index) => {
        const rank = index + 1;
        const rrfScore = 1.0 / (rrfK + rank);
        
        let entry = memoryMap.get(m.id);
        if (!entry) {
          entry = { memory: m, ftsScore: 0, vecScore: 0 };
          memoryMap.set(m.id, entry);
        }
        
        if (isFts) entry.ftsScore = rrfScore;
        else entry.vecScore = rrfScore;
      });
    };

    // Synthesize both lists independently
    processList(ftsMemories, true);
    processList(vectorMemories, false);

    const candidates = Array.from(memoryMap.values()).map(entry => {
      const fusedRelevance = entry.ftsScore + entry.vecScore;
      // Normalizing the RRF sum (max ~0.033) for the scoring formula
      const normalizedRelevance = fusedRelevance * 30.0; 
      return this.scoreMemory(entry.memory, normalizedRelevance);
    });

    candidates.sort((a, b) => b.score - a.score);

    // Apply diversity re-ranking: penalize successive same-dimension results
    const result = [];
    const dimensionCounts = new Map();

    for (const mem of candidates) {
      const dimCount = dimensionCounts.get(mem.dimension) || 0;
      const diversityPenalty = dimCount * 0.04;
      const adjustedScore = mem.score - diversityPenalty;
      result.push({ ...mem, score: adjustedScore, originalScore: mem.score });
      dimensionCounts.set(mem.dimension, dimCount + 1);
    }

    result.sort((a, b) => b.score - a.score);
    return result.slice(0, limit);
  }
}
