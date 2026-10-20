// POST /api/tagmatiks[?hub=QC006&by=Dylan+Cockett&type=Full+Hub+Audit&sled=1&k=KEY]
// Receiver for TagMatiks Wedge "Export Via API" (Auto Upload on).
//
// TagMatiks posts the inventory as a JSON array of reads:
//   [{ "EPC": "0000…258227", "RSSI": "-54", "ReadCount": "2", "Latitude": "41.9", "Longitude": "-111.8",
//      "ReadTime": "10/20/2026 01:46 AM", "EPCBank": "", "LocationDetail": "…", "Quantity": "1" }, …]
//
// The hub is worked out here (lib/assign.js: URL → inventory name → the tags vote). When it is known, the
// Scan Session is created complete, the Scan Ingest automation runs, and the result is waited for briefly.
// When it isn't, the session is parked as Ingest Status = "Awaiting hub" for the scan page to claim.
//
// If TAGMATIKS_KEY is set on the server, the URL must carry ?k=<that key>.

import { T, F, SESSION_TYPES, AWAITING_HUB, createRecord, getRecord, listAll, selectName } from "../lib/airtable.js";
import { parseTagList } from "../lib/epc.js";
import { assignHub } from "../lib/assign.js";

const WAIT_MS = 20 * 1000;

function num(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").trim());
  return Number.isFinite(n) ? n : null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Find the array of reads in whatever shape the body arrived. */
export function extractReads(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    for (const k of ["data", "Data", "tags", "Tags", "items", "records", "reads", "inventory", "Inventory"]) {
      if (Array.isArray(body[k])) return body[k];
    }
    if (body.EPC || body.epc) return [body];
  }
  return [];
}

/** Turn a TagMatiks payload into { epcs, lat, lng, inventory, reads } */
export function digest(body) {
  const reads = extractReads(body);
  const epcs = [];
  const seen = new Set();
  let lat = null, lng = null, inventory = "";
  for (const r of reads) {
    const raw = r?.EPC ?? r?.epc ?? r?.Epc ?? r?.TagID ?? r?.tagId ?? r?.tag ?? "";
    for (const e of parseTagList(String(raw))) if (!seen.has(e)) { seen.add(e); epcs.push(e); }
    if (lat == null) { const la = num(r?.Latitude ?? r?.latitude), lo = num(r?.Longitude ?? r?.longitude); if (la != null && lo != null && (la !== 0 || lo !== 0)) { lat = la; lng = lo; } }
    if (!inventory) inventory = String(r?.InventoryName ?? r?.inventoryName ?? r?.Inventory ?? r?.inventory ?? "").trim();
  }
  if (!inventory && body && typeof body === "object" && !Array.isArray(body)) inventory = String(body.InventoryName ?? body.inventoryName ?? body.name ?? "").trim();
  if (!epcs.length && typeof body === "string") for (const e of parseTagList(body)) if (!seen.has(e)) { seen.add(e); epcs.push(e); }
  return { epcs, lat, lng, inventory, reads: reads.length };
}

let peopleCache = { at: 0, list: [] };
async function findPerson(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  if (Date.now() - peopleCache.at > 5 * 60 * 1000 || !peopleCache.list.length) {
    const recs = await listAll(T.employees, { fields: [F.employees.name] });
    peopleCache = { at: Date.now(), list: recs.map((r) => ({ id: r.id, name: String(r.fields?.[F.employees.name] || "") })) };
  }
  return peopleCache.list.find((p) => p.name.toLowerCase() === n)
      || peopleCache.list.find((p) => p.name.toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0] && n.split(/\s+/).length === 1)
      || null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") {
    res.status(200).json({ ok: true, service: "gt-scan tagmatiks receiver", expects: "POST JSON array of {EPC,…}", keyRequired: !!process.env.TAGMATIKS_KEY,
      options: "?hub=QC006 (which box this sled rides in) ?by=Name (who scans with it) ?type=Full Hub Audit ?sled=1" });
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const url = new URL(req.url || "/", "http://x");
  const q = url.searchParams;
  const need = process.env.TAGMATIKS_KEY;
  if (need && q.get("k") !== need) { res.status(401).json({ error: "bad key" }); return; }
  const sled = (q.get("sled") || q.get("device") || "").slice(0, 40);
  const type = SESSION_TYPES.includes(q.get("type") || "") ? q.get("type") : "Full Hub Audit";

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* digest() will scan the text for tags */ } }
  const ct = String(req.headers?.["content-type"] || "");
  console.log("[tagmatiks] POST", { ct, type: Array.isArray(body) ? "array" : typeof body, keys: body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).slice(0, 10) : undefined, sample: JSON.stringify(body).slice(0, 300) });

  const d = digest(body);
  if (!d.epcs.length) { res.status(400).json({ error: "No tags found in the upload", reads: d.reads }); return; }

  try {
    const assigned = await assignHub({ urlHub: q.get("hub"), inventoryName: d.inventory, epcs: d.epcs });
    const person = await findPerson(q.get("by"));
    const notes = ["via TagMatiks", sled ? `sled ${sled}` : "", d.inventory ? `inventory "${d.inventory}"` : "", `${d.epcs.length} tags`,
      assigned ? `hub auto: ${assigned.how}` : "hub unknown — waiting for the page", assigned?.warning ? `⚠️ ${assigned.warning}` : ""].filter(Boolean).join(" · ");

    const fields = {
      [F.sessions.rawPayload]: d.epcs.join("\n"),
      [F.sessions.started]: new Date().toISOString(),
      [F.sessions.notes]: notes,
    };
    if (d.lat != null && d.lng != null) { fields[F.sessions.lat] = d.lat; fields[F.sessions.lng] = d.lng; }
    if (assigned) {
      fields[F.sessions.hub] = [assigned.hub.id];
      fields[F.sessions.type] = type;
      if (person) fields[F.sessions.by] = [person.id];
      // Ingest Status left blank → the Scan Ingest automation fires
    } else {
      fields[F.sessions.ingestStatus] = AWAITING_HUB;
    }

    const rec = await createRecord(T.sessions, fields);
    if (!assigned) {
      res.status(200).json({ ok: true, sessionId: rec.id, tags: d.epcs.length, status: AWAITING_HUB, next: "Open the scan page, tap the waiting scan, pick the hub, Complete." });
      return;
    }
    // give the automation a moment so the response (and Vercel logs) carry the verdict
    const deadline = Date.now() + WAIT_MS;
    let status = "", summary = "";
    while (Date.now() < deadline) {
      await sleep(1000);
      const r = await getRecord(T.sessions, rec.id);
      status = selectName(r.fields?.[F.sessions.ingestStatus]);
      summary = r.fields?.[F.sessions.summary] || "";
      if (status) break;
    }
    console.log("[tagmatiks] result", { sessionId: rec.id, hub: assigned.hub.name, how: assigned.how, status: status || "Pending", summary });
    res.status(200).json({ ok: true, sessionId: rec.id, tags: d.epcs.length, hub: assigned.hub.name, how: assigned.how, by: person?.name || null, status: status || "Pending", summary });
  } catch (e) {
    console.error("[tagmatiks] error", e.message);
    res.status(502).json({ error: e.message || String(e) });
  }
}
