#!/usr/bin/env node
// jev-scrape: starts src/scrape/cli.ts in a checkout, or dist/scrape/cli.js when installed.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./launch.js";

launch(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "scrape/cli");
