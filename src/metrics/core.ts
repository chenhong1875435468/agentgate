/**
 * Core reliability metrics for AI agents.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Benchmarks and most eval tools report Mean@k: the average success rate over
 * k attempts. That number flatters non-deterministic systems. A task that
 * succeeds 3 times out of 5 contributes 60% to the mean, hiding the fact that
 * a real user asking the same question twice has a coin-flip chance of a
 * different answer.
 *
 * Three metrics must be read together:
 *
 *   pass@k   OPTIMISTIC  at least one of k attempts succeeded.
 *                       Answers "is this task solvable at all?"
 *   Mean@k   AVERAGE    success rate across all attempts.
 *                       This is what leaderboards report.
 *   pass^k   PESSIMISTIC all k attempts succeeded.
 *                       Answers "can a user rely on this?"
 *
 * Production systems experience pass^k, not pass@k. Always true:
 *
 *   pass^k <= Mean@k <= pass@k
 *
 * The gap between Mean@k and pass^k is the CONSISTENCY GAP. It measures how
 * much of a system's apparent reliability is luck.
 *
 * Reference: IBM Research / Hugging Face, "Your Agent Aced the Task. Will It
 * Do It Again?" (2026-09). On AppWorld test_normal with GPT-4.1 ReAct:
 * Mean@5 = 77.4%, pass^5 = 53.0%, consistency gap = 24.4pp.
 */

export type Attempt = boolean;

export interface TaskResult {
  /** Stable task identifier. */
  taskId: string;
  /** One boolean per attempt, in order. Length must equal the k used at runtime. */
  attempts: Attempt[];
  /** Optional grouping used for per-difficulty / per-category breakdowns. */
  label?: string;
}

export interface MetricBreakdown {
  /** Fraction of tasks where every attempt succeeded. */
  passPowK: number;
  /** Fraction of all (task, attempt) pairs that succeeded. */
  meanAtK: number;
  /** Unbiased estimator of pass@k: at least one of k attempts succeeded. */
  passAtK: number;
  /** meanAtK - passPowK. Higher means more of the score is luck. */
  consistencyGap: number;
  /** passPowK / meanAtK. Guards against a large gap caused by low capability. */
  normalizedConsistency: number;
  /** Number of tasks aggregated. */
  tasks: number;
  /** The k used to produce these numbers. Always report this alongside them. */
  k: number;
}

export interface StratifiedBreakdown {
  label: string;
  metrics: MetricBreakdown;
}

export interface MetricReport {
  overall: MetricBreakdown;
  /** Per-label rollups, sorted by consistency gap descending (worst first). */
  stratified: StratifiedBreakdown[];
  /** Tasks that passed Mean@k but failed pass^k. The ones worth investigating. */
  luckyTasks: LuckyTask[];
  /** Tasks that failed every attempt. Either broken or unreasonably hard. */
  neverSolved: string[];
}

export interface LuckyTask {
  taskId: string;
  label?: string;
  meanAtK: number;
  attempts: Attempt[];
  /**
   * True when the agent solved the task at least once. These are the tasks that
   * look fine on a Mean@k dashboard but are unreliable in production.
   */
  partlySolved: boolean;
}

/** Binomial coefficient C(n, k). Returns 0 when k > n. */
export function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

/**
 * Unbiased estimator of pass@k (the HumanEval estimator).
 *
 * Given m >= k attempts per task with c successes, estimates the probability
 * that at least one of k sampled attempts is correct:
 *
 *   pass@k_hat = E_task [ 1 - C(m - c, k) / C(m, k) ]
 *
 * Using the raw mean of "did any attempt succeed" would over-count tasks where
 * many attempts happened to succeed. This estimator handles that.
 */
export function estimatePassAtK(taskAttempts: Attempt[], k: number): number {
  const m = taskAttempts.length;
  if (m === 0) return 0;
  if (k >= m) return taskAttempts.some(Boolean) ? 1 : 0;

  const successes = taskAttempts.filter(Boolean).length;
  // If the task never succeeded, or succeeded on all samples, the estimate is exact.
  if (successes === 0 || successes === m) return successes === 0 ? 0 : 1;

  return 1 - binom(m - successes, k) / binom(m, k);
}

