// POST /api/tagmatiks[?k=KEY] — receiver for TagMatiks Wedge "Export Via API".
//
// TagMatiks posts the inventory as a JSON array of reads:
//   [{ "EPC": "0000…258227", "RSSI": "-54", "ReadCount": "2", "Latitude": "41.9", "Longitude": "-111.8",
//      "ReadTime": "10/20/2026 01:46 AM", "EPCBank": "", "LocationDetail": "…", "Quantity": "1" }, …]
// The upload carries no hub, so the session is parked in Scan Sessions with
// Ingest Status = "Awaiting hub" (the Scan Ingest automation only fires on a
// blank status). The scan page lists these under "waiting from the gun"; picking
// a hub + person and tapping Complete clears the status and the ingest runs.
//
// If TAGMATIKS_KEY is set on the server, the URL must carry ?k=<that key>.

import { T, F, AWAITING_HUB, createRecord } from "../lib/airtable.js";
import { parseTagList } from "../lib/epc.js";

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
    // single read object
    if (body.EPC || body.epc) return [body];
  }
  return [];
}

/** Turn a TagMatiks payload into { epcs, lat, lng, started, inventory } */
export function digest(body) {
  const reads = extractReads(body);
  const epcs = [];
  const seen = new Set();
  let lat = null, lng = null, started = null, inventory = "";
  for (const r of reads) {
    const raw = r?.EPC ?? r?.epc ?? r?.Epc ?? r?.TagID ?? r?.tagId ?? r?.tag ?? "";
    for (const e of parseTagList(String(raw))) if (!seen.has(e)) { seen.add(e); epcs.push(e); }
    if (lat == null) { const la = num(r?.Latitude ?? r?.latitude), lo = num(r?.Longitude ?? r?.longitude); if (la != null && lo != null && (la !== 0 || lo !== 0)) { lat = la; lng = lo; } }
    if (!started) { const t = Date.parse(String(r?.ReadTime ?? r?.readTime ?? "")); if (Number.isFinite(t)) started = new Date(t).toISOString(); }
    if (!inventory) inventory = String(r?.InventoryName ?? r?.inventoryName ?? r?.Inventory ?? "").trim();
  }
  if (!epcs.length && body && typeof body === "string") for (const e of parseTagList(body)) if (!seen.has(e)) { seen.add(e); epcs.push(e); }
  return { epcs, lat, lng, started, inventory, reads: reads.length };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") {
    res.status(200).json({ ok: true, service: "gt-scan tagmatiks receiver", expects: "POST JSON array of {EPC,…}", keyRequired: !!process.env.TAGMATIKS_KEY });
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const url = new URL(req.url || "/", "http://x");
  const need = process.env.TAGMATIKS_KEY;
  if (need && url.searchParams.get("k") !== need) { res.status(401).json({ error: "bad key" }); return; }
  const sled = (url.searchParams.get("sled") || url.searchParams.get("device") || "").slice(0, 40);

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* leave as text; digest() will scan it for tags */ } }
  const ct = String(req.headers?.["content-type"] || "");
  console.log("[tagmatiks] POST", { ct, type: Array.isArray(body) ? "array" : typeof body, keys: body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).slice(0, 10) : undefined, sample: JSON.stringify(body).slice(0, 400) });

  const d = digest(body);
  if (!d.epcs.length) { res.status(400).json({ error: "No tags found in the upload", reads: d.reads }); return; }

  const fields = {
    [F.sessions.rawPayload]: d.epcs.join("\n"),
    [F.sessions.ingestStatus]: AWAITING_HUB,
    [F.sessions.started]: d.started || new Date().toISOString(),
    [F.sessions.notes]: ["via TagMatiks", sled ? `sled ${sled}` : "", d.inventory ? `inventory "${d.inventory}"` : "", `${d.epcs.length} tags`].filter(Boolean).join(" · "),
  };
  if (d.lat != null && d.lng != null) { fields[F.sessions.lat] = d.lat; fields[F.sessions.lng] = d.lng; }

  try {
    const rec = await createRecord(T.sessions, fields);
    res.status(200).json({ ok: true, sessionId: rec.id, tags: d.epcs.length, status: AWAITING_HUB, next: "Open the scan page, tap the waiting scan, pick the hub, Complete." });
  } catch (e) {
    console.error("[tagmatiks] airtable error", e.message);
    res.status(502).json({ error: e.message || String(e) });
  }
}
