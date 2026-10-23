// GET /api/setup?by=Aubrey&k=KEY — one-page phone setup for a crew member (text them this link).
// Shows their personal TagMatiks upload address with a Copy button, a Download-tool-list button, and the
// settings to check. Nothing secret beyond what the link already carries; a wrong/old key or an unknown name
// is called out on the page instead of failing later at the gun.

import { T, F, listAll } from "../lib/airtable.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  const url = new URL(req.url || "/", "http://x");
  const by = String(url.searchParams.get("by") || "").trim().slice(0, 60);
  const k = String(url.searchParams.get("k") || "").trim();
  const need = process.env.TAGMATIKS_KEY;
  const origin = `https://${req.headers?.host || "gt-scan-seven.vercel.app"}`;

  const problems = [];
  if (need && k !== need) problems.push("This setup link has an old or missing key. Ask Dylan for a new link — uploads from this address would be refused.");
  if (!by) problems.push("This link has no name on it (…?by=YourName). Ask Dylan for your link.");
  let person = null;
  if (by) {
    try {
      const people = await listAll(T.employees, { fields: [F.employees.name, F.employees.active] });
      const n = by.toLowerCase();
      person = people.find((p) => String(p.fields?.[F.employees.name] || "").toLowerCase() === n)
        || people.find((p) => String(p.fields?.[F.employees.name] || "").toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0]);
      if (!person) problems.push(`"${by}" isn't on the Employees list in Cockett Tools & Hubs yet — scans will still upload, but won't say who scanned. Ask Dylan to add you.`);
    } catch (e) { /* page still works without the check */ }
  }

  const q = new URLSearchParams();
  if (by) q.set("by", by);
  if (k) q.set("k", k);
  const upload = `${origin}/api/tagmatiks?${q.toString()}`;
  const refq = k ? `?k=${encodeURIComponent(k)}` : "";
  const reference = `${origin}/api/reference.csv${refq}`;
  const who = person ? String(person.fields?.[F.employees.name]) : by;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cockett Tools — phone setup</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1b1b1a;--muted:#5f5d58;--line:#e2e0da;--accent:#1f5f99;--warn:#a5410e;--ok:#2d6a3e}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#efeee9;--muted:#a9a69e;--line:#33322f;--accent:#7db3e8;--warn:#f0a070;--ok:#8fd19e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,system-ui,sans-serif;padding:16px}
main{max-width:560px;margin:0 auto}h1{font-size:22px;margin:4px 0 2px}.sub{color:var(--muted);margin:0 0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:0 0 12px}
.card h2{font-size:15px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.n{display:inline-block;width:22px;height:22px;border-radius:50%;background:var(--accent);color:#fff;text-align:center;font-size:13px;line-height:22px;margin-right:6px}
.addr{font:13px/1.4 ui-monospace,Menlo,monospace;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;margin:8px 0}
button,a.btn{display:block;width:100%;padding:13px;border:0;border-radius:10px;background:var(--accent);color:#fff;font:600 16px -apple-system,system-ui,sans-serif;text-align:center;text-decoration:none}
.warn{border-color:var(--warn);color:var(--warn)}.ok{color:var(--ok);font-weight:600}
ul{margin:6px 0 0;padding-left:20px}li{margin:3px 0}b{font-weight:600}
</style></head><body><main>
<h1>Cockett Tools — phone setup</h1>
<p class="sub">For <b>${esc(who || "—")}</b>. Do this once on your iPhone, with TagMatiks Wedge installed and the sled paired.</p>
${problems.map((p) => `<div class="card warn">⚠️ ${esc(p)}</div>`).join("")}
<div class="card"><h2><span class="n">1</span>Get the tool list</h2>
<a class="btn" href="${esc(reference)}">Download tool list</a>
<ul><li>Save it to <b>Files</b> when Safari asks.</li>
<li>In TagMatiks: <b>Application Configuration → Reference File</b> → browse → pick <b>grey-trunk-reference.csv</b>.</li>
<li><b>Header Mapping:</b> set <b>EPC (hex)</b> → <b>EPC</b>. Leave the rest.</li>
<li>Inventory View fields: <b>Name, Tag ID, Home Hub, Category</b>.</li></ul></div>
<div class="card"><h2><span class="n">2</span>Your upload address</h2>
<div class="addr" id="addr">${esc(upload)}</div>
<button id="copy">Copy address</button>
<ul><li>In TagMatiks export settings: <b>Export Via API</b>, <b>Auto Upload: On</b>, format <b>JSON</b>, <b>API V1</b>.</li>
<li>Paste this into the API URL box. Don't type it — paste it.</li></ul></div>
<div class="card"><h2><span class="n">3</span>Test it</h2>
<ul><li>Scan a few tagged tools and finish the inventory.</li>
<li>Tell Dylan — he'll see the scan land in Airtable with your name on it.</li></ul></div>
</main><script>
document.getElementById('copy').onclick=async function(){var t=document.getElementById('addr').textContent;try{await navigator.clipboard.writeText(t);this.textContent='Copied ✓';}catch(e){var r=document.createRange();r.selectNodeContents(document.getElementById('addr'));var s=getSelection();s.removeAllRanges();s.addRange(r);this.textContent='Selected — tap Copy';}};
</script></body></html>`);
}
