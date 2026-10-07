// A static server for the demo app. Usage: node examples/demo/serve.mjs [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "app");

export function serve(port) {
  const server = http.createServer((req, res) => {
    const name = new URL(req.url ?? "/", "http://x").pathname.replace(/^\/+/, "") || "login.html";
    const file = path.join(dir, path.basename(name));
    if (!fs.existsSync(file)) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8790);
  await serve(port);
  console.log(`demo app at http://127.0.0.1:${port}/login.html`);
}
