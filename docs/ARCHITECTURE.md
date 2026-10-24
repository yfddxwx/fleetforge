# FleetForge — Agent 舰队指挥台 · 架构

> 状态：本文档在 M0 定稿 **统一事件 schema v1** 与 **AgentDriver 接口**。
> 架构决策的沿革见 `docs/adr/`。

FleetForge 不自己造 agent。它把现成的 coding agent CLI（Claude Code、Codex、ZCode、
或任意命令）编排成一支可并行作业的舰队：任务看板派发 → git worktree 隔离并行执行 →
实时事件流聚合 → diff 审查合并 → 成本仪表盘。对标 paperclipai/paperclip 与 stablyai/orca。

```
                ┌────────────────────────────────────────────────┐
                │                    apps/web                    │
                │   看板 · 花名册 · 任务详情 · 成本仪表盘 · 设置   │
                └───────────────▲────────────────▲───────────────┘
                          REST │          WS /ws │ (events / board / roster)
                ┌───────────────┴────────────────┴───────────────┐
                │              packages/server (Fastify)         │
                │   ingest → envelope(seq) → SQLite → broadcast  │
                └───────▲───────────────▲────────────────▲───────┘
                        │               │                │
                ┌───────┴──────┐ ┌──────┴───────┐ ┌──────┴────────┐
                │orchestrator  │ │ store(SQLite)│ │ usage/prices  │
                │队列·锁·心跳  │ │ 任务/会话/   │ │ 价格表·聚合   │
                └───────▲──────┘ │ 事件/用量/锁 │ └───────────────┘
                        │        └──────────────┘
                ┌───────┴─────────────────────────────────────────┐
                │            packages/drivers                     │
                │  claude-code · codex · zcode · generic-shell·sim│
                │  wire JSON ──parseWireLine──▶ 归一化事件(v1)     │
                └───────▲─────────────────────────────────────────┘
                        │ spawn (结构化 JSON 流，绝无伪终端/抓屏)
                ┌───────┴───────┐   每任务独立 worktree + 独立分支
                │  agent CLI    │   fleet/task-abc123 (from main)
                │ in worktree   │◀── packages/worktree
                └───────────────┘
```

## 1. Workspace 结构

| 包 | 职责 |
| --- | --- |
| `packages/schema` | 统一事件与领域模型（Task/Session/Event/Usage/Diff），**版本化**。所有驱动输出归一化的唯一目标。 |
| `packages/drivers` | `AgentDriver` 统一接口 + 内置驱动：`claude-code`、`codex`、`zcode`、`generic-shell`、`sim`。 |
| `packages/worktree` | git worktree 生命周期：创建、node_modules 复用（junction/链接）、分支命名、冲突预检、回收。 |
| `packages/store` | SQLite 持久化（better-sqlite3）：tasks/sessions/events/usage/locks/settings。 |
| `packages/orchestrator` | 调度器：队列与优先级、并发上限（全局/每仓库）、DB 级 worktree/分支互斥、心跳与孤儿收割、崩溃重启策略。 |
| `packages/usage` | usage 事件 → token 计量 → 按价格表估算成本 → 按任务/agent/日聚合。 |
| `packages/server` | Fastify REST + WebSocket 网关；事件摄取（定 seq、校验、落库、广播）。 |
| `packages/cli` | `fleet serve / task / board / doctor / version`。 |
| `apps/web` | React 19 控制台。 |
| `fixtures/sim-agent` | 可编程剧本的假 coding agent CLI（只用于测试与 CI）。 |

## 2. 统一事件 schema v1（定稿）

单一真理源：`packages/schema/src/events.ts`（zod 校验 + TS 类型）。

### 2.1 信封（envelope）

```ts
interface EventEnvelope<K> {
  id: string;            // event uuid
  seq: number;           // 会话内单调递增，1 起，由 server 摄取时分配
  ts: number;            // epoch ms；驱动可带，否则摄取时盖戳
  schemaVersion: 1;      // SCHEMA_VERSION
  taskId: string;
  sessionId: string;
  kind: EventKind;
  payload: EventPayloads[K];
}
```

驱动产出的是**事件体** `AgentEventBody { kind, ts?, payload }`（无身份、无 seq）。
server 摄取管线：zod 校验（未知 kind 或载荷违规 → 拒绝并落 `raw`）→ 分配 seq →
写 SQLite → WebSocket 广播。消费端永远只面对信封。

### 2.2 事件种类（14 种）

