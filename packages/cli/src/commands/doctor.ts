import { spawnSync } from "node:child_process";
import process from "node:process";
import { defaultRegistry } from "@fleetforge/drivers";
import type { DriverDetect } from "@fleetforge/drivers";
import { PriceBook } from "@fleetforge/usage";
import { findSimAgentEntry } from "../paths.js";

export interface DoctorReport {
  healthy: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string; hint: string | null }>;
  drivers: DriverDetect[];
  prices: { source: string; entries: number };
}

/** Probe the local machine: CLIs, versions, login state, capability matrix. */
export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorReport["checks"] = [];

  const git = probe(["git", "--version"]);
  checks.push({
    name: "git",
    ok: git !== null,
    detail: git ?? "git not found on PATH",
    hint: git === null ? "install git ≥ 2.38 (merge-tree precheck requires 2.38+)" : null,
  });

  checks.push({
    name: "node",
    ok: true,
    detail: `v${process.versions.node}`,
    hint: null,
  });

  const simEntry = findSimAgentEntry();
  checks.push({
    name: "sim-agent (fixture)",
    ok: simEntry !== null,
    detail: simEntry ?? "sim-agent entry not resolvable",
    hint: simEntry === null ? "pnpm --filter @fleetforge/sim-agent build (demo & CI scenarios)" : null,
  });

  const priceBook = new PriceBook();
  const prices = { source: priceBook.sourceLabel, entries: priceBook.current.prices.length };

  const registry = defaultRegistry({ entry: simEntry });
  const drivers: DriverDetect[] = [];
  for (const driver of registry.list()) {
    drivers.push(await driver.detect());
  }

  const healthy =
    checks.every((check) => check.ok) && drivers.some((driver) => driver.installed);

  return { healthy, checks, drivers, prices };
}

function probe(argv: [string, ...string[]]): string | null {
  try {
    const result = spawnSync(argv[0], argv.slice(1), {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    });
    if (result.error) return null;
    return (result.stdout ?? "").trim().split("\n")[0] ?? "";
  } catch {
    return null;
  }
}

/** Render the doctor report for the terminal. */
export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = [];
  const mark = (ok: boolean): string => (ok ? "✔" : "✖");
  lines.push(`fleet doctor — ${report.healthy ? "healthy" : "issues found"}`);
  lines.push("");
  lines.push("environment:");
  for (const check of report.checks) {
    lines.push(`  ${mark(check.ok)} ${check.name}: ${check.detail}`);
    if (check.hint) lines.push(`      ↳ ${check.hint}`);
  }
  lines.push("");
  lines.push("agents:");
  for (const driver of report.drivers) {
    const state = driver.installed
      ? driver.authenticated === true
        ? "ready"
        : driver.authenticated === false
          ? "installed · NOT logged in"
          : "installed"
      : "not installed";
    lines.push(`  ${mark(driver.installed && driver.authenticated !== false)} ${driver.driverId} (${driver.label}) — ${state}${driver.version ? ` · ${driver.version}` : ""}`);
    if (driver.hint) lines.push(`      ↳ ${driver.hint}`);
    const caps = driver.capabilities;
    const supported = (Object.keys(caps) as Array<keyof typeof caps>)
      .map((key) => `${caps[key] ? "" : "!"}${key}`)
      .join(" ");
    lines.push(`      caps: ${supported}`);
  }
  lines.push("");
  lines.push(`prices: ${report.prices.entries} patterns from ${report.prices.source}`);
  if (!report.drivers.some((d) => d.installed && d.authenticated !== false)) {
    lines.push("");
    lines.push("no usable agent found — install/log in to a real CLI, or use the sim fixture:");
    lines.push("  pnpm --filter @fleetforge/sim-agent build && fleet task new --agent sim \"demo\"");
  }
  return lines.join("\n");
}