/**
 * Strict pass^k: fraction of tasks where ALL k attempts succeeded.
 *
 * Requires at least k attempts per task. Tasks with fewer attempts are counted as
 * failures rather than silently dropped, because dropping them would inflate the
 * result and hide exactly the inconsistency this tool exists to measure.
 */
export function strictPassPowK(tasks: TaskResult[], k: number): number {
  if (tasks.length === 0) return 0;
  const fullySolved = tasks.filter(
    (t) => t.attempts.length >= k && t.attempts.slice(0, k).every((a) => a === true),
  ).length;
  return fullySolved / tasks.length;
}

/** Mean success rate across all (task, attempt) pairs. */
export function meanAtK(tasks: TaskResult[], k: number): number {
  if (tasks.length === 0) return 0;
  let successes = 0;
  let total = 0;
  for (const task of tasks) {
    const attempts = task.attempts.slice(0, k);
    if (attempts.length < k) {
      // Count missing attempts as failures, consistent with strictPassPowK.
      total += k;
      successes += attempts.filter(Boolean).length;
      continue;
    }
    total += attempts.length;
    successes += attempts.filter(Boolean).length;
  }
  return total === 0 ? 0 : successes / total;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Compute all three metrics plus derived values for a set of tasks. */
export function computeMetrics(tasks: TaskResult[], k: number): MetricBreakdown {
  const passPowK = strictPassPowK(tasks, k);
  const mean = meanAtK(tasks, k);

  const passAtK =
    tasks.length === 0 ? 0 : tasks.reduce((sum, t) => sum + estimatePassAtK(t.attempts, k), 0) / tasks.length;

  const gap = mean - passPowK;

  return {
    passPowK: round(passPowK),
    meanAtK: round(mean),
    passAtK: round(passAtK),
    consistencyGap: round(gap),
    // Guard against division by zero: a system with 0 mean has no consistency to measure.
    normalizedConsistency: mean === 0 ? 0 : round(passPowK / mean),
    tasks: tasks.length,
    k,
  };
}

/**
 * Validate a raw attempt matrix before metrics are computed.
 * Returns a list of human-readable problems; empty means valid.
 */
export function validateResults(tasks: TaskResult[], k: number): string[] {
  const errors: string[] = [];
  if (k < 1) errors.push(`k must be at least 1, got ${k}`);
  if (tasks.length === 0) errors.push('no tasks were provided');

  for (const task of tasks) {
    if (task.attempts.length < k) {
      errors.push(
        `task "${task.taskId}" has ${task.attempts.length} attempts but k=${k}; ` +
          'it will be counted as a failure',
      );
    }
  }
  return errors;
}

/** Build the full report, including stratified rollups and task-level flags. */
export function buildReport(tasks: TaskResult[], k: number): MetricReport {
  const overall = computeMetrics(tasks, k);

  const byLabel = new Map<string, TaskResult[]>();
  for (const task of tasks) {
    const key = task.label ?? 'unlabeled';
    const bucket = byLabel.get(key);
    if (bucket) bucket.push(task);
    else byLabel.set(key, [task]);
  }

  const stratified: StratifiedBreakdown[] = [...byLabel.entries()]
    .map(([label, group]) => ({ label, metrics: computeMetrics(group, k) }))
    .sort((a, b) => b.metrics.consistencyGap - a.metrics.consistencyGap);

  const luckyTasks: LuckyTask[] = tasks
    .filter((t) => {
      const solvedAtLeastOnce = t.attempts.some(Boolean);
      const solvedEveryTime = t.attempts.slice(0, k).length >= k && t.attempts.slice(0, k).every(Boolean);
      return solvedAtLeastOnce && !solvedEveryTime;
    })
    .map((t) => ({
      taskId: t.taskId,
      ...(t.label !== undefined ? { label: t.label } : {}),
      meanAtK: round(meanAtK([t], k)),
      attempts: t.attempts.slice(0, k),
      partlySolved: true,
    }))
    .sort((a, b) => b.meanAtK - a.meanAtK);

  const neverSolved = tasks
    .filter((t) => !t.attempts.slice(0, k).some(Boolean))
    .map((t) => t.taskId);

  return { overall, stratified, luckyTasks, neverSolved };
}