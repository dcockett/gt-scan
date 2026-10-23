// Work out which hub a gun upload belongs to, so the ingest can run with nobody touching the page.
// Three answers, tried in order:
//   1. an explicit hub on the sled's upload URL (?hub=QC006) — the gun rides with the box
//   2. the inventory name typed in TagMatiks, if it names a hub
//   3. the tags vote: the home hub most of the known tags share
// Anything ambiguous returns null and the upload is parked for the page.

import { T, F, listAll } from "./airtable.js";

const TTL_MS = 5 * 60 * 1000;
let hubCache = { at: 0, list: [] };
let tagCache = { at: 0, map: new Map() };

const compact = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const stripZeros = (epc) => { const s = String(epc || "").toUpperCase().replace(/^0+/, ""); return s || String(epc || "").toUpperCase(); };

export async function loadHubs() {
  if (Date.now() - hubCache.at < TTL_MS && hubCache.list.length) return hubCache.list;
  const recs = await listAll(T.hubs, { fields: [F.hubs.name, F.hubs.nickname, F.hubs.siteText, F.hubs.assignedJob, F.hubs.lastLat, F.hubs.lastLng] });
  hubCache = { at: Date.now(), list: recs.map((r) => {
    const f = r.fields || {};
    const lat = Number(f[F.hubs.lastLat]), lng = Number(f[F.hubs.lastLng]);
    return { id: r.id, name: f[F.hubs.name] || "", nickname: f[F.hubs.nickname] || "",
      site: f[F.hubs.siteText] || "", job: f[F.hubs.assignedJob] || "",
      pos: Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0) && f[F.hubs.lastLat] != null ? { lat, lng } : null };
  }) };
  return hubCache.list;
}

/** Tag ID (leading zeros stripped) → home hub record id, for tools and equipment. */
export async function loadTagHomes() {
  if (Date.now() - tagCache.at < TTL_MS && tagCache.map.size) return tagCache.map;
  const map = new Map();
  const [tools, equip] = await Promise.all([
    listAll(T.tools, { fields: [F.tools.tagId, F.tools.homeHub] }),
    listAll(T.equipment, { fields: [F.equipment.tagId, F.equipment.homeHub] }),
  ]);
  for (const r of tools) { const t = stripZeros(r.fields?.[F.tools.tagId]); const h = r.fields?.[F.tools.homeHub]; if (t && Array.isArray(h) && h[0]) map.set(t, h[0]); }
  for (const r of equip) { const t = stripZeros(r.fields?.[F.equipment.tagId]); const h = r.fields?.[F.equipment.homeHub]; if (t && !map.has(t) && Array.isArray(h) && h[0]) map.set(t, h[0]); }
  tagCache = { at: Date.now(), map };
  return map;
}

/** "QC006", "qc 006", "Quad Con 006", a record id, or a nickname → hub, or null. */
export function matchHub(key, hubs) {
  const k = String(key || "").trim();
  if (!k) return null;
  if (/^rec[A-Za-z0-9]{14}$/.test(k)) return hubs.find((h) => h.id === k) || null;
  const ck = compact(k);
  if (!ck) return null;
  // "QC006" / "QC 6" / "006" / "6" → the quad con with that number
  const numMatch = /^(?:QC|QUADCON)?0*(\d+)$/.exec(ck);
  const num = numMatch ? numMatch[1].padStart(3, "0") : null;
  return hubs.find((h) => compact(h.name) === ck)
      || hubs.find((h) => h.nickname && compact(h.nickname) === ck)
      || (num ? hubs.find((h) => /^QUADCON\d+$/.test(compact(h.name)) && compact(h.name).endsWith(num)) : null)
      || null;
}

/**
 * Majority home hub among the known tags. A hub wins when it has a clear majority of the known reads AND
 * either at least 3 votes or every known tag agrees (≥ 2). Anything thinner is a guess, so it parks.
 */
export function voteHub(epcs, tagHomes) {
  const counts = new Map();
  let known = 0;
  for (const e of epcs) { const h = tagHomes.get(stripZeros(e)); if (!h) continue; known++; counts.set(h, (counts.get(h) || 0) + 1); }
  if (known < 2) return null;
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [top, n] = ranked[0];
  const runnerUp = ranked[1]?.[1] || 0;
  if (n <= runnerUp || n * 2 <= known) return null;
  if (n < 3 && n !== known) return null;
  return { hubId: top, votes: n, known, total: epcs.length };
}

/** The box most of the known tags call home, even when it's no majority — for labelling an unconfirmed scan. */
export function leadingHub(epcs, tagHomes) {
  const counts = new Map(); let known = 0;
  for (const e of epcs) { const h = tagHomes.get(stripZeros(e)); if (!h) continue; known++; counts.set(h, (counts.get(h) || 0) + 1); }
  if (!known) return { hubId: null, votes: 0, known: 0 };
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [hubId, votes] = ranked[0];
  return { hubId, votes, known, tiedWith: ranked[1] && ranked[1][1] === votes ? ranked[1][0] : null };
}

export async function describeLeader(epcs) {
  const [hubs, homes] = await Promise.all([loadHubs(), loadTagHomes()]);
  const l = leadingHub(epcs, homes);
  if (!l.known) return "no tagged tools in it";
  const name = (id) => hubs.find((h) => h.id === id)?.name || "?";
  if (l.tiedWith) return `tie: ${name(l.hubId)} and ${name(l.tiedWith)} (${l.votes} each of ${l.known} tagged tools)`;
  return `mostly ${name(l.hubId)} (${l.votes} of ${l.known} tagged tools)`;
}

/**
 * Decide the hub for an upload. Returns { hub, how, warning? } or null.
 * The tags outrank everything (sleds get swapped between boxes); the inventory name and the sled's URL
 * only settle it when the vote is unclear. A vote that contradicts the URL is honored and flagged.
 */
export async function assignHub({ urlHub, inventoryName, epcs }) {
  const hubs = await loadHubs();
  const fromUrl = matchHub(urlHub, hubs);
  const fromName = matchHub(inventoryName, hubs);
  let voted = null;
  if (epcs.length) {
    const v = voteHub(epcs, await loadTagHomes());
    if (v) { const hub = hubs.find((h) => h.id === v.hubId); if (hub) voted = { hub, how: `tags voted ${v.votes}/${v.known} known (${v.total} read)` }; }
  }
  if (voted) {
    const claimed = fromName || fromUrl;
    if (claimed && claimed.id !== voted.hub.id) voted.warning = `sled/inventory said ${claimed.name} but the tags say ${voted.hub.name} — went with the tags`;
    return voted;
  }
  if (fromName) return { hub: fromName, how: `inventory name "${inventoryName}" (tags inconclusive)` };
  if (fromUrl) return { hub: fromUrl, how: `sled url "${urlHub}" (tags inconclusive)` };
  return null;
}
