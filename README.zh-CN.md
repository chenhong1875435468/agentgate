# AgentGate

**AI Agent的可靠性闸门。它测的是 Pass^k，不是 Mean@k。**

[English](./README.md) · 简体中文

基准测试和大多数评测工具报的是 `Mean@k`：k 次尝试里的平均成功率。
这个数字对非确定性系统过于宽容。一道题5次里对3次，会给平均值贡献 60%，
但真实用户问同一个问题两次，得到的却是一次抛硬币。

AgentGate 把三个指标一起报出来，并且拿生产环境真正承受的那个指标设闸门。

```
pass@5   87.5%   乐观  — 这道题到底有没有解？
Mean@5   77.5%   平均  — 榜单上报的那个
pass^5   62.5%   悲观  — 用户实际体验的那个
         ─────────
         15.0pp 一致性缺口
```

同一套题、同一轮运行、同一个 Agent。77.5% 和 62.5% 之间的差距全部是运气，
而这在你测对指标之前是完全看不见的。

## 为什么需要这个

AI Agent 天生是非确定性的。贪心解码并不能让它变确定：
贪心解码只是从已有分布里挑一个 token，并没有改变分布本身的形状。
在托管端点上，GPU 浮点非结合性和动态批处理仍会让近似的 token 翻转。
把几十个这样的决策串起来，每步的微小偏差就会复利累积。

实测后果：

| 出处 | Mean@k | pass^k | 缺口 |
|---|---|---|---|
| IBM Research / Hugging Face，AppWorld + GPT-4.1 | 77.4% | 53.0% | 24.4pp |
| Splunk，Agent S3 + GPT-5 | ~78%（pass@10） | 36%（pass^10） | ~42pp |

IBM 把这称为财务对账和合同义务检查场景下的 **showstopper**（致命阻断）。
Gartner 预测到 2027 年，40% 的企业会降级或下线自主 Agent。

长链路也会复利。单步 95% 可靠的系统，20 步后剩 35.8%，50 步后剩 7.7%。

## 安装

```bash
npm install -g agentgate
```

零运行时依赖。无安装步骤、无 postinstall、无遥测。

## 快速开始

```bash
npx agentgate init          # 生成一份agentgate.yml 模板
npx agentgate check         # 跑 k 轮套件并判定闸门
```

## 工作原理

AgentGate 把你的套件回放 k 次，然后如实报告结果。
它**刻意不自己调模型**：提示词管理、鉴权、重试、限流都留在你手里。
你提供一个 `TaskRunner`，AgentGate 负责度量和设闸门。

```
┌──────────────┐     ┌──────────────┐     ┌───────────────┐     ┌──────────────┐
│  你的 Agent  │ ──▶ │  TaskRunner  │ ──▶ │    Grader     │ ──▶ │闸门 + CI│
│  （任意模型）│     │  （你写的）  │     │  通过还是失败 │     │  退出码     │
└──────────────┘     └──────────────┘     └───────────────┘     └──────────────┘
                        通用的部分          唯一跟领域相关的       通用的部分
                                          环节
```

