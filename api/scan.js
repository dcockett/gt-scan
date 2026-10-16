// POST /api/scan → creates the Scan Session in Grey Trunk (same path the
// Airtable form uses: Raw Payload filled + Ingest Status blank triggers the
// "Scan Ingest — form" automation), then waits for the script to finish and
// returns its verdict so the phone can show it on the spot.
//
// Body: { hubId, personId, type, tags: [epc...], lat, lng, accuracy, site, notes }

import { T, F, SESSION_TYPES, createRecord, getRecord, selectName } from "../lib/airtable.js";
import { extractEpcs } from "../lib/epc.js";

const POLL_MS = 1000;
const POLL_MAX_MS = 25 * 1000; // Vercel hobby functions get 10s by default; vercel.json raises it

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanTags(tags) {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    const { epcs } = extractEpcs(String(t) + "\n");
    for (const e of epcs) {
      if (!seen.has(e)) {
        seen.add(e);
        out.push(e);
      }
    }
  }
  return out;
}

function reportLines(s) {
  return String(s || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function submitScan(body) {
  const hubId = String(body.hubId || "").trim();
  const personId = String(body.personId || "").trim();
  const type = SESSION_TYPES.includes(body.type) ? body.type : "Full Hub Audit";
  const tags = cleanTags(body.tags);

  if (!/^rec[A-Za-z0-9]{14}$/.test(hubId)) throw Object.assign(new Error("Pick a hub first."), { status: 400 });
  if (!/^rec[A-Za-z0-9]{14}$/.test(personId)) throw Object.assign(new Error("Pick who is scanning."), { status: 400 });
  if (!tags.length) throw Object.assign(new Error("No tags read yet — nothing to submit."), { status: 400 });

  const fields = {
    [F.sessions.hub]: [hubId],
    [F.sessions.by]: [personId],
    [F.sessions.type]: type,
    [F.sessions.started]: body.startedAt || new Date().toISOString(),
    [F.sessions.rawPayload]: tags.join("\n"),
  };
  if (Number.isFinite(body.lat) && Number.isFinite(body.lng)) {
    fields[F.sessions.lat] = body.lat;
    fields[F.sessions.lng] = body.lng;
    if (Number.isFinite(body.accuracy)) fields[F.sessions.accuracy] = Math.round(body.accuracy);
  }
  if (body.site) fields[F.sessions.site] = String(body.site).slice(0, 200);
  const notes = [body.notes ? String(body.notes).trim() : "", "via scan page"].filter(Boolean).join(" · ");
  fields[F.sessions.notes] = notes;

  const created = await createRecord(T.sessions, fields);
  const sessionId = created.id;

  // Wait for Scan Ingest to stamp Done / Error.
  const deadline = Date.now() + POLL_MAX_MS;
  let rec = created;
  let status = "";
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    rec = await getRecord(T.sessions, sessionId);
    status = selectName(rec.fields?.[F.sessions.ingestStatus]);
    if (status) break;
  }

  const f = rec.fields || {};
  const wrongBox = reportLines(f[F.sessions.wrongBoxReport]);
  const missing = reportLines(f[F.sessions.missingReport]);
  return {
    sessionId,
    status: status || "Pending",
    summary: f[F.sessions.summary] || (status ? "" : "Airtable is still processing — check the base in a moment."),
    label: f[F.sessions.label] || "",
    toolsRead: f[F.sessions.toolsRead] ?? tags.length,
    toolsExpected: f[F.sessions.toolsExpected] ?? null,
    wrongBox,
    // the first line of the missing report is a header like "137 of 143 not scanned today…"
    missingHeader: missing[0] || "",
    missing: missing.slice(1),
    submitted: tags.length,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }
  }
  try {
    const result = await submitScan(body || {});
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(result);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message || String(e) });
  }
}
