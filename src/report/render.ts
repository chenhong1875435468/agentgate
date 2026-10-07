import type { MetricReport } from '../metrics/core.js';
import type { GateDecision, Verdict } from '../types.js';
import type { Baseline } from './gate.js';
import { summarizeMetrics } from './gate.js';

const SYMBOLS: Record<Verdict, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };

function bar(fraction: number, width = 20): string {
  const filled = Math.round(fraction * width);
  return `${'#'.repeat(filled)}${'.'.repeat(Math.max(0, width - filled))}`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Plain-text report written to stdout. */
export function renderConsoleReport(
  report: MetricReport,
  decision: GateDecision,
  context: { costPerAttemptUsd?: number; baseline?: Baseline; wallClockMs?: number } = {},
): string {
  const { overall } = report;
  const lines: string[] = [];

  lines.push('');
  lines.push(`AgentGate${SYMBOLS[decision.verdict] === 'PASS' ? '' : ` ${SYMBOLS[decision.verdict]}`}`);
  lines.push('='.repeat(64));
  lines.push('');

  lines.push(`  k = ${overall.k}   tasks = ${overall.tasks}`);
  lines.push('');
  lines.push(`  pass@${overall.k}   ${pct(overall.passAtK).padStart(7)}   optimistic, solvable at all`);
  lines.push(`  Mean@${overall.k}   ${pct(overall.meanAtK).padStart(7)}   average, what leaderboards report`);
  lines.push(`  pass^${overall.k}   ${pct(overall.passPowK).padStart(7)}   pessimistic, what users experience`);
  lines.push('');
  lines.push(`  consistency gap  ${(overall.consistencyGap * 100).toFixed(1)}pp`);
  lines.push(`  ${bar(overall.passPowK)} ${pct(overall.passPowK)} reliable across all ${overall.k} attempts`);
  lines.push(`  normalised       ${pct(overall.normalizedConsistency)} of the average is real, not luck`);
  lines.push('');

  if (report.stratified.length > 1) {
    lines.push('  Breakdown by group (worst consistency first)');
    lines.push('  ' + '-'.repeat(60));
    for (const group of report.stratified) {
      const g = group.metrics;
      lines.push(
        `  ${group.label.padEnd(22)} pass^${g.k} ${pct(g.passPowK).padStart(7)}   ` +
          `Mean@${g.k} ${pct(g.meanAtK).padStart(7)}   gap ${(g.consistencyGap * 100).toFixed(1).padStart(5)}pp`,
      );
    }
    lines.push('');
  }

  if (report.luckyTasks.length > 0) {
    lines.push(`  Unreliable but not broken (${report.luckyTasks.length})`);
    lines.push('  ' + '-'.repeat(60));
    lines.push('  These pass a Mean@k review but flip between attempts.');
    lines.push('');
    for (const task of report.luckyTasks.slice(0, 10)) {
      const marks = task.attempts.map((a) => (a ? '+' : '-')).join(' ');
      const name = task.label ? `${task.taskId} [${task.label}]` : task.taskId;
      lines.push(`    ${marks}   ${pct(task.meanAtK).padStart(6)}   ${name}`);
    }
    if (report.luckyTasks.length > 10) {
      lines.push(`    ... and ${report.luckyTasks.length - 10} more`);
    }
    lines.push('');
  }

  if (report.neverSolved.length > 0) {
    lines.push(`  Never solved (${report.neverSolved.length})`);
    lines.push('  ' + '-'.repeat(60));
    const preview = report.neverSolved.slice(0, 8).join(', ');
    lines.push(`    ${preview}${report.neverSolved.length > 8 ? ', ...' : ''}`);
    lines.push('    Either genuinely broken, or the expectation is unrealistic.');
    lines.push('');
  }

  if (context.baseline) {
    lines.push('  Against baseline');
    lines.push('  ' + '-'.repeat(60));
    const delta = (current: number, base: number) => {
      const diff = (current - base) * 100;
      const sign = diff >= 0 ? '+' : '';
      return `${sign}${diff.toFixed(1)}pp`;
    };
    lines.push(
      `    pass^${overall.k}   ${pct(context.baseline.passPowK)} -> ${pct(overall.passPowK)}   ` +
        `${delta(overall.passPowK, context.baseline.passPowK)}`,
    );
    lines.push(
      `    Mean@${overall.k}   ${pct(context.baseline.meanAtK)} -> ${pct(overall.meanAtK)}   ` +
        `${delta(overall.meanAtK, context.baseline.meanAtK)}`,
    );
    lines.push('');
  }

  if (context.costPerAttemptUsd !== undefined) {
    lines.push(`  Cost   $${context.costPerAttemptUsd.toFixed(4)} per attempt`);
  }
  if (context.wallClockMs !== undefined) {
    lines.push(`  Time   ${(context.wallClockMs / 1000).toFixed(1)}s`);
  }
  if (context.costPerAttemptUsd !== undefined || context.wallClockMs !== undefined) lines.push('');

  lines.push(`  ${SYMBOLS[decision.verdict]}  ${decision.reason}`);
  if (decision.violations.length > 1) {
    lines.push('');
    for (const violation of decision.violations.slice(1)) {
      lines.push(`      - ${violation}`);
    }
  }
  lines.push('');
  lines.push('  ' + summarizeMetrics(overall));
  lines.push('');

  return lines.join('\n');
}

/** Machine-readable payload for CI artifacts. */
export function renderJsonReport(
  report: MetricReport,
  decision: GateDecision,
  context: { costPerAttemptUsd?: number; baseline?: Baseline; wallClockMs?: number } = {},
): string {
  return JSON.stringify(
    {
      tool: 'agentgate',
      schemaVersion: 1,
      verdict: decision.verdict,
      reason: decision.reason,
      violations: decision.violations,
      metrics: report.overall,
      stratified: report.stratified,
      luckyTasks: report.luckyTasks,
      neverSolved: report.neverSolved,
      ...context,
    },
    null,
    2,
  );
}

function escapeAnnotation(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * GitHub Actions workflow commands.
 *
 * Annotations surface directly on the PR diff view, which is where a reviewer
 * will actually look. Emitting both ::error and ::warning means a failed gate is
 * visible without opening the raw log.
 */
export function renderGitHubAnnotations(
  report: MetricReport,
  decision: GateDecision,
): string {
  const { overall } = report;
  const lines: string[] = [];

  const level = decision.verdict === 'fail' ? 'error' : decision.verdict === 'warn' ? 'warning' : 'notice';
  lines.push(`::${level} title=AgentGate gate::${escapeAnnotation(decision.reason)}`);

  for (const violation of decision.violations) {
    lines.push(`::${level} title=AgentGate finding::${escapeAnnotation(violation)}`);
  }

  const summary =
    `AgentGate: pass^${overall.k} ${pct(overall.passPowK)}, ` +
    `Mean@${overall.k} ${pct(overall.meanAtK)}, ` +
    `gap ${(overall.consistencyGap * 100).toFixed(1)}pp`;
  lines.push(`::notice title=AgentGate metrics::${escapeAnnotation(summary)}`);

  return lines.join('\n');
}

/** Advice shown when a gate fails, tailored to what actually went wrong. */
export function renderRemediation(report: MetricReport, decision: GateDecision): string {
  const { overall } = report;
  const lines: string[] = ['', 'What to look at next:', ''];

  if (overall.passPowK < overall.meanAtK * 0.8 && report.luckyTasks.length > 0) {
    lines.push('  The dominant problem is flakiness, not capability.');
    lines.push('  Focus on the tasks listed above: they succeed sometimes and fail others');
    lines.push('  times. Check whether a decision point has near-tied options, which is where');
    lines.push('  small platform differences flip the outcome.');
    lines.push('');
  }

  if (overall.normalizedConsistency >= 0.95) {
    lines.push('  Normalized consistency is high, so the pass^k score is close to the Mean@k');
    lines.push('  score. This looks like a capability ceiling rather than instability: the');
    lines.push('  agent reliably fails the same tasks.');
    lines.push('  Focus on those tasks specifically rather than on sampling temperature.');
    lines.push('');
  }

  if (overall.passAtK - overall.passPowK > 0.2) {
    lines.push('  Peak capability (pass@k) far exceeds reliability (pass^k). The agent can');
    lines.push('  solve these tasks, but not repeatably. That points at process-level');
    lines.push('  nondeterminism: sampling, ambiguous tool arguments, or missing fallback');
    lines.push('  handling, rather than at what the model knows.');
    lines.push('');
  }

  const worst = report.stratified[0];
  if (report.stratified.length > 1 && worst && worst.metrics.consistencyGap > 0.05) {
    lines.push(`  Group "${worst.label}" has the widest gap at ${(worst.metrics.consistencyGap * 100).toFixed(1)}pp.`);
    lines.push('  Overall numbers hide per-group behaviour, so treating that group separately');
    lines.push('  is usually more productive than tuning globally.');
    lines.push('');
  }

  if (lines.length === 3) {
    lines.push('  No structural pattern detected. Read the failing attempts directly.');
    lines.push('');
  }

  return lines.join('\n');
}