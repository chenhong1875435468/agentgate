import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  binom,
  estimatePassAtK,
  strictPassPowK,
  meanAtK,
  computeMetrics,
  buildReport,
  validateResults,
  type TaskResult,
} from '../src/metrics/core.js';

const t = (taskId: string, attempts: boolean[], label?: string): TaskResult => ({
  taskId,
  attempts,
  ...(label !== undefined ? { label } : {}),
});

describe('binom', () => {
  test('computes standard coefficients', () => {
    assert.equal(binom(5, 2), 10);
    assert.equal(binom(10, 0), 1);
    assert.equal(binom(6, 6), 1);
  });

  test('returns 0 when k exceeds n', () => {
    assert.equal(binom(3, 5), 0);
  });
});

describe('estimatePassAtK', () => {
  test('is exact when k equals the sample count', () => {
    assert.equal(estimatePassAtK([true, false, false], 3), 1);
    assert.equal(estimatePassAtK([false, false, false], 3), 0);
  });

  test('returns 1 when every sample succeeded', () => {
    assert.equal(estimatePassAtK([true, true, true], 2), 1);
  });

  test('returns 0 when every sample failed', () => {
    assert.equal(estimatePassAtK([false, false], 1), 0);
  });

  test('stays below the naive success rate for lucky tasks', () => {
    const est = estimatePassAtK([true, false, false], 2);
    assert.ok(est < 1, 'unbiased estimate must not equal the naive any-success rate');
    assert.equal(est, 1 - binom(2, 2) / binom(3, 2));
  });

  test('is monotonically non-decreasing in k', () => {
    const attempts = [true, false, false, false, false];
    assert.ok(estimatePassAtK(attempts, 3) >= estimatePassAtK(attempts, 1));
  });
});

describe('strictPassPowK', () => {
  test('counts only tasks that succeeded every attempt', () => {
    const tasks = [
      t('a', [true, true, true]),
      t('b', [true, true, false]),
      t('c', [true, true, true]),
      t('d', [false, true, true]),
    ];
    assert.equal(strictPassPowK(tasks, 3), 0.5);
  });

  test('counts under-length tasks as failures rather than dropping them', () => {
    const tasks = [t('a', [true, true, true]), t('short', [true])];
    assert.equal(strictPassPowK(tasks, 3), 0.5);
  });

  test('returns 0 for an empty task set', () => {
    assert.equal(strictPassPowK([], 3), 0);
  });

  test('never exceeds Mean@k', () => {
    const tasks = [
      t('a', [true, false, true]),
      t('b', [true, true, false]),
      t('c', [false, false, true]),
      t('d', [true, true, true]),
    ];
    assert.ok(strictPassPowK(tasks, 3) <= meanAtK(tasks, 3));
  });
});

describe('meanAtK', () => {
  // MetricReport rounds to 6 decimals for stable CI diffs, so compare with a
  // tolerance slightly wider than that rounding step.
  const TOL = 1e-6;

  test('averages over all attempt pairs', () => {
    // task a: 2 of 3 succeeded. task b: 1 of 3 succeeded. total 3/6.
    const tasks = [t('a', [true, true, false]), t('b', [true, false, false])];
    assert.ok(Math.abs(meanAtK(tasks, 3) - 3 / 6) < TOL);
  });

  test('treats missing attempts as failures', () => {
    // task a: 3 of 3. task "short": 1 recorded + 2 missing counted as failures.
    const tasks = [t('a', [true, true, true]), t('short', [true])];
    assert.ok(Math.abs(meanAtK(tasks, 3) - 4 / 6) < TOL);
  });
});

