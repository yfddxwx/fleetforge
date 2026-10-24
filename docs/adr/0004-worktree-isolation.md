# ADR-0004: git worktree 作为唯一隔离手段

状态：已接受（M0）

## 背景
禁止 Docker；多任务必须真正并行修改文件而不互相污染；产物要能审查、合并、丢弃。

## 决策
- 每个运行中任务：`git worktree add <state>/worktrees/<taskId> -b fleet/<taskId8>-<slug> <baseBranch>`。
- node_modules 复用：worktree 内 junction（Windows）/symlink（POSIX）指向主仓库
  node_modules；agent 只读使用；确需安装新依赖的任务由剧本/命令自担。
- 分支命名规范：`fleet/<taskId 前 8 位>-<slug>`； taskId 全局唯一 ⇒ 分支全局唯一。
- 冲突预检：合并前 `git merge-tree --write-tree`（git ≥ 2.38）做真实三方合并预演，
  失败 ⇒ 任务置 conflict，列出冲突文件与处理指引。
- 回收：worktree remove + 分支删除（done/cancelled 后手动触发或回收策略触发）；
  有未提交更改时必须显式确认。
- server 崩溃恢复：启动时以 DB 为准对账 git（孤儿 worktree 清点、锁定任务收割）。

## 后果
+ 零容器依赖，Windows 原生可跑。
+ diff/合并/丢弃都是纯 git 操作，可 dry-run。
− agent 必须在 worktree cwd 内工作（驱动 SpawnOptions.cwd 强制传入）。
− junction 指向主仓库 node_modules，agent 全局安装类操作可能污染主仓库——文档明示。
