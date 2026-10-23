// Local dev server: serves public/ and routes /api/* to the Vercel-style
// handlers with a minimal req/res shim. `npm run dev` → http://localhost:3000
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import hubs from "./api/hubs.js";
import scan from "./api/scan.js";
import tagmatiks from "./api/tagmatiks.js";
import pending from "./api/pending.js";
import reference from "./api/reference.js";
import setup from "./api/setup.js";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = new URL("./public/", import.meta.url).pathname;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const routes = { "/api/hubs": hubs, "/api/scan": scan, "/api/tagmatiks": tagmatiks, "/api/pending": pending, "/api/reference": reference, "/api/reference.csv": reference, "/api/setup": setup, "/setup": setup };

function shim(req, res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => { req.body = raw; resolve(); });
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const handler = routes[url.pathname];
  if (handler) { await shim(req, res); return handler(req, res); }
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    const file = await readFile(join(PUBLIC, p));
    res.setHeader("Content-Type", MIME[extname(p)] || "application/octet-stream");
    res.end(file);
  } catch { res.statusCode = 404; res.end("not found"); }
}).listen(PORT, () => console.log(`gt-scan dev on http://localhost:${PORT}`));
