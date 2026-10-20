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

import { createHash } from "node:crypto";
import { T, F, SESSION_TYPES, AWAITING_HUB, createRecord, listAll } from "../lib/airtable.js";
import { parseTagList } from "../lib/epc.js";
import { assignHub } from "../lib/assign.js";

// TagMatiks re-sends an upload if the response is slow, so: answer at once, and treat the same tag set from the
// same sled inside this window as one upload. Checked in memory (warm instance) and in Airtable (cold start).
const DEDUPE_MS = 3 * 60 * 1000;
const recent = new Map(); // uploadKey → { at, sessionId }
function uploadKey(sled, epcs) { return createHash("sha1").update(sled + "|" + [...epcs].sort().join(",")).digest("hex").slice(0, 10); }
async function alreadyLanded(key) {
  const mem = recent.get(key);
  if (mem && Date.now() - mem.at < DEDUPE_MS) return mem.sessionId;
  try {
    const recs = await listAll(T.sessions, { fields: [F.sessions.notes], filterByFormula: `AND(FIND('upload ${key}', {Notes}), IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -${DEDUPE_MS / 60000}, 'minutes')))` });
    const hit = recs.find((r) => String(r.fields?.[F.sessions.notes] || "").includes(`upload ${key}`));
    if (hit) return hit.id;
  } catch (e) { console.warn("[tagmatiks] dedupe lookup failed", e.message); }
  return null;
}

function num(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

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
    const key = uploadKey(sled, d.epcs);
    const dup = await alreadyLanded(key);
    if (dup) { console.log("[tagmatiks] duplicate upload ignored", { key, sessionId: dup }); res.status(200).json({ ok: true, duplicate: true, sessionId: dup, tags: d.epcs.length }); return; }
    recent.set(key, { at: Date.now(), sessionId: "pending" });

    const assigned = await assignHub({ urlHub: q.get("hub"), inventoryName: d.inventory, epcs: d.epcs });
    const person = await findPerson(q.get("by"));
    const notes = ["via TagMatiks", sled ? `sled ${sled}` : "", `upload ${key}`, d.inventory ? `inventory "${d.inventory}"` : "", `${d.epcs.length} tags`,
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
    recent.set(key, { at: Date.now(), sessionId: rec.id });
    if (!assigned) {
      console.log("[tagmatiks] parked", { sessionId: rec.id, tags: d.epcs.length, sled });
      res.status(200).json({ ok: true, sessionId: rec.id, tags: d.epcs.length, status: AWAITING_HUB, next: "Open the scan page, tap the waiting scan, pick the hub, Complete." });
      return;
    }
    // answer right away — the Scan Ingest automation runs on its own; a slow answer makes TagMatiks re-send
    console.log("[tagmatiks] assigned", { sessionId: rec.id, hub: assigned.hub.name, how: assigned.how, warning: assigned.warning, by: person?.name, tags: d.epcs.length });
    res.status(200).json({ ok: true, sessionId: rec.id, tags: d.epcs.length, hub: assigned.hub.name, how: assigned.how, warning: assigned.warning, by: person?.name || null, status: "Processing" });
  } catch (e) {
    console.error("[tagmatiks] error", e.message);
    res.status(502).json({ error: e.message || String(e) });
  }
}
