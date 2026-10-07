import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { replay, validateExecutionSettings, ConfigurationError, seedFor } from '../src/runner/replay.js';
import { evaluateGate, regressionPoints } from '../src/report/gate.js';
import { createBuiltinGrader } from '../src/adapters/graders.js';
import { buildReport } from '../src/metrics/core.js';
import type { TaskDefinition, TaskRunner, AttemptOutcome } from '../src/types.js';

const BASE_SETTINGS = {
  k: 3,
  temperature: 1,
  seed: 42,
  concurrency: 2,
  timeoutMs: 1000,
};

const task = (id: string, label?: string): TaskDefinition => ({
  id,
  input: `input-${id}`,
  expected: 'handled',
  ...(label !== undefined ? { label } : {}),
});

/** Runner whose pass/fail pattern is fully controlled by the caller. */
function fixedRunner(patterns: Record<string, boolean[]>): TaskRunner {
  return (t) => {
    const pattern = patterns[t.id] ?? [true];
    const passed = pattern[0] ?? false;
    return Promise.resolve({
      output: passed ? { answer: 'handled: x' } : { answer: 'nope' },
      passed: true,
      costUsd: 0.001,
    });
  };
}

describe('validateExecutionSettings', () => {
  test('accepts a sane configuration', () => {
    assert.doesNotThrow(() => validateExecutionSettings(BASE_SETTINGS));
  });

  test('rejects temperature 0 with an explanation', () => {
    // This guardrail is the single most important one in the tool.
    assert.throws(
      () => validateExecutionSettings({ ...BASE_SETTINGS, temperature: 0 }),
      (error: Error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /temperature must be greater than 0/);
        assert.match(error.message, /floating-point/);
        return true;
      },
    );
  });

  test('rejects invalid k, concurrency and timeout', () => {
    assert.throws(() => validateExecutionSettings({ ...BASE_SETTINGS, k: 0 }), ConfigurationError);
    assert.throws(() => validateExecutionSettings({ ...BASE_SETTINGS, concurrency: 0 }), ConfigurationError);
    assert.throws(() => validateExecutionSettings({ ...BASE_SETTINGS, timeoutMs: 0 }), ConfigurationError);
  });
});

describe('seedFor', () => {
  test('produces distinct seeds per task and attempt', () => {
    const seeds = new Set<number>();
    for (let ti = 0; ti < 5; ti++) {
      for (let a = 0; a < 5; a++) seeds.add(seedFor(42, ti, a));
    }
    assert.equal(seeds.size, 25);
  });

  test('is deterministic', () => {
    assert.equal(seedFor(42, 3, 2), seedFor(42, 3, 2));
  });
});

describe('replay', () => {
  test('runs each task exactly k times', async () => {
    const seen: Array<{ id: string; attempt: number }> = [];
    const runner: TaskRunner = (t, attempt) => {
      seen.push({ id: t.id, attempt });
      return Promise.resolve({ output: 'handled', passed: true });
    };

    const result = await replay({
      settings: BASE_SETTINGS,
      runner,
      grader: createBuiltinGrader('exact_match'),
      tasks: [task('a'), task('b')],
    });

    assert.equal(result.tasks.length, 2);
    for (const row of result.tasks) assert.equal(row.attempts.length, BASE_SETTINGS.k);
    assert.equal(seen.length, 6);
  });

  test('counts a crashed attempt as a failure, never a skip', async () => {
    const runner: TaskRunner = (t) => {
      if (t.id === 'boom') return Promise.reject(new Error('upstream 503'));
      return Promise.resolve({ output: 'handled', passed: true });
    };

    const result = await replay({
      settings: BASE_SETTINGS,
      runner,
      grader: createBuiltinGrader('exact_match'),
      tasks: [task('boom'), task('ok')],
    });

    assert.deepEqual(result.tasks.find((r) => r.id === 'boom')?.attempts, [false, false, false]);
    assert.deepEqual(result.tasks.find((r) => r.id === 'ok')?.attempts, [true, true, true]);
  });

  test('surfaces grader errors as failures rather than crashing', async () => {
    const runner: TaskRunner = () => Promise.resolve({ output: 'x', passed: true });
    const result = await replay({
      settings: BASE_SETTINGS,
      runner,
      // exact_match against a missing expectation throws on contains, not here;
      // use a grader that throws to prove the containment.
      grader: () => {
        throw new Error('grader blew up');
      },
      tasks: [task('a')],
    });
    assert.deepEqual(result.tasks[0]?.attempts, [false, false, false]);
  });

  test('accumulates cost across attempts', async () => {
    const runner: TaskRunner = () =>
      Promise.resolve({ output: 'handled', passed: true, costUsd: 0.01 });
    const result = await replay({
      settings: BASE_SETTINGS,
      runner,
      grader: createBuiltinGrader('exact_match'),
      tasks: [task('a')],
    });
    assert.ok(Math.abs(result.totalCostUsd - 0.03) < 1e-9);
  });

  test('respects concurrency and reports progress', async () => {
    let completed = 0;
    const result = await replay({
      settings: { ...BASE_SETTINGS, k: 2, concurrency: 4 },
      runner: () =>
        Promise.resolve({
          output: 'handled',
          passed: true,
        }),
      grader: createBuiltinGrader('exact_match'),
      tasks: [task('a'), task('b'), task('c')],
      onProgress: () => {
        completed += 1;
      },
    });
    assert.equal(completed, 6);
    assert.equal(result.tasks.length, 3);
  });

  test('gives each attempt a distinct seed', async () => {
    const seeds: number[] = [];
    const runner: TaskRunner = (_t, _attempt, settings) => {
      seeds.push(settings.seed);
      return Promise.resolve({ output: 'handled', passed: true });
    };
    await replay({
      settings: BASE_SETTINGS,
      runner,
      grader: createBuiltinGrader('exact_match'),
      tasks: [task('a')],
    });
    assert.equal(new Set(seeds).size, BASE_SETTINGS.k);
  });
});

