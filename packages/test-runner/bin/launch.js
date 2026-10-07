// Starts a jev entry: its TypeScript source through tsx in a checkout, else the built file in dist. Loads .env from the package or the workspace root.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The first file named `name` in `dir` or a parent directory, or null. */
function up(dir, name) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, name))) return path.join(d, name);
    if (path.dirname(d) === d) return null;
  }
}

/** The .env of the package, else the .env of the workspace root (the nearest package.json with workspaces). */
function envFile(pkgDir) {
  if (existsSync(path.join(pkgDir, ".env"))) return path.join(pkgDir, ".env");
  for (let d = path.dirname(pkgDir); ; d = path.dirname(d)) {
    const pkg = path.join(d, "package.json");
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).workspaces) return existsSync(path.join(d, ".env")) ? path.join(d, ".env") : null;
    if (path.dirname(d) === d) return null;
  }
}

/** Run `entry` (a path under src/ or dist/ without its extension) with the CLI args, and exit with its code. */
export function launch(pkgDir, entry, signals = ["SIGINT"]) {
  const source = path.join(pkgDir, "src", `${entry}.ts`);
  const tsx = up(pkgDir, path.join("node_modules", ".bin", "tsx"));
  const env = envFile(pkgDir);
  const flags = env ? [`--env-file=${env}`] : [];
  const [cmd, args] = existsSync(source) && tsx
    ? [tsx, ["--conditions=jev-source", ...flags, source]]
    : [process.execPath, [...flags, path.join(pkgDir, "dist", `${entry}.js`)]];
  const child = spawn(cmd, [...args, ...process.argv.slice(2)], { stdio: "inherit", cwd: process.cwd(), env: process.env });
  child.on("exit", (code, signal) => { process.exit(code ?? (signal === "SIGINT" ? 130 : 1)); });
  for (const s of signals) process.on(s, () => child.kill(s));
}
