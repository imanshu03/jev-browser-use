#!/usr/bin/env node
// Builds the MCP server into one file for the plugin: plugin/dist/jev-mcp.mjs.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The notice of the ported code (THIRD_PARTY_NOTICES.md). The MIT License asks for it in every copy. */
export const ULTRAFAST_NOTICE = [
  "Includes code adapted from browser-use/jev-ultrafast (https://github.com/browser-use/jev-ultrafast):",
  "",
  "MIT License",
  "",
  "Copyright (c) 2026 Browser Use",
  "",
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  "of this software and associated documentation files (the \"Software\"), to deal",
  "in the Software without restriction, including without limitation the rights",
  "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
  "copies of the Software, and to permit persons to whom the Software is",
  "furnished to do so, subject to the following conditions:",
  "",
  "The above copyright notice and this permission notice shall be included in all",
  "copies or substantial portions of the Software.",
  "",
  "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR",
  "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
  "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
  "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
  "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
  "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
  "SOFTWARE.",
];

export const options = {
  entryPoints: [path.join(root, "src/mcp/main.ts")],
  outfile: path.join(root, "plugin/dist/jev-mcp.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", legalComments: "eof", logLevel: "warning",
  banner: { js: [
    "// jev-browser-use MCP server. Built by scripts/build-mcp.mjs. Do not edit.",
    ...ULTRAFAST_NOTICE.map((l) => (l ? `// ${l}` : "//")),
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
