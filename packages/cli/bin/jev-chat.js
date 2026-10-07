#!/usr/bin/env node
// jev-chat: starts src/chat.ts in a checkout, or dist/chat.js when installed.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./launch.js";

launch(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "chat");
