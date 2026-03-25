import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { DEFAULTS } from './constants.js';

function resolveDbPath() {
  const envPath = process.env.MEMORY_BRAIN_DB_PATH;
  if (envPath && String(envPath).trim()) {
    const resolved = path.resolve(String(envPath).trim());
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return resolved;
  }

  const root = process.cwd();
  const dataDir = path.join(root, '.memory-brain');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, DEFAULTS.dbFileName);
}

function columnExists(db, table, column) {
  const cols = db.pragma(`table_info(${table})`);
  return cols.some((c) => c.name === column);
}

export function createDb() {
  const dbPath = resolveDbPath();
  const db = new Database(dbPath, { timeout: 10000 }); // 10s busy timeout for concurrent writes

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000');
  db.pragma('wal_autocheckpoint = 1000'); // Checkpoint every 1000 pages
  db.pragma('auto_vacuum = FULL');        // Automatically reclaim disk space

  // ── Step 1: Core tables ──────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dimension TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      project TEXT,
      file_path TEXT,
      importance REAL NOT NULL DEFAULT 0.5,
      usage_count INTEGER NOT NULL DEFAULT 0,
      decay_factor REAL NOT NULL DEFAULT 0.985,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      embedding_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_memory_id INTEGER NOT NULL,
      to_memory_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(from_memory_id, to_memory_id, relation_type),
      FOREIGN KEY(from_memory_id) REFERENCES memories(id) ON DELETE CASCADE,
      FOREIGN KEY(to_memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS memory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS clusters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      keywords_json TEXT NOT NULL DEFAULT '[]',
      centroid_tags_json TEXT NOT NULL DEFAULT '[]',
      memory_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // ── Step 2: Migrations (add new columns to existing tables) ──────
  if (!columnExists(db, 'memories', 'compressed_content')) {
    db.exec('ALTER TABLE memories ADD COLUMN compressed_content TEXT');
  }
  if (!columnExists(db, 'memories', 'compression_level')) {
    db.exec('ALTER TABLE memories ADD COLUMN compression_level INTEGER NOT NULL DEFAULT 0');
  }
  if (!columnExists(db, 'memories', 'cluster_id')) {
    db.exec('ALTER TABLE memories ADD COLUMN cluster_id INTEGER');
  }
  if (!columnExists(db, 'memories', 'hash')) {
    db.exec('ALTER TABLE memories ADD COLUMN hash TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(hash)');
  }
  if (!columnExists(db, 'memories', 'embedding_json')) {
    db.exec('ALTER TABLE memories ADD COLUMN embedding_json TEXT');
  }

  // ── Step 3: Indexes ──────────────────────────────────────────────
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_dimension ON memories(dimension);
    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
    CREATE INDEX IF NOT EXISTS idx_memories_last_used ON memories(last_used_at);
    CREATE INDEX IF NOT EXISTS idx_memories_cluster ON memories(cluster_id);
    CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
    CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_memory_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_memory_id);
    CREATE INDEX IF NOT EXISTS idx_clusters_label ON clusters(label);
  `);

  // ── Step 4: FTS5 full-text search ────────────────────────────────
  const ftsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"
  ).get();

  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content, summary, tags_text,
        content='memories',
        content_rowid='id',
        tokenize='porter unicode61'
      );
    `);

    // Populate FTS from existing data
    db.exec(`
      INSERT INTO memories_fts(rowid, content, summary, tags_text)
      SELECT id, content, summary, REPLACE(REPLACE(tags_json, '[', ''), ']', '')
      FROM memories;
    `);
  }

  // ── Step 5: FTS sync triggers ────────────────────────────────────
  const triggerExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name='memories_ai'"
  ).get();

  if (!triggerExists) {
    db.exec(`
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, summary, tags_text)
        VALUES (new.id, new.content, new.summary, REPLACE(REPLACE(new.tags_json, '[', ''), ']', ''));
      END;

      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags_text)
        VALUES ('delete', old.id, old.content, old.summary, REPLACE(REPLACE(old.tags_json, '[', ''), ']', ''));
      END;

      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags_text)
        VALUES ('delete', old.id, old.content, old.summary, REPLACE(REPLACE(old.tags_json, '[', ''), ']', ''));
        INSERT INTO memories_fts(rowid, content, summary, tags_text)
        VALUES (new.id, new.content, new.summary, REPLACE(REPLACE(new.tags_json, '[', ''), ']', ''));
      END;
    `);
  }

  return { db, dbPath };
}
