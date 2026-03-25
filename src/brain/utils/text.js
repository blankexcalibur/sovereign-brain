export function normalizeText(input = '') {
  return String(input).toLowerCase().replace(/[^a-z0-9_\-\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function tokenize(input = '') {
  const normalized = normalizeText(input);
  if (!normalized) return [];
  return normalized.split(' ').filter((t) => t.length > 1);
}

export function jaccardSimilarity(aText, bText) {
  const a = new Set(tokenize(aText));
  const b = new Set(tokenize(bText));
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * TF-IDF cosine similarity between two texts.
 * Builds term frequency vectors, applies inverse-document-frequency
 * weighting (treating each text as a "document"), and returns cosine
 * similarity in [0, 1].
 */
export function tfidfCosineSimilarity(aText, bText) {
  const aTokens = tokenize(aText);
  const bTokens = tokenize(bText);
  if (aTokens.length === 0 || bTokens.length === 0) return 0;

  const tfA = new Map();
  const tfB = new Map();
  for (const t of aTokens) tfA.set(t, (tfA.get(t) || 0) + 1);
  for (const t of bTokens) tfB.set(t, (tfB.get(t) || 0) + 1);

  // Collect all terms
  const allTerms = new Set([...tfA.keys(), ...tfB.keys()]);

  // Build TF vectors and compute cosine directly. 
  // We omit localized IDF because ln(2/2)=0 zeroed out intersection matches.
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const term of allTerms) {
    const wA = tfA.get(term) || 0;
    const wB = tfB.get(term) || 0;
    dot += wA * wB;
    magA += wA * wA;
    magB += wB * wB;
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export function summarizeContent(content, maxChars = 240) {
  const compact = String(content || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;

  const sentenceSplit = compact.split(/(?<=[.!?])\s+/);
  let summary = '';
  for (const sentence of sentenceSplit) {
    if ((summary + ' ' + sentence).trim().length > maxChars) break;
    summary = `${summary} ${sentence}`.trim();
  }

  if (!summary) {
    return `${compact.slice(0, maxChars - 3).trim()}...`;
  }

  return summary.endsWith('.') ? summary : `${summary}...`;
}

/**
 * Compress content by extracting key sentences. Keeps the first sentence,
 * then sentences containing keywords, up to maxChars length.
 */
export function compressContent(content, maxChars = 160) {
  const compact = String(content || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;

  const sentences = compact.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length <= 1) {
    return `${compact.slice(0, maxChars - 3).trim()}...`;
  }

  // Always include first sentence
  const result = [sentences[0]];
  let totalLen = sentences[0].length;

  // Score remaining sentences by keyword density
  const keywords = ['fix', 'bug', 'error', 'implement', 'refactor', 'important',
    'critical', 'solution', 'cause', 'because', 'pattern', 'learn', 'issue'];

  const scored = sentences.slice(1).map((s) => {
    const lower = s.toLowerCase();
    const hits = keywords.filter((k) => lower.includes(k)).length;
    return { sentence: s, score: hits };
  }).sort((a, b) => b.score - a.score);

  for (const { sentence } of scored) {
    if (totalLen + sentence.length + 1 > maxChars) break;
    result.push(sentence);
    totalLen += sentence.length + 1;
  }

  const joined = result.join(' ');
  return joined.endsWith('.') ? joined : `${joined}...`;
}

export function parseTags(tagString = '') {
  if (!tagString) return [];
  return String(tagString)
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

export function uniqueTags(tags = []) {
  return Array.from(new Set(tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean)));
}

/**
 * Estimate token count for a string (rough approximation).
 * ~4 chars per token is a common heuristic for English text.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

/**
 * ANSI color helpers for CLI output.
 */
export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgGreen: '\x1b[42m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
};

export function colorize(text, ...codes) {
  const prefix = codes.join('');
  return `${prefix}${text}${colors.reset}`;
}

export function dimText(text) {
  return colorize(text, colors.dim);
}

export function boldText(text) {
  return colorize(text, colors.bold);
}

export function padRight(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

export function padLeft(str, len) {
  const s = String(str);
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}

export function formatTable(headers, rows) {
  const colWidths = headers.map((h, i) => {
    const maxData = rows.reduce((max, row) => Math.max(max, String(row[i] || '').length), 0);
    return Math.max(String(h).length, maxData);
  });

  const sep = colWidths.map((w) => '─'.repeat(w + 2)).join('┼');
  const headerLine = headers.map((h, i) => ` ${colorize(padRight(h, colWidths[i]), colors.bold, colors.cyan)} `).join('│');
  const dataLines = rows.map((row) =>
    row.map((cell, i) => ` ${padRight(String(cell || ''), colWidths[i])} `).join('│')
  );

  return [
    `┌${colWidths.map((w) => '─'.repeat(w + 2)).join('┬')}┐`,
    `│${headerLine}│`,
    `├${sep}┤`,
    ...dataLines.map((line) => `│${line}│`),
    `└${colWidths.map((w) => '─'.repeat(w + 2)).join('┴')}┘`,
  ].join('\n');
}
