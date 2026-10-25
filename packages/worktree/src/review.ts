import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiffFile, DiffSummary, MergeStrategy } from "@fleetforge/schema";
import { branchExists, git, gitOk } from "./git.js";
import { WorktreeManager } from "./worktree-manager.js";

export interface ReviewSpec {
  taskId: string;
  repoPath: string;
  branch: string;
  baseBranch: string;
  worktreePath: string | null;
}

export class MergeConflictError extends Error {
  constructor(
    message: string,
    public readonly conflicts: string[],
  ) {
    super(message);
    this.name = "MergeConflictError";
  }
}

/**
 * Diff generation + merge precheck + merge execution (ADR-0004).
 *
 * Merges never touch any checkout: fast-forwards move the base ref via
 * `update-ref`; squash/merge strategies synthesize the commit in a temporary
 * detached worktree, then move the ref. Conflict precheck runs a real
 * three-way `merge-tree --write-tree` (dry-run by construction).
 */
export class Reviewer {
  constructor(private readonly worktrees: WorktreeManager) {}

  /** Diff branch vs base: files, per-file stats, patch, ahead/behind. */
  async diffSummary(spec: ReviewSpec): Promise<DiffSummary> {
    const repo = spec.repoPath;
    if (!(await branchExists(repo, spec.branch))) {
      throw new Error(`branch not found: ${spec.branch}`);
    }
    const range = `${spec.baseBranch}...${spec.branch}`;

    const numstat = await gitOk(repo, ["diff", "--numstat", range]);
    const files: DiffFile[] = [];
    for (const line of numstat.split("\n").filter(Boolean)) {
      const [add, del, path] = line.split("\t");
      if (!path) continue;
      if (add === "-" || del === "-") {
        files.push({ path, change: "modify", additions: 0, deletions: 0, binary: true });
      } else {
        files.push({ path, change: "modify", additions: Number(add), deletions: Number(del), binary: false });
      }
    }
    // renames/adds/deletes via --name-status (takes precedence per path)
    const status = await git(repo, ["diff", "--name-status", "-M", range]);
    if (status.ok) {
      const byPath = new Map(files.map((file) => [file.path, file]));
      for (const line of status.stdout.split("\n").filter(Boolean)) {
        const parts = line.split("\t");
        const code = parts[0] ?? "";
        if (code.startsWith("R") || code.startsWith("C")) {
          const newPath = parts[2];
          const oldPath = parts[1];
          if (newPath && oldPath) {
            const existing = byPath.get(newPath);
            if (existing) {
              existing.change = "rename";
              files.push({ path: oldPath, change: "delete", additions: 0, deletions: 0, binary: false });
            }
          }
        } else if (code === "A") {
          const path = parts[1];
          if (path) {
            const existing = byPath.get(path);
            if (existing) existing.change = "add";
            else files.push({ path, change: "add", additions: 0, deletions: 0, binary: false });
          }
        } else if (code === "D") {
          const path = parts[1];
          if (path) {
            const existing = byPath.get(path);
            if (existing) existing.change = "delete";
            else files.push({ path, change: "delete", additions: 0, deletions: 0, binary: false });
          }
        }
      }
    }

    const patchResult = await git(repo, ["diff", "--patch", range]);
    const patch = patchResult.ok ? patchResult.stdout : "";

    const ahead = Number((await gitOk(repo, ["rev-list", "--count", `${spec.baseBranch}..${spec.branch}`])).trim());
    const behind = Number((await gitOk(repo, ["rev-list", "--count", `${spec.branch}..${spec.baseBranch}`])).trim());
    const commits = ahead;

    const precheck = await this.precheck(spec);
    return {
      taskId: spec.taskId,
      branch: spec.branch,
      baseBranch: spec.baseBranch,
      commits,
      files,
      ahead,
      behind,
      conflicts: precheck.conflicts,
      mergeable: precheck.mergeable,
      patch,
    };
  }

  /** Real three-way dry-run: `git merge-tree --write-tree base branch`. */
  async precheck(spec: ReviewSpec): Promise<{ mergeable: boolean; conflicts: string[] }> {
    const result = await git(spec.repoPath, [
      "merge-tree",
      "--write-tree",
      "--name-only",
      spec.baseBranch,
      spec.branch,
    ]);
    if (result.ok) {
      return { mergeable: true, conflicts: [] };
    }
    // git ≥2.39 exits 1 on conflicts. stdout: tree OID, conflicted paths,
    // then informational lines ("Auto-merging …", "CONFLICT … in <path>").
    const lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const conflicts = new Set<string>();
    for (const line of lines.slice(1)) {
      const conflictMatch = /^CONFLICT .* in (.+)$/.exec(line);
      if (conflictMatch?.[1]) {
        conflicts.add(conflictMatch[1]);
      } else if (!/^(Auto-merging|warning|error:|fatal:)/.test(line)) {
        conflicts.add(line);
      }
    }
    return { mergeable: false, conflicts: [...conflicts] };
  }