describe('graders', () => {
  test('exact_match trims before comparing', () => {
    const g = createBuiltinGrader('exact_match');
    assert.ok(g(task('a'), { output: '  handled  ', passed: true }));
    assert.ok(!g(task('a'), { output: 'handled extra', passed: true }));
  });

  test('contains rejects an empty needle instead of passing everything', () => {
    const g = createBuiltinGrader('contains');
    assert.ok(g(task('a'), { output: 'well handled now', passed: true }));
    // An empty needle would trivially pass every output, which is a config bug
    // rather than a valid expectation.
    const emptyExpectation = { ...task('a'), expected: '' };
    assert.throws(() => g(emptyExpectation, { output: 'anything', passed: true }));
  });

  test('regex matches the output', () => {
    const g = createBuiltinGrader('regex');
    const t = { ...task('a'), expected: '^ORDER-\\d+$' };
    assert.ok(g(t, { output: 'ORDER-42', passed: true }));
    assert.ok(!g(t, { output: 'order-42', passed: true }));
  });

  test('json_schema checks nested fields only', () => {
    const g = createBuiltinGrader('json_schema');
    const t = {
      ...task('a'),
      expected: { tool: 'lookup', args: { id: 7 } },
    };
    assert.ok(g(t, { output: JSON.stringify({ tool: 'lookup', args: { id: 7 }, extra: 1 }), passed: true }));
    assert.ok(!g(t, { output: JSON.stringify({ tool: 'other', args: { id: 7 } }), passed: true }));
    assert.ok(!g(t, { output: 'not json', passed: true }));
  });

  test('an agent-side pass=false short-circuits before the grader', async () => {
    // When the runner reports failure the grader is never consulted, which keeps
    // cost down and avoids confusing grader errors with agent errors.
    let graderCalled = false;
    const result = await replay({
      settings: BASE_SETTINGS,
      runner: () => Promise.resolve({ output: 'x', passed: false, error: 'model refused' }),
      grader: () => {
        graderCalled = true;
        return true;
      },
      tasks: [task('a')],
    });
    assert.equal(graderCalled, false);
    assert.deepEqual(result.tasks[0]?.attempts, [false, false, false]);
  });
});

