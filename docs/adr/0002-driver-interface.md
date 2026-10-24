# ADR-0002: AgentDriver 接口形态

状态：已接受（M0）

## 背景
要编排 Claude Code / Codex / ZCode / 任意命令四类 CLI，且「同一剧本经归一化后
事件序列完全一致」必须可测。CI 里没有真实 API key，也没有全部真实 CLI。

## 决策
1. 驱动接口 = `detect / buildArgs / spawn`（会话对象 = `events / sendFollowUp /
   cancel / whenExit`），见 ARCHITECTURE §3。
2. **wire 解析是纯函数**：每个驱动导出 `parseWireLine(line): AgentEventBody[]`，
   会话循环只做「读行 → 喂解析器 → 推通道」。因此一致性测试 = 剧本 → 各驱动
   `renderWire`（测试工具）→ `parseWireLine` → 能力过滤 → 逐事件比对，全离线可跑。
3. 会话事件流契约：`session.started` 开头、`session.completed` 结尾，缺失由驱动合成。
4. 能力矩阵（resume/followUp/toolEvents/usageEvents/thinking/fileChanges/
   modelSelection）由驱动如实声明，一致性测试锁死声明与实际行为。
5. generic-shell：任意命令 + stdout 结构化捕获——行是带合法 kind 的 JSON 则归一化，
   否则落 `session.log`。能力最受限但永远可用（兜底）。
6. 禁伪终端/抓屏；全部走 CLI 的非交互 JSON 流输出。

## 后果
+ 一致性测试无需真实 CLI/key，三平台 CI 可跑。
+ 解析器 bug 与进程管理 bug 天然隔离。
− 各 CLI 新版本 wire 变化需要更新 fixture；缓解：未识别行落 `raw` 不中断会话。
