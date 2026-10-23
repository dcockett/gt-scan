// Thin Airtable REST client for the relay. Field/table IDs are pinned so
// renames in the base don't break the page.

export const BASE_ID = process.env.AIRTABLE_BASE_ID || "app2Hy10fWVqEs4T0";

export const T = {
  hubs: "tblJivoY2jZI9b3at",
  employees: "tbldQrEVxFYdVrBi5",
  sessions: "tbl1gDnpnNoa36d38",
  tools: "tblt1mNexHRkG0aSq",
  equipment: "tblIzmuWnWGcnimVz",
};

export const F = {
  tools: { name: "fldzrUK25BcmobI7p", tagId: "fldlIt2543zw00wwN", homeHub: "fld8zHzmbea5o44AF" },
  equipment: { name: "fldp9PjTXWJLfpX0w", tagId: "fldkGvIQu7ni7c75w", homeHub: "fld1B1eldfWAy62AZ" },
  hubs: {
    name: "fldOwxEqbJFOKbiM4",
    nickname: "fldKrXCyYdHpPYazv",
    type: "fldKy8gIBtEZjfSec",
    status: "fldVSwin0zwU46vsH",
    location: "fld3IDMLUHwIVIvHP", // Location (effective)
    siteText: "fld78dUMGnzN9AspA", // Site / Location (typed / written by Ops)
    assignedJob: "fldZkQ7LUuRCH1uUc", // Assigned Job (Ops write-back)
    lastLat: "fldJtTQekDjZ7NhEL", // Last Known Lat (set by scans)
    lastLng: "fldY4n4VexRFZ0zR6", // Last Known Long
    expected: "fldYGE9qP0e6rv7KV", // Tools Expected (count)
    scannedToday: "fldma8X4hhexTc8bC",
  },
  employees: {
    name: "fldtLUOMaubO4pXJC",
    active: "fld524UDt907nY6Y0",
  },
  sessions: {
    label: "fldWdefgntg5yQYFm",
    hub: "fldfTyKsOAdSHbVnO",
    by: "fldFXmgxzRNdhNOeN",
    started: "fldzkxrBiCqglez6U",
    ended: "fld3HjDvxWBsJznJn",
    lat: "fldhaXazA8gJSOCuj",
    lng: "fldUjkKlOWCAfgQEx",
    accuracy: "fldWc5ZsGWIDrkh2A",
    site: "fldCHmEdFrhv2wTOW",
    type: "fldLDSeaP6CQrxq8Y",
    toolsRead: "fldDGjGhVdjw3GHtk",
    toolsExpected: "flduNI4ZbQY1GAvXN",
    missingReport: "fld0CL36kcxVKUU0U",
    wrongBoxReport: "fldO9vDlAzhBwGcPY",
    notes: "fldny2z8Z5OKuL51P",
    rawPayload: "flde0qnfKleKwNcHZ",
    ingestStatus: "fldDjF1KMVfUkZRjt",
    summary: "fld1isLmXoiDuODDL",
  },
};

export const SESSION_TYPES = [
  "Full Hub Audit",
  "Spot Check",
  "Load Out",
  "Return / Restock",
  "Final Check — Ready to Roll",
  "Check Out (borrow)",
  "Check In (return)",
  "Sweep", // no hub: logs where every tool was seen, judges nothing (Scan Ingest v1.4)
];

function token() {
  const t = process.env.AIRTABLE_TOKEN;
  if (!t) throw new Error("AIRTABLE_TOKEN is not set on the server");
  return t;
}

const API = process.env.AIRTABLE_API_BASE || "https://api.airtable.com/v0";

async function call(path, init = {}) {
  const res = await fetch(`${API}/${BASE_ID}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const msg = body?.error?.message || body?.error || res.statusText;
    const err = new Error(`Airtable ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** List every record in a table (follows offsets), returning fields keyed by field ID. */
export async function listAll(tableId, { fields = [], filterByFormula, sort } = {}) {
  const out = [];
  let offset;
  do {
    const qs = new URLSearchParams();
    qs.set("returnFieldsByFieldId", "true");
    qs.set("pageSize", "100");
    for (const f of fields) qs.append("fields[]", f);
    if (filterByFormula) qs.set("filterByFormula", filterByFormula);
    if (sort) sort.forEach((s, i) => {
      qs.set(`sort[${i}][field]`, s.field);
      qs.set(`sort[${i}][direction]`, s.direction || "asc");
    });
    if (offset) qs.set("offset", offset);
    const page = await call(`${tableId}?${qs.toString()}`);
    out.push(...(page.records || []));
    offset = page.offset;
  } while (offset);
  return out;
}

export async function createRecord(tableId, fields) {
  const body = await call(`${tableId}?returnFieldsByFieldId=true`, {
    method: "POST",
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  return body.records[0];
}

export async function getRecord(tableId, recordId) {
  return call(`${tableId}/${recordId}?returnFieldsByFieldId=true`);
}

export async function updateRecord(tableId, recordId, fields) {
  return call(`${tableId}/${recordId}?returnFieldsByFieldId=true`, {
    method: "PATCH",
    body: JSON.stringify({ fields, typecast: true }),
  });
}

/** Delete up to 10 records (Airtable's per-request max). Only the Scan Log cleanup (lib/prune.js) calls this. */
export async function deleteRecords(tableId, ids) {
  if (!ids.length) return { records: [] };
  if (ids.length > 10) throw new Error("deleteRecords: max 10 per call");
  const qs = ids.map((id) => `records[]=${encodeURIComponent(id)}`).join("&");
  return call(`${tableId}?${qs}`, { method: "DELETE" });
}

/** Ingest Status value that parks a gun upload until someone picks its hub on the page. */
export const AWAITING_HUB = "Awaiting hub";

export function selectName(v) {
  if (!v) return "";
  return typeof v === "string" ? v : v.name || "";
}
