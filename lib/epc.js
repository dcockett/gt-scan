// EPC / Tag ID helpers shared by the page (inlined there) and the relay.
// Cockett tags: 96-bit EPCs typed by the RFD40 as 24 hex chars, zero-padded
// decimal Tag IDs for Cockett labels (…000258227) and raw GS1 hex for retail
// chips (303404…). The page keeps the 24-char string; Airtable's Scan Ingest
// script strips leading zeros to match Tools.Tag ID.

const HEX24 = /[0-9A-F]{24}/g;

/** Normalize one typed chunk to uppercase hex only. */
export function hexOnly(s) {
  return String(s || "").toUpperCase().replace(/[^0-9A-F]/g, "");
}

/**
 * Pull complete EPCs out of a keyboard-wedge buffer.
 * Lines ending in a newline are complete; the last line (no newline) is only
 * consumed in 24-char multiples and the remainder is returned as `pending`.
 * Run-on strings (two tags with no Enter between them) are split every 24.
 */
export function extractEpcs(buffer) {
  const epcs = [];
  const text = String(buffer || "");
  const lines = text.split(/\r?\n/);
  const last = lines.pop(); // tail with no trailing newline
  for (const line of lines) {
    const h = hexOnly(line);
    if (!h) continue;
    if (h.length % 24 === 0) {
      for (let i = 0; i < h.length; i += 24) epcs.push(h.slice(i, i + 24));
    } else {
      // odd length: take what we can, drop the stub (noise or partial)
      const m = h.match(HEX24);
      if (m) epcs.push(...m);
    }
  }
  let pending = hexOnly(last);
  while (pending.length >= 24) {
    epcs.push(pending.slice(0, 24));
    pending = pending.slice(24);
  }
  return { epcs, pending };
}

/** Manual entry: a label number like 89599 → 24-char zero-padded EPC. */
export function epcFromTagId(tagId) {
  const h = hexOnly(tagId);
  if (!h) return null;
  if (h.length > 24) return null;
  return h.padStart(24, "0");
}

/** Strip leading zeros for display (what Airtable calls the Tag ID). */
export function displayTag(epc) {
  const s = String(epc).replace(/^0+/, "");
  return s || "0";
}
