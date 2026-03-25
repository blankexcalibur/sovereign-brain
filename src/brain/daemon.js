import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import winston from 'winston';
import { z } from 'zod';
import crypto from 'crypto';
import { DeveloperMemoryService } from './service.js';
import path from 'path';
import fs from 'fs';
import client from 'prom-client';
import { createMcpServer } from './mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

// ── Logging Configuration (Winston) ──────────────────────────
const logDir = path.join(process.cwd(), '.memory-brain');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: path.join(logDir, 'daemon-error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logDir, 'daemon.log') }),
  ]
});

// If we're not in production then log to the `console`
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple(),
  }));
}

// ── Application Initialization ──────────────────────────────
const app = express();
const PORT = 31337;

// Security Middleware
app.use(helmet());
app.use(cors({
  origin: '*', // Allow local Chrome extension IDs to connect seamlessly
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate Limiting (Prevent infinite loop attacks from extensions)
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 500, // Limit each IP to 500 requests per windowMs
  message: { success: false, error: 'Too many requests, please try again later.' }
});
app.use(limiter);

app.use(express.json({ limit: '10mb' }));

// A single, long-lived instance holding the SQLite pool & loaded ONNX models
const service = new DeveloperMemoryService();

// Pre-warm the native C++ HNSW Graph Index on boot without blocking the event loop
setTimeout(async () => {
  try {
    logger.info('🧠 Pre-warming Local HNSW AI Index...');
    const allVectors = service.repository.getRecentVectors(5000); // Protect i3 RAM constraints
    const parsedVectors = allVectors.map(v => {
      try { return { id: v.id, embedding: JSON.parse(v.embedding) }; } 
      catch (e) { return null; }
    }).filter(Boolean);
    
    const loadedCount = await service.embeddingEngine.bulkLoadIndex(parsedVectors);
    logger.info(`✅ HNSW Index Warmed: ${loadedCount} vectors ready for instant semantic retrieval.`);
  } catch (err) {
    logger.error(`HNSW Pre-warm failed: ${err.message}`);
  }
}, 2000); // Wait 2s to not block HTTP listener boot

// ── Zero-Trust Authentication ───────────────────────────────
const tokenPath = path.join(logDir, '.daemon_token');
let DAEMON_TOKEN = '';
try {
  // Always assign a new cryptographically secure token on boot 
  DAEMON_TOKEN = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, DAEMON_TOKEN, { mode: 0o600 }); // Restrict explicit OS read permissions
  logger.info('Daemon Authentication Token rotated and secured.');
} catch (err) {
  logger.error('Failed to secure Daemon Authentication Token:', err);
  process.exit(1);
}

// Enterprise: Team API Keys from environment (comma-separated)
const TEAM_API_KEYS = process.env.MEMORY_API_KEYS
  ? process.env.MEMORY_API_KEYS.split(',').map(k => k.trim()).filter(Boolean)
  : [];
const IS_TEAM_MODE = TEAM_API_KEYS.length > 0 || process.env.MEMORY_TEAM_MODE === 'true';

if (TEAM_API_KEYS.length > 0) {
  logger.info(`Enterprise Mode: ${TEAM_API_KEYS.length} team API key(s) loaded.`);
}

// ── Prometheus Observability ─────────────────────────────────
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestCounter = new client.Counter({
  name: 'brain_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
});
register.registerMetric(httpRequestCounter);

const memoryAddCounter = new client.Counter({
  name: 'brain_memories_added_total',
  help: 'Total memories ingested',
});
register.registerMetric(memoryAddCounter);

const searchCounter = new client.Counter({
  name: 'brain_searches_total',
  help: 'Total search queries',
});
register.registerMetric(searchCounter);

const searchLatency = new client.Histogram({
  name: 'brain_search_duration_seconds',
  help: 'Search query latency',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1],
});
register.registerMetric(searchLatency);

// ── Lifecycle Management ────────────────────────────────────
let idleTimeout;
const IDLE_LIMIT_MS = 15 * 60 * 1000; // 15 minutes of inactivity triggers shutdown

// ── OOM Auto-Pruning Routine ────────────────────────────────
// The pruning heartbeat wakes up every 24 hours to delete obsolete code vectors.
setInterval(() => {
  try {
     service.repository.pruneStaleCode();
  } catch(e) {}
}, 24 * 60 * 60 * 1000);