  /**
   * Merge the task branch into its base. `dryRun` performs only the precheck.
   * Throws MergeConflictError with conflicting paths on a failed precheck.
   */
  async merge(spec: ReviewSpec, strategy: MergeStrategy, options: { dryRun: boolean; message?: string }): Promise<{ merged: boolean; strategy: MergeStrategy; dryRun: boolean; commit: string | null; conflicts: string[] }> {
    const precheck = await this.precheck(spec);
    if (!precheck.mergeable) {
      throw new MergeConflictError(
        `conflicts between ${spec.branch} and ${spec.baseBranch}: ${precheck.conflicts.join(", ")}`,
        precheck.conflicts,
      );
    }
    if (options.dryRun) {
      return { merged: false, strategy, dryRun: true, commit: null, conflicts: [] };
    }

    const repo = spec.repoPath;
    const branchHead = (await gitOk(repo, ["rev-parse", spec.branch])).trim();
    // Record whether the main worktree can be fast-forwarded in place
    // (clean and on the base branch) BEFORE moving the ref — after update-ref
    // the status would show phantom deletions.
    const syncable = await this.mainWorktreeSyncable(repo, spec.baseBranch);

    if (strategy === "ff") {
      const isAncestor = await git(repo, ["merge-base", "--is-ancestor", spec.baseBranch, spec.branch]);
      if (!isAncestor.ok) {
        throw new Error(`branch is not ahead of ${spec.baseBranch}; use squash or merge strategy`);
      }
      await gitOk(repo, ["update-ref", `refs/heads/${spec.baseBranch}`, branchHead]);
      if (syncable) await this.materialize(repo, spec.baseBranch);
      return { merged: true, strategy, dryRun: false, commit: branchHead, conflicts: [] };
    }

    // squash / merge: synthesize the commit in a detached temp worktree
    const tmp = mkdtempSync(join(tmpdir(), "fleetforge-merge-"));
    try {
      const added = await git(repo, ["worktree", "add", "--detach", tmp, spec.baseBranch]);
      if (!added.ok) {
        throw new Error(`temp merge worktree failed: ${added.stderr.trim()}`);
      }
      try {
        let commitOid: string | null = null;
        if (strategy === "squash") {
          const squash = await git(tmp, ["merge", "--squash", spec.branch]);
          if (!squash.ok) throw new Error(`squash failed: ${squash.stderr.trim()}`);
          const message = options.message ?? `fleet: merge ${spec.branch} (squash)`;
          const commit = await git(tmp, [
            "-c", "user.name=fleet", "-c", "user.email=fleet@local",
            "commit", "-m", message,
          ]);
          if (!commit.ok) throw new Error(`squash commit failed: ${commit.stderr.trim()}`);
          commitOid = (await gitOk(tmp, ["rev-parse", "HEAD"])).trim();
        } else {
          const message = options.message ?? `fleet: merge ${spec.branch}`;
          const merge = await git(tmp, [
            "-c", "user.name=fleet", "-c", "user.email=fleet@local",
            "merge", "--no-ff", spec.branch, "-m", message,
          ]);
          if (!merge.ok) throw new Error(`merge failed: ${merge.stderr.trim()}`);
          commitOid = (await gitOk(tmp, ["rev-parse", "HEAD"])).trim();
        }
        if (commitOid) {
          await gitOk(repo, ["update-ref", `refs/heads/${spec.baseBranch}`, commitOid]);
          if (syncable) await this.materialize(repo, spec.baseBranch);
        }
        return { merged: true, strategy, dryRun: false, commit: commitOid, conflicts: [] };
      } finally {
        await git(repo, ["worktree", "remove", "--force", tmp]);
      }
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }

  /**
   * Merges move refs without touching checkouts. When the main repository sits
   * cleanly on the base branch, the merged files are materialized there so
   * operators see the result immediately; otherwise only the ref moves.
   */
  private async mainWorktreeSyncable(repo: string, baseBranch: string): Promise<boolean> {
    const head = await git(repo, ["symbolic-ref", "--quiet", "HEAD"]);
    if (!head.ok || head.stdout.trim() !== `refs/heads/${baseBranch}`) return false;
    const status = await git(repo, ["status", "--porcelain"]);
    return status.ok && status.stdout.trim().length === 0;
  }

  private async materialize(repo: string, baseBranch: string): Promise<void> {
    await git(repo, ["checkout", "--quiet", baseBranch, "--", "."]);
  }

  /**
   * Discard a task: remove its worktree and branch. Refuses (throws
   * DirtyWorktreeError) when uncommitted changes exist unless `force` —
   * the API layer maps that to an explicit-confirmation requirement.
   */
  async discard(spec: ReviewSpec, options: { force: boolean }): Promise<{ removedWorktree: boolean; removedBranch: boolean; wasDirty: boolean }> {
    const dirty = spec.worktreePath !== null && existsSync(spec.worktreePath)
      ? await this.worktrees.isDirty(spec.worktreePath)
      : false;
    if (dirty && !options.force) {
      const err = new Error(`worktree has uncommitted changes: ${spec.worktreePath} — confirm with force`);
      err.name = "DirtyWorktreeError";
      throw err;
    }
    return this.worktrees.remove(
      { taskId: spec.taskId, repoPath: spec.repoPath, branch: spec.branch },
      { deleteBranch: true, force: true },
    );
  }
}
