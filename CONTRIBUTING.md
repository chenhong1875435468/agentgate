# Contributing to AgentGate

Thanks for taking a look. This is an early tool built around a specific claim: that
agent reliability should be measured with `pass^k` rather than `Mean@k`, and that the
difference matters enough to gate a deployment on.

## What this project is not

It is not a general LLM eval framework. If you need trajectory replay, judge calibration
or dataset curation at scale, look at Langfuse, Braintrust or Arize. AgentGate is
narrow on purpose: it measures one thing well and gets out of the way.

It is also not an observability tool. It does not trace production traffic.

## Getting set up

```bash
npm install
npm run pretest        # compile to dist-test/
npm test               # run the suite
npm run build          # compile to dist/
```

The published package has zero runtime dependencies. Please keep it that way. A CLI that
starts instantly and needs no install step is the whole reason someone reaches for it
inside a CI job.

## Project layout

```
src/
  metrics/core.ts      pass@k, Mean@k, pass^k, consistency gap. No dependencies.
  types.ts             Public interfaces. TaskRunner and Grader are the extension points.
  adapters/graders.ts  Built-in graders.
  runner/replay.ts     k-times replay with bounded concurrency.
  report/gate.ts       Threshold logic and regression detection.
  report/render.ts     Console, JSON and GitHub Actions output.
  config.ts            YAML subset parser. Also hand-rolled, also for zero deps.
  cli.ts               Command dispatch and exit codes.
```

## Design rules

**Metrics carry their context.** Every `pass^k` value is meaningless without its k. Never
return or print one alone.

**Crashed attempts are failures.** When a runner throws or times out, the attempt counts
as `false`. Skipping it would inflate every metric and hide the flakiness we are here to
find. There is a test for this.

**Absolute thresholds produce random red builds.** LLM-as-judge is itself
non-deterministic. Gate on a drop relative to baseline, not on an absolute number. A
small regression inside the noise floor gets reported, not blocked.

**Informational notes must not tint a passing run.** If a baseline was recorded on a
different suite size, that is worth saying, but it does not turn a good run yellow.
Reviewers who see spurious warnings learn to ignore the signal.

**Prefer deterministic graders.** A judge adds variance to both sides of the comparison.
That is the noise this tool exists to remove.

**Never relax the temperature guard.** It is deliberately inconvenient. At temperature 0
on a hosted endpoint you measure GPU floating-point non-associativity and dynamic
batching, which is your provider's noise, not your users' experience.

## Adding a grader

```ts
import type { Grader } from 'agentgate';

const startsWithRef: Grader = (task, outcome) =>
  String(outcome.output).startsWith(String(task.expected));

export default startsWithRef;
```

If the check already exists in another language or a test harness, use
`createCommandGrader` instead of porting it.

## Adding an output format

Reports go through `renderConsoleReport` / `renderJsonReport` / `renderGitHubAnnotations`.
Add a sibling function rather than extending an existing one with a format flag.

## Tests

Uses the Node built-in test runner. No framework dependency.

```bash
npm test           # compiles to dist-test/, then runs the suite
npm run pretest    # compile only
```

**When you add a test file, register it in the `test` script in package.json.**

The script lists test files explicitly rather than using a glob or a directory:

```json
"test": "npm run pretest && node --test dist-test/test/metrics.test.js dist-test/test/agentgate.test.js"
```

This is not laziness. `node --test` does not expand `**` globs on Linux, and passing a
directory behaves differently across platforms and Node versions. Explicit paths are the
only form that works identically on Windows, macOS and Linux. It was found the hard way:
the first CI run failed only on the Linux runner while passing locally on Windows.

The suite is run against Node 20 and 22 in CI. Avoid APIs newer than 20.

Tests assert on real numbers, not just "it does not throw". When you change metric
behaviour, update the IBM AppWorld-shaped case in `test/metrics.test.ts` — it encodes
the property the tool exists to expose, so it should never be loosened to make a change
pass.

## Commit and PR conventions

- One logical change per PR.
- State which metric behaviour changed and why, in the description.
- Include the before/after numbers if you touched `metrics/core.ts` or `report/gate.ts`.

## Reporting issues

A useful report includes the suite shape (how many tasks, what k), the three metrics you
got, and what you expected. If you hit a surprising pass^k value, the reason is usually
temperature or k, so include those.