// ── Disaster Recovery ───────────────────────────────────────
const BACKUP_DIR = path.join(logDir, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

async function runNightlyBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(BACKUP_DIR, `brain-${timestamp}.db.bak`);
  try {
    logger.info(`Starting SQLite Native Backup to ${backupFile}`);
    await service.backup(backupFile);
    logger.info('Backup completed successfully.');
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('brain-') && f.endsWith('.db.bak'))
      .sort().reverse();
    if (files.length > 7) {
      const toDelete = files.slice(7);
      for (const f of toDelete) fs.unlinkSync(path.join(BACKUP_DIR, f));
      logger.info(`Cleaned up ${toDelete.length} old backups.`);
    }
  } catch (err) {
    logger.error(`Backup failed: ${err.message}`);
  }
}
setTimeout(runNightlyBackup, 5000);
setInterval(runNightlyBackup, 24 * 60 * 60 * 1000);

function gracefulShutdown(reason) {
  logger.info(`Initiating graceful shutdown due to: ${reason}`);
  try {
    service.close();
    logger.info('Database connection closed successfully.');
  } catch (err) {
    logger.error(`Error closing database: ${err.message}`);
  }
  process.exit(0);
}

function resetIdleTimeout() {
  if (idleTimeout) clearTimeout(idleTimeout);
  idleTimeout = setTimeout(() => {
    logger.info('Daemon idle for 15 minutes. Shutting down to free memory.');
    gracefulShutdown('IDLE_TIMEOUT');
  }, IDLE_LIMIT_MS);
}

// Reset idle timer on every incoming request
app.use((req, res, next) => {
  resetIdleTimeout();
  next();
});

// Start the timer immediately upon boot
resetIdleTimeout();



// OS Signal Traps
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', { error: err.stack });
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', { reason });
});

// ── Zod Validation Schemas ──────────────────────────────────
const addMemorySchema = z.object({
  dimension: z.string().min(2),
  content: z.string().min(1),
  summary: z.string().optional(),
  tags: z.union([z.string(), z.array(z.string())]).optional(),
  project: z.string().nullable().optional(),
  filePath: z.string().nullable().optional()
}).passthrough(); // Allow extra fields but validate the core

const searchSchema = z.object({
  query: z.string().min(1),
  dimension: z.string().optional(),
  target: z.string().optional(),
  project: z.string().nullable().optional(),
  limit: z.number().int().positive().optional()
}).passthrough();

// ── Routes ──────────────────────────────────────────────────
app.get('/ping', (req, res) => {
  res.json({ success: true, status: 'alive' });
});

const eventClients = new Set();
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  res.write('data: {"status": "connected"}\\n\\n');
  eventClients.add(res);
  
  req.on('close', () => {
    eventClients.delete(res);
  });
});

service.on('guardrail_violation', (violation) => {
  const payload = JSON.stringify({ type: 'guardrail_violation', data: violation });
  for (const client of eventClients) {
    client.write(`data: ${payload}\\n\\n`);
  }
});

import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Enforce Zero-Trust Bearer Token validation for all API routes
app.use((req, res, next) => {
  // /ping and /metrics are public (health checks + Prometheus scraping)
  if (req.path === '/ping' || req.path === '/metrics') return next();
  // MCP SSE endpoints use their own auth query param
  if (req.path.startsWith('/mcp/')) return next();

  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  // Accept: local daemon token OR any team-issued API key
  if (token === DAEMON_TOKEN || TEAM_API_KEYS.includes(token)) {
    return next();
  }

  logger.warn('Unauthorized access attempt intercepted.');
  return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or missing API key.' });
});

app.post('/add', async (req, res) => {
  try {
    const validatedData = addMemorySchema.parse(req.body);
    const memory = await service.addMemory(validatedData);
    res.json({ success: true, memory });
  } catch (err) {
    logger.warn('Add Memory Validation Failed', { error: err.message });
    res.status(400).json({ success: false, error: err.message || err.errors });
  }
});

app.post('/search', async (req, res) => {
  const end = searchLatency.startTimer();
  try {
    const validatedData = searchSchema.parse(req.body);
    const results = await service.searchMemories(validatedData);
    searchCounter.inc();
    end();
    res.json({ success: true, results });
  } catch (err) {
    end();
    res.status(400).json({ success: false, error: err.message || err.errors });
  }
});

app.post('/context', async (req, res) => {
  try {
    const validatedData = searchSchema.parse(req.body); // Shares input shape
    const context = await service.context(validatedData);
    res.json({ success: true, ...context });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || err.errors });
  }
});

