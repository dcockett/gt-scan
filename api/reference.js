// GET /api/reference.csv[?hub=QC006] — the tool list as a TagMatiks Wedge reference file, straight from Airtable.
// Import in TagMatiks: Application Configuration → Reference File → browse → this file; in Header Mapping map
// the system field "EPC (hex)" to our column "EPC". Then every read shows the tool's name and home box on the gun.
// Columns: EPC (24-hex, what the gun reads), Tag ID (label number), Name, Home Hub, Category, Kind (Tool/Equipment).

import { T, F, listAll } from "../lib/airtable.js";
import { loadHubs, matchHub } from "../lib/assign.js";

const CATEGORY = "flddpunQHqQ3ov5qJ"; // Tools.Category
const EQ_TYPE = "fldEzRTGg6ucXhdsP";  // Equipment.Type

const padEpc = (tag) => { const h = String(tag || "").toUpperCase().replace(/[^0-9A-F]/g, ""); return h && h.length <= 24 ? h.padStart(24, "0") : h; };
const sel = (v) => (v && typeof v === "object" ? v.name || "" : v || "");
const csvCell = (s) => { const t = String(s ?? ""); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") { res.status(405).json({ error: "GET only" }); return; }
  try {
    const url = new URL(req.url || "/", "http://x");
    const hubs = await loadHubs();
    const hubName = new Map(hubs.map((h) => [h.id, h.name]));
    const only = matchHub(url.searchParams.get("hub"), hubs);
    const [tools, equip] = await Promise.all([
      listAll(T.tools, { fields: [F.tools.name, F.tools.tagId, F.tools.homeHub, CATEGORY] }),
      listAll(T.equipment, { fields: [F.equipment.name, F.equipment.tagId, F.equipment.homeHub, EQ_TYPE] }),
    ]);
    const rows = [];
    for (const r of tools) {
      const tag = r.fields?.[F.tools.tagId]; if (!tag) continue;
      const home = (r.fields?.[F.tools.homeHub] || [])[0];
      if (only && home !== only.id) continue;
      rows.push([padEpc(tag), String(tag).replace(/^0+/, ""), r.fields?.[F.tools.name] || "", hubName.get(home) || "", sel(r.fields?.[CATEGORY]), "Tool"]);
    }
    for (const r of equip) {
      const tag = r.fields?.[F.equipment.tagId]; if (!tag) continue;
      const home = (r.fields?.[F.equipment.homeHub] || [])[0];
      if (only && home !== only.id) continue;
      rows.push([padEpc(tag), String(tag).replace(/^0+/, ""), r.fields?.[F.equipment.name] || "", hubName.get(home) || "", sel(r.fields?.[EQ_TYPE]), "Equipment"]);
    }
    rows.sort((a, b) => a[3].localeCompare(b[3]) || a[2].localeCompare(b[2]));
    const csv = ["EPC,Tag ID,Name,Home Hub,Category,Kind", ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n") + "\r\n";
    const fname = only ? `grey-trunk-reference-${only.name.replace(/[^A-Za-z0-9]+/g, "-")}.csv` : "grey-trunk-reference.csv";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    res.status(200).end(csv);
  } catch (e) {
    res.status(502).json({ error: e.message || String(e) });
  }
}
