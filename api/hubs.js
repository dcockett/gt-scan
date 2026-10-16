// GET /api/hubs → { hubs, people, types, fetchedAt }
// Live from Airtable with a short in-memory cache so the counter's "total"
// is never a stale snapshot. The token never leaves the server.

import { T, F, SESSION_TYPES, listAll, selectName } from "../lib/airtable.js";

const TTL_MS = 60 * 1000;
let cache = { at: 0, body: null };

export async function loadHubs() {
  if (cache.body && Date.now() - cache.at < TTL_MS) return cache.body;

  const [hubRecs, peopleRecs] = await Promise.all([
    listAll(T.hubs, {
      fields: [
        F.hubs.name,
        F.hubs.nickname,
        F.hubs.type,
        F.hubs.status,
        F.hubs.location,
        F.hubs.expected,
        F.hubs.scannedToday,
      ],
      sort: [{ field: F.hubs.name }],
    }),
    listAll(T.employees, {
      fields: [F.employees.name, F.employees.active],
      sort: [{ field: F.employees.name }],
    }),
  ]);

  const hubs = hubRecs
    .map((r) => {
      const f = r.fields || {};
      return {
        id: r.id,
        name: f[F.hubs.name] || "",
        nickname: f[F.hubs.nickname] || "",
        type: selectName(f[F.hubs.type]),
        status: selectName(f[F.hubs.status]),
        location: typeof f[F.hubs.location] === "string" ? f[F.hubs.location] : "",
        expected: Number(f[F.hubs.expected] || 0),
        scannedToday: Number(f[F.hubs.scannedToday] || 0),
      };
    })
    .filter((h) => h.name)
    // hubs with tools first, then the rest alphabetically
    .sort((a, b) => (b.expected > 0) - (a.expected > 0) || a.name.localeCompare(b.name));

  const people = peopleRecs
    .map((r) => ({
      id: r.id,
      name: (r.fields || {})[F.employees.name] || "",
      active: Boolean((r.fields || {})[F.employees.active]),
    }))
    .filter((p) => p.name)
    // active first; inactive still selectable at the bottom
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));

  cache = { at: Date.now(), body: { hubs, people, types: SESSION_TYPES, fetchedAt: new Date().toISOString() } };
  return cache.body;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "GET only" });
    return;
  }
  try {
    const body = await loadHubs();
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(body);
  } catch (e) {
    res.status(502).json({ error: e.message || String(e) });
  }
}
