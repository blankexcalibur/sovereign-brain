import { DIMENSIONS, DEFAULTS } from '../constants.js';
import { estimateTokens } from '../utils/text.js';

function formatMemoryLine(memory) {
  const tailId = String(memory.id).slice(-6);
  const tags = Array.isArray(memory.tags) ? memory.tags.slice(0, 4).join(',') : '';
  const summary = memory.compressed_content || memory.summary || memory.content;
  return `- [${tailId}] (${memory.dimension}) imp=${Number(memory.importance).toFixed(2)} use=${memory.usage_count} tags=${tags} :: ${summary}`;
}

function formatCompactLine(memory) {
  return `[${memory.dimension}] ${memory.summary || memory.content}`;
}

function truncate(text, max = 2200) {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

/**
 * Build target-specific prompt packs optimized for each AI tool.
 */
function buildPromptPack(target, payload) {
  const sections = [];

  // Current Working Context
  if (payload.currentWorkingContext.length > 0) {
    sections.push('## Current Working Context');
    sections.push(...payload.currentWorkingContext.map(formatMemoryLine));
  }

  // Relevant Past Knowledge
  if (payload.relevantPastKnowledge.length > 0) {
    sections.push('', '## Relevant Past Knowledge');
    sections.push(...payload.relevantPastKnowledge.map(formatMemoryLine));
  }

  // Related Via Graph
  if (payload.graphRelated && payload.graphRelated.length > 0) {
    sections.push('', '## Related Memories (Graph)');
    sections.push(...payload.graphRelated.map((r) =>
      `- [${r.relationType}] ${formatCompactLine(r.memory)}`
    ));
  }

  // Cluster Context
  if (payload.clusterContext && payload.clusterContext.length > 0) {
    sections.push('', '## Thematic Clusters');
    for (const cluster of payload.clusterContext) {
      sections.push(`### ${cluster.label} (${cluster.count} memories)`);
      sections.push(...cluster.samples.map(formatCompactLine));
    }
  }

  // Project Intelligence
  sections.push('', '## Project Intelligence');
  sections.push(payload.projectIntelligenceSummary);
  sections.push('', `**Query:** ${payload.query}`);

  const sectionText = sections.join('\n');

  if (target === 'claude') {
    return [
      '<system>',
      'You are a precise software engineering assistant. Use the developer memory context below before external knowledge. Keep answers implementation-focused with concrete code suggestions.',
      '</system>',
      '',
      '<user>',
      truncate(sectionText, 3200),
      '</user>',
    ].join('\n');
  }

  if (target === 'cursor') {
    return [
      '# Memory Context for Cursor',
      '',
      truncate(sectionText, 3200),
      '',
      '---',
      'Use this context first. Implement concrete changes in the repo and validate assumptions with tests.',
    ].join('\n');
  }

  // Copilot (default)
  return [
    '### Copilot Memory Context',
    '',
    truncate(sectionText, 3200),
    '',
    '---',
    'Use this context first. Prefer direct file edits with concise rationale.',
  ].join('\n');
}

export class ContextEngine {
  constructor(repository, rankingEngine) {
    this.repository = repository;
    this.rankingEngine = rankingEngine;
  }

  build({ query, project, target = 'copilot', limit = 12, preRankedMemories }) {
    // Step 1: Search and rank candidates
    let ranked = preRankedMemories;
    if (!ranked) {
      const candidates = this.repository.searchBase({
        query, project, dimension: null,
        limit: Math.max(limit * 4, 30),
      });
      ranked = this.rankingEngine.rank(candidates, query, limit);
    }

    // Step 2: Split into context categories
    const currentWorkingContext = ranked
      .filter((m) => [DIMENSIONS.TASK, DIMENSIONS.CONTEXT].includes(m.dimension))
      .slice(0, 6);

    const relevantPastKnowledge = ranked
      .filter((m) => [DIMENSIONS.COGNITIVE, DIMENSIONS.CODE, DIMENSIONS.EPISODIC].includes(m.dimension))
      .slice(0, 8);

    // Step 3: Traverse relationship graph for connected memories
    const touchedIds = ranked.map((m) => m.id);
    let graphRelated = [];
    if (touchedIds.length > 0) {
      graphRelated = this.repository.getMemoryGraph(touchedIds, 1, 6);
    }

    // Step 4: Find relevant clusters
    const clusters = this.repository.listClusters();
    const clusterContext = [];
    for (const cluster of clusters.slice(0, 3)) {
      const members = this.repository.getClusterMembers(cluster.id, 3);
      if (members.length > 0) {
        clusterContext.push({
          label: cluster.label,
          count: cluster.memory_count,
          samples: members,
        });
      }
    }

    // Step 5: Build project intelligence summary
    const insights = this.repository.getInsights(project || null);
    const dimensionSummary = insights.byDimension
      .map((d) => `${d.dimension}: ${d.count} (avgImp=${Number(d.avgImportance || 0).toFixed(2)})`)
      .join(', ');

    const topTagSummary = (insights.topTags || [])
      .slice(0, 8)
      .map((t) => `${t.tag}(${t.count})`)
      .join(', ');

    const projectIntelligenceSummary = [
      `Total Memories: ${insights.totals.total || 0}`,
      `Avg Importance: ${Number(insights.totals.avgImportance || 0).toFixed(2)}`,
      `Usage Signals: ${insights.totals.totalUsage || 0}`,
      `Dimensions: ${dimensionSummary || 'n/a'}`,
      `Relationships: ${insights.relationshipCount || 0}`,
      `Clusters: ${insights.clusterCount || 0}`,
      topTagSummary ? `Top Tags: ${topTagSummary}` : '',
    ].filter(Boolean).join(' | ');

    // Step 6: Apply token budget
    const tokenBudget = DEFAULTS.maxTokenBudget;
    const allContextMemories = [...currentWorkingContext, ...relevantPastKnowledge];
    let usedTokens = estimateTokens(projectIntelligenceSummary) + estimateTokens(query) + 100;

    const budgetedCurrent = [];
    const budgetedPast = [];

    for (const m of currentWorkingContext) {
      const memTokens = estimateTokens(formatMemoryLine(m));
      if (usedTokens + memTokens <= tokenBudget) {
        budgetedCurrent.push(m);
        usedTokens += memTokens;
      }
    }

    for (const m of relevantPastKnowledge) {
      const memTokens = estimateTokens(formatMemoryLine(m));
      if (usedTokens + memTokens <= tokenBudget) {
        budgetedPast.push(m);
        usedTokens += memTokens;
      }
    }

    const payload = {
      query,
      currentWorkingContext: budgetedCurrent,
      relevantPastKnowledge: budgetedPast,
      graphRelated,
      clusterContext,
      projectIntelligenceSummary,
      tokenBudget,
      estimatedTokens: usedTokens,
    };

    return {
      ...payload,
      promptPack: buildPromptPack(target, payload),
      llmContext: truncate([
        '<current_working_context>',
        ...budgetedCurrent.map((m) => m.summary || m.content),
        '</current_working_context>',
        '<relevant_past_knowledge>',
        ...budgetedPast.map((m) => m.summary || m.content),
        '</relevant_past_knowledge>',
        ...(graphRelated.length > 0 ? [
          '<related_memories>',
          ...graphRelated.map((r) => `[${r.relationType}] ${r.memory.summary || r.memory.content}`),
          '</related_memories>',
        ] : []),
        `<project_intelligence>${projectIntelligenceSummary}</project_intelligence>`,
      ].join('\n'), 3600),
    };
  }
}
