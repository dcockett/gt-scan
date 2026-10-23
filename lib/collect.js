// One scan = one Scan Session, even though TagMatiks Auto Upload sends a scan in pieces (seen Oct 23: 6 + 3 tags
// 4 s apart; 14, 2, then all 16 within 50 s). Every piece from the same sled + person lands in an open
// "Collecting" session; once no new piece has arrived for QUIET_MS, the session is finalised: the box vote
// runs once on the whole scan, then Ingest Status is cleared so the Scan Ingest automation processes it.
//
//   receiveChunk()  — append to the open session for this sled+person (≤ WINDOW_MS old), or open a new one
//   finalizeSession() — decide box / sweep / unconfirmed on the merged tags, hand to the automation
//   finalizeStale() — safety net: anything still "Collecting" after STALE_MS gets finalised (called on every
//                     upload and by the daily cron), so nothing can sit there forever.

import { createHash } from "node:crypto";
import * as at from "./airtable.js";
import * as asg from "./assign.js";
import { snapSite as realSnap } from "./site.js";

export const COLLECTING = "Collecting";
export const QUIET_MS = 25 * 1000;
export const WINDOW_MS = 3 * 60 * 1000;
export const STALE_MS = 2 * 60 * 1000;

const realDeps = () => ({
  T: at.T, F: at.F,
  listAll: at.listAll, createRecord: at.createRecord, getRecord: at.getRecord, updateRecord: at.updateRecord,
  assignHub: asg.assignHub, describeLeader: asg.describeLeader, snapSite: realSnap,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(),
});

export const groupToken = (sled, by) => createHash("sha1").update(`${sled}|${String(by || "").toLowerCase()}`).digest("hex").slice(0, 8);
const status = (f, F) => { const v = f?.[F.sessions.ingestStatus]; return v ? (typeof v === "string" ? v : v.name) : ""; };
const uploads = (notes) => (String(notes || "").match(/upload [0-9a-f]{10}/g) || []).length;
const splitTags = (s) => String(s || "").split(/\s+/).filter(Boolean);

const open = new Map();   // group → { sessionId, createdAt }   (warm-instance cache)
const locks = new Map();  // group → promise chain              (serialise pieces within an instance)

/**
 * c: { sled, device, by, person:{id,name}|null, epcs, lat, lng, place, uploadKey, urlType ("" | "Sweep" | …), urlHub }
 * → { sessionId, chunk, created }
 */
export async function receiveChunk(c, deps = realDeps()) {
  const g = groupToken(c.sled || c.device || "", c.by);
  const prev = locks.get(g) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => receiveLocked(c, g, deps));
  locks.set(g, run);
  try { return await run; } finally { if (locks.get(g) === run) locks.delete(g); }
}

async function receiveLocked(c, g, deps) {
  const { T, F } = deps;
  const now = deps.now();
  let target = null;
  const mem = open.get(g);
  if (mem && now - mem.createdAt < WINDOW_MS) target = mem.sessionId;
  if (!target) {
    try {
      const recs = await deps.listAll(T.sessions, {
        fields: [F.sessions.notes, F.sessions.ingestStatus],
        filterByFormula: `AND({Ingest Status}='${COLLECTING}', FIND('group ${g}', {Notes}), IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -${Math.round(WINDOW_MS / 60000)}, 'minutes')))`,
      });
      const hit = recs.find((r) => status(r.fields, F) === COLLECTING && String(r.fields?.[F.sessions.notes] || "").includes(`group ${g}`)
        && (!r.createdTime || now - Date.parse(r.createdTime) < WINDOW_MS));
      if (hit) { target = hit.id; open.set(g, { sessionId: hit.id, createdAt: hit.createdTime ? Date.parse(hit.createdTime) : now }); }
    } catch (e) { console.warn("[collect] open-session lookup failed", e.message); }
  }

  if (target) {
    const rec = await deps.getRecord(T.sessions, target);
    if (status(rec.fields, F) === COLLECTING) {
      const merged = [...new Set([...splitTags(rec.fields?.[F.sessions.rawPayload]), ...c.epcs])];
      const notes = `${rec.fields?.[F.sessions.notes] || ""} · upload ${c.uploadKey} · +${c.epcs.length} tags`;
      const fields = { [F.sessions.rawPayload]: merged.join("\n"), [F.sessions.notes]: notes };
      if (rec.fields?.[F.sessions.lat] == null && c.lat != null) { fields[F.sessions.lat] = c.lat; fields[F.sessions.lng] = c.lng; }
      await deps.updateRecord(T.sessions, target, fields);
      return { sessionId: target, chunk: uploads(notes), created: false };
    }
    open.delete(g); // it was finalised meanwhile → start a fresh one
  }

  const notes = ["via TagMatiks", c.sled ? `sled ${c.sled}` : "", c.device && c.device !== c.sled ? `device ${c.device}` : "", `group ${g}`,
    c.urlHub ? `hint ${c.urlHub}` : "", `upload ${c.uploadKey}`, `${c.epcs.length} tags`].filter(Boolean).join(" · ");
  const fields = {
    [F.sessions.rawPayload]: c.epcs.join("\n"),
    [F.sessions.started]: new Date(now).toISOString(),
    [F.sessions.notes]: notes,
    [F.sessions.ingestStatus]: COLLECTING,
  };
  if (c.urlType) fields[F.sessions.type] = c.urlType;
  if (c.person) fields[F.sessions.by] = [c.person.id];
  if (c.lat != null && c.lng != null) { fields[F.sessions.lat] = c.lat; fields[F.sessions.lng] = c.lng; }
  if (c.place) fields[F.sessions.site] = String(c.place).slice(0, 200); // the gun's own place name, replaced on finalise
  const rec = await deps.createRecord(T.sessions, fields);
  open.set(g, { sessionId: rec.id, createdAt: now });
  return { sessionId: rec.id, chunk: 1, created: true };
}

