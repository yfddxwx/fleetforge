# ADR-0003: SQLite 作为互斥与持久化基座

状态：已接受（M0）

## 背景
红线：任何时刻不允许两个运行中任务共享 worktree/分支。单机单 server 进程部署
（无 Docker），持久化需求 = 任务/会话/事件/用量。

## 决策
- better-sqlite3，WAL 模式，外键开启。
- `worktree_locks(worktreePath UNIQUE, branch UNIQUE)`：调度器派发前在
  `BEGIN IMMEDIATE` 事务内 INSERT 占位，任务终态时 DELETE 释放。数据库层硬约束，
  应用层 bug 无法绕过。
- 事件表 `(session_id, seq)` 唯一；seq 由摄取器在事务内分配，天然抗并发摄取。
- 不引入网络数据库/队列：单机指挥台的运维面必须为零。

## 后果
+ 互斥不依赖应用层正确性，可用属性测试直接验证不变量。
+ 同步事务语义让调度器状态机简单可推理。
− 单写者限制：事件摄取是唯一的写热点；WAL + 批量写应对 50 并发会话压测。
