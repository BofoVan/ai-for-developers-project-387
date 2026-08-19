#!/usr/bin/env node
/**
 * Generate or update a GitHub Issue with Lighthouse report summary using gh CLI.
 * Compares current scores with previous run (extracted from the existing Issue body).
 */

const { execSync } = require('child_process');
const fs = require('fs');

const REPORT_PATH = './lighthouse-report.report.json';
const ISSUE_LABEL = 'lighthouse-report';
const ISSUE_TITLE_PREFIX = 'Lighthouse Report';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate() {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().slice(0, 5);
  return `${date} ${time} MSK`;
}

function scoreToEmoji(score) {
  if (score >= 90) return '🟢';
  if (score >= 50) return '🟡';
  return '🔴';
}

function deltaArrow(delta) {
  if (delta > 0) return `+${delta} ↑`;
  if (delta < 0) return `${delta} ↓`;
  return '0';
}

// Extract previous scores from an existing Issue body
function extractPreviousScores(body) {
  const scores = {};
  const lines = body.split('\n');
  for (const line of lines) {
    const match = line.match(/\|\s*(\w[\w\s-]*)\s*\|\s*(\d+)\s*[🔴🟡🟢]\s*\|\s*(?:\d+|—)\s*\|/);
    if (match) {
      const key = match[1].trim().toLowerCase().replace(/\s+/g, '-');
      scores[key] = parseInt(match[2], 10);
    }
  }
  return scores;
}

function getAudits(report) {
  const audits = report.audits || {};
  const results = [];

  const keyAudits = [
    { id: 'largest-contentful-paint', name: 'LCP', threshold: 2.5, unit: 's' },
    { id: 'total-blocking-time', name: 'TBT', threshold: 200, unit: 'ms' },
    { id: 'cumulative-layout-shift', name: 'CLS', threshold: 0.1, unit: '' },
    { id: 'first-contentful-paint', name: 'FCP', threshold: 1.8, unit: 's' },
    { id: 'speed-index', name: 'Speed Index', threshold: 3.4, unit: 's' },
    { id: 'interactive', name: 'TTI', threshold: 3.8, unit: 's' },
  ];

  for (const audit of keyAudits) {
    const data = audits[audit.id];
    if (!data) continue;
    const value = data.numericValue;
    if (value == null) continue;

    const displayValue = data.displayValue || `${value}${audit.unit}`;
    const failed = value > audit.threshold;

    results.push({
      name: audit.name,
      value: displayValue,
      rawValue: value,
      threshold: `${audit.threshold}${audit.unit}`,
      failed,
    });
  }

  return results.sort((a, b) => (b.failed ? 1 : 0) - (a.failed ? 1 : 0));
}

function buildIssueBody(report, previousScores, runUrl, artifactUrl) {
  const categories = report.categories || {};

  const scores = {
    performance: Math.round((categories.performance?.score || 0) * 100),
    accessibility: Math.round((categories.accessibility?.score || 0) * 100),
    'best-practices': Math.round((categories['best-practices']?.score || 0) * 100),
    seo: Math.round((categories.seo?.score || 0) * 100),
  };

  const rows = Object.entries(scores).map(([key, score]) => {
    const prev = previousScores[key];
    const delta = prev != null ? score - prev : null;
    const deltaStr = delta != null ? deltaArrow(delta) : '—';
    return `| ${key.charAt(0).toUpperCase() + key.slice(1)} | ${score} ${scoreToEmoji(score)} | ${prev != null ? prev : '—'} | ${deltaStr} |`;
  });

  let body = `## Lighthouse Report — ${formatDate()}\n\n`;
  body += `| Category | Score | Prev | Δ |\n`;
  body += `|----------|-------|------|---|\n`;
  body += rows.join('\n') + '\n\n';

  // Links
  body += `**Ссылки:**\n`;
  if (artifactUrl) {
    body += `- [HTML Report (artifact)](${artifactUrl})\n`;
  }
  if (runUrl) {
    body += `- [Workflow Run](${runUrl})\n`;
  }
  body += '\n';

  // Performance issues section
  if (scores.performance < 90) {
    body += `### 🔴 Performance < 90 — требуются правки\n\n`;
    const audits = getAudits(report);
    if (audits.length > 0) {
      body += `| Audit | Value | Threshold |\n`;
      body += `|-------|-------|-----------|\n`;
      for (const audit of audits) {
        const icon = audit.failed ? '🔴' : '🟢';
        body += `| ${icon} ${audit.name} | ${audit.value} | ${audit.threshold} |\n`;
      }
    } else {
      body += `> Детальные данные по аудитам недоступны. Смотрите полный отчёт в артефактах.\n`;
    }
    body += '\n';
  }

  return body;
}

// ─── gh CLI Helpers ─────────────────────────────────────────────────────────

function execGh(args) {
  try {
    return execSync(`gh ${args}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN },
    });
  } catch (err) {
    throw new Error(`gh command failed: ${err.stderr || err.message}`);
  }
}

function findExistingIssue() {
  try {
    const result = execGh(`issue list --label "${ISSUE_LABEL}" --state open --json number,body --jq '.[0]'`);
    if (!result.trim() || result.trim() === 'null') return null;
    return JSON.parse(result);
  } catch (err) {
    console.warn('Could not find existing Issue:', err.message);
    return null;
  }
}

function createIssue(title, body, labels) {
  const labelsArg = labels.map(l => `--label "${l}"`).join(' ');
  const result = execGh(`issue create --title "${title}" --body "${body}" ${labelsArg}`);
  console.log('Created Issue:', result.trim());
}

function updateIssue(number, body) {
  execGh(`issue edit ${number} --body "${body}"`);
  console.log(`Updated Issue #${number}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(REPORT_PATH)) {
    console.error(`Lighthouse report not found: ${REPORT_PATH}`);
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));

  // Build URLs
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  const runId = process.env.GITHUB_RUN_ID;
  const runUrl = runId ? `https://github.com/${owner}/${repo}/actions/runs/${runId}` : null;
  const artifactUrl = runId
    ? `https://github.com/${owner}/${repo}/actions/runs/${runId}/artifacts`
    : null;

  // Find existing Issue
  let previousScores = {};
  const existingIssue = findExistingIssue();
  if (existingIssue) {
    previousScores = extractPreviousScores(existingIssue.body || '');
    console.log('Found existing Issue #' + existingIssue.number);
    console.log('Previous scores:', previousScores);
  }

  const body = buildIssueBody(report, previousScores, runUrl, artifactUrl);

  if (existingIssue) {
    updateIssue(existingIssue.number, body);
  } else {
    createIssue(`${ISSUE_TITLE_PREFIX} — ${formatDate()}`, body, [ISSUE_LABEL]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
