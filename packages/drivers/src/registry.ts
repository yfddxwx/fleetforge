import type { AgentDriver } from "./types.js";
import { GenericShellDriver } from "./generic-shell/generic-shell.js";
import { SimDriver, type SimDriverOptions } from "./sim/sim.js";
import { createClaudeCodeDriver, createZcodeDriver } from "./claude-code/claude-code.js";
import { CodexDriver } from "./codex/codex.js";

/** Lookup of drivers by id; registries are plain maps with registration. */
export class DriverRegistry {
  private readonly drivers = new Map<string, AgentDriver>();

  register(driver: AgentDriver): void {
    if (this.drivers.has(driver.id)) {
      throw new Error(`driver id already registered: ${driver.id}`);
    }
    this.drivers.set(driver.id, driver);
  }

  get(id: string): AgentDriver | null {
    return this.drivers.get(id) ?? null;
  }

  require(id: string): AgentDriver {
    const driver = this.get(id);
    if (!driver) {
      throw new Error(
        `unknown driver: ${id} (available: ${[...this.drivers.keys()].join(", ") || "none"})`,
      );
    }
    return driver;
  }

  list(): AgentDriver[] {
    return [...this.drivers.values()];
  }

  ids(): string[] {
    return [...this.drivers.keys()];
  }
}

export interface DefaultRegistryOptions extends SimDriverOptions {
  /** Extra generic-shell drivers, e.g. { id: "my-wrapper", config: {...} }. */
  shells?: Array<{ id: string; label?: string; config: ConstructorParameters<typeof GenericShellDriver>[0] }>;
}

/**
 * Built-in registry: sim + generic-shell + the real CLI drivers
 * (claude-code, codex, zcode). Presence is probed lazily via detect().
 */
export function defaultRegistry(options: DefaultRegistryOptions): DriverRegistry {
  const registry = new DriverRegistry();
  registry.register(
    new SimDriver({
      entry: options.entry,
      ...(options.speed !== undefined ? { speed: options.speed } : {}),
    }),
  );
  registry.register(createClaudeCodeDriver());
  registry.register(new CodexDriver());
  registry.register(createZcodeDriver());
  for (const shell of options.shells ?? []) {
    registry.register(new GenericShellDriver(shell.config, shell.id, shell.label));
  }
  return registry;
}
