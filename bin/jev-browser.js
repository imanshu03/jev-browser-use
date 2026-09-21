#!/usr/bin/env node
// Launcher: runs src/cli.ts through tsx with .env loaded from the package directory.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(pkgDir, "node_modules", ".bin", "tsx");
const envFile = path.join(pkgDir, ".env");
const args = [];
if (existsSync(envFile)) args.push(`--env-file=${envFile}`);
args.push(path.join(pkgDir, "src", "cli.ts"), ...process.argv.slice(2));
const child = spawn(tsx, args, { stdio: "inherit", cwd: process.cwd(), env: process.env });
child.on("exit", (code, signal) => { process.exit(code ?? (signal === "SIGINT" ? 130 : 1)); });
process.on("SIGINT", () => child.kill("SIGINT"));
