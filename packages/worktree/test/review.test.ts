import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Reviewer, MergeConflictError } from "../src/review.js";
import { WorktreeManager } from "../src/worktree-manager.js";
import { gitOk } from "../src/git.js";

let repo: string;
let root: string;
let manager: WorktreeManager;
let reviewer: Reviewer;
const dirs: string[] = [];

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "fleetforge-rev-repo-"));
  root = mkdtempSync(join(tmpdir(), "fleetforge-rev-root-"));
  dirs.push(repo, root);
  await gitOk(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  manager = new WorktreeManager(join(root, "worktrees"));
  reviewer = new Reviewer(manager);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      // Windows TEMP handle races
    }
  }
});

async function makeTaskBranch(taskId: string, title: string): Promise<{ path: string; branch: string }> {
  const handle = await manager.create({ taskId, title, repoPath: repo, baseBranch: "main" });
  return { path: handle.path, branch: handle.branch };
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await gitOk(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  await gitOk(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message]);
}

function spec(branch: string, worktreePath: string, taskId = "task_rev"): {
  taskId: string; repoPath: string; branch: string; baseBranch: string; worktreePath: string;
} {
  return { taskId, repoPath: repo, branch, baseBranch: "main", worktreePath };
}

describe("Reviewer diff", () => {
  it("summarizes adds/modifies/deletes and produces a patch", async () => {
    const t = await makeTaskBranch("task_d1", "diff case");
    writeFileSync(join(t.path, "new.txt"), "new\n");
    writeFileSync(join(t.path, "base.txt"), "base\nchanged\n");
    await commitAll(t.path, "feat: changes");

    const summary = await reviewer.diffSummary(spec(t.branch, t.path, "task_d1"));
    expect(summary.mergeable).toBe(true);
    expect(summary.ahead).toBe(1);
    expect(summary.behind).toBe(0);
    const byPath = new Map(summary.files.map((f) => [f.path, f]));
    expect(byPath.get("new.txt")).toMatchObject({ change: "add", additions: 1 });
    expect(byPath.get("base.txt")).toMatchObject({ change: "modify", additions: 1, deletions: 0 });
    expect(summary.patch).toContain("+new");
  });

  it("marks behind when base advanced", async () => {
    const t = await makeTaskBranch("task_d2", "behind case");
    // advance base independently
    await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base moved"]);
    const summary = await reviewer.diffSummary(spec(t.branch, t.path, "task_d2"));
    expect(summary.behind).toBe(1);
    expect(summary.ahead).toBe(0);
  });
});

describe("Reviewer merge", () => {
  it("fast-forwards the base without touching any checkout", async () => {
    const t = await makeTaskBranch("task_m1", "ff case");
    writeFileSync(join(t.path, "ff.txt"), "ff\n");
    await commitAll(t.path, "feat: ff");
    const head = (await gitOk(t.path, ["rev-parse", "HEAD"])).trim();

    const result = await reviewer.merge(spec(t.branch, t.path, "task_m1"), "ff", { dryRun: false });
    expect(result.merged).toBe(true);
    expect(result.commit).toBe(head);
    expect((await gitOk(repo, ["rev-parse", "main"])).trim()).toBe(head);
    // main worktree file appears only after checkout state catches up; ref is the truth
    expect((await gitOk(repo, ["log", "--oneline", "main"]))).toContain("feat: ff");
  });

  it("squash merges into a single commit", async () => {
    const t = await makeTaskBranch("task_m2", "squash case");
    writeFileSync(join(t.path, "a.txt"), "1\n");
    await commitAll(t.path, "feat: one");
    writeFileSync(join(t.path, "b.txt"), "2\n");
    await commitAll(t.path, "feat: two");

    const result = await reviewer.merge(spec(t.branch, t.path, "task_m2"), "squash", { dryRun: false });
    expect(result.merged).toBe(true);
    const log = await gitOk(repo, ["log", "--oneline", "main"]);
    expect(log.split("\n").filter(Boolean).length).toBe(2); // squash commit + init
    expect(log).toContain("fleet: merge");
  });

  it("dry-run performs only the precheck (base untouched)", async () => {
    const t = await makeTaskBranch("task_m3", "dry case");
    writeFileSync(join(t.path, "dry.txt"), "x\n");
    await commitAll(t.path, "feat: dry");
    const before = (await gitOk(repo, ["rev-parse", "main"])).trim();

    const result = await reviewer.merge(spec(t.branch, t.path, "task_m3"), "ff", { dryRun: true });
    expect(result.merged).toBe(false);
    expect(result.dryRun).toBe(true);
    expect((await gitOk(repo, ["rev-parse", "main"])).trim()).toBe(before);
  });

  it("conflicting branch fails precheck with file list and never merges", async () => {
    const t = await makeTaskBranch("task_m4", "conflict case");
    writeFileSync(join(t.path, "base.txt"), "task version\n");
    await commitAll(t.path, "feat: conflict");

    // same file changed on base
    const other = await makeTaskBranch("task_m4b", "other");
    writeFileSync(join(other.path, "base.txt"), "base version\n");
    await commitAll(other.path, "feat: base-side");
    await reviewer.merge(spec(other.branch, other.path, "task_m4b"), "ff", { dryRun: false });

    const precheck = await reviewer.precheck(spec(t.branch, t.path, "task_m4"));
    expect(precheck.mergeable).toBe(false);
    expect(precheck.conflicts).toContain("base.txt");

    await expect(
      reviewer.merge(spec(t.branch, t.path, "task_m4"), "ff", { dryRun: false }),
    ).rejects.toThrow(MergeConflictError);
  });

  it("merge strategy requires being ahead for ff; suggests squash otherwise", async () => {
    const t = await makeTaskBranch("task_m5", "not ahead");
    await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base moved"]);
    await expect(
      reviewer.merge(spec(t.branch, t.path, "task_m5"), "ff", { dryRun: false }),
    ).rejects.toThrow(/not ahead/);
  });
});

describe("Reviewer discard", () => {
  it("clean worktree discards worktree + branch", async () => {
    const t = await makeTaskBranch("task_x1", "discard clean");
    const result = await reviewer.discard(spec(t.branch, t.path, "task_x1"), { force: false });
    expect(result.removedWorktree).toBe(true);
    expect(result.removedBranch).toBe(true);
    expect(existsSync(t.path)).toBe(false);
  });

  it("dirty worktree requires explicit force", async () => {
    const t = await makeTaskBranch("task_x2", "discard dirty");
    writeFileSync(join(t.path, "uncommitted.txt"), "no commit\n");
    await expect(
      reviewer.discard(spec(t.branch, t.path, "task_x2"), { force: false }),
    ).rejects.toThrow(/uncommitted changes/);
    const forced = await reviewer.discard(spec(t.branch, t.path, "task_x2"), { force: true });
    expect(forced.wasDirty).toBe(true);
    expect(existsSync(t.path)).toBe(false);
  });
});
