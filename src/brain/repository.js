import { createDb } from './db.js';
import { COMPRESSION_LEVELS } from './constants.js';

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapMemory(row) {
  return {
    ...row,
    hash: row.hash || null,
    tags: safeJsonParse(row.tags_json, []),
    metadata: safeJsonParse(row.metadata_json, {}),
    embedding: safeJsonParse(row.embedding_json, null)
  };
}

export class MemoryRepository {
  constructor() {
    const { db, dbPath } = createDb();
    this.db = db;
    this.dbPath = dbPath;
    this.stmts = {};

    this.insertMemoryStmt = this.db.prepare(`
      INSERT INTO memories (
        dimension, content, summary, compressed_content, compression_level,
        tags_json, project, file_path, hash,
        importance, usage_count, decay_factor, cluster_id, metadata_json,
        embedding_json,
        created_at, updated_at, last_used_at
      ) VALUES (
        @dimension, @content, @summary, @compressed_content, @compression_level,
        @tags_json, @project, @file_path, @hash,
        @importance, @usage_count, @decay_factor, @cluster_id, @metadata_json,
        @embedding_json,
        @created_at, @updated_at, @last_used_at
      )
    `);

    this.insertEventStmt = this.db.prepare(`
      INSERT INTO memory_events (memory_id, event_type, payload_json, created_at)
      VALUES (@memory_id, @event_type, @payload_json, @created_at)
    `);

    this.insertRelationshipStmt = this.db.prepare(`
      INSERT OR IGNORE INTO relationships (from_memory_id, to_memory_id, relation_type, weight, created_at)
      VALUES (@from_memory_id, @to_memory_id, @relation_type, @weight, @created_at)
    `);

    // ── Pre-compiled Cache for Staff Performance ──
    this.reinforceMemoryStmt = this.db.prepare(`
      UPDATE memories
      SET
        usage_count = usage_count + 1,
        importance = MIN(1.0, importance + @delta),
        updated_at = @now,
        last_used_at = @now
      WHERE id = @id
    `);

    this.assignClusterMemoryStmt = this.db.prepare('UPDATE memories SET cluster_id = @clusterId, updated_at = @now WHERE id = @id');
    this.assignClusterCountStmt = this.db.prepare('UPDATE clusters SET memory_count = memory_count + 1, updated_at = @now WHERE id = @id');

    this.compressMemoryStmt = this.db.prepare(`
      UPDATE memories
      SET compressed_content = @compressed,
          compression_level = @level,
          updated_at = @now
      WHERE id = @id
    `);
  }

  _getStmt(key, sql) {
    if (!this.stmts[key]) {
      this.stmts[key] = this.db.prepare(sql);
    }
    return this.stmts[key];
  }