### 1. 写一个 runner

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
    passed: true,          // 让 grader 来判定
    costUsd: 0.003,
    latencyMs: Date.now() - started,
  };
}
```

### 2. 写任务集

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

给任务打上 `label`。总体数字会掩盖到底是哪部分不可靠。

### 3. 配置

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

### 4. 接进 CI

```yaml
- run: npx agentgate check --config agentgate.yml
```

## 配置项

| 字段 | 默认值 | 含义 |
|---|---|---|
| `k` | 5 | 每题尝试次数。要按业务场景定，别照抄默认值。 |
| `temperature` | 1.0 | **必须大于 0**，原因见下。 |
| `seed` | 42 | 基础种子，每次尝试会派生出自己的种子。 |
| `concurrency` | 4 | 只影响墙钟时间，不影响结果。 |
| `timeoutMs` | 60000 | 单次尝试超时。 |
| `grader` | `exact_match` | 任务未指定时的默认评分器。 |
| `runner` | — | 模块路径，默认导出一个 `TaskRunner`。 |
| `suite` | — | 任务文件路径。 |

### 阈值

| 字段 | 行为 |
|---|---|
| `hard` | `pass^k` 低于此值则拦截合并。用于安全性和成本这类硬性不变量。 |
| `soft` | `pass^k` 低于此值则提示复审。自身不触发拦截。 |
| `maxMeanRegression` | `Mean@k` 相对基线跌超此值则拦截。 |
| `maxCostPerAttemptUsd` | 单次尝试平均成本超过此值则拦截。 |

## 为什么拒绝 temperature = 0

AgentGate 拒绝在 `temperature: 0` 下运行。

温度为 0 时，托管端点依然会给出不同结果，
因为 GPU 浮点非结合性和动态批处理的存在。但这种方差
**不是**用户会遇到的分布——它是你托管供应商的噪声。
你测到的是平台，然后把结果当成了可靠性。

这是 Agent 评测最常见的误导方式。

## k值怎么选

k 是业务决策，不是默认值。

| 场景 | k | 原因 |
|---|---|---|
| 六轮客服对话流程 | 6 | 用户体验的是整个流程 |
| 一次性摘要 | 1 | 重复执行没有意义 |
| 代码审查 Agent | 3~5 | 同一个 PR 会被反复审查 |
| 夜间批量对账 | 3 | 量小但风险高 |

任何时候都要连k 一起报。`pass^5` = 0.70 和 `pass^3` = 0.70 是两件完全不同的事。

## 评分器

内置：`exact_match`、`contains`、`regex`、`json_schema`。

**优先用确定性评分器，而不是 LLM 裁判。**
裁判会给比较的**两边**都加上方差，而这正是本工具要帮你消除的噪声。
如果非用不可，先校准它：同一个输出打两次分，量一下分歧率。

其他需求可以自己实现 `Grader` 接口，
或者用 `createCommandGrader` 复用你已有的测试脚本。

## 输出

```
AgentGate
================================================================

  k = 5   tasks = 8

  pass@5     87.5%   乐观，能做出来吗
  Mean@5     77.5%   平均，榜单上报的那个
  pass^5     62.5%   悲观，用户体验的那个

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

闸门失败时，还会输出 GitHub Actions annotations 和针对性修复建议，
并且能区分「不稳定」和「能力不够」：

- 缺口大且 `pass@k` 高 → 是稳定性问题，不是能力问题。去找接近平局的决策点。
- 归一化一致性高 → 是能力天花板，不是抖动。集中处理那些固定失败的题。
- 某一组明显比其他差 → 单独治理那一组。

## 什么时候不该用它

AgentGate 面向的是**会重复执行**、且**失败有代价**的任务。
下面这些场景不适合：

- 一次性任务——根本不存在「下次」一说
- 还在快速迭代期的项目——闸门只会拖慢你
- 反正有人工复核的输出——复核本身就是闸门

下面三条至少要满足两条：

1. 出错不可逆，或有法律、财务代价
2. 用户会重复问同一个问题
3. 人眼扫不出来错误，或者根本没人复核

如果你做的是一次性任务、出错当场可见，加可靠性闸门只是纯开销。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 闸门通过 |
| 1 | 闸门失败 |
| 2 | 配置错误 |
| 3 | runner 错误 |

## CLI

```
agentgate check [options]      回放套件 k 次并判定闸门
agentgate init                 生成一份 agentgate.yml 模板

  -c, --config <path>          配置文件（默认 agentgate.yml）
      --json                   输出机器可读报告
      --save-baseline          把当前结果记为基线
      --quiet                  关闭逐次尝试的进度输出
```

## 参考

- [Your Agent Aced the Task. Will It Do It Again?](https://huggingface.co/blog) —— IBM Research / Hugging Face，2026-09。提出了 `pass^k` 和 Consistency Analyzer，底层算法已在 ALTK-Evolve 开源。
- Splunk，*Evaluating AI Agents on Tool Calling and Planning* —— 报告了 36% 的 `pass^10` 结果，并解释了基准分数为何有误导性。
- AWS，*AI agent regression testing to GitHub Actions* —— 同样的闸门思路，但只报 `Mean@k`。

## 状态

v0.1覆盖判定层：回放、三个指标、阈值、CI 退出码、GitHub annotations。
成本引擎（跨提交缓存、决策点重采样、局部回放）和脆弱点定位是接下来的计划。

## 许可证

MIT