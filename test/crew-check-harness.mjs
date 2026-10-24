// Runs airtable/crew_check_v1_0.js against a tiny fake of the Airtable scripting API.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const SCRIPT = readFileSync(new URL("../airtable/crew_check_v1_0.js", import.meta.url), "utf8");
function table(rows) {
  const recs = rows.map((r) => ({ id: r.id, f: { ...r.f } }));
  const str = (v) => (v == null ? "" : Array.isArray(v) ? v.map((x) => x.name ?? x).join(", ") : typeof v === "object" ? v.name ?? "" : String(v));
  const wrap = (r) => ({ id: r.id, getCellValue: (k) => r.f[k] ?? null, getCellValueAsString: (k) => str(r.f[k]) });
  return {
    recs,
    async selectRecordAsync(id) { const r = recs.find((x) => x.id === id); return r ? wrap(r) : null; },
    async updateRecordAsync(id, fields) { const r = recs.find((x) => x.id === id); for (const [k, v] of Object.entries(fields)) { if (v === null) delete r.f[k]; else r.f[k] = v; } },
    async createRecordAsync(fields) { recs.push({ id: "recL" + recs.length, f: fields }); return "recL" + recs.length; },
  };
}
async function run(tools, log, recordId) {
  const out = {};
  const fn = new Function("base", "input", "output", `return (async () => {\n${SCRIPT}\n})();`);
  await fn({ getTable: (n) => ({ Tools: tools, "Scan Log": log }[n]) }, { config: () => ({ recordId }) }, { set: (k, v) => (out[k] = v) });
  return out;
}
const QC6 = { id: "recQC6", name: "Quad Con 006" };
const base = (f) => table([{ id: "recT1", f: { "Tool Name": "Grinder", "Tag ID": "89708", "Home Hub": [QC6], "Crew Check By": { id: "usr1", name: "Steve Robinson" }, ...f } }]);

{ // Seen it: Visual Confirm, misses 0, counter +1, log row, Crew Check cleared
  const tools = base({ "Crew Check": { name: "Seen it — tag didn't read" }, "Daily Status": { name: "Not Checked" }, "Consecutive Misses": 3, "Visual Confirms in a Row": 2 });
  const log = table([]);
  await run(tools, log, "recT1");
  const f = tools.recs[0].f;
  assert.equal(f["Daily Status"].name, "Visual Confirm"); assert.equal(f["Consecutive Misses"], 0); assert.equal(f["Visual Confirms in a Row"], 3);
  assert.equal(f["Crew Check"], undefined); assert.equal(f["Status Set By"], "Steve Robinson"); assert.ok(f["Status Set At"] instanceof Date);
  assert.equal(log.recs.length, 1); const l = log.recs[0].f;
  assert.equal(l.Status.name, "Visual Confirm"); assert.equal(l.Source.name, "Manual"); assert.equal(l["Scanned By"], "Steve Robinson"); assert.deepEqual(l.Hub, [{ id: "recQC6" }]);
  console.log("PASS seen it:", l.Note);
}
{ // Tag not reading / Damaged
  const tools = base({ "Crew Check": { name: "Tag not reading" } }); const log = table([]);
  await run(tools, log, "recT1"); assert.equal(tools.recs[0].f["Daily Status"].name, "Missing Tag");
  const t2 = base({ "Crew Check": { name: "Damaged" } }); await run(t2, table([]), "recT1"); assert.equal(t2.recs[0].f["Daily Status"].name, "Damaged");
  console.log("PASS tag not reading + damaged");
}
{ // a Damaged tool stays Damaged when crew taps Seen it; misses still reset; log says so
  const tools = base({ "Crew Check": { name: "Seen it — tag didn't read" }, "Daily Status": { name: "Damaged" }, "Consecutive Misses": 2 }); const log = table([]);
  await run(tools, log, "recT1");
  assert.equal(tools.recs[0].f["Daily Status"].name, "Damaged"); assert.equal(tools.recs[0].f["Consecutive Misses"], 0);
  assert.match(log.recs[0].f.Note, /still Damaged/);
  console.log("PASS damaged stays damaged");
}
{ // nothing picked → nothing happens
  const tools = base({}); const log = table([]);
  const out = await run(tools, log, "recT1"); assert.equal(out.result, "nothing to do"); assert.equal(log.recs.length, 0);
  console.log("PASS no-op");
}
console.log("ALL CREW CHECK TESTS PASSED");