  addMemory(memoryInput) {
    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      const payload = {
        dimension: memoryInput.dimension,
        content: memoryInput.content,
        summary: memoryInput.summary,
        compressed_content: memoryInput.compressedContent || null,
        compression_level: memoryInput.compressionLevel ?? COMPRESSION_LEVELS.NONE,
        tags_json: JSON.stringify(memoryInput.tags || []),
        project: memoryInput.project || null,
        file_path: memoryInput.filePath || null,
        hash: memoryInput.hash || null,
        importance: memoryInput.importance,
        usage_count: memoryInput.usageCount ?? 0,
        decay_factor: memoryInput.decayFactor,
        cluster_id: memoryInput.clusterId || null,
        metadata_json: JSON.stringify(memoryInput.metadata || {}),
        embedding_json: memoryInput.embedding ? JSON.stringify(memoryInput.embedding) : null,
        created_at: now,
        updated_at: now,
        last_used_at: now,
      };

      const info = this.insertMemoryStmt.run(payload);
      const id = Number(info.lastInsertRowid);

      this.insertEventStmt.run({
        memory_id: id,
        event_type: 'memory_added',
        payload_json: JSON.stringify({ dimension: memoryInput.dimension }),
        created_at: now,
      });

      return this.getMemoryById(id);
    });

    return tx();
  }

  getMemoryById(id) {
    const row = this._getStmt('getById', 'SELECT * FROM memories WHERE id = ?').get(id);
    return row ? mapMemory(row) : null;
  }

  getMemoryByHash(hash) {
    if (!hash) return null;
    const row = this._getStmt('getByHash', 'SELECT id FROM memories WHERE hash = ? LIMIT 1').get(hash);
    return row ? row.id : null;
  }

  listRecentByProject(project, limit = 25) {
    const rows = this._getStmt('listRecent', `
      SELECT * FROM memories
      WHERE (@project IS NULL OR project = @project)
      ORDER BY created_at DESC
      LIMIT @limit
    `).all({ project: project || null, limit });

    return rows.map(mapMemory);
  }

  listRecentSince(cutoff, project, limit = 100) {
    const rows = this._getStmt('listRecentSince', `
      SELECT * FROM memories
      WHERE (@project IS NULL OR project = @project)
        AND created_at >= @cutoff
      ORDER BY created_at DESC
      LIMIT @limit
    `).all({ project: project || null, cutoff, limit });

    return rows.map(mapMemory);
  }

  searchBase({ query, project, dimension, limit }) {
    const queryStr = String(query || '').trim();
    if (!queryStr) return [];

    try {
      return this._ftsSearch({ query: queryStr, project, dimension, limit });
    } catch {
      return this._likeSearch({ query: queryStr, project, dimension, limit });
    }
  }

  _ftsSearch({ query, project, dimension, limit }) {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1).slice(0, 12);
    if (terms.length === 0) return [];

    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');

    const rows = this._getStmt('ftsSearch', `
      SELECT m.*, rank
      FROM memories_fts fts
      JOIN memories m ON m.id = fts.rowid
      WHERE memories_fts MATCH @ftsQuery
        AND (@project IS NULL OR m.project = @project)
        AND (@dimension IS NULL OR m.dimension = @dimension)
      ORDER BY rank
      LIMIT @limit
    `).all({
      ftsQuery,
      project: project || null,
      dimension: dimension || null,
      limit,
    });

    return rows.map(mapMemory);
  }

  _likeSearch({ query, project, dimension, limit }) {
    const tokens = query.toLowerCase().split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 1).slice(0, 12);
    if (tokens.length === 0) return [];

    const whereParts = [];
    const params = { project: project || null, dimension: dimension || null, limit };

    for (let i = 0; i < tokens.length; i++) {
      const key = `t${i}`;
      params[key] = `%${tokens[i]}%`;
      whereParts.push(`(content LIKE @${key} OR summary LIKE @${key} OR tags_json LIKE @${key})`);
    }

    const tokenSql = whereParts.join(' OR ');
    const rows = this._getStmt('likeSearch_' + tokens.length, `
      SELECT * FROM memories
      WHERE (${tokenSql})
      AND (@project IS NULL OR project = @project)
      AND (@dimension IS NULL OR dimension = @dimension)
      LIMIT @limit
    `).all(params);

    return rows.map(mapMemory);
  }

  listByDimension(dimension, project = null, limit = 50) {
    const rows = this._getStmt('listByDim', `
      SELECT * FROM memories
      WHERE dimension = @dimension
      AND (@project IS NULL OR project = @project)
      ORDER BY importance DESC, usage_count DESC
      LIMIT @limit
    `).all({ dimension, project: project || null, limit });

    return rows.map(mapMemory);
  }

  addRelationship(fromMemoryId, toMemoryId, relationType, weight = 0.5) {
    if (!fromMemoryId || !toMemoryId || fromMemoryId === toMemoryId) return;

    this.insertRelationshipStmt.run({
      from_memory_id: fromMemoryId,
      to_memory_id: toMemoryId,
      relation_type: relationType,
      weight,
      created_at: new Date().toISOString(),
    });
  }

  getRelationshipsForMemory(memoryId, limit = 20) {
    return this._getStmt('getRelations', `
      SELECT r.*, m.content, m.summary, m.dimension, m.tags_json, m.project,
             m.file_path, m.importance, m.usage_count, m.decay_factor,
             m.metadata_json, m.created_at AS mem_created_at, m.updated_at, m.last_used_at
      FROM relationships r
      JOIN memories m ON m.id = r.to_memory_id
      WHERE r.from_memory_id = ?
      ORDER BY r.weight DESC
      LIMIT ?
    `).all(memoryId, limit).map((row) => ({
      relationType: row.relation_type,
      weight: row.weight,
      memory: mapMemory(row),
    }));
  }

  getMemoryGraph(memoryIds, depth = 1, maxResults = 20) {
    const visited = new Set(memoryIds.map(Number));
    let frontier = [...visited];
    const relatedMemories = [];

    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const placeholders = frontier.map(() => '?').join(',');
      const rows = this._getStmt('graph_' + frontier.length, `
        SELECT r.from_memory_id, r.relation_type, r.weight, m.*
        FROM relationships r
        JOIN memories m ON m.id = r.to_memory_id
        WHERE r.from_memory_id IN (${placeholders})
        ORDER BY r.weight DESC
        LIMIT ?
      `).all(...frontier, maxResults * 2);

      const nextFrontier = [];
      for (const row of rows) {
        const sourceId = row.from_memory_id;
        const relId = row.id;
        
        if (!visited.has(relId)) {
          visited.add(relId);
          nextFrontier.push(relId);
          relatedMemories.push({
            relationType: row.relation_type,
            weight: row.weight,
            depth: d + 1,
            sourceId,
            memory: mapMemory(row)
          });
        }
      }

      frontier = nextFrontier;
      if (relatedMemories.length >= maxResults) break;
    }

    return relatedMemories.slice(0, maxResults);
  }

  reinforceMemory(memoryId, importanceDelta = 0.03) {
    const tx = this.db.transaction(() => {
      this.reinforceMemoryStmt.run({ id: memoryId, delta: importanceDelta, now: new Date().toISOString() });

      this.insertEventStmt.run({
        memory_id: memoryId,
        event_type: 'memory_reinforced',
        payload_json: JSON.stringify({ importanceDelta }),
        created_at: new Date().toISOString(),
      });
    });
    tx();
  }

  applyDecay({ staleDays = 7, minImportance = 0.1 }) {
    const now = Date.now();
    const threshold = new Date(now - staleDays * 24 * 60 * 60 * 1000).toISOString();

    const staleRows = this._getStmt('stale_rows', `
      SELECT id, importance, decay_factor, usage_count
      FROM memories
      WHERE last_used_at < ?
    `).all(threshold);

    const updateStmt = this._getStmt('decay_update', `
      UPDATE memories
      SET importance = @importance, updated_at = @now
      WHERE id = @id
    `);

    const insertEvent = this.insertEventStmt;
    const tx = this.db.transaction((rows) => {
      const timestamp = new Date().toISOString();
      for (const row of rows) {
        const usageProtection = Math.min(0.02, row.usage_count * 0.002);
        const effectiveDecay = Math.min(1.0, row.decay_factor + usageProtection);
        const decayed = Math.max(minImportance, row.importance * effectiveDecay);
        if (decayed !== row.importance) {
          updateStmt.run({ id: row.id, importance: decayed, now: timestamp });
          insertEvent.run({
            memory_id: row.id,
            event_type: 'memory_decayed',
            payload_json: JSON.stringify({ previousImportance: row.importance, newImportance: decayed }),
            created_at: timestamp,
          });
        }
      }
    });

    tx(staleRows);
    return staleRows.length;
  }

  getMemoriesForCompression(minContentLength = 500, limit = 50) {
    const rows = this._getStmt('getCompression', `
      SELECT * FROM memories
      WHERE compression_level = 0
        AND LENGTH(content) > @minLen
      ORDER BY last_used_at ASC
      LIMIT @limit
    `).all({ minLen: minContentLength, limit });

    return rows.map(mapMemory);
  }

  searchFTS(query, project = null, dimension = null, limit = 10) {
    try {
      const safeQuery = query.replace(/[^a-zA-Z0-9_]/g, ' ').trim().split(/\\s+/).filter(Boolean).join(' OR ');
      if (!safeQuery) return [];
      
      const rows = this._getStmt('searchFTSFiltered', `
        SELECT m.*, bm25(memories_fts) AS match_rank
        FROM memories_fts f
        JOIN memories m ON f.rowid = m.id
        WHERE memories_fts MATCH ?
          AND (@project IS NULL OR m.project = @project)
          AND (@dimension IS NULL OR m.dimension = @dimension)
        ORDER BY match_rank
        LIMIT ?
      `).all({ 
        matchStr: safeQuery, 
        project: project || null, 
        dimension: dimension || null, 
        lim: limit 
      });
      
      return rows.map(r => {
        const memory = mapMemory(r);
        memory.score = 10.0 / (Math.abs(r.match_rank) + 1);
        return memory;
      });
    } catch (err) {
      return []; 
    }
  }

  compressMemory(memoryId, compressedContent, compressionLevel) {
    const tx = this.db.transaction(() => {
      this.compressMemoryStmt.run({
        id: memoryId,
        compressed: compressedContent,
        level: compressionLevel,
        now: new Date().toISOString(),
      });

      this.insertEventStmt.run({
        memory_id: memoryId,
        event_type: 'memory_compressed',
        payload_json: JSON.stringify({ compressionLevel }),
        created_at: new Date().toISOString(),
      });
    });
    tx();
  }

  createCluster(label, keywords = [], centroidTags = []) {
    const now = new Date().toISOString();
    const info = this._getStmt('createCluster', `
      INSERT INTO clusters (label, keywords_json, centroid_tags_json, memory_count, created_at, updated_at)
      VALUES (@label, @keywords_json, @centroid_tags_json, 0, @now, @now)
    `).run({
      label,
      keywords_json: JSON.stringify(keywords),
      centroid_tags_json: JSON.stringify(centroidTags),
      now,
    });
    return Number(info.lastInsertRowid);
  }

  assignToCluster(memoryId, clusterId) {
    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      this.assignClusterMemoryStmt.run({ id: memoryId, clusterId, now });
      this.assignClusterCountStmt.run({ id: clusterId, now });
    });
    tx();
  }

  getClusterMembers(clusterId, limit = 50) {
    const rows = this._getStmt('clusterMembers', `
      SELECT * FROM memories WHERE cluster_id = ? ORDER BY importance DESC LIMIT ?
    `).all(clusterId, limit);
    return rows.map(mapMemory);
  }

  listClusters() {
    return this._getStmt('listClusters', 'SELECT * FROM clusters ORDER BY memory_count DESC').all().map((c) => ({
      ...c,
      keywords: safeJsonParse(c.keywords_json, []),
      centroidTags: safeJsonParse(c.centroid_tags_json, []),
    }));
  }

  getUnclusteredMemories(limit = 100) {
    const rows = this._getStmt('unclustered', `
      SELECT * FROM memories WHERE cluster_id IS NULL ORDER BY created_at DESC LIMIT ?
    `).all(limit);
    return rows.map(mapMemory);
  }

  getInsights(project = null) {
    const totals = this._getStmt('insights_totals', `
      SELECT
        COUNT(*) AS total,
        AVG(importance) AS avgImportance,
        SUM(usage_count) AS totalUsage
      FROM memories
      WHERE (@project IS NULL OR project = @project)
    `).get({ project: project || null });

    const byDimension = this._getStmt('insights_byDim', `
      SELECT dimension, COUNT(*) AS count, AVG(importance) AS avgImportance,
             SUM(usage_count) AS totalUsage
      FROM memories
      WHERE (@project IS NULL OR project = @project)
      GROUP BY dimension
      ORDER BY count DESC
    `).all({ project: project || null });

    const topUsed = this._getStmt('insights_topUsed', `
      SELECT * FROM memories
      WHERE (@project IS NULL OR project = @project)
      ORDER BY usage_count DESC, importance DESC
      LIMIT 10
    `).all({ project: project || null }).map(mapMemory);

    const recentlyAdded = this._getStmt('insights_recent', `
      SELECT * FROM memories
      WHERE (@project IS NULL OR project = @project)
      ORDER BY created_at DESC
      LIMIT 5
    `).all({ project: project || null }).map(mapMemory);

    const topTags = this._getTopTags(project);

    const compressionStats = this._getStmt('insights_comp', `
      SELECT
        SUM(CASE WHEN compression_level > 0 THEN 1 ELSE 0 END) AS compressed,
        SUM(CASE WHEN compression_level = 0 THEN 1 ELSE 0 END) AS uncompressed
      FROM memories
      WHERE (@project IS NULL OR project = @project)
    `).get({ project: project || null });

    const relationshipCount = this._getStmt('insights_rel', 'SELECT COUNT(*) AS c FROM relationships').get().c;
    const clusterCount = this._getStmt('insights_cluster', 'SELECT COUNT(*) AS c FROM clusters').get().c;

    return {
      totals,
      byDimension,
      topUsed,
      recentlyAdded,
      topTags,
      compressionStats,
      relationshipCount,
      clusterCount,
    };
  }

  _getTopTags(project = null, limit = 15) {
    // Highly optimized Native SQLite JSON extraction algorithm instead of looping over string arrays in V8
    const rows = this._getStmt('top_tags', `
      SELECT json_each.value AS tag, COUNT(*) AS count
      FROM memories, json_each(memories.tags_json)
      WHERE (@project IS NULL OR project = @project)
      GROUP BY json_each.value
      ORDER BY count DESC
      LIMIT @limit
    `).all({ project: project || null, limit });

    return rows;
  }

  debugStats() {
    const counts = this._getStmt('debug_c', 'SELECT COUNT(*) AS c FROM memories').get();
    const relCounts = this._getStmt('debug_rc', 'SELECT COUNT(*) AS c FROM relationships').get();
    const clusterCounts = this._getStmt('debug_cc', 'SELECT COUNT(*) AS c FROM clusters').get();
    const eventCounts = this._getStmt('debug_ec', 'SELECT COUNT(*) AS c FROM memory_events').get();

    const orphanRelationships = this._getStmt('debug_oc', `
      SELECT COUNT(*) AS c
      FROM relationships r
      LEFT JOIN memories m1 ON m1.id = r.from_memory_id
      LEFT JOIN memories m2 ON m2.id = r.to_memory_id
      WHERE m1.id IS NULL OR m2.id IS NULL
    `).get();

    const stale = this._getStmt('debug_sc', `
      SELECT COUNT(*) AS c
      FROM memories
      WHERE last_used_at < datetime('now', '-90 day')
    `).get();

    const compressed = this._getStmt('debug_compc', `
      SELECT COUNT(*) AS c FROM memories WHERE compression_level > 0
    `).get();

    const avgImportance = this._getStmt('debug_avg', 'SELECT AVG(importance) AS avg FROM memories').get();

    const dimensionBreakdown = this._getStmt('debug_dimb', `
      SELECT dimension, COUNT(*) AS count FROM memories GROUP BY dimension ORDER BY count DESC
    `).all();

    return {
      dbPath: this.dbPath,
      memoryCount: counts.c,
      relationshipCount: relCounts.c,
      clusterCount: clusterCounts.c,
      eventCount: eventCounts.c,
      orphanRelationshipCount: orphanRelationships.c,
      staleMemoryCount90d: stale.c,
      compressedMemoryCount: compressed.c,
      averageImportance: Number(avgImportance.avg || 0).toFixed(3),
      dimensionBreakdown,
    };
  }

  exportAll(project = null) {
    const rows = this._getStmt('exportAll', `
      SELECT * FROM memories
      WHERE (@project IS NULL OR project = @project)
      ORDER BY created_at ASC
    `).all({ project: project || null });

    return rows.map(mapMemory);
  }

  getRecentVectors(limit = 5000) {
    return this._getStmt('getRecentVecs', `
      SELECT id, embedding_json as embedding 
      FROM memories 
      WHERE embedding_json IS NOT NULL 
      ORDER BY last_used_at DESC 
      LIMIT ?
    `).all(limit);
  }

  pruneStaleCode() {
    try {
      import('../utils/logger.js').then(({ logger }) => {
        logger.info(`🧹 Executing DB Auto-Prune Sweep...`);
        const stmt = this._getStmt('pruneStale', `
          DELETE FROM memories 
          WHERE dimension = 'code' 
          AND usage_count = 0 
          AND last_used_at < datetime('now', '-30 day')
        `);
        const result = stmt.run();
        if (result.changes > 0) {
           logger.info(`✅ Pruned ${result.changes} obsolete codebase vectors to save massive disk space.`);
        }
      });
    } catch (e) {
      console.error(e);
    }
  }

  getRelationshipsAll() {
    return this._getStmt('getAllRels', 'SELECT * FROM relationships ORDER BY weight DESC').all();
  }

  addRelationship(fromId, toId, relationType = 'linked', weight = 1.0) {
    if (fromId === toId) return false;
    try {
      this._getStmt('add_rel', `
        INSERT OR IGNORE INTO relationships (from_memory_id, to_memory_id, relation_type, weight, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(fromId, toId, relationType, weight, new Date().toISOString());
      return true;
    } catch(e) {
      return false;
    }
  }

  getAssociations(memoryId, limit = 15) {
    // 1st Degree Blast Radius Extraction (Traverse both Import/Export edges)
    const rows = this.db.prepare(`
      SELECT m.*, r.relation_type, r.weight, 
             CASE WHEN r.from_memory_id = ? THEN 'outgoing' ELSE 'incoming' END as direction
      FROM relationships r
      JOIN memories m ON (m.id = r.to_memory_id AND r.from_memory_id = ?)
                      OR (m.id = r.from_memory_id AND r.to_memory_id = ?)
      ORDER BY r.weight DESC, m.importance DESC
      LIMIT ?
    `).all(memoryId, memoryId, memoryId, limit);
    
    return rows.map(r => {
      const memory = mapMemory(r);
      memory._edge = { type: r.relation_type, weight: r.weight, direction: r.direction };
      return memory;
    });
  }

  /**
   * Get the most highly-connected "anchor" memories for spaced repetition digest.
   * Returns memories with the most relationships, weighted by importance.
   */
  getDigest(limit = 5) {
    const rows = this.db.prepare(`
      SELECT m.*,
        (SELECT COUNT(*) FROM relationships r WHERE r.from_memory_id = m.id OR r.to_memory_id = m.id) as linkCount
      FROM memories m
      ORDER BY linkCount DESC, m.importance DESC, m.usage_count DESC
      LIMIT ?
    `).all(limit);

    return rows.map(r => ({ ...mapMemory(r), linkCount: r.linkCount }));
  }

  /**
   * Get graph data for D3.js force-directed visualization.
   * Returns { nodes: [...], links: [...] }
   */
  getGraphData(limit = 200) {
    const memories = this.db.prepare(`
      SELECT id, dimension, summary, content, importance, usage_count
      FROM memories
      ORDER BY importance DESC, usage_count DESC
      LIMIT ?
    `).all(limit);

    const nodes = memories.map(m => ({
      id: m.id,
      dimension: m.dimension,
      label: (m.summary || m.content || '').slice(0, 50),
      importance: Number(m.importance),
      usage: m.usage_count,
    }));

    const nodeIds = new Set(nodes.map(n => n.id));

    const relationships = this.db.prepare(`
      SELECT from_memory_id, to_memory_id, relation_type, weight
      FROM relationships
    `).all();

    const links = relationships
      .filter(r => nodeIds.has(r.from_memory_id) && nodeIds.has(r.to_memory_id))
      .map(r => ({
        source: r.from_memory_id,
        target: r.to_memory_id,
        type: r.relation_type,
        weight: r.weight,
      }));

    return { nodes, links };
  }

  async backup(destinationPath) {
    return this.db.backup(destinationPath);
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch (err) {
        console.error('Failed to close database:', err.message);
      }
    }
  }
}
