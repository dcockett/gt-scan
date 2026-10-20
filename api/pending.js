// GET /api/pending — gun uploads (TagMatiks) parked as "Awaiting hub", newest first.
import { T, F, AWAITING_HUB, listAll, selectName } from "../lib/airtable.js";
import { parseTagList } from "../lib/epc.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") { res.status(405).json({ error: "GET only" }); return; }
  try {
    // filterByFormula needs the field *name*; the status check below is the backstop if the field is ever renamed.
    const recs = await listAll(T.sessions, {
      fields: [F.sessions.rawPayload, F.sessions.ingestStatus, F.sessions.started, F.sessions.lat, F.sessions.lng, F.sessions.notes],
      filterByFormula: `{Ingest Status} = '${AWAITING_HUB}'`,
    });
    const out = recs
      .filter((r) => selectName(r.fields?.[F.sessions.ingestStatus]) === AWAITING_HUB)
      .map((r) => {
        const tags = parseTagList(r.fields?.[F.sessions.rawPayload] || "");
        return {
          id: r.id,
          tags,
          count: tags.length,
          startedAt: r.fields?.[F.sessions.started] || r.createdTime || null,
          createdAt: r.createdTime || null,
          lat: r.fields?.[F.sessions.lat] ?? null,
          lng: r.fields?.[F.sessions.lng] ?? null,
          notes: r.fields?.[F.sessions.notes] || "",
        };
      })
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    res.status(200).json({ pending: out });
  } catch (e) {
    res.status(502).json({ error: e.message || String(e) });
  }
}
