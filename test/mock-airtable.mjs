// A fake Airtable REST API for local end-to-end runs. Mirrors just enough of
// the Grey Trunk base: Hubs, Employees, Scan Sessions, and a pretend
// "Scan Ingest" automation that stamps Done ~1.5 s after a session is created.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 3999);
const BASE = "app2Hy10fWVqEs4T0";
const T = { hubs: "tblJivoY2jZI9b3at", employees: "tbldQrEVxFYdVrBi5", sessions: "tbl1gDnpnNoa36d38", tools: "tblt1mNexHRkG0aSq", equipment: "tblIzmuWnWGcnimVz" };
// tag → home hub, for the "tags vote" hub assignment
const tools = [
  ["258227", "recwk9GhI5A8WUXcC"], ["89616", "recwk9GhI5A8WUXcC"], ["89599", "recwk9GhI5A8WUXcC"], ["89581", "recwk9GhI5A8WUXcC"],
  ["89708", "recQC004xxxxxxxxx"], ["251003", "recQC004xxxxxxxxx"], ["251038", "recQC004xxxxxxxxx"],
].map(([t, h], i) => ({ id: "recTOOL" + String(i).padStart(10, "0"), fields: { fldzrUK25BcmobI7p: "tool " + t, fldlIt2543zw00wwN: t, fld8zHzmbea5o44AF: [h] } }));
const equipment = [];

const hubs = [
  { id: "recwk9GhI5A8WUXcC", fields: { fldOwxEqbJFOKbiM4: "Quad Con 006", fldKrXCyYdHpPYazv: "QC 006", fldKy8gIBtEZjfSec: { name: "Quad Con" }, fldVSwin0zwU46vsH: { name: "At Yard / Shop" }, fld3IDMLUHwIVIvHP: "Cockett Yard - Lewiston UT", fld78dUMGnzN9AspA: "Cockett Yard - Lewiston UT", fldJtTQekDjZ7NhEL: 41.955, fldY4n4VexRFZ0zR6: -111.856, fldYGE9qP0e6rv7KV: 143, fldma8X4hhexTc8bC: 7 } },
  { id: "recQC004xxxxxxxxx", fields: { fldOwxEqbJFOKbiM4: "Quad Con 004", fld78dUMGnzN9AspA: "1100 Navy Dr, Stockton CA", fldZkQ7LUuRCH1uUc: "Niagara Stockton", fldJtTQekDjZ7NhEL: 37.95, fldY4n4VexRFZ0zR6: -121.29, fldKy8gIBtEZjfSec: { name: "Quad Con" }, fldYGE9qP0e6rv7KV: 98, fldma8X4hhexTc8bC: 0 } },
  { id: "recFatMikexxxxxxx", fields: { fldOwxEqbJFOKbiM4: "Fat Mike", fldKy8gIBtEZjfSec: { name: "Van Trailer" }, fldYGE9qP0e6rv7KV: 0, fldma8X4hhexTc8bC: 0 } },
];
const people = [
  { id: "rec1Ziue9t41Bvs7X", fields: { fldtLUOMaubO4pXJC: "Dylan Cockett", fld524UDt907nY6Y0: true } },
  { id: "recMikePerezxxxxx", fields: { fldtLUOMaubO4pXJC: "Michael Perez", fld524UDt907nY6Y0: true } },
  { id: "recOldGuyxxxxxxxx", fields: { fldtLUOMaubO4pXJC: "Former Employee", fld524UDt907nY6Y0: false } },
];
const sessions = new Map();
let n = 0;

function json(res, code, body) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }

http.createServer((req, res) => {
  let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const parts = url.pathname.split("/").filter(Boolean); // v0, base, table, [rec]
    if (parts[1] !== BASE) return json(res, 404, { error: "no such base" });
    const table = parts[2], recId = parts[3];
    if (req.method === "GET" && !recId) {
      const rows = table === T.hubs ? hubs : table === T.employees ? people : table === T.tools ? tools : table === T.equipment ? equipment : [...sessions.values()];
      return json(res, 200, { records: rows });
    }
    if (req.method === "GET" && recId) {
      const r = sessions.get(recId); return r ? json(res, 200, r) : json(res, 404, { error: "nope" });
    }
    // pretend Scan Ingest: fires when Raw Payload is set and Ingest Status is blank (same as the real automation)
    const ingest = (rec) => {
      const f = rec.fields;
      if (!f.flde0qnfKleKwNcHZ || f.fldDjF1KMVfUkZRjt) return;
      setTimeout(() => {
        const tags = String(f.flde0qnfKleKwNcHZ || "").split("\n").filter(Boolean);
        const hub = hubs.find((h) => h.id === (f.fldfTyKsOAdSHbVnO || [])[0]);
        const expected = hub?.fields.fldYGE9qP0e6rv7KV || 0;
        const wrong = tags.filter((t) => t.endsWith("089708"));
        rec.fields.fldDjF1KMVfUkZRjt = { name: "Done" };
        rec.fields.fldDGjGhVdjw3GHtk = tags.length;
        rec.fields.flduNI4ZbQY1GAvXN = expected;
        rec.fields.fldWdefgntg5yQYFm = `${hub?.fields.fldOwxEqbJFOKbiM4 || "?"} — 2026-10-16 — Dylan Cockett`;
        rec.fields.fld1isLmXoiDuODDL = `${tags.length} read this pass · ${7 + tags.length} / ${expected} scanned today · ${expected - 7 - tags.length} to go · ${wrong.length} wrong box`;
        rec.fields.fldO9vDlAzhBwGcPY = wrong.length ? `1 in the wrong box:\n89708 Milwaukee 4-1/2" - 6" Grinder — belongs in Quad Con 004` : "✅ nothing out of place";
        rec.fields.fld0CL36kcxVKUU0U = `${expected - 7 - tags.length} of ${expected} not scanned today (…):\n250959 1/2” impact socket set SAE — miss #1\n89564 1/2” impact small — miss #1`;
      }, 1500);
    };
    if (req.method === "POST" && table === T.sessions) {
      const body = JSON.parse(raw); const f = body.records[0].fields;
      const id = "recMOCK" + String(++n).padStart(10, "0");
      const rec = { id, fields: { ...f }, createdTime: new Date().toISOString() }; sessions.set(id, rec);
      if (typeof rec.fields.fldDjF1KMVfUkZRjt === "string") rec.fields.fldDjF1KMVfUkZRjt = { name: rec.fields.fldDjF1KMVfUkZRjt };
      ingest(rec);
      return json(res, 200, { records: [rec] });
    }
    if (req.method === "PATCH" && table === T.sessions && recId) {
      const rec = sessions.get(recId); if (!rec) return json(res, 404, { error: "nope" });
      const f = JSON.parse(raw).fields || {};
      for (const [k, v] of Object.entries(f)) { if (v === null) delete rec.fields[k]; else rec.fields[k] = (k === "fldDjF1KMVfUkZRjt" && typeof v === "string") ? { name: v } : v; }
      ingest(rec);
      return json(res, 200, rec);
    }
    json(res, 405, { error: "unsupported in mock" });
  });
}).listen(PORT, () => console.log(`mock airtable on http://localhost:${PORT}`));
