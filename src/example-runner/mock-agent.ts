/**
 * Deterministic mock agent used by the example suite and the smoke test.
 *
 * It simulates the exact failure profile AgentGate exists to catch:
 *   - most tasks are answered correctly every time
 *   - some are answered correctly only sometimes
 *   - one is never answered correctly
 *
 * The "flakiness" is derived from a hash of the task id and the attempt number,
 * so a given (task, attempt) pair always produces the same verdict. That makes
 * the example reproducible and lets you predict the metrics by hand.
 *
 * Real usage: replace this with a module that calls your actual agent.
 */

import type { AttemptOutcome, ExecutionSettings, TaskDefinition } from '../types.js';

function hash(input: string): number {
  let value = 0;
  for (let i = 0; i < input.length; i++) {
    value = (value * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(value);
}

/** Tasks whose id contains this marker flip on specific attempts. */
const FLAKY = /\b(flaky|retry|lookup)\b/i;
/** Tasks whose id contains this marker always fail. */
const BROKEN = /\b(unsupported|edge)\b/i;

export default function mockAgent(
  task: TaskDefinition,
  attempt: number,
  settings: ExecutionSettings,
): Promise<AttemptOutcome> {
  // Consume the derived seed so the runner's seeding contract is exercised.
  const noise = hash(`${task.id}:${settings.seed}:${attempt}`);
  const rate = (noise % 100) / 100;

  let passed: boolean;
  if (BROKEN.test(task.id)) {
    passed = false;
  } else if (FLAKY.test(task.id)) {
    // Fails roughly half the time, which is what widens the consistency gap.
    passed = rate >= 0.5;
  } else {
    passed = true;
  }

  return Promise.resolve({
    output: passed
      ? { answer: `handled: ${String(task.input)}` }
      : { answer: `cannot resolve: ${String(task.input)}` },
    passed: true, // The runner itself succeeded; the grader decides pass/fail.
    costUsd: 0.002 + (noise % 50) / 10000,
    latencyMs: 120 + (noise % 300),
    steps: [
      { index: 0, description: 'select tool: knowledge_lookup', payload: { tool: 'knowledge_lookup' } },
      { index: 1, description: `attempt=${attempt}`, payload: { attempt } },
    ],
  });
}