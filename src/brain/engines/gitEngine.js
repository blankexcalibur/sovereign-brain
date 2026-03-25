import { execSync } from 'child_process';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';

/**
 * GitEngine — Automated Git History Ingestion
 * 
 * Connects to the native OS `git` binary to parse recent commit history
 * and automatically ingest commits as `episodic` dimension memories.
 */
export class GitEngine {
  constructor(service) {
    this.service = service;
  }

  /**
   * Ingest recent git commits as episodic memories.
   * @param {number} limit - Max number of commits to process
   * @param {string|null} project - Optional project name to tag memories
   * @returns {Object} { ingested, skipped, total }
   */
  async ingestRecentCommits(limit = 30, project = null) {
    let logOutput;

    try {
      logOutput = execSync(
        `git log -n ${limit} --pretty=format:"%H|||%an|||%ae|||%ai|||%s|||%b" --stat`,
        { encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }
      );
    } catch (err) {
      throw new Error(`Git not available or not a git repository: ${err.message}`);
    }

    const commits = this._parseGitLog(logOutput);
    let ingested = 0;
    let skipped = 0;

    for (const commit of commits) {
      const hash = crypto.createHash('md5').update(commit.sha).digest('hex');
      const tagKey = `git_${hash}`;

      // Check for duplicate ingestion using the commit hash tag
      const existing = this.service.repository.db.prepare(
        `SELECT id FROM memories WHERE tags LIKE ? LIMIT 1`
      ).get(`%${tagKey}%`);

      if (existing) {
        skipped++;
        continue;
      }

      const content = [
        `Commit: ${commit.sha.slice(0, 8)}`,
        `Author: ${commit.author} <${commit.email}>`,
        `Date: ${commit.date}`,
        ``,
        `${commit.subject}`,
        commit.body ? `\n${commit.body}` : '',
        commit.stats ? `\nFiles changed:\n${commit.stats}` : '',
      ].filter(Boolean).join('\n');

      const tags = [
        'git-commit',
        tagKey,
        ...(this._extractKeywords(commit.subject)),
      ];

      try {
        await this.service.addMemory({
          dimension: 'episodic',
          content,
          tags: tags.join(','),
          project: project,
          importance: this._estimateImportance(commit),
          metadata: { source: 'git-ingest', sha: commit.sha },
        });
        ingested++;
      } catch (err) {
        logger.warn(`Skipped commit ${commit.sha.slice(0, 8)}: ${err.message}`);
        skipped++;
      }
    }

    logger.info(`Git ingestion complete: ${ingested} ingested, ${skipped} skipped out of ${commits.length} commits.`);
    return { ingested, skipped, total: commits.length };
  }

  /**
   * Parse the raw git log output into structured commit objects.
   */
  _parseGitLog(raw) {
    const commits = [];
    const entries = raw.split(/(?=^[a-f0-9]{40}\|\|\|)/m);

    for (const entry of entries) {
      const lines = entry.trim();
      if (!lines) continue;

      const headerMatch = lines.match(/^([a-f0-9]{40})\|\|\|(.+?)\|\|\|(.+?)\|\|\|(.+?)\|\|\|(.+?)(?:\|\|\|(.*))?$/m);
      if (!headerMatch) continue;

      const [, sha, author, email, date, subject, body = ''] = headerMatch;

      // Extract file stats (everything after the header line)
      const headerEnd = lines.indexOf('\n');
      const stats = headerEnd >= 0 ? lines.slice(headerEnd + 1).trim() : '';

      commits.push({
        sha,
        author: author.trim(),
        email: email.trim(),
        date: date.trim(),
        subject: subject.trim(),
        body: body.trim(),
        stats: stats.slice(0, 500), // Cap stats size
      });
    }

    return commits;
  }

  /**
   * Extract simple keywords from a commit subject for tagging.
   */
  _extractKeywords(subject) {
    const keywords = [];
    const lower = subject.toLowerCase();

    if (lower.includes('fix') || lower.includes('bug')) keywords.push('bugfix');
    if (lower.includes('feat') || lower.includes('add')) keywords.push('feature');
    if (lower.includes('refactor')) keywords.push('refactor');
    if (lower.includes('test')) keywords.push('testing');
    if (lower.includes('docs') || lower.includes('readme')) keywords.push('documentation');
    if (lower.includes('perf') || lower.includes('optim')) keywords.push('performance');
    if (lower.includes('security') || lower.includes('auth')) keywords.push('security');
    if (lower.includes('breaking')) keywords.push('breaking-change');

    return keywords.slice(0, 4);
  }

  /**
   * Estimate the importance of a commit based on its content.
   */
  _estimateImportance(commit) {
    let importance = 0.4; // Base importance for git commits
    const lower = commit.subject.toLowerCase();

    if (lower.includes('breaking')) importance += 0.3;
    if (lower.includes('fix') || lower.includes('bug')) importance += 0.15;
    if (lower.includes('feat')) importance += 0.1;
    if (lower.includes('security') || lower.includes('auth')) importance += 0.2;
    if (commit.stats && commit.stats.split('\n').length > 10) importance += 0.1; // Big commits

    return Math.min(importance, 1.0);
  }
}