| kind | 语义 | 载荷要点 |
| --- | --- | --- |
| `session.started` | 会话开始（流中第一个事件） | driver, pid?, model?, externalRef? |
| `session.completed` | 会话结束（流中最后一个事件） | status: completed/failed/cancelled, exitCode?, error? |
| `turn.started` / `turn.completed` | 一轮推理的边界 | turn 序号, stopReason? |
| `message` | 完整消息 | role: assistant/user/system, text |
| `message.delta` | 助手消息流式分片 | text（拼接即完整消息） |
| `thinking` | 思维链分片 | text |
| `tool.started` / `tool.completed` | 工具调用边界 | toolCallId, name, input / status+output/error |
| `usage` | token 计量 | model?, inputTokens, outputTokens, cacheRead/Write |
| `file.changed` | 文件变更通知 | path, change: add/modify/delete/rename |
| `session.log` | 控制台输出（stderr、generic-shell 的非 JSON stdout） | stream, text |
| `followup` | 操作者向运行中会话追加的指令 | text |
| `raw` | 无法归一化的原始行（永不丢弃，用于排障） | wire, parseError? |

**生命周期契约**：每个会话的事件流必须以 `session.started` 开头、`session.completed`
结尾。底层 CLI 不发就由驱动合成（init 行 → started；进程退出 → completed）。
`session.completed.status` 与任务状态机的关系：completed→review，failed→failed（或按
重启策略重排），cancelled→cancelled。

**成本不在事件里**：`usage` 只带 token 数；美元成本由 `packages/usage` 按
**价格表（可配置 JSON）** 计算，价格可随时修正而不污染历史事件。

### 2.3 演进规则

- 新增 kind / 新增可选载荷字段 → minor（SCHEMA_VERSION 不变，老消费端必须容忍未知字段）。
- 删除字段 / 收紧约束 / 改变语义 → major，SCHEMA_VERSION +1，server 按 kind 白名单降级转换。
- `raw` 是永久逃生舱：驱动遇到不认识的 wire 行不是报错，而是归一化为 `raw`。

## 3. AgentDriver 接口（定稿）

单一真理源：`packages/drivers/src/types.ts`。

```ts
interface AgentDriver {
  id: string;                    // "claude-code" | "codex" | "zcode" | "generic-shell" | "sim"
  label: string;
  capabilities: DriverCapabilities;   // resume/followUp/toolEvents/usageEvents/thinking/fileChanges/modelSelection
  detect(): Promise<DriverDetect>;    // 探测本机 CLI：是否安装、版本、登录态
  buildArgs(opts): string[];          // 将要执行的 argv（doctor / dry-run 展示）
  spawn(options: SpawnOptions): DriverSession;
}

interface DriverSession {
  sessionId: string;
  pid: number | null;
  events: AsyncIterable<AgentEventBody>;  // 已归一化；以 started 开头、completed 结尾
  sendFollowUp(text): Promise<void>;      // capabilities.followUp=false 时抛 FollowUpUnsupportedError
  cancel(): Promise<void>;                // 终止整个进程树（Windows: taskkill /T /F）
  whenExit(): Promise<SessionExit>;       // { code, signal }
}
```

### 3.1 铁律

1. **只走结构化 JSON 流**：每个驱动都以 CLI 的非交互 JSON 输出模式运行
   （claude-code `-p --output-format stream-json`、codex `exec --json`、zcode headless
   JSON 流）。禁止伪终端、禁止抓屏幕、禁止解析 TUI。
2. **`parseWireLine(line) → AgentEventBody[]` 是纯函数**（驱动导出），会话循环只是
   逐行喂给它。一致性测试因此无需真实 CLI：同一 sim 剧本渲染成各驱动的 wire 行，
   经各自 parse 后归一化序列必须完全一致（能力子集过滤后）。
3. **进程可收割**：PIDs 落库；POSIX 上子进程独立进程组，`kill(-pid)`；Windows 上
   `taskkill /pid X /T /F` 按树终止。server 启动时清扫孤儿。
4. **能力如实标注**：驱动宣称的 capabilities 由一致性测试锁死——测试剧本覆盖
   thinking/tool/usage/file 变更，驱动不支持的字段不得虚报。

### 3.2 内置驱动与 wire 协议

