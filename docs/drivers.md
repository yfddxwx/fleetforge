# 新增驱动指南（drivers.md）

FleetForge 通过 `AgentDriver` 接口编排任意 coding agent CLI。本文是给驱动作者的
操作指南；接口定稿见 `docs/ARCHITECTURE.md` §3，决策记录见 `docs/adr/0002`。

## 1. 驱动必须满足的契约

1. **结构化 JSON 流**：以 CLI 的非交互 JSON 输出模式运行。禁止伪终端 / 抓屏 / TUI 解析。
2. **纯函数解析**：`parseWireLine(line: string): AgentEventBody[]` 必须是纯函数；
   会话循环逐行喂给它。不认识的行 → `ev("raw", { wire: line })`，**绝不抛错、绝不丢行**。
3. **生命周期合成**：流以 `session.started` 开头、`session.completed` 结尾。
   CLI 自带则透传；不带则在 spawn 后 / 进程退出时合成。
4. **进程树收割**：用 `spawnTree()`（`src/process.ts`）起子进程；cancel 走
   `killTree()`。不要自己 `child.kill()` 单进程——Windows 上会留孤儿孙进程。
5. **能力如实声明**：`capabilities` 七个布尔位与真实行为一致，一致性测试会锁死。

## 2. 最小实现骨架

```ts
import { AgentDriver, DriverSession, SpawnOptions, EventChannel, spawnTree } from "@fleetforge/drivers";
import { ev } from "@fleetforge/schema";

export class MyAgentDriver implements AgentDriver {
  id = "my-agent";
  label = "My Agent";
  capabilities = { resume: false, followUp: false, toolEvents: true,
                   usageEvents: true, thinking: false, fileChanges: false, modelSelection: true };

  async detect() {
    const version = await probeVersion("my-agent", ["--version"]);
    return { driverId: this.id, installed: version !== null, version,
             authenticated: "unknown" as const, capabilities: this.capabilities,
             hint: version === null ? "npm i -g my-agent" : null };
  }

  buildArgs({ prompt, model }) {
    return ["-p", prompt, "--json", ...(model ? ["--model", model] : [])];
  }

  spawn(opts: SpawnOptions): DriverSession {
    const channel = new EventChannel();
    channel.push(ev("session.started", { driver: this.id, model: opts.model, pid: null, externalRef: null }));
    // spawnTree + readline 逐行 → parseWireLine → channel.push
    // 进程退出 → 合成 session.completed → channel.close()
    return { /* sessionId, pid, events: channel, sendFollowUp, cancel, whenExit */ };
  }
}

export function parseWireLine(line: string): AgentEventBody[] {
  // CLI 的 JSONL → 归一化事件；解析失败 → [ev("raw", { wire: line, parseError })]
}
```

注册：在 `packages/drivers/src/registry.ts` 的 `defaultRegistry()` 里加入即可，
`fleet doctor` 与调度器自动可见。

## 3. 一致性测试（必须通过）

在 `packages/drivers/test/conformance/` 放两组文件：

- `<driver>.wire.txt` —— 你的 CLI 真实输出样例（手工截取若干行，或由
  `renderWire(canonicalScenario)` 生成后固化）。
- `<driver>.expected.jsonl` —— 期望的归一化事件序列。

测试通用逻辑（`conformance.test.ts`）：
1. 逐行喂 `parseWireLine`，拼接结果与 expected 逐事件相等；
2. 跨驱动：canonical 剧本 → 各驱动 render → parse → 按各自 capabilities 过滤
   （例如 generic-shell 无 toolEvents ⇒ 剧本中的 tool 步骤过滤掉）→ 与 golden 相等。

写新驱动时先跑 `renderWire` 生成 wire 样例，手工确认没有丢语义，再固化。

## 4. detect 的规矩

- 只做只读探测：`--version`、登录态检查命令、配置文件存在性。
- 超时 ≤ 5s；失败一律 `installed: false` + `hint`（怎么装、怎么登录），绝不抛错。
- 不要在 detect 里真正跑任务或耗 token。

## 5. 追问（followUp）支持判据

只有当 CLI 支持向**运行中**进程注入输入（stdin 协议、socket、`--continue` 类机制）
才可声明 `followUp: true`。单发单收型 CLI（claude-code/codex 的 exec 模式）请声明
false，并实现 `resume`（下次 spawn 复用会话）作为替代交互路径。
