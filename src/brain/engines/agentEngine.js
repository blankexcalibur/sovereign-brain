import { logger } from '../utils/logger.js';

export class AgentEngine {
  constructor(service) {
    this.service = service;
  }

  /**
   * Scans the local memory graph for redundant logic (code duplication).
   * Returns a structured report of duplicated clusters and their file paths.
   * Does NOT attempt LLM-based patching — that is the user's job.
   */
  async runEvolutionSweep() {
    logger.info(`🤖 AgentEngine: Initiating codebase duplication scan...`);

    try {
      const duplicates = this.service.repository.db.prepare(`
        SELECT cluster_id, COUNT(*) as count
        FROM memories 
        WHERE dimension = 'code' AND cluster_id IS NOT NULL
        GROUP BY cluster_id
        HAVING count > 1
        ORDER BY count DESC
        LIMIT 10
      `).all();

      if (!duplicates || duplicates.length === 0) {
        logger.info(`🤖 AgentEngine: No duplicated code clusters detected.`);
        return { success: true, suggestions: [] };
      }

      logger.info(`🤖 AgentEngine: Found ${duplicates.length} redundant clusters.`);

      const suggestions = [];

      for (const cluster of duplicates) {
        const chunks = this.service.repository.db.prepare(`
          SELECT id, file_path, content 
          FROM memories 
          WHERE cluster_id = ? AND dimension = 'code'
        `).all(cluster.cluster_id);

        if (chunks.length < 2) continue;

        const baseCode = chunks[0].content;
        const dupCode = chunks[1].content;

        if (baseCode === dupCode) continue;

        suggestions.push({
          clusterId: cluster.cluster_id,
          fileCount: chunks.length,
          files: chunks.map(c => c.file_path).filter(Boolean),
          previewA: baseCode.substring(0, 300),
          previewB: dupCode.substring(0, 300),
        });

        logger.info(`📋 Duplication: ${chunks.map(c => c.file_path).join(' ↔ ')}`);
      }

      return { success: true, suggestions };

    } catch (err) {
      logger.error(`AgentEngine Error during sweep: ${err.message}`);
      throw err;
    }
  }
}
