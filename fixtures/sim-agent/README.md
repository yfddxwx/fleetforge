# sim-agent — 可编程剧本的假 coding agent

> 只允许用于测试与 CI。生产调度器对它一视同仁：它就是一个遵循 wire 协议的
> coding agent CLI。

## CLI

```
sim-agent --script scenario.json [--speed N] [--cwd DIR]
```

- `--speed N`：时间因子，N=0 全速（sleep 步长清零），N>0 步长除以 N。CI 用 0。
- wire 输出走 **stdout（JSONL）**，人类可读日志走 stderr。退出码：剧本正常完成 0；
  `crash`/`fail` 步按剧本指定。

## 剧本格式（v1）

```jsonc
{
  "name": "fizzbuzz",              // 展示名
  "model": "sim-large",            // usage 事件里的模型名
  "wire": "sim",                   // 输出协议，v1 只有 "sim"
  "externalRef": "sim-session-1",  // resume 句柄（可选）
  "followUp": true,                // 是否支持追问（可选，默认 true）
  "steps": [
    { "type": "think",  "text": "分析任务..." },
    { "type": "say",    "text": "我来写 FizzBuzz" },
    { "type": "write",  "path": "fizzbuzz.ts", "content": "...", "mode": "create" },
    { "type": "tool",   "name": "Write", "input": { "path": "fizzbuzz.ts" },
                        "output": "ok", "status": "success" },
    { "type": "shell",  "command": "git add -A && git commit -m feat: fizzbuzz" },
    { "type": "usage",  "inputTokens": 1200, "outputTokens": 300,
                        "cacheReadTokens": 0, "cacheWriteTokens": 0 },
    { "type": "sleep",  "ms": 500 },
    { "type": "crash",  "exitCode": 1, "after": 2 },   // after: 前置 sleep ms；终止进程
    { "type": "fail",   "message": "tests failed" }    // 正常完成但失败语义
  ]
}
```

## 步骤语义

| type | 行为 |
| --- | --- |
| `think` | 输出 `thinking` 事件 |
| `say` | 输出 `message.delta`（可分片）+ 末尾 `message` |
| `write` | 在 cwd 真实写文件（`mode: create/append`），并输出 `file.changed` |
| `edit` | 在 cwd 真实编辑文件（old/new 文本替换），输出 `file.changed` |
| `delete` | 删除文件，输出 `file.changed` |
| `tool` | 输出 `tool.started` + `tool.completed` |
| `shell` | cwd 内真实执行 shell 命令（供剧本 git commit 等），stdout/stderr 落 `session.log`；非零退出 → `fail` |
| `usage` | 输出 `usage` 事件 |
| `sleep` | 停顿 ms（受 --speed 影响） |
| `crash` | 输出 stderr 日志后按 exitCode 退出（模拟中途崩溃；会话无 completed） |
| `fail` | 输出失败 message，`session.completed(status=failed)`，退出码 1 |

## 设计要点

- **真实副作用**：`write/shell` 在 cwd 里真的改文件、真的跑 git —— 所以 sim 任务
  在 worktree 里能产出真实 diff、真实冲突（M5/M8 E2E 的基础）。
- **确定性**：无随机、无时钟依赖（sleep 受 speed 控制），CI 三平台回放结果一致。
- **崩溃可注入**：`crash` 步让 M3 的崩溃重启策略、孤儿清扫有真实演练对象。
