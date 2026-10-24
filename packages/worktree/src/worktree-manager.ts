import { existsSync, lstatSync, readdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { slugify } from "@fleetforge/schema";
import { branchExists, git, gitOk, hasCommits } from "./git.js";

export interface WorktreeSpec {
  taskId: string;
  title: string;
  repoPath: string;
  baseBranch: string;
}

export interface WorktreeHandle {
  path: string;
  branch: string;
  baseBranch: string;
  nodeModules: "repo" | "junction" | "symlink" | "none";
}

export class WorktreeError extends Error {
  constructor(
    message: string,
    public readonly code: "no-commits" | "base-missing" | "create-failed" | "dirty",
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

/**
 * git worktree lifecycle (ADR-0004): create isolated worktree+branch per task,
 * reuse the repo's node_modules via junction/symlink, clean up on reclaim.
 */
export class WorktreeManager {
  constructor(private readonly worktreesRoot: string) {}

  root(): string {
    return this.worktreesRoot;
  }

  branchNameFor(spec: WorktreeSpec): string {
    return `fleet/${spec.taskId.replace(/^task_/, "").slice(0, 8)}-${slugify(spec.title)}`;
  }

  pathFor(taskId: string): string {
    return join(this.worktreesRoot, taskId);
  }

  /** Create the worktree + branch for a task (throws WorktreeError). */
  async create(spec: WorktreeSpec): Promise<WorktreeHandle> {
    if (!(await hasCommits(spec.repoPath))) {
      throw new WorktreeError(`repository has no commits: ${spec.repoPath}`, "no-commits");
    }
    if (!(await branchExists(spec.repoPath, spec.baseBranch))) {
      throw new WorktreeError(`base branch not found: ${spec.baseBranch}`, "base-missing");
    }
    const path = this.pathFor(spec.taskId);
    if (existsSync(path)) {
      throw new WorktreeError(`worktree path already exists: ${path}`, "create-failed");
    }
    const branch = this.branchNameFor(spec);
    const created = await git(spec.repoPath, [
      "worktree",
      "add",
      "-b",
      branch,
      path,
      spec.baseBranch,
    ]);
    if (!created.ok) {
      // branch may pre-exist from a crashed run: retry binding to it
      const retry = await git(spec.repoPath, ["worktree", "add", path, branch]);
      if (!retry.ok) {
        throw new WorktreeError(
          `git worktree add failed: ${(created.stderr || retry.stderr).trim()}`,
          "create-failed",
        );
      }
    }
    const nodeModules = this.linkNodeModules(spec.repoPath, path);
    return { path, branch, baseBranch: spec.baseBranch, nodeModules };
  }

  /**
   * Reuse the repo's node_modules: junction on Windows, symlink elsewhere.
   * Agent installs inside the worktree would follow the link into the main
   * checkout — documented limitation (ADR-0004).
   */
  private linkNodeModules(repoPath: string, worktreePath: string): WorktreeHandle["nodeModules"] {
    const target = join(repoPath, "node_modules");
    const link = join(worktreePath, "node_modules");
    if (existsSync(link)) return "repo";
    if (!existsSync(target)) return "none";
    try {
      if (process.platform === "win32") {
        symlinkSync(target, link, "junction");
        return "junction";
      }
      symlinkSync(target, link, "dir");
      return "symlink";
    } catch {
      return "none"; // agents without deps don't need it
    }
  }

  /** Uncommitted changes in the worktree? (discard guard, M5) */
  async isDirty(worktreePath: string): Promise<boolean> {
    const status = await git(worktreePath, ["status", "--porcelain"]);
    return status.ok && status.stdout.trim().length > 0;
  }

  /** Remove the worktree and (optionally) its branch. Fails on dirt unless forced. */
  async remove(
    spec: Pick<WorktreeSpec, "taskId" | "repoPath"> & { branch?: string },
    options: { deleteBranch: boolean; force: boolean },
  ): Promise<{ removedWorktree: boolean; removedBranch: boolean; wasDirty: boolean }> {
    const path = this.pathFor(spec.taskId);
    const dirty = existsSync(path) && (await this.isDirty(path));
    if (dirty && !options.force) {
      throw new WorktreeError(`worktree has uncommitted changes: ${path}`, "dirty");
    }
    let removedWorktree = false;
    if (existsSync(path)) {
      // unlink node_modules link first so worktree prune can delete the dir
      this.unlinkNodeModules(path);
      const pruned = await git(spec.repoPath, ["worktree", "remove", "--force", path]);
      if (pruned.ok) {
        removedWorktree = true;
      } else {
        rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        await git(spec.repoPath, ["worktree", "prune"]);
        removedWorktree = true;
      }
    }
    let removedBranch = false;
    if (options.deleteBranch) {
      const branch = spec.branch ?? (await this.branchOf(path, spec));
      if (branch) {
        const branchResult = await git(spec.repoPath, ["branch", "-D", branch]);
        removedBranch = branchResult.ok;
      }
    }
    return { removedWorktree, removedBranch, wasDirty: dirty === true };
  }

  /** Resolve the fleet branch of a worktree path (empty when unknown). */
  private async branchOf(worktreePath: string, spec: Pick<WorktreeSpec, "taskId" | "repoPath">): Promise<string | null> {
    const listed = await this.list(spec.repoPath);
    const found = listed.find((entry) => entry.path === worktreePath);
    return found?.branch ?? null;
  }

  unlinkNodeModules(worktreePath: string): void {
    const link = join(worktreePath, "node_modules");
    try {
      const stat = lstatSync(link);
      if (stat.isSymbolicLink()) {
        unlinkSync(link);
      } else if (stat.isDirectory() && readdirSync(link).length === 0) {
        rmSync(link, { recursive: true, force: true });
      }
      // a populated real directory means the agent installed deps — leave it;
      // `git worktree remove --force` handles deletion.
    } catch {
      // absent is fine
    }
  }

  /** All fleet worktrees known to a repo (path + branch). */
  async list(repoPath: string): Promise<Array<{ path: string; branch: string }>> {
    const out = await gitOk(repoPath, ["worktree", "list", "--porcelain"]);
    const entries: Array<{ path: string; branch: string }> = [];
    let current: { path: string; branch: string } | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current) entries.push(current);
        current = { path: line.slice("worktree ".length), branch: "" };
      } else if (line.startsWith("branch ") && current) {
        current.branch = line.slice("branch refs/heads/".length);
      } else if (line.length === 0) {
        if (current) {
          entries.push(current);
          current = null;
        }
      }
    }
    if (current) entries.push(current);
    return entries.filter((entry) => entry.branch.startsWith("fleet/"));
  }
}
