#!/usr/bin/env node
/**
 * Runs the production standalone server locally exactly as in Docker:
 * copies .next/static and public/ next to .next/standalone/server.js, then starts it.
 * Usage: node scripts/start-standalone.mjs [port]   (after `pnpm build`)
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standalone = path.join(root, ".next/standalone");
if (!existsSync(path.join(standalone, "server.js"))) {
  console.error("No standalone build found. Run `pnpm build` first.");
  process.exit(1);
}
cpSync(path.join(root, ".next/static"), path.join(standalone, ".next/static"), { recursive: true });
cpSync(path.join(root, "public"), path.join(standalone, "public"), { recursive: true });

const port = process.argv[2] ?? process.env.PORT ?? "3000";
const child = spawn(process.execPath, ["server.js"], {
  cwd: standalone,
  stdio: "inherit",
  env: { ...process.env, PORT: port, HOSTNAME: process.env.HOSTNAME_BIND ?? "127.0.0.1" },
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
