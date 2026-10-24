# Changelog

All notable changes to FleetForge are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/) · [Conventional Commits](https://www.conventionalcommits.org/).

## [0.5.0] - 2026-10-25 (M4)

### Added
- `packages/server` FleetServer (Fastify): REST under `/api` (tasks CRUD + dispatch/cancel/followup, events replay with seq cursor, transcript aggregation, sessions, agents roster with capability matrix + usage, usage/aggregate, settings, doctor, prices GET/PUT) and WebSocket gateway `/ws` (hello/event/task/notification; client followup + ping).
- Follow-up path end to end: `SessionRunner.followUp` → driver stdin → `followup` event persisted & broadcast; capability-gated (409 when unsupported).
- `fleet serve` (SIGINT/SIGTERM graceful), `fleet board` — TTY keyboard view (j/k navigate, d dispatch, c cancel-with-confirm, f follow-up prompt, r refresh, ? help, q quit) reading the WAL DB while commands go over HTTP; non-interactive one-shot mode for scripts.
- `docs/shortcuts.md` keymap for CLI board + planned web console keys.
- Session transcript endpoint (messages/tools/follow-ups ordered).
- 6 server integration tests (live WS, REST lifecycle, follow-up delivery, aggregates); workspace now at 100 tests.

## [0.4.0] - 2026-10-25 (M3)

### Added
- `packages/worktree`: git worktree lifecycle — `fleet/<id8>-<slug>` branch per task, node_modules reuse via junction (Windows)/symlink (POSIX), dirty guard, force reclaim with fallback, fleet worktree listing. Real-git tests incl. isolation & branch-only commits.
- `packages/orchestrator` Scheduler: priority queue with two-tier concurrency caps (global + per-repo), parallel task startup with reservation accounting, DB-level worktree/branch mutex acquired before every run, crash restart policy (`attempt < maxAttempts → requeue`), heartbeat watchdog sweep (`killPidTree` reaps stale sessions by PID tree), and `recover()` startup reconciliation (reaps orphaned CLIs, requeues/fails tasks, releases stale locks).
- Property test: random 12-task stream over 2 repos sampled at 30ms — zero mutex/cap violations, all tasks complete in distinct worktrees.
- Real-process tests: crash→rewrite-scenario→retry succeeds; sweep reaps a hung CLI by PID; `recover()` after simulated server kill.
- Coverage gates wired into CI: worktree 88% lines / 82% branches, orchestrator 84% / 79% (threshold 70%).

## [0.3.0] - 2026-10-25 (M2)

### Added
- Real CLI drivers: `claude-code` (`-p --output-format stream-json --verbose`, `--resume`), `codex` (`exec --json`, `exec resume <thread>`), `zcode` (claude-family headless protocol). All share the drain-aware line session loop; env overrides `FLEETFORGE_CLAUDE_PATH/_CODEX_PATH/_ZCODE_PATH`.
- `codex-wire` parser: thread/turn/item mapping (agent_message, reasoning, command_execution, file_change, mcp/web_search), turn usage, turn.failed/error → failed completion.
- Driver conformance suite: one canonical scenario → per-family wire renderers (claude/sim/zcode/codex/generic-shell) → pure parsers → capability filter → golden sequence identity; tool identity by `toolCallId`, driver-dialect tool names documented; unknown wire lines always fall back to `raw`.
- `fleet doctor`: environment checks (git/node/sim fixture), per-agent installed/version/login/capability matrix with actionable hints, price-table source. Verified on a machine with no real CLIs: reports exactly what is missing and how to fix.
- `DriverDetect.label` added for roster/doctor surfaces.

## [0.2.0] - 2026-10-25 (M1)

### Added
- `packages/store`: SQLite persistence (better-sqlite3, WAL) — tasks/sessions/events/usage/worktree_locks/settings; per-session monotonic seq allocation; invalid payloads downgrade to `raw` envelopes; DB-level worktree/branch/task mutex with stale-lock reconciliation.
- `fixtures/sim-agent`: programmable fake coding-agent CLI — claude-stream-json-shaped wire, real file/shell/git side effects, streaming deltas, tool calls, usage, crash injection, stdin follow-ups; deterministic under `--speed 0`.
- `packages/drivers`: shared line-protocol session loop (lifecycle synthesis, stderr-drain-aware completion, process-tree reaping), claude-family wire parser (pure `parseWireLine`), `sim` driver, `generic-shell` driver (schema-JSON stdout capture), driver registry; Windows `taskkill /T` tree-kill tested for grandchildren.
- `packages/usage`: configurable price table (glob patterns, JSON override via `FLEETFORGE_PRICES`), cost estimation, unpriced-model visibility.
- `packages/orchestrator`: ingestion pipeline (validate → envelope → SQLite → usage cost rollup) and `SessionRunner` (spawn → pump → finalize task/session state machine).
- `packages/cli`: `fleet version`, `fleet task new` — inline M1 mode with live normalized event stream rendering (deltas folded, tools/files/tokens colorized).
- 69 tests across 7 suites; `fleet task new --agent sim "写个 FizzBuzz"` verified end-to-end on Windows.

## [0.1.0] - 2026-10-25 (M0)

### Added
- pnpm monorepo scaffold (schema/drivers/worktree/store/orchestrator/usage/server/cli + apps/web + fixtures/sim-agent), TS strict, NodeNext.
- Unified event schema v1: 14 normalized event kinds, versioned envelope, zod-validated (`packages/schema`).
- `AgentDriver` interface finalized: detect/buildArgs/spawn + session (events/sendFollowUp/cancel/whenExit), capability matrix, event channel, process-tree reaping (taskkill on Windows, process-group on POSIX).
- Architecture docs: `docs/ARCHITECTURE.md` (event schema v1 + driver interface finalized), ADR-0001..0005, `docs/drivers.md`, sim-agent scenario format (`fixtures/sim-agent/README.md`).
- CI: 3-platform matrix (ubuntu/windows/macos), coverage gate job.
