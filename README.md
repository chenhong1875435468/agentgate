# AgentGate

**A reliability gate for AI agents. It measures Pass^k, not Mean@k.**

Benchmarks and most eval tools report `Mean@k`: the average success rate over k attempts.
That number flatters non-deterministic systems. A task that succeeds 3 times out of 5
contributes 60% to the mean, while a real user asking the same question twice gets a
coin flip.

AgentGate reports all three metrics together and gates on the one production actually
experiences.

```
pass@5   87.5%   optimistic  — is this task solvable at all?
Mean@5   77.5%   average     — what leaderboards report
pass^5   62.5%   pessimistic — what users experience
         ─────────
         15.0pp consistency gap
```

The same suite, the same run, the same agent. The difference between 77.5% and 62.5% is
entirely luck, and it is invisible until you measure the right thing.

## Why this exists

AI agents are non-deterministic by construction. Greedy decoding does not make them
deterministic: it picks a token from the existing distribution but does not change the
distribution's shape. On hosted endpoints, GPU floating-point non-associativity and
dynamic batching still flip near-tied tokens. Chain a few dozen of those decisions
together and the per-step variance compounds.

Measured consequences:

| Report | Mean@k | pass^k | Gap |
|---|---|---|---|
| IBM Research / Hugging Face, AppWorld + GPT-4.1 | 77.4% | 53.0% | 24.4pp |
| Splunk, Agent S3 + GPT-5 | ~78% (pass@10) | 36% (pass^10) | ~42pp |

IBM calls this a **showstopper** for financial reconciliation and contract obligation
checking. Gartner projected that 40% of enterprises will downgrade or decommission
autonomous agents by 2027.

Long chains compound too. A step that is 95% reliable leaves 35.8% after 20 steps and
7.7% after 50.

## Install

```bash
npm install -g agentgate
```

Zero runtime dependencies. No install step, no postinstall, no telemetry.

## Quick start

```bash
npx agentgate init          # write a starter agentgate.yml
npx agentgate check         # run the suite k times and evaluate the gate
```

## How it works

AgentGate replays your suite k times and reports what happened. It deliberately does not
call models itself: you keep control of prompt management, auth, retries and rate
limiting. You provide a `TaskRunner`, AgentGate provides the measurement and the gate.

```
┌──────────────┐     ┌──────────────┐     ┌───────────────┐     ┌──────────────┐
│  your agent  │ ──▶ │  TaskRunner  │ ──▶ │    Grader     │ ──▶ │  gate + CI   │
│  (any model) │     │  (yours)     │     │  pass or fail │     │  exit code   │
└──────────────┘     └──────────────┘     └───────────────┘     └──────────────┘
                          generic              the only             generic
                                             domain-specific
                                             piece
```

### 1. Write a runner

```ts
// my-runner.ts
import type { AttemptOutcome, ExecutionSettings, TaskDefinition } from 'agentgate';

export default async function run(
  task: TaskDefinition,
  attempt: number,
  settings: ExecutionSettings,
): Promise<AttemptOutcome> {
  const started = Date.now();
  const answer = await myAgent(task.input, { temperature: settings.temperature, seed: settings.seed });
  return {
    output: answer,
    passed: true,          // let the grader decide
    costUsd: 0.003,
    latencyMs: Date.now() - started,
  };
}
```

### 2. Write a task suite

```yaml
# tasks.yml
tasks:
  - id: order-status-001
    label: order-lookup
    input: where is my order
    expected: handled
    metadata:
      grader: contains
```

Label your tasks. Overall numbers hide which part of the agent is unreliable.

### 3. Configure

```yaml
# agentgate.yml
k: 5
temperature: 1.0
concurrency: 4
runner: ./dist/my-runner.js

thresholds:
  hard: 0.75
  maxMeanRegression: 0.05

suite: ./tasks.yml
baseline: .agentgate/baseline.json
```

### 4. Wire it into CI

```yaml
- run: npx agentgate check --config agentgate.yml
```

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `k` | 5 | Attempts per task. Pick from your domain, not from a default. |
| `temperature` | 1.0 | **Must be greater than 0.** See below. |
| `seed` | 42 | Base seed. Each attempt derives its own. |
| `concurrency` | 4 | Wall-clock only, never results. |
| `timeoutMs` | 60000 | Per-attempt timeout. |
| `grader` | `exact_match` | Default grader for tasks. |
| `runner` | — | Module path, default-exporting a `TaskRunner`. |
| `suite` | — | Path to the task file. |

### Thresholds

