import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeManager, WorktreeError } from "../src/worktree-manager.js";
import { git, gitOk } from "../src/git.js";

let repo: string;
let root: string;
const dirs: string[] = [];

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "fleetforge-wt-repo-"));
  root = mkdtempSync(join(tmpdir(), "fleetforge-wt-root-"));
  dirs.push(repo, root);
  await gitOk(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "initial\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep.txt"), "dep\n");
  await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
});

afterEach(() => {
  // worktrees keep a .git file link into the repo; plain rm of repo dir may
  // race on Windows — retry and ignore leftovers in TEMP.
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

function manager(): WorktreeManager {
  return new WorktreeManager(join(root, "worktrees"));
}

describe("WorktreeManager", () => {
  it("creates an isolated worktree + fleet branch from the base", async () => {
    const m = manager();
    const handle = await m.create({ taskId: "task_abcdef12", title: "Write FizzBuzz 模块", repoPath: repo, baseBranch: "main" });
    expect(existsSync(join(handle.path, "a.txt"))).toBe(true);
    expect(handle.branch).toBe("fleet/abcdef12-write-fizzbuzz");
    const branches = await gitOk(repo, ["branch", "--list", "fleet/*"]);
    expect(branches).toContain("fleet/abcdef12-write-fizzbuzz");

    // writes in the worktree do not touch the main checkout
    writeFileSync(join(handle.path, "b.txt"), "from task\n");
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
  });

  it("reuses node_modules via junction/symlink", async () => {
    const m = manager();
    const handle = await m.create({ taskId: "task_nm", title: "t", repoPath: repo, baseBranch: "main" });
    expect(["junction", "symlink", "repo"]).toContain(handle.nodeModules);
    expect(readFileSync(join(handle.path, "node_modules", "dep.txt"), "utf8")).toContain("dep");
  });

  it("two tasks get distinct worktrees and branches", async () => {
    const m = manager();
    const h1 = await m.create({ taskId: "task_11111111", title: "one", repoPath: repo, baseBranch: "main" });
    const h2 = await m.create({ taskId: "task_22222222", title: "two", repoPath: repo, baseBranch: "main" });
    expect(h1.path).not.toBe(h2.path);
    expect(h1.branch).not.toBe(h2.branch);
    expect((await m.list(repo)).length).toBeGreaterThanOrEqual(2);
  });

  it("refuses empty repos and missing base branches", async () => {
    const empty = mkdtempSync(join(tmpdir(), "fleetforge-empty-"));
    dirs.push(empty);
    gitOk(empty, ["init", "-q", "-b", "main"]);
    const m = manager();
    await expect(
      m.create({ taskId: "task_e", title: "t", repoPath: empty, baseBranch: "main" }),
    ).rejects.toThrow(WorktreeError);
    await expect(
      m.create({ taskId: "task_b", title: "t", repoPath: repo, baseBranch: "nope" }),
    ).rejects.toThrow(/base branch not found/);
  });

  it("remove reclaims worktree and branch; guards dirty unless forced", async () => {
    const m = manager();
    const handle = await m.create({ taskId: "task_rm", title: "t", repoPath: repo, baseBranch: "main" });
    writeFileSync(join(handle.path, "c.txt"), "uncommitted\n");
    await expect(
      m.remove({ taskId: "task_rm", repoPath: repo }, { deleteBranch: true, force: false }),
    ).rejects.toThrow(WorktreeError);

    const result = await m.remove(
      { taskId: "task_rm", repoPath: repo, branch: handle.branch },
      { deleteBranch: true, force: true },
    );
    expect(result.removedWorktree).toBe(true);
    expect(result.removedBranch).toBe(true);
    expect(result.wasDirty).toBe(true);
    expect(existsSync(handle.path)).toBe(false);
    expect(await git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${handle.branch}`])).toMatchObject({ ok: false });
  });

  it("commits inside the worktree land on the fleet branch only", async () => {
    const m = manager();
    const handle = await m.create({ taskId: "task_c", title: "t", repoPath: repo, baseBranch: "main" });
    writeFileSync(join(handle.path, "feature.txt"), "x\n");
    await gitOk(handle.path, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
    await gitOk(handle.path, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "feat"]);
    const onBranch = await gitOk(handle.path, ["log", "--oneline"]);
    expect(onBranch).toContain("feat");
    const mainLog = await gitOk(repo, ["log", "--oneline", "main"]);
    expect(mainLog).not.toContain("feat");
  });
});