| driver | 命令 | wire | resume | followUp |
| --- | --- | --- | --- | --- |
| `claude-code` | `claude -p <prompt> --output-format stream-json --verbose` | JSONL: system.init / assistant / user(tool_result) / result | `--resume <session_id>` | ✗（单发单收，v1） |
| `codex` | `codex exec --json <prompt>` | JSONL: thread.started / turn.started / item.*(command_execution 等) / turn.completed(usage) | `exec resume <thread_id>` | ✗ |
| `zcode` | `zcode -p <prompt> --output-format stream-json` | JSONL（与 claude 流式家族同构，含 zcode 特有扩展） | resume 参数 | ✗ |
| `generic-shell` | 任意 `command args {prompt}` 模板 | stdout 逐行；**行是 JSON 且带合法 kind → 归一化；否则 → `session.log`** | ✗ | ✗ |
| `sim` | `sim-agent --script <scenario.json>`（仅测试/CI） | JSONL 剧本回放 | 剧本决定 | 剧本可开 |

> zcode 驱动的 wire 细节以本机实际 CLI 为准；解析器按「claude stream-json 家族 +
> 宽松扩展」实现，未识别行落 `raw`，绝不抛错中断会话。见 `docs/drivers.md`。

## 4. 隔离与并发（红线）

- **每个运行中任务独占一个 git worktree + 独立分支**（`fleet/<taskid8>-<slug>`，
  从任务 baseBranch 切出）。node_modules 通过 junction（Windows）/symlink（POSIX）
  复用主仓库的安装产物，只读使用。
- **互斥是 DB 级约束**：`worktree_locks` 表对 worktreePath/branch 建唯一索引，
  获取锁用 `BEGIN IMMEDIATE` 事务内 INSERT，绝不允许两个运行中任务共享 worktree/分支。
  调度器另有属性测试（随机任务流下不变量成立）。
- **并发两档上限**：全局 `maxConcurrent`、每仓库 `maxConcurrentPerRepo`，可配置。
- **心跳**：运行中会话每 5s 更新 heartbeatAt；server 每 30s 巡检，超过阈值的会话
  判定孤儿（pid 已死或心跳超时）→ 按 pid 收割残留进程 → 按重启策略处理任务。
- **崩溃重启策略**（可配，任务级覆盖）：`none` | `requeue`（重新排队，attempt+1，
  上限 maxAttempts）| `requeue` 默认 3 次。
- 合并前可 **dry-run 预演**；**丢弃带未提交更改的任务必须显式确认**；
  **默认绝不自动 push**。

## 5. 持久化模型（SQLite）

| 表 | 要点 |
| --- | --- |
| `tasks` | 领域主表；status 机：backlog→queued→running→review→done，旁路 failed/conflict/cancelled |
| `sessions` | 每次驱动 spawn 一行；pid、externalRef、heartbeat、exit code |
| `events` | `(sessionId, seq)` 唯一；payload 存 JSON；id 主键 |
| `usage` | 每条 usage 事件一行（含算好的 costUsd） |
| `worktree_locks` | worktreePath UNIQUE / branch UNIQUE —— 硬互斥 |
| `settings` | 并发上限、驱动开关、合并策略、价格表覆盖 |

better-sqlite3 同步事务是调度器的互斥原语（单进程 server；WAL 模式下 CLI 侧只读
不冲突）。DB 文件默认 `<state-dir>/fleet.db`，`--db` 可指定。

## 6. API 与实时通道

REST（前缀 `/api`）：`/tasks`（CRUD、dispatch/cancel/merge/discard）、`/sessions`、
`/events?sessionId=&after=`（历史回放，按 seq 分页）、`/usage/aggregate`、`/agents`、
`/settings`、`/doctor`。

WS `/ws`：服务端推 `hello`（快照游标）、`event`（信封）、`task`、`board`、`roster`、
`notification`；客户端发 `followup`、`ping`。断线重连用 `hello.lastSeq` 续传。

## 7. 测试与质量基线

- orchestrator / worktree / schema 覆盖率 ≥ 70%（vitest coverage）。
- 驱动一致性测试：sim 剧本 → 各驱动 render → parse → 能力过滤后逐事件相等。
- Windows 进程语义真测：CI 矩阵 ubuntu/windows/macos 全绿；进程树终止、
  孤儿清扫、崩溃恢复都在 Windows runner 上真实执行。
- sim-agent 全场景 E2E 在 CI 无 API key 跑通。

## 8. 里程碑

M0 脚手架 → M1 驱动层+单会话 → M2 真实驱动+doctor → M3 调度器+worktree 隔离 →
M4 会话与追问 → M5 审查与合并 → M6 Web 控制台（一）→ M7 成本+设置 → M8 打磨。