app.post('/stats', (req, res) => {
  try {
    const stats = service.stats(req.body.project || null);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/debug', (req, res) => {
  try {
    const debug = service.debug();
    res.json({ success: true, debug });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/insights', (req, res) => {
  try {
    const insights = service.insights(req.body.project || null);
    res.json({ success: true, insights });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/export', (req, res) => {
  try {
    const exported = service.exportAll(req.body.project || null);
    res.json({ success: true, exported });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/compress', async (req, res) => {
  try {
    const result = await service.compress({
      minContentLength: req.body.minContentLength || 500,
      limit: req.body.limit || 30
    });
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/link', (req, res) => {
  try {
    const result = service.link(
      req.body.fromId,
      req.body.toId,
      req.body.relation,
      req.body.weight || 0.5
    );
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/vision', async (req, res) => {
  try {
    const { imagePath, project } = req.body;
    if (!imagePath) throw new Error("imagePath is required");
    const result = await service.visionEngine.ingestImage(imagePath, project);
    res.json({ success: true, caption: result.caption });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/graph', (req, res) => {
  try {
    const limit = req.body.limit || 200;
    const graphData = service.repository.getGraphData(limit);
    res.json({ success: true, ...graphData });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/digest', (req, res) => {
  try {
    const limit = req.body.limit || 5;
    const digest = service.repository.getDigest(limit);
    res.json({ success: true, digest });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/chat', async (req, res) => {
  try {
    const query = req.body.query;
    if (!query) throw new Error('query is required');
    
    // Ensure the embedding model lazy-loads before generation
    await service.embeddingEngine.initPipeline();
    const responseText = await service.chat(query);
    
    res.json({ success: true, response: responseText });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/shutdown', (req, res) => {
  res.json({ success: true, message: 'Shutting down...' });
  setTimeout(() => gracefulShutdown('CLIENT_REQUEST'), 100);
});

app.get('/health', (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    success: true,
    uptime: process.uptime(),
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
      heap: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
    },
    watcherActive: watcher.active,
  });
});

// ── Ambient Intelligence ────────────────────────────────────
import { WatcherEngine } from './engines/watcherEngine.js';
const watcher = new WatcherEngine(service);

// ── Prometheus Metrics Endpoint (Public) ────────────────────
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// ── MCP over SSE (Team Mode) ────────────────────────────────
const mcpServer = createMcpServer(service);
const sseTransports = new Map();

app.get('/mcp/sse', async (req, res) => {
  // Authenticate SSE connections via query param
  const token = req.query.token;
  if (token !== DAEMON_TOKEN && !TEAM_API_KEYS.includes(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  logger.info('MCP SSE client connected.');
  const transport = new SSEServerTransport('/mcp/messages', res);
  sseTransports.set(transport.sessionId, transport);

  res.on('close', () => {
    sseTransports.delete(transport.sessionId);
    logger.info('MCP SSE client disconnected.');
  });

  await mcpServer.connect(transport);
});

app.post('/mcp/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports.get(sessionId);
  if (!transport) {
    return res.status(400).json({ error: 'No active SSE session for this sessionId.' });
  }
  await transport.handlePostMessage(req, res);
});

// ── Auto-Seed on First Boot ─────────────────────────────────
async function autoSeedIfEmpty() {
  try {
    const stats = service.stats(null);
    if (stats.memoryCount === 0) {
      logger.info('Empty brain detected. Auto-seeding from Git history...');
      const { GitEngine } = await import('./engines/gitEngine.js');
      const git = new GitEngine(service);
      const result = await git.ingestRecentCommits(50, null);
      logger.info(`Auto-seed complete: ${result.ingested} commits ingested.`);
    }
  } catch (err) {
    logger.warn(`Auto-seed skipped: ${err.message}`);
  }
}

// ── Boot ─────────────────────────────────────────────────────
const BIND_HOST = IS_TEAM_MODE ? '0.0.0.0' : '127.0.0.1';

app.listen(PORT, BIND_HOST, () => {
  logger.info(`Local Brain Daemon listening on http://${BIND_HOST}:${PORT}`);
  if (IS_TEAM_MODE) {
    logger.info(`🔗 Team Mode ACTIVE — MCP SSE available at http://${BIND_HOST}:${PORT}/mcp/sse`);
    logger.info(`📊 Prometheus metrics at http://${BIND_HOST}:${PORT}/metrics`);
  }
  watcher.start().catch(err => logger.error(`Watcher failed: ${err.message}`));
  autoSeedIfEmpty().catch(err => logger.warn(`Auto-seed failed: ${err.message}`));
});