| Key | Behaviour |
|---|---|
| `hard` | Block the merge below this `pass^k`. Use for safety and cost invariants. |
| `soft` | Flag for review below this `pass^k`. Never blocks on its own. |
| `maxMeanRegression` | Block when `Mean@k` falls more than this against the baseline. |
| `maxCostPerAttemptUsd` | Block when the mean cost per attempt exceeds this. |

## Why temperature 0 is rejected

AgentGate refuses to run at `temperature: 0`.

At temperature 0 on a hosted endpoint you still get different results across runs,
because of GPU floating-point non-associativity and dynamic batching. But that variance
is **not** the distribution your users experience — it is your hosting provider's noise.
You would measure the platform and call it reliability.

This is the single most common way agent evaluations mislead people.

## Picking k

k is a business decision, not a default.

| Scenario | k | Why |
|---|---|---|
| Six-turn customer support flow | 6 | Users experience the whole flow |
| One-shot summarizer | 1 | Repetition adds nothing |
| Code review agent | 3–5 | Same PR reviewed repeatedly |
| Nightly batch reconciliation | 3 | Lower volume, higher stakes |

Always report k alongside the number. A `pass^5` of 0.70 and a `pass^3` of 0.70 mean
very different things.

## Graders

Built in: `exact_match`, `contains`, `regex`, `json_schema`.

Prefer deterministic graders over LLM judges. A judge adds variance to **both** sides
of the comparison, which is precisely the noise this tool exists to help you avoid. If
you must use one, calibrate it first: score the same output twice and measure the
disagreement rate.

For anything else, implement the `Grader` interface or shell out to your existing test
harness with `createCommandGrader`.

## Output

```
AgentGate
================================================================

  k = 5   tasks = 8

  pass@5     87.5%   optimistic, solvable at all
  Mean@5     77.5%   average, what leaderboards report
  pass^5     62.5%   pessimistic, what users experience

  consistency gap  15.0pp
  #############....... 62.5% reliable across all 5 attempts
  normalised       80.6% of the average is real, not luck

  Breakdown by group (worst consistency first)
  ------------------------------------------------------------
  order-lookup           pass^5   75.0%   Mean@5   95.0%   gap  20.0pp
  account                pass^5   50.0%   Mean@5   70.0%   gap  20.0pp
  policy                 pass^5  100.0%   Mean@5  100.0%   gap   0.0pp
  legacy                 pass^5    0.0%   Mean@5    0.0%   gap   0.0pp

  Unreliable but not broken (2)
  ------------------------------------------------------------
  These pass a Mean@k review but flip between attempts.

    + + + - +    80.0%   flaky-lookup-001 [order-lookup]
    + - - - +    40.0%   flaky-retry-001 [account]
```

On failure it also emits GitHub Actions annotations and remediation advice tailored to
what actually went wrong:

- wide gap, high `pass@k` → instability, not capability. Look for near-tied decisions.
- high normalised consistency → capability ceiling, not flakiness. Focus on the failing tasks.
- one group much worse than the others → treat that group separately.

## When NOT to use this

AgentGate is for **repeated** tasks whose failures carry a cost. It is not useful for:

- one-off tasks, where there is no "next time" to be consistent about
- work still under rapid iteration, where the gate only slows you down
- outputs a human reviews anyway, where the review is already the gate

Two of the three conditions below must hold:

1. Failures are irreversible, or carry legal or financial cost
2. Users will ask the same thing more than once
3. A human cannot eyeball the errors, or nobody reviews them

If you have one-off tasks with visible errors, a reliability gate is overhead.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Gate passed |
| 1 | Gate failed |
| 2 | Configuration error |
| 3 | Runner error |

## CLI

```
agentgate check [options]      Replay the suite k times and evaluate the gate
agentgate init                 Write a starter agentgate.yml

  -c, --config <path>          Config file (default: agentgate.yml)
      --json                   Machine-readable report
      --save-baseline          Record the current result as the baseline
      --quiet                  Suppress per-attempt progress
```

## Reference

- [Your Agent Aced the Task. Will It Do It Again?](https://huggingface.co/blog) — IBM Research / Hugging Face, 2026-09. Introduces `pass^k` and the Consistency Analyzer. The underlying algorithms are open source in ALTK-Evolve.
- Splunk, *Evaluating AI Agents on Tool Calling and Planning* — documents the 36% `pass^10` result and why benchmark scores mislead.
- AWS, *AI agent regression testing to GitHub Actions* — the same gating idea, but reporting on `Mean@k` only.

## Status

v0.1 covers the judgement layer: replay, the three metrics, thresholds, CI exit codes,
GitHub annotations. The cost engine (cross-commit caching, decision-point resampling,
partial replay) and fragility localisation are the planned next layer.

## License

MIT