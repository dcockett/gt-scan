// Runs airtable/scan_ingest_v*.js against an in-memory fake of the Airtable scripting API.
// usage: node test/ingest-harness.mjs  (asserts and prints PASS/FAIL)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const SCRIPT = readFileSync(new URL("../airtable/scan_ingest_v1_7.js", import.meta.url), "utf8");

function makeTable(name, rows) {
  const recs = rows.map((r) => ({ id: r.id, f: { ...r.fields } }));
  const val = (rec, field) => rec.f[field] ?? null;
  const str = (v) => (v == null ? "" : Array.isArray(v) ? v.map((x) => x.name ?? x.id ?? x).join(", ") : typeof v === "object" ? v.name ?? "" : String(v));
  const wrap = (rec) => ({ id: rec.id, name: str(rec.f[primary(name)]), getCellValue: (f) => val(rec, f), getCellValueAsString: (f) => str(val(rec, f)) });
  return {
    name, recs,
    async selectRecordsAsync() { const list = recs.map(wrap); return { records: list, getRecord: (id) => list.find((r) => r.id === id) || null }; },
    async createRecordAsync(fields) { const id = "recNEW" + name.slice(0, 3) + String(recs.length).padStart(8, "0"); recs.push({ id, f: { ...fields } }); return id; },
    async createRecordsAsync(list) { return Promise.all(list.map((x) => this.createRecordAsync(x.fields))); },
    async updateRecordAsync(id, fields) { const r = recs.find((x) => x.id === id); if (!r) throw new Error("no record " + id); Object.assign(r.f, fields); },
    async updateRecordsAsync(list) { for (const x of list) await this.updateRecordAsync(x.id, x.fields); },
    get: (id) => recs.find((x) => x.id === id)?.f,
  };
}
const primary = (t) => ({ Tools: "Tool Name", Equipment: "Equipment Name", Hubs: "Hub", Employees: "Name", "Scan Sessions": "Session", "Scan Log": "Scan", "Unknown Tags": "Tag (EPC)" }[t]);

const QC6 = { id: "recQC6", name: "Quad Con 006" }, QC4 = { id: "recQC4", name: "Quad Con 004" };
function freshBase(session) {
  const tables = {
    Tools: makeTable("Tools", [
      { id: "recT1", fields: { "Tool Name": "Screwdriver set", "Tag ID": "258227", "Home Hub": [QC6], Custody: { name: "In Hub" }, "Consecutive Misses": 2 } },
      { id: "recT2", fields: { "Tool Name": "M18 battery", "Tag ID": "89616", "Home Hub": [QC6] } },
      { id: "recT3", fields: { "Tool Name": "Impact", "Tag ID": "89599", "Home Hub": [QC6] } },
      { id: "recT4", fields: { "Tool Name": "Grinder", "Tag ID": "89708", "Home Hub": [QC4] } },
      { id: "recT5", fields: { "Tool Name": "Socket set (not read)", "Tag ID": "250959", "Home Hub": [QC6], "Consecutive Misses": 0 } },
    ]),
    Equipment: makeTable("Equipment", [{ id: "recE1", fields: { "Equipment Name": "Welder", "Tag ID": "77001", "Home Hub": [QC6] } }]),
    Hubs: makeTable("Hubs", [
      { id: "recQC6", fields: { Hub: "Quad Con 006", Nickname: "QC 006", "Site / Location": "Cockett Yard - Lewiston UT" } },
      { id: "recQC4", fields: { Hub: "Quad Con 004" } },
    ]),
    "Scan Sessions": makeTable("Scan Sessions", [{ id: "recS1", fields: session }]),
    "Scan Log": makeTable("Scan Log", []),
    Employees: makeTable("Employees", [{ id: "recDY", fields: { Name: "Dylan Cockett" } }]),
    "Unknown Tags": makeTable("Unknown Tags", []),
  };
  return tables;
}

async function run(tables, sessionId) {
  const outputs = {};
  const base = { getTable: (n) => tables[n] };
  const input = { config: () => ({ sessionId }) };
  const output = { set: (k, v) => (outputs[k] = v) };
  const console_ = { log: () => {} };
  const fn = new Function("base", "input", "output", "console", `return (async () => {\n${SCRIPT}\n})();`);
  await fn(base, input, output, console_);
  return outputs;
}
const P = (t) => t.padStart(24, "0");
const PKG = "30283312D82900D61E7101F7";

