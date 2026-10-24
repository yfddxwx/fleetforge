# FleetForge — Agent 舰队指挥台

把现成的 coding agent CLI（Claude Code、Codex、ZCode、任意命令）编排成一支
可并行作业的舰队：**任务看板派发 → git worktree 隔离并行 → 实时事件流聚合 →
diff 审查合并 → 成本仪表盘**。

- 统一事件 schema（版本化）+ AgentDriver 统一接口：见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 新增驱动指南：[docs/drivers.md](docs/drivers.md)
- 架构决策记录：[docs/adr/](docs/adr/)
- 键盘快捷键：[docs/shortcuts.md](docs/shortcuts.md)

## 快速开始

```bash
pnpm install
pnpm build
pnpm test

# 启动指挥台（API + WebSocket + Web 控制台）
pnpm fleet serve

# 派发一个 sim 任务（无任何真实 agent CLI 也能全流程演示）
pnpm fleet task new --agent sim --repo <某git仓库> "写个 FizzBuzz"

# 体检：探测本机已装的 agent CLI
pnpm fleet doctor
```

## 状态

按里程碑推进（M0→M8），见 [CHANGELOG.md](CHANGELOG.md)。
