#!/usr/bin/env node
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, type LoadedConfig } from './config.js';
import { buildReport, validateResults } from './metrics/core.js';
import { replay, ConfigurationError } from './runner/replay.js';
import { resolveGrader, createBuiltinGrader } from './adapters/graders.js';
import { evaluateGate, type Baseline } from './report/gate.js';
import { renderConsoleReport, renderJsonReport, renderGitHubAnnotations, renderRemediation } from './report/render.js';
import type { TaskRunner, Grader, TaskDefinition, AttemptOutcome } from './types.js';

const VERSION = '0.1.0';

/**
 * Exit codes carry meaning for CI. A human reading CI logs will notice, and more
 * importantly a wrapper script can branch on them.
 */
const EXIT = {
  pass: 0,
  gateFailed: 1,
  configError: 2,
  runnerError: 3,
} as const;

interface Argv {
  command: string;
  config: string;
  format: 'text' | 'json';
  saveBaseline: boolean;
  quiet: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Argv {
  const result: Argv = {
    command: '',
    config: 'agentgate.yml',
    format: 'text',
    saveBaseline: false,
    quiet: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '-h':
      case '--help':
        result.help = true;
        break;
      case '-v':
      case '--version':
        result.version = true;
        break;
      case '--json':
        result.format = 'json';
        break;
      case '--quiet':
        result.quiet = true;
        break;
      case '--save-baseline':
        result.saveBaseline = true;
        break;
      case '-c':
      case '--config':
        result.config = argv[++i] ?? result.config;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new ConfigurationError(`unknown flag: ${arg}`);
        }
        if (result.command === '') result.command = arg;
        break;
    }
  }

  return result;
}

function printHelp(): void {
  process.stdout.write(`
AgentGate ${VERSION} - reliability gate for AI agents

USAGE
  agentgate check [options]        Replay the suite k times and evaluate the gate
  agentgate init                   Write a starter agentgate.yml
  agentgate help

OPTIONS
  -c, --config <path>   Config file (default: agentgate.yml)
      --json            Emit a machine-readable report instead of text
      --save-baseline   Record the current result as the regression baseline
      --quiet           Suppress per-attempt progress
  -h, --help            Show this message
  -v, --version         Show the version

EXIT CODES
  0  gate passed
  1  gate failed
  2  configuration error
  3  runner error

WHY THIS TOOL EXISTS
  Mean@k flatters non-deterministic agents. A task succeeding 3 times out of 5
  contributes 60% to the mean while a real user gets a coin flip. AgentGate
  reports pass@k, Mean@k and pass^k together and gates on pass^k, because
  production systems experience pass^k.

EXAMPLE
  agentgate check --config agentgate.yml
`);
}

const STARTER_CONFIG = `# AgentGate configuration

# Number of attempts per task. Pick this from your domain, not from a default:
#   6-turn customer support flow -> pass^6
#   one-shot summarizer-> pass^1
k: 5

# MUST be greater than 0. At temperature 0 you would measure hosting-platform
# noise (GPU floating-point non-associativity, dynamic batching) instead of the
# distribution your users actually experience.
temperature: 1.0
seed: 42

# Concurrency affects wall-clock time only, never the result.
concurrency: 4
timeoutMs: 60000

# Default grader for tasks that do not override it.
grader: exact_match

thresholds:
  # Block the merge below this pass^k. Use for safety and cost invariants.
  hard: 0.75
  # Block when Mean@k falls more than this many points against the baseline.
  maxMeanRegression: 0.05
  # Block when the mean cost per attempt exceeds this.
  # maxCostPerAttemptUsd: 0.05

baseline: .agentgate/baseline.json

suite: ./tasks.yml
`;

/** Load the runner the user configured. Supports ESM and CJS adapters. */
async function loadRunner(config: LoadedConfig): Promise<TaskRunner> {
  const runnerPath = typeof config.config.runner === 'string' ? config.config.runner : undefined;
  if (!runnerPath) {
    throw new ConfigurationError(
      'config: no "runner" specified.\n' +
        'AgentGate does not call models itself, by design: you keep control of prompt\n' +
        'management, auth, retries and rate limiting. Point "runner" at a module that\n' +
        'default-exports a TaskRunner.',
    );
  }

  // Paths in the config are relative to the config file, not the process cwd.
  const configDir = config.configPath.replace(/[\\/][^\\/]*$/, '');
  const absolute = resolve(configDir, runnerPath);
  if (!existsSync(absolute)) {
    throw new ConfigurationError(
      `runner module not found: ${absolute}\n` +
        'If it is TypeScript, compile it first or point "runner" at the built .js file.',
    );
  }

  const module = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>;
  const candidate = module.default ?? module.runner;
  if (typeof candidate !== 'function') {
    throw new ConfigurationError(
      `runner module "${runnerPath}" must default-export a function (TaskRunner)`,
    );
  }
  return candidate as TaskRunner;
}