describe('evaluateGate', () => {
  const report = buildReport(
    [
      { taskId: 'a', attempts: [true, true, true] },
      { taskId: 'b', attempts: [true, true, true] },
      { taskId: 'c', attempts: [true, false, true] },
      { taskId: 'd', attempts: [false, false, false] },
    ],
    3,
  );

  test('passes when above the hard floor', () => {
    const decision = evaluateGate({ report, thresholds: { hard: 0.4 } });
    assert.equal(decision.verdict, 'pass');
  });

  test('fails below the hard floor and reports the number', () => {
    const decision = evaluateGate({ report, thresholds: { hard: 0.9 } });
    assert.equal(decision.verdict, 'fail');
    assert.match(decision.reason, /hard floor/);
  });

  test('blocks a large Mean@k regression', () => {
    const baseline = { meanAtK: 0.95, passPowK: 0.9, recordedAt: 'x', tasks: 4 };
    const decision = evaluateGate({
      report,
      thresholds: { maxMeanRegression: 0.05 },
      baseline,
    });
    assert.equal(decision.verdict, 'fail');
    assert.match(decision.reason, /Mean@3 fell/);
  });

  test('tolerates a small regression inside the noise floor', () => {
    const currentMean = report.overall.meanAtK;
    const baseline = {
      meanAtK: currentMean + 0.01, // only one point worse
      passPowK: report.overall.passPowK,
      recordedAt: 'x',
      tasks: 4,
    };
    const decision = evaluateGate({ report, thresholds: { maxMeanRegression: 0.05 }, baseline });
    assert.equal(decision.verdict, 'warn');
    assert.match(decision.reason, /within the allowed/);
  });

  test('does not block when the baseline suite size differs', () => {
    const baseline = { meanAtK: 0.95, passPowK: 0.9, recordedAt: 'x', tasks: 99 };
    const decision = evaluateGate({
      report,
      thresholds: { maxMeanRegression: 0.01 },
      baseline,
    });
    // A non-comparable baseline is informational, not a regression. The run must
    // not be tinted yellow, or reviewers learn to ignore the signal.
    assert.equal(decision.verdict, 'pass');
    assert.ok(decision.violations.some((v) => v.includes('not comparable')));
  });

  test('blocks on a cost breach without needing a baseline', () => {
    const decision = evaluateGate({
      report,
      thresholds: { maxCostPerAttemptUsd: 0.01 },
      costPerAttemptUsd: 0.5,
    });
    assert.equal(decision.verdict, 'fail');
    assert.match(decision.reason, /cost per attempt/);
  });

  test('warns when the soft target is missed and no baseline exists', () => {
    const decision = evaluateGate({ report, thresholds: { soft: 0.95 } });
    assert.equal(decision.verdict, 'warn');
    assert.match(decision.reason, /soft target/);
  });

  test('regressionPoints treats a missing baseline as zero drop', () => {
    assert.equal(regressionPoints(0.8, 0.8), 0);
    assert.ok(Math.abs(regressionPoints(0.7, 0.8) - 0.1) < 1e-9);
  });
});

describe('report integration', () => {
  test('a flaky agent passes a lenient gate but is caught by the baseline', async () => {
    // This is the scenario the whole tool exists for: an agent that looks fine on
    // an absolute Mean@k view but is caught once a baseline is available.
    const passPattern: Record<string, boolean> = {
      stable1: true,
      stable2: true,
      flaky1: true,
      flaky2: true,
    };
    void passPattern;

    // flaky1 succeeds twice out of three, flaky2 once out of three, so only the
    // two deterministic tasks pass every attempt.
    const gatedRunner: TaskRunner = (t, attempt) => {
      if (t.id === 'flaky1') return Promise.resolve({ output: attempt < 2 ? 'handled' : 'no', passed: true });
      if (t.id === 'flaky2') return Promise.resolve({ output: attempt === 0 ? 'handled' : 'no', passed: true });
      return Promise.resolve({ output: 'handled', passed: true });
    };

    const grader = (t: TaskDefinition, o: AttemptOutcome) => JSON.stringify(o.output).includes('handled');

    const result = await replay({
      settings: BASE_SETTINGS,
      runner: gatedRunner,
      grader,
      tasks: [task('stable1'), task('stable2'), task('flaky1'), task('flaky2')],
    });

    const report = buildReport(
      result.tasks.map((t) => ({ taskId: t.id, attempts: t.attempts })),
      BASE_SETTINGS.k,
    );

    // 6 of 9 attempts succeed: the average looks respectable.
    assert.ok(report.overall.meanAtK > 0.6, 'Mean@k looks acceptable');
    // Only the two deterministic tasks pass every time.
    assert.ok(Math.abs(report.overall.passPowK - 0.5) < 1e-6, 'pass^k exposes that half the suite is flaky');
    assert.equal(report.luckyTasks.length, 2);

    // Thresholding at the Mean@k level fails here. That is the trap this tool
    // exists to make visible: the same floor that would wave aMean@k review
    // through is applied to a metric that reflects what users experience.
    const meanFloor = evaluateGate({ report, thresholds: { hard: report.overall.meanAtK } });
    assert.equal(meanFloor.verdict, 'fail');
    assert.match(meanFloor.reason, /pass\^3/);

    // Gating on pass^k at a realistic level blocks it outright.
    const strict = evaluateGate({ report, thresholds: { hard: 0.8 } });
    assert.equal(strict.verdict, 'fail');

    // And once the baseline is set, the drop is reported as a regression.
    const againstBaseline = evaluateGate({
      report,
      thresholds: { maxMeanRegression: 0.05 },
      baseline: { meanAtK: 0.95, passPowK: 0.9, recordedAt: '', tasks: 4 },
    });
    assert.equal(againstBaseline.verdict, 'fail');
    assert.match(againstBaseline.reason, /Mean@3 fell/);
  });
});