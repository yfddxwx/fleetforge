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

## 后果
+ kill -9 server 也不留僵尸；重启后看板状态一致。
− 任务进程被误杀的可能性存在，靠重启策略（requeue）兜底。
