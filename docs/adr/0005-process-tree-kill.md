# ADR-0005: 进程树收割与孤儿清扫

状态：已接受（M0）

## 背景
红线：不许留僵尸 CLI 进程；Windows 进程语义必须真测；server 可能被 kill，
留下仍在运行的 agent。

## 决策
1. spawn：POSIX `detached: true`（独立进程组）；Windows 常规 spawn +
   `windowsHide`。
2. 终止：Windows `taskkill /pid <pid> /T /F`（真·进程树）；POSIX 先
   `process.kill(-pid, SIGTERM)`，2s 不退再 `SIGKILL`。
3. PIDs 落库（sessions.pid）。server 启动时：所有 running 会话 ⇒ 检查 pid ⇒
   活着就按树收割（视为孤儿，server 重启后不再信任）⇒ 会话标记
   `orphan-killed`，任务按重启策略处理。
4. 运行中每 5s 心跳（sessions.heartbeatAt）；巡检发现心跳超时且 pid 存活
   ⇒ 同上收割。防止 CLI 挂死占并发额度。
5. **后代 PID 快照**（M8 补充）：硬杀 server 时，agent CLI 自身可能死亡，但它的
   工具子进程（孙进程）会存活，且其父进程已消失——`taskkill /T` 无法再枚举到它们。
   因此调度器每 10s（真进程，一次 CIM/ps 查询；新会话 spawn 后 1.2s 额外拍一张）
   把每个运行中会话的**全部后代 PID** 合并落库（sessions.descendants）。启动
   `recover()` 与 `sweep()` 除收割记录 PID 外，逐个收割快照中仍存活的后代 PID
   （各自按树终止）。Windows 实测：只杀 server 主进程后 2 个工具孙进程存活，
   重启后按快照全部收割，无残留。

## 后果
+ kill -9 server 也不留僵尸（含工具孙进程）；重启后看板状态一致。
+ 快照是"尽力而为"的：若孙进程在两次快照之间被创建且 server 立即被硬杀，
  它仍可能漏网（10s 窗口）。文档明示；缓解：新会话 spawn 后立即补拍。
− 任务进程被误杀的可能性存在，靠重启策略（requeue）兜底。
− Windows 上快照需要一次 PowerShell CIM 查询（约 300–500ms/10s，单次全表）；
  POSIX 用 `ps -A -o pid=,ppid=`，开销可忽略。
