import { RELATION_TYPES, DEFAULTS } from '../constants.js';
import { tfidfCosineSimilarity, tokenize } from '../utils/text.js';

function hasTag(memory, tag) {
  return Array.isArray(memory.tags) && memory.tags.includes(tag);
}

function extractKeywords(memory) {
  const text = `${memory.content} ${(memory.tags || []).join(' ')}`;
  return tokenize(text).filter((t) => t.length > 2);
}

export class AdaptiveEngine {
  constructor(repository) {
    this.repository = repository;
  }

  reinforce(memoryId, score = 1) {
    const delta = Math.min(0.08, Math.max(0.01, score * 0.02));
    this.repository.reinforceMemory(memoryId, delta);
  }

  applyDecay() {
    return this.repository.applyDecay({ staleDays: 7, minImportance: 0.1 });
  }

  /**
   * Auto-link a new memory to existing related memories using TF-IDF similarity.
   */
  autoLink(newMemory) {
    const nearby = this.repository.listRecentByProject(newMemory.project || null, 40)
      .filter((m) => m.id !== newMemory.id);

    const newText = `${newMemory.content} ${(newMemory.tags || []).join(' ')}`;

    for (const candidate of nearby) {
      const candidateText = `${candidate.content} ${(candidate.tags || []).join(' ')}`;
      const similarity = tfidfCosineSimilarity(newText, candidateText);

      if (similarity >= DEFAULTS.clusterSimilarityThreshold) {
        this.repository.addRelationship(
          newMemory.id, candidate.id, RELATION_TYPES.SIMILAR_CONCEPT, similarity
        );
      }

      // Bug-fix pair detection
      if ((hasTag(newMemory, 'bug') && hasTag(candidate, 'fix')) ||
          (hasTag(newMemory, 'fix') && hasTag(candidate, 'bug'))) {
        this.repository.addRelationship(newMemory.id, candidate.id, RELATION_TYPES.BUG_FIX_PAIR, 0.9);
      }

      // Supersedes detection: same dimension+project, high similarity
      if (newMemory.dimension === candidate.dimension &&
          newMemory.project === candidate.project &&
          similarity >= 0.7) {
        this.repository.addRelationship(newMemory.id, candidate.id, RELATION_TYPES.SUPERSEDES, similarity);
      }

      // Part-of detection: task referencing code or context
      if (newMemory.dimension === 'task' && ['code', 'context'].includes(candidate.dimension) && similarity >= 0.3) {
        this.repository.addRelationship(newMemory.id, candidate.id, RELATION_TYPES.PART_OF, similarity);
      }
    }
  }

  /**
   * Simple keyword-based clustering. Groups unclustered memories by
   * shared keywords and assigns them to clusters.
   */
  cluster() {
    const unclustered = this.repository.getUnclusteredMemories(100);
    if (unclustered.length === 0) return { newClusters: 0, assigned: 0 };

    const existingClusters = this.repository.listClusters();
    let newClusters = 0;
    let assigned = 0;

    for (const memory of unclustered) {
      const memKeywords = extractKeywords(memory);
      let bestCluster = null;
      let bestOverlap = 0;

      // Try to find a matching existing cluster
      for (const cluster of existingClusters) {
        const clusterKeywords = new Set(cluster.keywords);
        let overlap = 0;
        for (const kw of memKeywords) {
          if (clusterKeywords.has(kw)) overlap++;
        }
        const score = clusterKeywords.size > 0 ? overlap / clusterKeywords.size : 0;
        if (score > bestOverlap && score >= 0.25) {
          bestOverlap = score;
          bestCluster = cluster;
        }
      }

      if (bestCluster) {
        this.repository.assignToCluster(memory.id, bestCluster.id);
        assigned++;
      } else if (memKeywords.length >= 3) {
        // Create a new cluster from this memory's keywords
        const label = (memory.tags || []).slice(0, 3).join('-') || memKeywords.slice(0, 3).join('-');
        const clusterId = this.repository.createCluster(
          label,
          memKeywords.slice(0, 10),
          (memory.tags || []).slice(0, 5)
        );
        this.repository.assignToCluster(memory.id, clusterId);
        existingClusters.push({ id: clusterId, keywords: memKeywords.slice(0, 10), centroidTags: memory.tags || [] });
        newClusters++;
        assigned++;
      }
    }

    return { newClusters, assigned };
  }
}
