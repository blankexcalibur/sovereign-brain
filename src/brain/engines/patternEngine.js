import path from 'path';
import { uniqueTags } from '../utils/text.js';
import { PATTERN_CATEGORIES } from '../constants.js';

export class PatternEngine {
  /**
   * Extract tags from content and file path using multi-category pattern recognition.
   */
  extract(content, filePath = '') {
    const text = String(content || '');
    const tags = [];

    // ── Content pattern detection ──

    // Bug / fix detection
    if (/\bbug\b|\bissue\b|\berror\b|\bexception\b|\bcrash\b|\bfail(ure|ed)?\b/i.test(text)) tags.push('bug');
    if (/\bfix(ed)?\b|\bresolved\b|\bpatched\b|\bworkaround\b|\bhotfix\b/i.test(text)) tags.push('fix');
    if (/\brefactor\b|\bcleanup\b|\boptimi[sz]e\b|\brewrite\b|\brestructur/i.test(text)) tags.push('refactor');
    if (/\btest\b|\bjest\b|\bunit\b|\bintegration\b|\be2e\b|\bspec\b|\bcoverage\b/i.test(text)) tags.push('testing');
    if (/\bperformance\b|\blatency\b|\bslow\b|\bbenchmark\b|\bprofile\b|\bmemory.?leak\b/i.test(text)) tags.push('performance');
    if (/\bsecurity\b|\bauth\b|\btoken\b|\bjwt\b|\bvulnerab\b|\bxss\b|\bsql.?inject\b|\bcors\b/i.test(text)) tags.push('security');
    if (/\bdeprecated?\b|\bbreaking.?change\b|\bmigrat/i.test(text)) tags.push('deprecation');
    if (/\bdeploy\b|\brelease\b|\bpipeline\b|\bstaging\b|\bproduction\b/i.test(text)) tags.push('deployment');
    if (/\bdocument\b|\breadme\b|\bapi.?doc\b|\bjsdoc\b|\btypedoc\b/i.test(text)) tags.push('documentation');
    if (/\bdesign\b|\barchitect\b|\bpattern\b|\bprinciple\b|\bdecision\b/i.test(text)) tags.push('design');
    if (/\blearn(ed|ing)?\b|\binsight\b|\btil\b|\bdiscover/i.test(text)) tags.push('learning');

    // Code structure patterns
    if (/\bclass\s+\w+|\bfunction\s+\w+|=>|export\s+(default\s+)?/i.test(text)) tags.push('code-pattern');
    if (/\bimport\s+.*from\b|\brequire\s*\(/i.test(text)) tags.push('imports');

    // ── Framework detection ──
    for (const rule of PATTERN_CATEGORIES.FRAMEWORKS) {
      if (rule.pattern.test(text)) tags.push(rule.tag);
    }

    // ── Architecture pattern detection ──
    for (const rule of PATTERN_CATEGORIES.ARCHITECTURE) {
      if (rule.pattern.test(text)) tags.push(rule.tag);
    }

    // ── Complexity indicator detection ──
    for (const rule of PATTERN_CATEGORIES.COMPLEXITY) {
      if (rule.pattern.test(text)) tags.push(rule.tag);
    }

    // ── File extension / language detection ──
    if (filePath) {
      const ext = path.extname(filePath).replace('.', '').toLowerCase();
      if (ext) {
        tags.push(`file:${ext}`);
        const lang = PATTERN_CATEGORIES.LANGUAGES[ext];
        if (lang) tags.push(`lang:${lang}`);
      }

      // Detect file-type patterns from path
      const baseName = path.basename(filePath).toLowerCase();
      if (/test|spec|__test__|\.test\.|\.spec\./i.test(baseName)) tags.push('test-file');
      if (/config|\.env|settings/i.test(baseName)) tags.push('config-file');
      if (/migration|seed/i.test(baseName)) tags.push('migration-file');
      if (/middleware/i.test(baseName)) tags.push('middleware-file');
      if (/route|controller|handler/i.test(baseName)) tags.push('api-file');
      if (/model|schema|entity/i.test(baseName)) tags.push('model-file');
      if (/util|helper|lib/i.test(baseName)) tags.push('utility-file');
    }

    return uniqueTags(tags);
  }

  /**
   * Detect the primary programming language from file path.
   */
  detectLanguage(filePath) {
    if (!filePath) return null;
    const ext = path.extname(filePath).replace('.', '').toLowerCase();
    return PATTERN_CATEGORIES.LANGUAGES[ext] || null;
  }

  /**
   * Extract complexity level from content (0-1 scale).
   */
  assessComplexity(content) {
    const text = String(content || '');
    let score = 0;
    let hits = 0;

    for (const rule of PATTERN_CATEGORIES.COMPLEXITY) {
      if (rule.pattern.test(text)) {
        score += 0.2;
        hits++;
      }
    }

    // Length-based complexity bonus
    if (text.length > 500) score += 0.1;
    if (text.length > 1000) score += 0.1;

    // Multi-concern complexity
    const architectureHits = PATTERN_CATEGORIES.ARCHITECTURE.filter((r) => r.pattern.test(text)).length;
    if (architectureHits >= 2) score += 0.15;

    return Math.min(1.0, score);
  }
}
