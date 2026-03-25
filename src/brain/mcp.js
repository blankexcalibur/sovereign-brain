import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Creates and configures an MCP server wired to the given service.
 * Returns the server instance so it can be mounted on different transports.
 */
export function createMcpServer(service) {

  const server = new Server(
    {
      name: "local-brain",
      version: "2.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_memory",
        description: "Search the local developer brain using hybrid semantic + keyword search. Use this before modifying any code to understand architecture, past decisions, and related patterns.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural language search query" },
            limit: { type: "number", description: "Max results (default: 5, max: 20)" },
            dimension: { type: "string", description: "Filter by: code, episodic, cognitive, spatial, task" },
            project: { type: "string", description: "Filter by project name" }
          },
          required: ["query"],
        },
      },
      {
        name: "add_memory",
        description: "Store a new piece of knowledge in the local brain. Use this to record architectural decisions, bug fixes, patterns, or any insight worth remembering across sessions.",
        inputSchema: {
          type: "object",
          properties: {
            dimension: { type: "string", enum: ["code", "episodic", "cognitive", "spatial", "task"], description: "Memory type" },
            content: { type: "string", description: "The knowledge to store" },
            tags: { type: "string", description: "Comma-separated tags" },
            project: { type: "string", description: "Project name" },
            filePath: { type: "string", description: "Related file path" },
            importance: { type: "number", description: "0.0 to 1.0 (default: 0.5)" }
          },
          required: ["dimension", "content"],
        },
      },
      {
        name: "build_context",
        description: "Generate a rich context pack from the brain for a specific query. Returns structured memories optimized for LLM consumption with token budgeting.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "What you need context about" },
            project: { type: "string", description: "Project to focus on" },
            maxTokens: { type: "number", description: "Token budget (default: 2000)" }
          },
          required: ["query"],
        },
      },
      {
        name: "get_stats",
        description: "Get statistics about the local brain: total memories, dimensions breakdown, top tags, and health metrics.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "find_duplicates",
        description: "Scan the memory graph for duplicated code patterns across different files. Returns file pairs with similar logic that could be refactored.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const args = request.params.arguments || {};

    switch (request.params.name) {
      case "search_memory": {
        const results = await service.searchMemories({
          query: args.query,
          limit: Math.min(Number(args.limit) || 5, 20),
          dimension: args.dimension || null,
          project: args.project || null,
        });

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No matching memories found." }] };
        }

        let text = "";
        for (const r of results) {
          const score = Number(r.score).toFixed(2);
          const meta = r.metadata_json ? (() => { try { return JSON.parse(r.metadata_json); } catch { return null; } })() : null;
          const gitInfo = meta?.git ? ` | Git: ${meta.git.message}` : '';
          text += `[${r.dimension}] (score: ${score}) ${r.file_path || ''}${gitInfo}\n`;
          text += `  Tags: ${r.tags}\n`;
          text += `  ${r.content}\n\n`;
        }
        return { content: [{ type: "text", text }] };
      }

      case "add_memory": {
        const memory = await service.addMemory({
          dimension: args.dimension,
          content: args.content,
          tags: args.tags || '',
          project: args.project || null,
          filePath: args.filePath || null,
          importance: args.importance || 0.5,
        });

        let responseText = `Memory stored (id: ${memory.id}, dimension: ${memory.dimension})`;
        if (memory.conflicts && memory.conflicts.length > 0) {
          responseText += `\n\n⚠️ CONFLICT WARNING ⚠️`;
          responseText += `\nHigh similarity to recently added memories (potential contradiction):`;
          for (const c of memory.conflicts) {
            responseText += `\n- [Similarity: ${c.similarity}] ${c.existingSummary}`;
            responseText += `\n  Resolution: ${c.resolution}`;
          }
        }
        return { content: [{ type: "text", text: responseText }] };
      }

      case "build_context": {
        const context = await service.buildContext({
          query: args.query,
          project: args.project || null,
          maxTokens: args.maxTokens || 2000,
        });
        return { content: [{ type: "text", text: context.llmContext || context.promptPack || "No context available." }] };
      }

      case "get_stats": {
        const stats = service.repository.getInsights();
        return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
      }

      case "find_duplicates": {
        const result = await service.agentEngine.runEvolutionSweep();
        if (result.suggestions.length === 0) {
          return { content: [{ type: "text", text: "No code duplication detected." }] };
        }
        let text = "Duplicated code clusters found:\n\n";
        for (const s of result.suggestions) {
          text += `Files: ${s.files.join(' ↔ ')}\n`;
          text += `Preview A: ${s.previewA.substring(0, 150)}...\n`;
          text += `Preview B: ${s.previewB.substring(0, 150)}...\n\n`;
        }
        return { content: [{ type: "text", text }] };
      }

      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

  return server;
}

// ── Standalone stdio mode (called directly by Claude Desktop) ──
const isDirectRun = process.argv[1] && (process.argv[1].endsWith('mcp.js') || process.argv.includes('--mcp'));
if (isDirectRun) {
  const { DeveloperMemoryService } = await import('./service.js');
  const service = new DeveloperMemoryService();
  const server = createMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🧠 Local Brain MCP Server running on stdio");
}
