import process from "node:process";
import { FleetServer } from "@fleetforge/server";
import { defaultDbPath, defaultStateDir, ensureDir, findSimAgentEntry } from "../paths.js";

export interface ServeOptions {
  port?: number;
  host?: string;
  db?: string;
  state?: string;
}

/** `fleet serve` — run the command deck: REST + WS + scheduler + watchdog. */
export async function serve(options: ServeOptions): Promise<void> {
  const stateDir = ensureDir(options.state ?? defaultStateDir());
  const dbFile = options.db ?? defaultDbPath(stateDir);
  const server = new FleetServer({
    dbFile,
    stateDir,
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
    simEntry: findSimAgentEntry(),
  });

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\nfleet: ${signal} received, shutting down…\n`);
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const { port } = await server.start();
  const host = options.host ?? "127.0.0.1";
  process.stdout.write(
    [
      `fleet serve — listening on http://${host}:${port}`,
      `  api      http://${host}:${port}/api`,
      `  websocket ws://${host}:${port}/ws`,
      `  state    ${stateDir}`,
      `  db       ${dbFile}`,
      ``,
      `web console: pnpm --filter @fleetforge/web dev (M6) · or REST examples:`,
      `  curl -X POST http://${host}:${port}/api/tasks -H content-type:application/json \\`,
      `    -d '{"prompt":"demo","agent":"sim","repoPath":"<repo>"}'`,
      ``,
    ].join("\n"),
  );
  await new Promise(() => {
    /* runs until signal */
  });
}
