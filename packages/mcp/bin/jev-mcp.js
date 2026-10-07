#!/usr/bin/env node
// jev-mcp: starts src/main.ts in a checkout, or dist/main.js when installed. stdin and stdout carry MCP JSON-RPC.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./launch.js";

launch(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "main", ["SIGINT", "SIGTERM", "SIGHUP"]);
