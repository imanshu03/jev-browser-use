#!/usr/bin/env node
// jev-browser: starts src/cli.ts in a checkout, or dist/cli.js when installed.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./launch.js";

launch(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "cli");