// 1. Full audit of QC 006, mixed box, GPS + site, packaging tag, a machine
{
  const t = freshBase({ "Hub Scanned": [QC6], "Scanned By": [{ id: "recDY", name: "Dylan Cockett" }], "Session Type": { name: "Full Hub Audit" },
    Latitude: 41.85, Longitude: -111.83, "Site (snapped)": "Cache County, Utah",
    "Raw Payload": [P("258227"), P("89616"), P("89599"), P("89708"), PKG, P("77001"), P("999999")].join("\n") });
  const out = await run(t, "recS1");
  const s = t["Scan Sessions"].get("recS1");
  assert.equal(s["Ingest Status"].name, "Done");
  assert.match(s.Summary, /^4 read this pass · 3 \/ 4 scanned today · 1 to go · 1 wrong box · 1 machines · 1 new tag to review · 1 packaging ignored$/);
  assert.match(s["Wrong Box Report"], /89708 Grinder — belongs in Quad Con 004/);
  assert.match(s["Missing Report"], /250959 Socket set/);
  assert.match(s["Missing Report"], /1 of our tag\(s\) not in Tools or Equipment[\s\S]*999999/);
  assert.match(s["Missing Report"], /1 packaging tag\(s\) ignored[\s\S]*30283312/);
  const g = t.Tools.get("recT4");
  assert.equal(g["Current Hub"][0].id, "recQC6");
  assert.equal(g["Last Seen Lat"], 41.85); assert.equal(g["Last Seen Long"], -111.83); assert.equal(g["Last Seen Site"], "Cache County, Utah");
  assert.ok(g["Last Scanned"] instanceof Date);
  assert.equal(t.Tools.get("recT1")["Consecutive Misses"], 0);
  assert.equal(t.Tools.get("recT5")["Consecutive Misses"], 1);
  const e = t.Equipment.get("recE1");
  assert.equal(e["Last Seen Site"], "Cache County, Utah"); assert.ok(e["Last Scanned"] instanceof Date); assert.equal(e["Current Hub"][0].id, "recQC6");
  const log = t["Scan Log"].recs.map((r) => r.f);
  assert.equal(log.length, 5, "only tools + machines get Scan Log rows; packaging and unknown don't");
  assert.ok(!log.some((r) => r["Tag ID (as read)"] === PKG));
  const u = t["Unknown Tags"].recs.map((r) => r.f);
  assert.equal(u.length, 1); assert.equal(u[0]["Tag ID"], "999999"); assert.equal(u[0].Status.name, "Needs Review"); assert.equal(u[0]["Times Seen"], 1);
  assert.equal(u[0]["Tag (EPC)"], P("999999")); assert.deepEqual(u[0]["Last Scan"], [{ id: "recS1" }]);
  assert.equal(t.Hubs.get("recQC6")["Last Known Lat"], 41.85);
  console.log("PASS audit:", s.Summary);
}

// 1b. Filter: A6B6 vendor tag → Unknown Tags; blocked tag skipped; foreign + packaging → no records; known unknown → Times Seen +1
{
  const A6 = "A6B600000000000000009999", FOREIGN = "1BF104083B801750FD401403";
  const t = freshBase({ "Hub Scanned": [QC6], "Session Type": { name: "Spot Check" },
    "Raw Payload": [P("258227"), A6, FOREIGN, PKG, P("555555"), P("777777")].join("\n") });
  t["Unknown Tags"].recs.push({ id: "recU1", f: { "Tag (EPC)": P("555555"), "Tag ID": "555555", Status: { name: "Blocked — Not Ours" }, "Times Seen": 4 } });
  t["Unknown Tags"].recs.push({ id: "recU2", f: { "Tag (EPC)": P("777777"), "Tag ID": "777777", Status: { name: "Needs Review" }, "Times Seen": 2 } });
  await run(t, "recS1");
  const s = t["Scan Sessions"].get("recS1");
  assert.equal(s.Summary, "1 read this pass · 0 wrong box · 2 new tags to review · 1 packaging ignored · 1 other tags ignored · 1 blocked");
  assert.equal(t["Scan Log"].recs.length, 1);
  const U = (id) => t["Unknown Tags"].get(id);
  assert.equal(U("recU1")["Times Seen"], 4, "blocked row untouched"); assert.equal(U("recU1")["Last Seen"], undefined);
  assert.equal(U("recU2")["Times Seen"], 3); assert.equal(U("recU2").Status.name, "Needs Review");
  const a6 = t["Unknown Tags"].recs.find((r) => r.f["Tag (EPC)"] === A6);
  assert.ok(a6, "A6B6 tag counts as ours"); assert.equal(a6.f.Status.name, "Needs Review");
  assert.ok(!t["Unknown Tags"].recs.some((r) => r.f["Tag (EPC)"] === FOREIGN || r.f["Tag (EPC)"] === PKG));
  assert.match(s["Missing Report"], /1 blocked tag\(s\) skipped[\s\S]*555555/); assert.match(s["Missing Report"], /1 other tag\(s\) ignored[\s\S]*1BF104/);
  console.log("PASS filter:", s.Summary);
}