describe('computeMetrics', () => {
  test('reproduces the reported IBM AppWorld shape', () => {
    // Synthetic set shaped like Mean@5 77.4% / pass^5 53.0%. The point is the
    // wide consistency gap, which is exactly what this tool exists to expose.
    const attempts: boolean[][] = [];
    for (let i = 0; i < 50; i++) attempts.push([true, true, true, true, true]);
    for (let i = 0; i < 20; i++) attempts.push([true, true, true, false, true]);
    const tasks = attempts.map((a, i) => t(`task-${i}`, a));

    const m = computeMetrics(tasks, 5);
    assert.ok(Math.abs(m.passPowK - 50 / 70) < 1e-4);
    assert.ok(m.meanAtK > m.passPowK);
    assert.ok(Math.abs(m.consistencyGap - (m.meanAtK - m.passPowK)) < 1e-6);
    assert.ok(Math.abs(m.normalizedConsistency - m.passPowK / m.meanAtK) < 1e-5);
  });

  test('maintains the invariant pass^k <= Mean@k <= pass@k', () => {
    const tasks = [
      t('a', [true, false, true, false, true]),
      t('b', [false, false, true, false, false]),
      t('c', [true, true, true, true, true]),
      t('d', [false, false, false, false, false]),
    ];
    const m = computeMetrics(tasks, 5);
    assert.ok(m.passPowK <= m.meanAtK);
    assert.ok(m.meanAtK <= m.passAtK + 1e-9);
  });

  test('reports near-perfect consistency for a task-level deterministic agent', () => {
    const tasks = [t('a', [true, true, true]), t('b', [false, false, false])];
    const m = computeMetrics(tasks, 3);
    assert.ok(Math.abs(m.consistencyGap - (m.meanAtK - m.passPowK)) < 1e-9);
    // Every task is internally deterministic, so all the mean mass comes from
    // stable tasks and normalized consistency is 1. The gap only opens when a
    // single task flips between attempts.
    assert.ok(Math.abs(m.normalizedConsistency - 1) < 1e-9);
  });

  test('never divides by zero when mean is zero', () => {
    const m = computeMetrics([t('a', [false, false])], 2);
    assert.equal(m.normalizedConsistency, 0);
  });

  test('produces a wide gap for a plausible flaky agent', () => {
    // Mirrors the layout of a customer-service bot: most tasks deterministic,
    // a minority flaky. This is the profile AgentGate is designed to catch.
    const tasks: TaskResult[] = [];
    for (let i = 0; i < 7; i++) tasks.push(t(`stable-${i}`, [true, true, true, true, true]));
    for (let i = 0; i < 3; i++)
      tasks.push(t(`flaky-${i}`, [true, false, true, true, false, ] as boolean[]));
    const m = computeMetrics(tasks, 5);
    assert.ok(m.passPowK >= 0.7, 'the 7 deterministic tasks alone give pass^5 >= 0.7');
    assert.ok(m.meanAtK > m.passPowK, 'flaky tasks must widen the gap');
  });
});

describe('buildReport', () => {
  test('flags lucky tasks that would look fine on a Mean@k dashboard', () => {
    const tasks = [
      t('solid', [true, true, true], 'easy'),
      t('lucky', [true, false, true], 'easy'),
      t('broken', [false, false, false], 'hard'),
    ];
    const report = buildReport(tasks, 3);
    assert.deepEqual(
      report.luckyTasks.map((l) => l.taskId),
      ['lucky'],
    );
    assert.deepEqual(report.neverSolved, ['broken']);
  });

  test('sorts stratified groups worst-consistency-first', () => {
    const tasks = [
      t('a1', [true, true, true], 'stable'),
      t('b1', [true, false, true], 'flaky'),
      t('b2', [true, true, false], 'flaky'),
    ];
    const report = buildReport(tasks, 3);
    assert.equal(report.stratified[0]?.label, 'flaky');
    assert.ok((report.stratified[0]?.metrics.consistencyGap ?? 0) > 0);
  });

  test('groups unlabeled tasks together', () => {
    const report = buildReport([t('a', [true, false])], 2);
    assert.equal(report.stratified.length, 1);
    assert.equal(report.stratified[0]?.label, 'unlabeled');
  });
});

describe('validateResults', () => {
  test('accepts a well-formed matrix', () => {
    assert.deepEqual(validateResults([t('a', [true, false])], 2), []);
  });

  test('reports under-length tasks and an empty suite', () => {
    const errors = validateResults([t('a', [true])], 2);
    assert.ok(errors.some((e) => e.includes('"a"')));
    assert.ok(validateResults([], 2).some((e) => e.includes('no tasks')));
  });
});