function loadBaseline(path: string | undefined): Baseline | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Baseline;
    if (typeof parsed.meanAtK !== 'number' || typeof parsed.passPowK !== 'number') {
      return undefined;
    }
    return parsed;
  } catch {
    // A corrupt baseline must not block a run; treat it as absent.
    return undefined;
  }
}

async function commandCheck(args: Argv): Promise<number> {
  const config = loadConfig(args.config);

  // Fail fast on a temperature that would produce a meaningless metric, before
  // spending a single token.
  if (config.settings.temperature <= 0) {
    throw new ConfigurationError(
      `config: temperature must be greater than 0, got ${config.settings.temperature}.\n` +
        'At temperature 0 the variance you would measure is hosting-platform noise, not\n' +
        'the distribution your users experience. See the note in agentgate.yml.',
    );
  }

  const runner = await loadRunner(config);
  const defaultGrader = config.defaultGrader;
  createBuiltinGrader(defaultGrader as Parameters<typeof createBuiltinGrader>[0]);

  const grader: Grader = (task, outcome) => resolveGrader(task, defaultGrader as never)(task, outcome);

  const total = config.tasks.length * config.settings.k;
  if (!args.quiet && args.format === 'text') {
    process.stderr.write(
      `Running ${config.tasks.length} tasks x k=${config.settings.k} ` +
        `= ${total} attempts (concurrency ${config.settings.concurrency})\n\n`,
    );
  }

  const result = await replay({
    settings: config.settings,
    runner,
    grader,
    tasks: config.tasks,
    ...(args.quiet
      ? {}
      : {
          onProgress: (done, all, taskId, attempt) => {
            // Pad to erase the previous longer line.
            const line = `  ${done}/${all}  ${taskId} attempt ${attempt + 1}`;
            process.stderr.write(`\r${line.padEnd(60)}\r`);
          },
        }),
  });

  if (!args.quiet && args.format === 'text') process.stderr.write('\n');

  const validationErrors = validateResults(
    result.tasks.map((t) => ({ taskId: t.id, attempts: t.attempts, label: t.label })),
    config.settings.k,
  );
  if (validationErrors.length > 0) {
    process.stderr.write(`\nResult validation problems:\n${validationErrors.map((e) => `  - ${e}`).join('\n')}\n`);
  }

  const report = buildReport(
    result.tasks.map((t) => ({ taskId: t.id, attempts: t.attempts, label: t.label })),
    config.settings.k,
  );

  const costPerAttemptUsd =
    result.totalCostUsd > 0 ? result.totalCostUsd / total : undefined;

  const baseline = loadBaseline(config.baselinePath);
  const decision = evaluateGate({
    report,
    thresholds: config.thresholds,
    ...(baseline ? { baseline } : {}),
    ...(costPerAttemptUsd !== undefined ? { costPerAttemptUsd } : {}),
  });

  if (args.saveBaseline) {
    const path = config.baselinePath ?? '.agentgate/baseline.json';
    writeFileSync(
      path,
      JSON.stringify(
        {
          meanAtK: report.overall.meanAtK,
          passPowK: report.overall.passPowK,
          recordedAt: new Date().toISOString(),
          tasks: report.overall.tasks,
        },
        null,
        2,
      ),
    );
    if (args.format === 'text') process.stderr.write(`Baseline written to ${path}\n`);
  }

  if (args.format === 'json') {
    process.stdout.write(
      renderJsonReport(report, decision, {
        ...(costPerAttemptUsd !== undefined ? { costPerAttemptUsd } : {}),
        ...(baseline ? { baseline } : {}),
        wallClockMs: result.wallClockMs,
      }) + '\n',
    );
  } else {
    process.stdout.write(
      renderConsoleReport(report, decision, {
        ...(costPerAttemptUsd !== undefined ? { costPerAttemptUsd } : {}),
        ...(baseline ? { baseline } : {}),
        wallClockMs: result.wallClockMs,
      }),
    );
    if (decision.verdict !== 'pass') {
      process.stdout.write(renderRemediation(report, decision));
    }
  }

  if (process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write('\n' + renderGitHubAnnotations(report, decision) + '\n');
  }

  return decision.verdict === 'fail' ? EXIT.gateFailed : EXIT.pass;
}

async function main(): Promise<number> {
  let args: Argv;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.configError;
  }

  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.pass;
  }
  if (args.help || args.command === '' || args.command === 'help') {
    printHelp();
    return EXIT.pass;
  }

  try {
    switch (args.command) {
      case 'check':
        return await commandCheck(args);
      case 'init': {
        if (existsSync(args.config)) {
          process.stderr.write(`${args.config} already exists; refusing to overwrite.\n`);
          return EXIT.configError;
        }
        writeFileSync(args.config, STARTER_CONFIG);
        process.stdout.write(`Wrote ${args.config}\n`);
        return EXIT.pass;
      }
      default:
        process.stderr.write(`unknown command: ${args.command}\n\n`);
        printHelp();
        return EXIT.configError;
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`configuration error:\n${error.message}\n`);
      return EXIT.configError;
    }
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.runnerError;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = EXIT.runnerError;
  });

export type { TaskDefinition, AttemptOutcome };