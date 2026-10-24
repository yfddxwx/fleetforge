# Changelog

All notable changes to FleetForge are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/) · [Conventional Commits](https://www.conventionalcommits.org/).

## [0.1.0] - 2026-10-25 (M0)

### Added
- pnpm monorepo scaffold (schema/drivers/worktree/store/orchestrator/usage/server/cli + apps/web + fixtures/sim-agent), TS strict, NodeNext.
- Unified event schema v1: 14 normalized event kinds, versioned envelope, zod-validated (`packages/schema`).
- `AgentDriver` interface finalized: detect/buildArgs/spawn + session (events/sendFollowUp/cancel/whenExit), capability matrix, event channel, process-tree reaping (taskkill on Windows, process-group on POSIX).
- Architecture docs: `docs/ARCHITECTURE.md` (event schema v1 + driver interface finalized), ADR-0001..0005, `docs/drivers.md`, sim-agent scenario format (`fixtures/sim-agent/README.md`).
- CI: 3-platform matrix (ubuntu/windows/macos), coverage gate job.
