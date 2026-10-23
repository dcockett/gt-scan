// Fire-and-forget copy of every upload into Postgres. Never slows or breaks a scan:
// waitUntil lets the function answer TagMatiks at once and finish the insert afterwards.

import { waitUntil } from "@vercel/functions";
import { hasDb, insertUpload } from "./db.js";

export function recordUpload(u) {
  if (!hasDb()) return;
  const p = insertUpload(u).catch((e) => console.warn("[history] upload not saved", e.message));
  try { waitUntil(p); } catch { /* not on Vercel (local dev) — the promise still runs */ }
}
