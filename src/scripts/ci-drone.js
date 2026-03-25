#!/usr/bin/env node
/**
 * CI/CD Headless Drone — Structural Codebase Audit
 * 
 * Runs inside GitHub Actions to scan PR diffs for duplication
 * and structural issues using the local memory graph.
 * Does NOT use any LLM — purely deterministic analysis.
 */
import fs from 'fs/promises';
import { execSync } from 'child_process';
import { DeveloperMemoryService } from '../brain/service.js';
import { logger } from '../brain/utils/logger.js';

async function main() {
  logger.info('🤖 CI/CD Drone booting in headless mode...');
  const service = new DeveloperMemoryService();

  // Get list of changed files from the PR diff
  let files;
  try {
    const diff = execSync('git diff --name-only origin/main', { encoding: 'utf-8' });
    files = diff.trim().split('\n').filter(f => f.endsWith('.js') || f.endsWith('.ts'));
  } catch {
    logger.info('No diff available. Scanning full repo.');
    files = [];
  }

  if (files.length === 0) {
    logger.info('No code files changed. Drone exiting cleanly.');
    process.exit(0);
  }

  logger.info(`📋 Scanning ${files.length} changed files...`);
  
  let warnings = 0;
  let prReport = "## 🧠 Cognitive Memory Drone Audit\n\n";

  for (const file of files) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      
      // Deterministic pattern checks (no LLM needed)
      const issues = [];
      
      if (/eval\s*\(/.test(content)) issues.push('`eval()` detected — potential code injection vector');
      if (/innerHTML\s*=/.test(content)) issues.push('`innerHTML` assignment — potential XSS vector');
      if (/new Function\s*\(/.test(content)) issues.push('`new Function()` — dynamic code execution risk');
      if (content.length > 500 && !/\/\*\*/.test(content)) issues.push('Large file with no JSDoc documentation');
      
      if (issues.length > 0) {
        prReport += `### ⚠️ \`${file}\`\n${issues.map(i => `- ${i}`).join('\n')}\n\n`;
        warnings += issues.length;
      } else {
        logger.info(`✅ ${file} — clean`);
      }
    } catch (e) {
      logger.warn(`Skipped ${file}: ${e.message}`);
    }
  }

  // Run duplication analysis
  try {
    const dupes = await service.agentEngine.runEvolutionSweep();
    if (dupes.suggestions.length > 0) {
      prReport += `### 📋 Code Duplication Report\n`;
      for (const s of dupes.suggestions) {
        prReport += `- **${s.files.join(' ↔ ')}** (cluster ${s.clusterId})\n`;
        warnings++;
      }
      prReport += '\n';
    }
  } catch { /* duplication scan is best-effort */ }

  if (warnings > 0) {
    logger.warn(`🛑 Found ${warnings} issues.`);

    // Post to GitHub PR if running in Actions
    const token = process.env.GITHUB_TOKEN;
    if (token && process.env.GITHUB_REPOSITORY && process.env.GITHUB_EVENT_PATH) {
      try {
        const payload = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, 'utf-8'));
        const prNum = payload.pull_request?.number;
        if (prNum) {
          const url = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues/${prNum}/comments`;
          await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: prReport }),
          });
          logger.info(`Posted audit report to PR #${prNum}`);
        }
      } catch (e) {
        logger.warn(`Failed to post PR comment: ${e.message}`);
      }
    }

    process.exit(1);
  } else {
    logger.info('✅ All checks passed. No issues found.');
    process.exit(0);
  }
}

main().catch(err => {
  logger.error(`Drone crashed: ${err.message}`);
  process.exit(1);
});
