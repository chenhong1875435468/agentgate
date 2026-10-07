import type {
  TaskDefinition,
  TaskRunner,
  Grader,
  ExecutionSettings,
  AttemptOutcome,
  SuiteResult,
} from '../types.js';

export interface ReplayOptions {
  settings: ExecutionSettings;
  runner: TaskRunner;
  grader: Grader;
  tasks: TaskDefinition[];
  /** Called after each attempt completes, for progress output. */
  onProgress?: (done: number, total: number, taskId: string, attempt: number) => void;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Reject configurations that would produce a meaningless pass^k.
 *
 * This is the single most important guardrail in the tool. At temperature 0 with
 * a fixed seed, a hosted inference endpoint still returns different results
 * across runs because of GPU floating-point non-associativity and dynamic
 * batching, but that variance is NOT representative of the distribution a real
 * user experiences. You would measure platform noise and call it reliability.
 */
export function validateExecutionSettings(settings: ExecutionSettings): void {
  const { k, temperature, concurrency, timeoutMs } = settings;

  if (!Number.isInteger(k) || k < 1) {
    throw new ConfigurationError(`k must be a positive integer, got ${k}`);
  }
  if (temperature <= 0) {
    throw new ConfigurationError(
      `temperature must be greater than 0 for pass^k to be meaningful, got ${temperature}.\n` +
        'At temperature 0 the variance you would measure is hosting-platform noise ' +
        '(GPU floating-point non-associativity, dynamic batching), not the ' +
        'distribution your users actually experience.',
    );
  }
  if (concurrency < 1) {
    throw new ConfigurationError(`concurrency must be at least 1, got ${concurrency}`);
  }
  if (timeoutMs < 1) {
    throw new ConfigurationError(`timeoutMs must be at least 1, got ${timeoutMs}`);
  }
}

/** Derive a distinct but reproducible seed per attempt. */
export function seedFor(baseSeed: number, taskIndex: number, attempt: number): number {
  // Mix indices so adjacent tasks do not produce correlated streams.
  return (baseSeed + taskIndex * 7919 + attempt * 104729) % 2_147_483_647;
}

async function runWithTimeout(
  runner: TaskRunner,
  task: TaskDefinition,
  attempt: number,
  settings: ExecutionSettings,
  taskIndex: number,
): Promise<AttemptOutcome> {
  const seeded = { ...settings, seed: seedFor(settings.seed, taskIndex, attempt) };

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`attempt timed out after ${settings.timeoutMs}ms`)),
      settings.timeoutMs,
    );
  });

  try {
    return await Promise.race([runner(task, attempt, seeded), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface PendingAttempt {
  task: TaskDefinition;
  taskIndex: number;
  attempt: number;
}

/**
 * Run every task k times with bounded concurrency.
 *
 * Concurrency only affects wall-clock time, never the result: each attempt is
 * independent and gets its own derived seed.
 */
export async function replay(options: ReplayOptions): Promise<SuiteResult> {
  const { settings, runner, grader, tasks, onProgress } = options;
  validateExecutionSettings(settings);

  const queue: PendingAttempt[] = [];
  for (const [taskIndex, task] of tasks.entries()) {
    for (let attempt = 0; attempt < settings.k; attempt++) {
      queue.push({ task, taskIndex, attempt });
    }
  }

  const total = queue.length;
  const results: Array<boolean[]> = tasks.map(() => new Array<boolean>(settings.k).fill(false));
  const costs: number[] = [];
  let completed = 0;
  const startedAt = Date.now();

  // Simple worker pool: N workers pull from the shared queue.
  let cursor = 0;
  const workerCount = Math.min(settings.concurrency, total);

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= total) return;
      const item = queue[index];
      if (!item) return;

      let outcome: AttemptOutcome;
      try {
        outcome = await runWithTimeout(runner, item.task, item.attempt, settings, item.taskIndex);
      } catch (error) {
        // A crashed attempt counts as a failure, never as a skip. Skipping would
        // inflate every metric and hide exactly the flakiness we are here to find.
        outcome = {
          output: null,
          passed: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      let passed = outcome.passed;
      if (passed) {
        try {
          passed = await grader(item.task, outcome);
        } catch (error) {
          passed = false;
          outcome = {
            ...outcome,
            error: `grader failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      results[item.taskIndex]![item.attempt] = passed;
      if (typeof outcome.costUsd === 'number') costs.push(outcome.costUsd);

      completed += 1;
      onProgress?.(completed, total, item.task.id, item.attempt);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    tasks: tasks.map((task, index) => {
      const row = results[index]!;
      return {
        id: task.id,
        attempts: row,
        ...(task.label !== undefined ? { label: task.label } : {}),
      };
    }),
    totalCostUsd: costs.reduce((sum, c) => sum + c, 0),
    wallClockMs: Date.now() - startedAt,
  };
}