// 1c. v1.6: hub Last Scan fields; a read clears Missing Tag / Visual Confirm + Visual Confirms in a Row; Damaged stays
{
  const t = freshBase({ "Hub Scanned": [QC6], "Scanned By": [{ id: "recDY", name: "Dylan Cockett" }], "Session Type": { name: "Spot Check" },
    "Site (snapped)": "Cockett Yard - Lewiston UT", "Raw Payload": [P("258227"), P("89616"), P("89599")].join("\n") });
  Object.assign(t.Tools.get("recT1"), { "Daily Status": { name: "Missing Tag" }, "Visual Confirms in a Row": 2 });
  Object.assign(t.Tools.get("recT2"), { "Daily Status": { name: "Damaged" } });
  Object.assign(t.Tools.get("recT3"), { "Daily Status": { name: "Visual Confirm" }, "Visual Confirms in a Row": 3 });
  await run(t, "recS1");
  const h = t.Hubs.get("recQC6");
  assert.ok(h["Last Scan At"] instanceof Date); assert.equal(h["Last Scan By"], "Dylan Cockett");
  assert.equal(h["Last Scan Site"], "Cockett Yard - Lewiston UT"); assert.match(h["Last Scan Summary"], /^3 read this pass/);
  assert.equal(t.Tools.get("recT1")["Daily Status"].name, "Confirmed (RFID)"); assert.equal(t.Tools.get("recT1")["Visual Confirms in a Row"], 0);
  assert.equal(t.Tools.get("recT2")["Daily Status"].name, "Damaged", "a scan never clears Damaged");
  assert.equal(t.Tools.get("recT3")["Daily Status"].name, "Confirmed (RFID)"); assert.equal(t.Tools.get("recT3")["Visual Confirms in a Row"], 0);
  assert.equal(t.Tools.get("recT1")["Last Scanned By"], "Dylan Cockett");
  console.log("PASS v1.6/1.7 hub last scan + tag health + last scanned by:", h["Last Scan Summary"]);
}

// 2. No GPS, no site → Last Seen Site falls back to the hub's Site / Location; Lat/Long untouched
{
  const t = freshBase({ "Hub Scanned": [QC6], "Session Type": { name: "Spot Check" }, "Raw Payload": P("258227") });
  t.Tools.get("recT1")["Last Seen Lat"] = 10;
  await run(t, "recS1");
  const tl = t.Tools.get("recT1");
  assert.equal(tl["Last Seen Site"], "Cockett Yard - Lewiston UT"); assert.equal(tl["Last Seen Lat"], 10);
  console.log("PASS no-gps fallback:", t["Scan Sessions"].get("recS1").Summary);
}

// 3. Sweep with no hub: Last Seen updated, Current Hub / misses untouched, no hub side effects
{
  const t = freshBase({ "Session Type": { name: "Sweep" }, Latitude: 37.95, Longitude: -121.29, "Site (snapped)": "Niagara Stockton",
    "Raw Payload": [P("258227"), P("89708"), PKG, P("77001")].join("\n") });
  t.Tools.get("recT4")["Current Hub"] = [QC4]; t.Tools.get("recT4")["Consecutive Misses"] = 3;
  await run(t, "recS1");
  const s = t["Scan Sessions"].get("recS1");
  assert.equal(s["Ingest Status"].name, "Done");
  assert.equal(s.Summary, "Sweep · 2 tools seen · 1 machines · 1 packaging ignored");
  assert.match(s.Session, /^Sweep — Niagara Stockton — /);
  const g = t.Tools.get("recT4");
  assert.equal(g["Current Hub"][0].id, "recQC4"); assert.equal(g["Consecutive Misses"], 3); assert.equal(g["Last Seen Site"], "Niagara Stockton");
  assert.equal(t.Equipment.get("recE1")["Current Hub"], undefined);
  assert.equal(t.Tools.get("recT5")["Consecutive Misses"], 0);
  assert.equal(t.Hubs.get("recQC6")["Last Known Lat"], undefined);
  assert.ok(t["Scan Log"].recs.every((r) => !r.f.Hub));
  assert.equal(t.Hubs.get("recQC6")["Last Scan At"], undefined, "a sweep never stamps a hub");
  console.log("PASS sweep:", s.Summary);
}

// 4. Non-sweep with no hub still fails cleanly
{
  const t = freshBase({ "Session Type": { name: "Full Hub Audit" }, "Raw Payload": P("258227") });
  await assert.rejects(run(t, "recS1"));
  assert.equal(t["Scan Sessions"].get("recS1")["Ingest Status"].name, "Error");
  console.log("PASS no-hub audit errors:", t["Scan Sessions"].get("recS1").Summary);
}

// 5. Already Done → skipped
{
  const t = freshBase({ "Hub Scanned": [QC6], "Ingest Status": { name: "Done" }, "Raw Payload": P("258227") });
  const out = await run(t, "recS1");
  assert.equal(out.summary, "already processed"); assert.equal(t["Scan Log"].recs.length, 0);
  console.log("PASS done-skip");
}
console.log("ALL INGEST HARNESS TESTS PASSED");