/** After QUIET_MS, finalise — unless a later piece arrived (that piece's own timer will do it). */
export async function finalizeAfterQuiet(sessionId, chunk, deps = realDeps()) {
  await deps.sleep(QUIET_MS);
  return finalizeSession(sessionId, { expectChunks: chunk }, deps);
}

export async function finalizeSession(sessionId, { expectChunks = null, force = false } = {}, deps = realDeps()) {
  const { T, F } = deps;
  const rec = await deps.getRecord(T.sessions, sessionId);
  const f = rec.fields || {};
  if (status(f, F) !== COLLECTING) return { skipped: "not collecting" };
  const notes = String(f[F.sessions.notes] || "");
  const n = uploads(notes);
  if (!force && expectChunks != null && n > expectChunks) return { skipped: "a later piece will finalise" };

  const epcs = splitTags(f[F.sessions.rawPayload]);
  const typeNow = f[F.sessions.type] ? (typeof f[F.sessions.type] === "string" ? f[F.sessions.type] : f[F.sessions.type].name) : "";
  const isSweep = typeNow === "Sweep";
  const hint = (notes.match(/hint ([^·]+)/) || [])[1]?.trim() || null;
  const assigned = isSweep ? null : await deps.assignHub({ urlHub: hint, inventoryName: "", epcs });
  const unconfirmed = !isSweep && !assigned;
  const leader = unconfirmed ? await deps.describeLeader(epcs).catch(() => "") : "";
  const lat = f[F.sessions.lat], lng = f[F.sessions.lng];
  const gunPlace = String(f[F.sessions.site] || "");
  let snapped = { site: gunPlace, how: "gun's reported place" };
  try { snapped = await deps.snapSite({ lat: lat ?? null, lng: lng ?? null, hubId: assigned?.hub.id || null, gunPlace }); }
  catch (e) { console.warn("[collect] site snap failed", e.message); }

  const verdict = isSweep ? "sweep — no hub"
    : assigned ? `hub auto: ${assigned.how}${assigned.warning ? ` · ⚠️ ${assigned.warning}` : ""}`
    : `UNCONFIRMED box — tags didn't agree${leader ? `; ${leader}` : ""} · processed as a sweep (no missing / wrong-box)`;
  const merged = n > 1 ? ` · ${n} uploads merged into one scan (${epcs.length} tags)` : "";
  const fields = {
    [F.sessions.notes]: `${notes}${merged} · ${verdict}${snapped.site ? ` · site: ${snapped.how}` : ""}${force ? " · finalised by the safety net" : ""}`,
    [F.sessions.ingestStatus]: null, // blank → the Scan Ingest automation fires
  };
  if (snapped.site) fields[F.sessions.site] = snapped.site.slice(0, 200);
  if (assigned) { fields[F.sessions.hub] = [assigned.hub.id]; if (!typeNow) fields[F.sessions.type] = "Full Hub Audit"; }
  else fields[F.sessions.type] = "Sweep";
  await deps.updateRecord(T.sessions, sessionId, fields);
  for (const [g, v] of open) if (v.sessionId === sessionId) open.delete(g);
  console.log("[collect] finalised", { sessionId, uploads: n, tags: epcs.length, hub: assigned?.hub.name || null, unconfirmed, force });
  return { sessionId, uploads: n, tags: epcs.length, hub: assigned?.hub.name || null, unconfirmed, sweep: isSweep };
}

/** Safety net: finalise anything still collecting after STALE_MS. */
export async function finalizeStale(deps = realDeps()) {
  const { T, F } = deps;
  const recs = await deps.listAll(T.sessions, {
    fields: [F.sessions.ingestStatus],
    filterByFormula: `AND({Ingest Status}='${COLLECTING}', IS_BEFORE(CREATED_TIME(), DATEADD(NOW(), -${Math.round(STALE_MS / 60000)}, 'minutes')))`,
  });
  const now = deps.now();
  const stale = recs.filter((r) => status(r.fields, F) === COLLECTING && (!r.createdTime || now - Date.parse(r.createdTime) >= STALE_MS));
  const out = [];
  for (const r of stale) { try { out.push(await finalizeSession(r.id, { force: true }, deps)); } catch (e) { console.warn("[collect] stale finalise failed", r.id, e.message); } }
  return out;
}

export function __resetForTests() { open.clear(); locks.clear(); }
