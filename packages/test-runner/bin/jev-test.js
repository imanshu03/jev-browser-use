#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./launch.js";

launch(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "cli");
