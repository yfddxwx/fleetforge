import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run git in `cwd`, never throws (callers decide how failures surface). */
export async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "git failed" };
  }
}

export async function gitOk(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Is `path` inside a git work tree? */
export async function isGitRepo(path: string): Promise<boolean> {
  const result = await git(path, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const result = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return result.ok ? result.stdout.trim() : null;
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const result = await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return result.ok;
}

export async function hasCommits(cwd: string): Promise<boolean> {
  const result = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
  return result.ok;
}
