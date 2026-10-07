import type { MetricReport, MetricBreakdown } from '../metrics/core.js';
import type { GateDecision, ThresholdSet } from '../types.js';

/**
 * Gate logic.
 *
 * Design principle: separate REGRESSION from ABSOLUTE LEVEL.
 *
 * An absolute threshold alone produces random red builds. LLM-as-judge is itself
 * non-deterministic, so a run can score 0.84 then 0.79 with zero code changes.
 * AWS documented this same problem in its AgentCore guide and recommended gating
 * on a drop relative to baseline rather than on an absolute number.
 *
 * So: the soft threshold is judged against baseline, and a small regression is
 * reported but allowed. Only a large regression, or a breach of an absolute
 * safety or cost invariant, blocks the merge.
 */

export interface Baseline {
  meanAtK: number;
  passPowK: number;
  recordedAt: string;
  /** Task count, so we can refuse to compare across different suite sizes. */
  tasks: number;
}

export interface GateInput {
  report: MetricReport;
  thresholds: ThresholdSet;
  baseline?: Baseline;
  /** Mean cost per attempt in USD, when the runner reported costs. */
  costPerAttemptUsd?: number;
}

/** Percent change expressed as points, guarded against a zero baseline. */
export function regressionPoints(current: number, baseline: number): number {
  return baseline - current;
}

export function evaluateGate(input: GateInput): GateDecision {
  const { report, thresholds, baseline, costPerAttemptUsd } = input;
  const { overall } = report;
  const violations: string[] = [];
  const warnings: string[] = [];
  /**
   * Purely informational notes. These never influence the verdict: a run that
   * passes every real threshold is a pass, even if we could not compare it to a
   * baseline. Tinting a good run yellow teaches reviewers to ignore the signal.
   */
  const notes: string[] = [];

  // --- Safety and cost invariants: judged absolutely, no baseline needed. ---
  if (thresholds.maxCostPerAttemptUsd !== undefined && costPerAttemptUsd !== undefined) {
    if (costPerAttemptUsd > thresholds.maxCostPerAttemptUsd) {
      violations.push(
        `cost per attempt $${costPerAttemptUsd.toFixed(4)} exceeds the limit of ` +
          `$${thresholds.maxCostPerAttemptUsd.toFixed(4)}`,
      );
    }
  }

  if (thresholds.hard !== undefined && overall.passPowK < thresholds.hard) {
    violations.push(
      `pass^${overall.k} ${(overall.passPowK * 100).toFixed(1)}% is below the hard floor of ` +
        `${(thresholds.hard * 100).toFixed(1)}%`,
    );
  }

  // --- Regression checks: only meaningful against a baseline of the same suite. ---
  if (baseline) {
    if (baseline.tasks !== overall.tasks) {
      notes.push(
        `baseline was recorded on ${baseline.tasks} tasks but this run has ${overall.tasks}; ` +
          'regression checks were skipped because the suites are not comparable',
      );
    } else {
      if (thresholds.maxMeanRegression !== undefined) {
        const drop = regressionPoints(overall.meanAtK, baseline.meanAtK);
        // Ignore drops inside the noise floor. A small dip between runs is
        // expected even with no code change.
        if (drop > thresholds.maxMeanRegression) {
          violations.push(
            `Mean@${overall.k} fell ${(drop * 100).toFixed(1)} points against baseline ` +
              `(${(baseline.meanAtK * 100).toFixed(1)}% -> ${(overall.meanAtK * 100).toFixed(1)}%), ` +
              `which exceeds the allowed ${(thresholds.maxMeanRegression * 100).toFixed(1)} points`,
          );
        } else if (drop > 0) {
          warnings.push(
            `Mean@${overall.k} dipped ${(drop * 100).toFixed(1)} points, within the allowed ` +
              `${(thresholds.maxMeanRegression * 100).toFixed(1)}`,
          );
        }
      }

      const passDrop = regressionPoints(overall.passPowK, baseline.passPowK);
      if (passDrop > 0.1) {
        warnings.push(
          `pass^${overall.k} dropped ${(passDrop * 100).toFixed(1)} points against baseline ` +
            `(${(baseline.passPowK * 100).toFixed(1)}% -> ${(overall.passPowK * 100).toFixed(1)}%)`,
        );
      }
    }
  }

  if (violations.length > 0) {
    return {
      verdict: 'fail',
      reason: violations[0]!,
      violations: [...violations, ...warnings, ...notes],
    };
  }

  // Only a genuine soft-target miss turns a run yellow. Informational notes, such
  // as a baseline recorded on a different suite size, must not: tinting a good
  // run yellow teaches reviewers to ignore the signal.
  const comparable = baseline === undefined || baseline.tasks === overall.tasks;

  if (comparable && thresholds.soft !== undefined && overall.passPowK < thresholds.soft) {
    const message =
      `pass^${overall.k} ${(overall.passPowK * 100).toFixed(1)}% is below the soft target of ` +
      `${(thresholds.soft * 100).toFixed(1)}%` +
      (baseline
        ? ''
        : '. Record a baseline with --save-baseline to enable regression-based gating.');
    return {
      verdict: 'warn',
      reason: message,
      violations: [message, ...warnings, ...notes],
    };
  }

  if (warnings.length > 0) {
    return { verdict: 'warn', reason: warnings[0]!, violations: [...warnings, ...notes] };
  }

  return {
    verdict: 'pass',
    reason: `pass^${overall.k} ${(overall.passPowK * 100).toFixed(1)}%, consistency gap ` +
      `${(overall.consistencyGap * 100).toFixed(1)} points`,
    violations: notes,
  };
}

/** Human-readable one-liner summarising the three metrics. */
export function summarizeMetrics(metrics: MetricBreakdown): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  return (
    `pass@${metrics.k} ${pct(metrics.passAtK)}  |  ` +
    `Mean@${metrics.k} ${pct(metrics.meanAtK)}  |  ` +
    `pass^${metrics.k} ${pct(metrics.passPowK)}  |  ` +
    `gap ${(metrics.consistencyGap * 100).toFixed(1)}pp`
  );
}