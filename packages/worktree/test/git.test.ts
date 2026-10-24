import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "../src/worktree-manager.js";
import { branchExists, currentBranch, git, gitOk, hasCommits, isGitRepo } from "../src/git.js";

const dirs: string[] = [];
function track(path: string): string {
  dirs.push(path);
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Windows handle-release races in TEMP
    }
  }
});

async function seedRepo(): Promise<string> {
  const repo = track(mkdtempSync(join(tmpdir(), "fleetforge-gitcov-")));
  await gitOk(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

describe("git helpers", () => {
  it("isGitRepo / currentBranch / branchExists / hasCommits", async () => {
    const repo = await seedRepo();
    expect(await isGitRepo(repo)).toBe(true);
    expect(await currentBranch(repo)).toBe("main");
    expect(await branchExists(repo, "main")).toBe(true);
    expect(await branchExists(repo, "nope")).toBe(false);
    expect(await hasCommits(repo)).toBe(true);
  });

  it("isGitRepo false outside a repo; git() captures failures without throwing", async () => {
    const plain = track(mkdtempSync(join(tmpdir(), "fleetforge-plain-")));
    expect(await isGitRepo(plain)).toBe(false);
    const result = await git(plain, ["log", "--oneline"]);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("fatal");
    await expect(gitOk(plain, ["log"])).rejects.toThrow(/failed/);
  });

  it("currentBranch null when HEAD is broken", async () => {
    const plain = track(mkdtempSync(join(tmpdir(), "fleetforge-broken-")));
    expect(await currentBranch(plain)).toBeNull();
  });
});

describe("node_modules link handling", () => {
  it("absent link is a no-op; symlink is removed; populated real dir is kept", async () => {
    const repo = await seedRepo();
    const root = track(mkdtempSync(join(tmpdir(), "fleetforge-nmcov-")));
    const m = new WorktreeManager(join(root, "wts"));

    // absent
    const wt1 = track(mkdtempSync(join(tmpdir(), "fleetforge-wt1-")));
    m.unlinkNodeModules(wt1);

    // real populated dir kept (agent-installed deps)
    const wt2 = track(mkdtempSync(join(tmpdir(), "fleetforge-wt2-")));
    mkdirSync(join(wt2, "node_modules"), { recursive: true });
    writeFileSync(join(wt2, "node_modules", "x.txt"), "x");
    m.unlinkNodeModules(wt2);
    expect(existsSync(join(wt2, "node_modules", "x.txt"))).toBe(true);

    // junction/symlink removed
    const repoWithDeps = await seedRepo();
    mkdirSync(join(repoWithDeps, "node_modules"), { recursive: true });
    writeFileSync(join(repoWithDeps, "node_modules", "dep.txt"), "dep");
    const handle = await m.create({ taskId: "task_cov1", title: "t", repoPath: repoWithDeps, baseBranch: "main" });
    if (handle.nodeModules === "junction" || handle.nodeModules === "symlink") {
      expect(readFileSync(join(handle.path, "node_modules", "dep.txt"), "utf8")).toContain("dep");
      m.unlinkNodeModules(handle.path);
      expect(existsSync(join(handle.path, "node_modules"))).toBe(false);
      expect(existsSync(join(repoWithDeps, "node_modules", "dep.txt"))).toBe(true); // target intact
    }
    void repo;
    void process;
  });

  it("remove falls back to rmSync when git worktree remove fails", async () => {
    const repo = await seedRepo();
    const root = track(mkdtempSync(join(tmpdir(), "fleetforge-rmfb-")));
    const m = new WorktreeManager(join(root, "wts"));
    const handle = await m.create({ taskId: "task_cov2", title: "t", repoPath: repo, baseBranch: "main" });
    // corrupt the worktree's git link so `git worktree remove` errors
    rmSync(join(handle.path, ".git"), { force: true });
    const result = await m.remove(
      { taskId: "task_cov2", repoPath: repo, branch: handle.branch },
      { deleteBranch: true, force: true },
    );
    expect(result.removedWorktree).toBe(true);
    expect(existsSync(handle.path)).toBe(false);
  });

  it("worktree path collision raises create-failed", async () => {
    const repo = await seedRepo();
    const root = track(mkdtempSync(join(tmpdir(), "fleetforge-coll-")));
    const m = new WorktreeManager(join(root, "wts"));
    await m.create({ taskId: "task_cov3", title: "t", repoPath: repo, baseBranch: "main" });
    // same taskId again → path exists
    await expect(
      m.create({ taskId: "task_cov3", title: "t2", repoPath: repo, baseBranch: "main" }),
    ).rejects.toThrow(/already exists/);
  });
});
