# FleetForge — Agent 舰队指挥台

把现成的 coding agent CLI（Claude Code、Codex、ZCode、任意命令）编排成一支
可并行作业的舰队：**任务看板派发 → git worktree 隔离并行 → 实时事件流聚合 →
diff 审查合并 → 成本仪表盘**。对标 paperclipai/paperclip 与 stablyai/orca。

- 架构与定稿设计：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（统一事件 schema v1 + AgentDriver 接口）
- 新增驱动指南：[docs/drivers.md](docs/drivers.md)
- 架构决策记录：[docs/adr/](docs/adr/)
- 键盘快捷键：[docs/shortcuts.md](docs/shortcuts.md)
- 变更日志：[CHANGELOG.md](CHANGELOG.md)

## 安装与构建

要求：Node.js ≥ 22、pnpm ≥ 9、git ≥ 2.38（`merge-tree` 冲突预检）。

```bash
pnpm install
pnpm build       # 全 workspace 构建
pnpm test        # 全部测试（含 sim-agent 真进程 E2E）
pnpm lint
```

## 快速开始

```bash
# 0) 体检：探测本机已装的 agent CLI（版本 / 登录态 / 能力矩阵）
pnpm fleet doctor

# 1) 启动指挥台（REST + WebSocket + Web 控制台）
pnpm fleet serve                       # 默认 127.0.0.1:7700
FLEETFORGE_WEB_DIST=apps/web/dist pnpm fleet serve   # 托管 Web 控制台

# 2) 派任务（无任何真实 agent CLI 时用 sim 演示全流程）
node packages/cli/dist/main.js task new --agent sim --repo <git仓库> "写个 FizzBuzz"

# 3) 终端看板（j/k 导航，d 派发，c 取消，f 追问）
pnpm fleet board

# 4) Web 控制台
pnpm --filter @fleetforge/web dev      # 开发模式（代理到 7700）
```

## 工作方式

1. `fleet task new` / `POST /api/tasks` 创建任务（agent + 仓库 + 基分支）。
2. 调度器排队（优先级 + 全局/每仓库并发上限），为每个任务创建独立
   `git worktree` + `fleet/<id>-<slug>` 分支，获取 DB 级互斥锁。
3. 驱动以 CLI 的结构化 JSON 流模式启动 agent（绝不抓终端），
   wire 行经纯函数解析器归一化为统一事件（schema v1）落库并 WebSocket 广播。
4. 会话结束进入 review：看 diff → dry-run 冲突预检 → 合并（ff/squash/merge，
   全程不碰任何 checkout）或丢弃（脏工作区强制确认）。
5. 崩溃自动重启（attempt/maxAttempts），心跳超时的会话按 PID 树收割；
   server 被 kill 后重启会清扫孤儿进程并恢复任务状态。

## 统一事件流

每个会话的事件流以 `session.started` 开头、`session.completed` 结尾，14 种归一化
事件（message.delta / thinking / tool.* / usage / file.changed / followup / raw …）。
未知 wire 行落 `raw`，永不丢弃。`fleet task new` 实时打印归一化流：

```
   1 ▶ session started sim · sim-large · pid 2564
   2 thinking Analyzing request: 写个 FizzBuzz
     assistant 写个 FizzBuzz
   6 tokens: in 64 · out 32
   7 ✔ session completed (exit 0)
```

## CLI 一览

| 命令 | 说明 |
| --- | --- |
| `fleet serve` | 启动指挥台（API + WS + 调度器 + 看门狗 + Web 托管） |
| `fleet task new` | 建任务并内联运行，终端实时事件流 |
| `fleet board` | 终端聚合看板（j/k · d/c/f） |
| `fleet doctor` | 本机 agent 体检（安装/版本/登录态/能力） |
| `fleet version` | 版本与事件 schema 版本 |

## 真实 agent CLI

`fleet doctor` 报告每个驱动的安装与登录态，缺什么就提示怎么装：

| agent | 安装 | 登录 |
| --- | --- | --- |
| claude-code | `npm i -g @anthropic-ai/claude-code` | `claude` 首次运行登录 |
| codex | `npm i -g @openai/codex` | `codex login` |
| zcode | 安装 headless CLI 版本 | 启动登录一次 |

命令路径可用环境变量覆盖：`FLEETFORGE_CLAUDE_PATH` / `FLEETFORGE_CODEX_PATH` /
`FLEETFORGE_ZCODE_PATH`。sim-agent（fixtures/）仅用于测试与 CI。

## REST / WebSocket

REST（`/api`）：tasks（CRUD、dispatch/cancel/followup、events 回放、transcript、
diff、merge、discard）、agents、usage/aggregate、settings、prices、doctor。
WS（`/ws`）：`hello` / `event` / `task` / `notification` 下行，`followup` / `ping` 上行。

## 测试与红线

- 147 测试：驱动一致性（同剧本 → 同归一化序列）、调度器属性测试（随机任务流
  互斥不变量）、worktree 真实 git 测试、server 集成、最终验收 E2E
  （5 任务全场景 + kill server 恢复 + 50 会话摄取压测）。
- 硬杀演练（真实 CLI 路径）：只杀 server 主进程后 agent 工具孙进程存活，
  重启按后代 PID 快照全部收割，任务 attempt 2 重排、看板一致。
- orchestrator / worktree / schema 覆盖率门槛 70%（CI 强制）。
- Windows 进程语义真测：进程树终止（含孙进程）、taskkill 收割、TEMP 句柄竞态。

## 里程碑

M0 脚手架 → M1 驱动+单会话 → M2 真实驱动+doctor → M3 调度+worktree →
M4 会话追问+serve → M5 审查合并 → M6/7 Web 控制台 → M8 打磨。
全部完成，见 CHANGELOG。
