#!/usr/bin/env node
// Builds the MCP server into one file for the plugin: plugin/dist/jev-mcp.mjs.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const options = {
  entryPoints: [path.join(root, "src/mcp/main.ts")],
  outfile: path.join(root, "plugin/dist/jev-mcp.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", legalComments: "eof", logLevel: "warning",
  banner: { js: [
    "// jev-browser-use MCP server. Built by scripts/build-mcp.mjs. Do not edit.",
    "// Includes code adapted from browser-use/jev-ultrafast. MIT License, Copyright (c) 2026 Browser Use.",
    "import { createRequire as __jevCreateRequire } from 'node:module'; const require = __jevCreateRequire(import.meta.url);",
  ].join("\n") },
};

/**
 * True when `argv1` names the module at `url`. Node gives import.meta.url as the real path, so the check compares
 * real paths: a checkout reached through a symlink (for example /tmp on macOS) still builds.
 */
export function isMain(argv1, url) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

if (isMain(process.argv[1], import.meta.url)) {
  await build(options);
  process.stderr.write(`built ${path.relative(root, options.outfile)}\n`);
}
