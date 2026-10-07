import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ExecutionSettings, ThresholdSet, TaskDefinition } from './types.js';

/**
 * Minimal YAML subset parser.
 *
 * Deliberately hand-rolled to keep the published package dependency-free, so
 * `npx agentgate` works with no install step and no postinstall. It supports
 * exactly what an agentgate config needs: nested maps, scalars, and block
 * sequences. If you need something richer, agentgate.yml is a config file you
 * can also express in JSON.
 */

export interface ParsedConfig {
  suite?: string;
  k?: number;
  temperature?: number;
  seed?: number;
  concurrency?: number;
  timeoutMs?: number;
  grader?: string;
  thresholds?: ThresholdSet;
  baseline?: string;
  runner?: string;
  runnerArgs?: string[];
  [key: string]: unknown;
}

function coerce(raw: string): unknown {
  const text = raw.trim();

  if (text === '' || text === '~' || text === 'null') return null;
  if (text === 'true' || text === 'yes') return true;
  if (text === 'false' || text === 'no') return false;

  // Quoted strings keep their contents verbatim.
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length > 1) ||
    (text.startsWith("'") && text.endsWith("'") && text.length > 1)
  ) {
    return text.slice(1, -1);
  }

  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d*\.\d+$/.test(text)) return Number.parseFloat(text);

  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((part) => coerce(part));
  }

  return text;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Parse the YAML subset into a tree of nodes first, then collapse it.
 *
 * Two phases keeps this readable. A single-pass parser with a stack has to
 * decide at parse time whether an empty value is a nested map or the header of a
 * block sequence, and getting that wrong silently corrupts the result.
 */
type Node =
  | { kind: 'scalar'; value: unknown }
  | { kind: 'map'; entries: Array<[string, Node]> }
  | { kind: 'seq'; items: Node[] };

interface RawLine {
  indent: number;
  text: string;
}

function scan(source: string): RawLine[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, '  '))
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    .map((line) => ({ indent: indentOf(line), text: line.trim() }));
}

/** Split "key: rest" once, respecting that values may contain colons. */
function splitKey(text: string): [string, string] | null {
  const separator = text.indexOf(':');
  if (separator === -1) return null;
  return [text.slice(0, separator).trim(), text.slice(separator + 1).trim()];
}

function buildTree(lines: RawLine[], start: number, indent: number): { node: Node; next: number } {
  // Decide what kind of node this block of same-indent lines represents.
  if (lines[start]?.text.startsWith('- ') || lines[start]?.text === '-') {
    const items: Node[] = [];
    let i = start;
    while (i < lines.length && lines[i]!.indent === indent && lines[i]!.text.startsWith('- ')) {
      const body = lines[i]!.text.slice(2).trim();
      const pair = splitKey(body);

      if (!pair) {
        // Plain scalar item.
        items.push({ kind: 'scalar', value: coerce(body) });
        i += 1;
        continue;
      }

      // "- key: value" starts a map whose first key is on this line and whose
      // remaining keys are indented deeper.
      const [firstKey, firstValue] = pair;
      const entries: Array<[string, Node]> = [];
      let childIndent = -1;

      if (firstValue === '') {
        const child = buildTree(lines, i + 1, lines[i + 1]?.indent ?? indent + 2);
        entries.push([firstKey, child.node]);
        i = child.next;
      } else {
        entries.push([firstKey, { kind: 'scalar', value: coerce(firstValue) }]);
        i += 1;
        // Sibling keys of a list item align just past the dash.
        childIndent = indent + 2;
        while (i < lines.length && lines[i]!.indent >= childIndent && !lines[i]!.text.startsWith('- ')) {
          const sub = buildTree(lines, i, lines[i]!.indent);
          if (sub.node.kind === 'map') entries.push(...sub.node.entries);
          i = sub.next;
        }
      }

      items.push({ kind: 'map', entries });
    }
    return { node: { kind: 'seq', items }, next: i };
  }

  const entries: Array<[string, Node]> = [];
  let i = start;
  while (i < lines.length && lines[i]!.indent === indent) {
    const line = lines[i]!;
    const pair = splitKey(line.text);
    if (!pair) {
      i += 1;
      continue;
    }
    const [key, rest] = pair;

    if (rest === '') {
      const childIndent = lines[i + 1]?.indent ?? -1;
      if (childIndent > indent) {
        const child = buildTree(lines, i + 1, childIndent);
        entries.push([key, child.node]);
        i = child.next;
      } else {
        // No deeper block: treat as an empty value.
        entries.push([key, { kind: 'scalar', value: null }]);
        i += 1;
      }
    } else {
      entries.push([key, { kind: 'scalar', value: coerce(rest) }]);
      i += 1;
    }
  }
  return { node: { kind: 'map', entries }, next: i };
}

