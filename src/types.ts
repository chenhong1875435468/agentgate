/**
 * Public type surface for AgentGate.
 *
 * The important design decision here is that everything domain-specific lives
 * behind the TaskRunner and Grader interfaces. Metrics, thresholds, reporting
 * and CI integration are fully generic and work with any agent framework or
 * model provider.
 */

/** A single test case in the suite. Domain-agnostic by construction. */
export interface TaskDefinition {
  /** Stable identifier. Appears in reports, so keep it meaningful. */
  id: string;
  /**
   * The input handed to the agent. Shape is up to you; AgentGate never
   * inspects it.
   */
  input: unknown;
  /**
   * Expected outcome, interpreted by the configured Grader. Again, shape is
   * up to the grader.
   */
  expected?: unknown;
  /**
   * Grouping label used for per-category breakdowns. Strongly recommended:
   * overall numbers hide which part of the agent is unreliable.
   */
  label?: string;
  /** Free-form metadata passed through to the grader untouched. */
  metadata?: Record<string, unknown>;
}

/** What a runner reports back for one attempt. */
export interface AttemptOutcome {
  /** The agent's output for this attempt. */
  output: unknown;
  /** true = passed. */
  passed: boolean;
  /** Optional decision trace, recorded for later fragility analysis (v2). */
  steps?: DecisionStep[];
  /** Optional cost in USD, used by the cost-budget threshold. */
  costUsd?: number;
  /** Optional latency in milliseconds. */
  latencyMs?: number;
  /** Set when the attempt itself failed (timeout, API error, crash). */
  error?: string;
}

/**
 * One decision the agent made while producing an output.
 * Captured now so v2 fragility analysis can locate flip-prone steps without
 * requiring a re-run.
 */
export interface DecisionStep {
  index: number;
  /** What the agent decided: a tool call, a parameter, an argument. */
  description: string;
  /** Structured payload when available. */
  payload?: unknown;
}

export interface ExecutionSettings {
  /**
   * Number of attempts per task. This is k in pass^k.
   *
   * Pick it from your domain, not from a default:
   *   - 6-turn customer support flow -> pass^6
   *   - one-shot summarizer           -> pass^1 (k>1 buys little)
   */
  k: number;
  /**
   * Sampling temperature for replay. MUST be greater than 0 for pass^k to
   * mean anything; AgentGate refuses to run at temperature 0 by default.
   */
  temperature: number;
  /** Random seed base. Each attempt derives its own seed so runs vary. */
  seed: number;
  /** Max concurrent attempts. Controls wall-clock time, not correctness. */
  concurrency: number;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs: number;
}

export type Verdict = 'pass' | 'warn' | 'fail';

export interface ThresholdSet {
  /** Block the merge below this pass^k. Use for safety and cost invariants. */
  hard?: number;
  /** Flag for human review below this pass^k. Never blocks on its own. */
  soft?: number;
  /** Block when Mean@k drops more than this many points vs baseline. */
  maxMeanRegression?: number;
  /** Block when mean cost per attempt exceeds this many USD. */
  maxCostPerAttemptUsd?: number;
}

export interface GateDecision {
  verdict: Verdict;
  /** One-line reason suitable for a CI annotation. */
  reason: string;
  /** Every threshold that was violated, for a detailed report. */
  violations: string[];
}

export interface SuiteResult {
  tasks: Array<{ id: string; attempts: boolean[]; label?: string }>;
  totalCostUsd: number;
  wallClockMs: number;
}

/**
 * Runs one attempt of one task. Implement this around your agent.
 *
 * AgentGate deliberately does NOT shell out to a CLI or know how to call an
 * LLM. Keeping the runner boundary explicit means you keep control of prompt
 * management, auth, retries and rate limiting.
 */
export interface TaskRunner {
  (task: TaskDefinition, attempt: number, settings: ExecutionSettings): Promise<AttemptOutcome>;
}

/**
 * Decides whether an output passes. This is the one domain-specific piece.
 *
 * Built-in: exact_match, json_schema, contains, regex.
 * Custom: implement this interface, or expose an external process that speaks
 * JSON on stdin/stdout.
 */
export interface Grader {
  (task: TaskDefinition, outcome: AttemptOutcome): Promise<boolean> | boolean;
}