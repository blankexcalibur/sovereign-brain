# 🧠 Sovereign Memory Daemon

**A shared memory layer for AI coding agents.** Stop your team's 10 Claude instances from writing the same code 10 different ways.

Runs 100% locally. SQLite + ONNX embeddings. No cloud. No telemetry. Zero outbound connections.

---

## What It Does

Every AI coding tool (Claude, Cursor, Copilot) operates in isolation. Each one has zero memory of what the others have built. This daemon solves that by providing a **persistent, shared brain** that every AI agent queries before writing code.

- **Ingests** your entire codebase via Tree-Sitter AST parsing
- **Stores** semantic embeddings in a local SQLite + HNSW vector index
- **Serves** memory to any MCP-compatible AI tool (Claude Desktop, Cursor, Zed)
- **Scales** to teams via SSE transport + API key auth + Prometheus observability

---

## Quick Start (Solo Developer)

```bash
# Option A: npx (zero-install)
npx sovereign-brain

# Option B: Clone
git clone <repo> && cd sovereign-brain && npm install
npm run install-claude  # Auto-configure Claude Desktop
npm start               # Boots daemon (auto-ingests on first run)
```

Done. Open Claude Desktop → your brain is live with 5 MCP tools:
- `search_memory` — Hybrid semantic + keyword search
- `add_memory` — Store knowledge across sessions (with **conflict detection**)
- `build_context` — Generate LLM-optimized context packs
- `get_stats` — Brain health metrics
- `find_duplicates` — Detect code duplication

---

## Team Deployment (Shared Brain)

Host the daemon on a central server so every developer's AI agent talks to the same brain.

### 1. Server Setup

```bash
# Generate team API keys (one per developer)
export MEMORY_API_KEYS="key_alice_abc123,key_bob_def456,key_carol_ghi789"

# Boot in team mode (binds to 0.0.0.0 instead of localhost)
npm start
```

### 2. Developer Setup (Remote Claude Desktop)

Each developer adds this to their `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "team-brain": {
      "url": "http://team-brain.internal:31337/mcp/sse?token=key_alice_abc123"
    }
  }
}
```

### 3. Observability

Prometheus metrics are exposed at `/metrics`:

```
brain_memories_added_total
brain_searches_total
brain_search_duration_seconds
process_cpu_seconds_total
nodejs_heap_size_total_bytes
```

Scrape with Datadog, Grafana, or any Prometheus-compatible system.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│              Sovereign Brain Daemon          │
│                                              │
│  ┌──────────┐  ┌───────────┐  ┌───────────┐ │
│  │ SQLite   │  │ HNSW      │  │ Tree-     │ │
│  │ FTS5+WAL │  │ Vector    │  │ Sitter    │ │
│  │          │  │ Index     │  │ AST       │ │
│  └──────────┘  └───────────┘  └───────────┘ │
│                                              │
│  ┌──────────┐  ┌───────────┐  ┌───────────┐ │
│  │ MCP      │  │ REST API  │  │ Prometheus│ │
│  │ SSE/stdio│  │ :31337    │  │ /metrics  │ │
│  └──────────┘  └───────────┘  └───────────┘ │
└──────────────────────────────────────────────┘
        ↑               ↑              ↑
   Claude Desktop    VS Code        Grafana
   Cursor/Zed       Extension       Datadog
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MEMORY_BRAIN_DB_PATH` | `.memory-brain/brain.db` | SQLite database location |
| `MEMORY_API_KEYS` | *(none)* | Comma-separated team API keys |
| `MEMORY_TEAM_MODE` | `false` | Force team mode (0.0.0.0 binding) |

---

## Conflict Detection

When any agent stores a memory via `add_memory`, the daemon scans memories added in the last hour for high-similarity entries (>85% cosine similarity). If found, the MCP response includes a **conflict warning**:

```
Memory stored (id: 42, dimension: code)

⚠️ CONFLICT WARNING ⚠️
High similarity to recently added memories (potential contradiction):
- [Similarity: 0.91] Auth module uses session cookies for state management
  Resolution: Review both memories — high similarity suggests potential duplication or contradiction.
```

This catches contradictory architectural decisions before they ship — e.g. when Developer A's Claude decides "use JWT" while Developer B's Claude decides "use session cookies."

---

## CLI

```bash
npm run memory -- add --type code --content "Auth uses JWT" --project myapp
npm run memory -- search --query "authentication" --format json
npm run memory -- ingest-repo ./
npm run memory -- context --query "payment flow" --target claude
```

---

## License

MIT. No cloud. No spies. Ship it.