function collapse(node: Node): unknown {
  switch (node.kind) {
    case 'scalar':
      return node.value;
    case 'seq':
      return node.items.map(collapse);
    case 'map': {
      const result: Record<string, unknown> = {};
      for (const [key, child] of node.entries) result[key] = collapse(child);
      return result;
    }
  }
}

export function parseSimpleYaml(source: string): Record<string, unknown> {
  const lines = scan(source);
  if (lines.length === 0) return {};
  const { node } = buildTree(lines, 0, lines[0]!.indent);
  const collapsed = collapse(node);
  return (collapsed && typeof collapsed === 'object' ? collapsed : {}) as Record<string, unknown>;
}

export interface LoadedConfig {
  configPath: string;
  config: ParsedConfig;
  tasks: TaskDefinition[];
  settings: ExecutionSettings;
  thresholds: ThresholdSet;
  defaultGrader: string;
  baselinePath?: string;
}

function requireNumber(
  value: unknown,
  field: string,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`config: "${field}" must be a number, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function loadConfig(configPath: string): LoadedConfig {
  const absolute = resolve(configPath);
  if (!existsSync(absolute)) {
    throw new Error(`config file not found: ${absolute}`);
  }

  const source = readFileSync(absolute, 'utf8');
  const config = parseSimpleYaml(source) as ParsedConfig;
  const baseDir = absolute.replace(/[\\/][^\\/]*$/, '');

  // Tasks may live in the config itself, or in a separate suite file.
  const inlineTasks = Array.isArray(config.tasks) ? (config.tasks as TaskDefinition[]) : undefined;
  const suiteRef = typeof config.suite === 'string' ? config.suite : undefined;

  let tasks: TaskDefinition[] = inlineTasks ?? [];
  if (tasks.length === 0 && suiteRef) {
    const suitePath = resolve(baseDir, suiteRef);
    if (!existsSync(suitePath)) {
      throw new Error(`suite file not found: ${suitePath}`);
    }
    const suiteSource = readFileSync(suitePath, 'utf8');
    const parsed = parseSimpleYaml(suiteSource);
    const list = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    tasks = list as TaskDefinition[];
    if (tasks.length === 0) {
      throw new Error(`suite file contains no tasks: ${suitePath}`);
    }
  }

  if (tasks.length === 0) {
    throw new Error(
      'config: no tasks found. Provide either a "suite:" file or an inline "tasks:" list.',
    );
  }

  const settings: ExecutionSettings = {
    k: requireNumber(config.k, 'k', 5),
    temperature: requireNumber(config.temperature, 'temperature', 1.0),
    seed: requireNumber(config.seed, 'seed', 42),
    concurrency: requireNumber(config.concurrency, 'concurrency', 4),
    timeoutMs: requireNumber(config.timeoutMs, 'timeoutMs', 60_000),
  };

  const thresholds: ThresholdSet =
    config.thresholds && typeof config.thresholds === 'object' ? config.thresholds : {};

  const defaultGrader = typeof config.grader === 'string' ? config.grader : 'exact_match';

  return {
    configPath: absolute,
    config,
    tasks,
    settings,
    thresholds,
    defaultGrader,
    ...(typeof config.baseline === 'string'
      ? { baselinePath: resolve(baseDir, config.baseline) }
      : {}),
  };
}