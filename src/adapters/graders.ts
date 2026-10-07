import { spawnSync } from 'node:child_process';

import type { Grader, TaskDefinition, AttemptOutcome } from '../types.js';

/**
 * Built-in graders.
 *
 * The reason these are pluggable: "did this attempt pass?" is the only question
 * AgentGate cannot answer on its own. Everything else in this tool is generic.
 *
 * Prefer deterministic graders over LLM judges whenever possible. A judge adds
 * variance to BOTH sides of the comparison, which is exactly the noise this
 * tool exists to help you avoid. If you must use one, calibrate it: score the
 * same output twice and measure the disagreement rate first.
 */

type BuiltinName = 'exact_match' | 'contains' | 'regex' | 'json_schema';

interface BuiltinSpec {
  name: BuiltinName;
  description: string;
  /** Which fields the grader compares. */
  compares: string;
  deterministic: boolean;
  /** Rough cost note surfaced in docs so users pick the cheap one first. */
  cost: 'none';
}

export const BUILTIN_GRADERS: readonly BuiltinSpec[] = [
  {
    name: 'exact_match',
    description: 'Stringifies both sides and requires exact equality after trimming.',
    compares: 'output vs expected',
    deterministic: true,
    cost: 'none',
  },
  {
    name: 'contains',
    description: 'Checks that the expected string appears inside the output.',
    compares: 'output contains expected',
    deterministic: true,
    cost: 'none',
  },
  {
    name: 'regex',
    description: 'Tests the output against an expected regular expression.',
    compares: 'output matches expected regex',
    deterministic: true,
    cost: 'none',
  },
  {
    name: 'json_schema',
    description:
      'Parses output as JSON, then checks every key in the expected object matches. ' +
      'Use this for structured tool-calling checks.',
    compares: 'JSON fields vs expected',
    deterministic: true,
    cost: 'none',
  },
] as const;

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Structural equality for json_schema: every expected key must match. */
function matchesShape(actual: unknown, expected: unknown, path: string, errors: string[]): void {
  if (expected === null || typeof expected !== 'object') {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    return;
  }

  if (actual === null || typeof actual !== 'object') {
    errors.push(`${path}: expected an object, got ${JSON.stringify(actual)}`);
    return;
  }

  const actualObj = actual as Record<string, unknown>;
  const expectedObj = expected as Record<string, unknown>;

  for (const [key, expectedValue] of Object.entries(expectedObj)) {
    const childPath = path ? `${path}.${key}` : key;
    if (!(key in actualObj)) {
      errors.push(`${childPath}: missing from output`);
      continue;
    }
    matchesShape(actualObj[key], expectedValue, childPath, errors);
  }
}

export function createBuiltinGrader(name: BuiltinName): Grader {
  switch (name) {
    case 'exact_match':
      return (task, outcome) => toText(outcome.output).trim() === toText(task.expected).trim();

    case 'contains':
      return (task, outcome) => {
        const needle = toText(task.expected).trim();
        // An empty needle would trivially pass everything; treat it as a config bug.
        if (needle === '') throw new Error('contains grader requires a non-empty expected value');
        return toText(outcome.output).includes(needle);
      };

    case 'regex':
      return (task, outcome) => {
        const pattern = toText(task.expected);
        if (pattern === '') throw new Error('regex grader requires a non-empty expected pattern');
        return new RegExp(pattern).test(toText(outcome.output));
      };

    case 'json_schema':
      return (task, outcome) => {
        let parsed: unknown;
        try {
          parsed =
            typeof outcome.output === 'string'
              ? JSON.parse(outcome.output)
              : outcome.output;
        } catch {
          return false;
        }
        const errors: string[] = [];
        matchesShape(parsed, task.expected, '', errors);
        return errors.length === 0;
      };

    default: {
      const exhaustive: never = name;
      throw new Error(`unknown grader: ${String(exhaustive)}`);
    }
  }
}

/** Read the grader names off a task definition, falling back to exact_match. */
export function resolveGrader(task: TaskDefinition, fallback: BuiltinName): Grader {
  const requested = (task.metadata?.grader as BuiltinName | undefined) ?? fallback;
  return createBuiltinGrader(requested);
}

/**
 * Grader that shells out to an external command. Useful when your checks live
 * in Python, or in a test harness you already have.
 *
 * Protocol: the command receives the task and outcome as JSON on stdin and is
 * expected to print "PASS" or "FAIL". A non-zero exit is treated as a failure
 * of the check itself, not as a passing result.
 */
export function createCommandGrader(command: string[]): Grader {
  return (task, outcome) => {
    const payload = JSON.stringify({
      id: task.id,
      input: task.input,
      expected: task.expected,
      output: outcome.output,
      metadata: task.metadata ?? {},
    });

    const result = spawnSync(command[0]!, command.slice(1), {
      input: payload,
      encoding: 'utf8',
      timeout: 30_000,
    });

    if (result.error) throw result.error;
    return result.stdout?.trim().toUpperCase().startsWith('PASS') ?? false;
  };
}

export type { AttemptOutcome };