// Name the place a scan happened, for Scan Sessions.Site (snapped) → Tools.Last Seen Site.
// Order:
//   1. the assigned hub's own site, when the GPS is within SNAP_M of where that hub was last scanned
//      (or of its Site / Location address, geocoded once and cached, when it has no position yet or has moved)
//   2. any other hub whose last known position (or geocoded site) is within SNAP_M — "this is where QC 004 lives"
//   3. the plain-English place the gun reported (TagMatiks LocationDetail, e.g. "Cache County, Utah, United States")
// A hub's label is its Assigned Job (from Ops v2) when it has one, else its Site / Location.
// No coordinates in Ops v2 and the relay token only reaches this base, so hub records are the source.

import { loadHubs } from "./assign.js";

export const SNAP_M = 1600; // ~1 mile
const GEO_TIMEOUT_MS = 2500;
const geoCache = new Map(); // address → { lat, lng } | null

export function metersBetween(a, b) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function hubLabel(h) {
  return (h.job || h.site || "").trim();
}

/** Geocode an address once (OpenStreetMap Nominatim). Returns null on any failure or slowness — never throws. */
export async function geocode(address, fetchImpl = globalThis.fetch) {
  const a = String(address || "").trim();
  if (!a || a.length < 6) return null;
  if (geoCache.has(a)) return geoCache.get(a);
  let out = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GEO_TIMEOUT_MS);
    const r = await fetchImpl(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us,ca&q=${encodeURIComponent(a)}`, {
      headers: { "User-Agent": "gt-scan/1.0 (+https://gt-scan-seven.vercel.app)" }, signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (r.ok) { const j = await r.json(); if (j?.[0]) out = { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) }; }
  } catch { out = null; }
  geoCache.set(a, out); // cache misses too, so a bad address costs one lookup per warm instance
  return out;
}

/**
 * @param {{lat:number|null,lng:number|null,hubId?:string|null,gunPlace?:string}} q
 * @returns {Promise<{site:string, how:string}>}
 */
export async function snapSite({ lat, lng, hubId = null, gunPlace = "" }, deps = {}) {
  const hubs = deps.hubs || (await loadHubs());
  const geo = deps.geocode || geocode;
  const gun = String(gunPlace || "").trim();
  const here = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0) ? { lat, lng } : null;
  const near = (p) => p && here && metersBetween(here, p) <= SNAP_M;

  const assigned = hubId ? hubs.find((h) => h.id === hubId) : null;
  if (assigned && hubLabel(assigned)) {
    if (!here) return { site: hubLabel(assigned), how: "assigned hub's site (no GPS)" };
    if (near(assigned.pos)) return { site: hubLabel(assigned), how: "assigned hub, at its last known spot" };
    if (assigned.site && near(await geo(assigned.site))) return { site: hubLabel(assigned), how: "assigned hub, at its site address" };
  }
  if (here) {
    let best = null;
    for (const h of hubs) {
      if (!hubLabel(h) || !h.pos) continue;
      const d = metersBetween(here, h.pos);
      if (d <= SNAP_M && (!best || d < best.d)) best = { h, d };
    }
    if (best) return { site: hubLabel(best.h), how: `near ${best.h.name} (${Math.round(best.d)} m)` };
  }
  if (gun) return { site: gun, how: "gun's reported place" };
  return { site: "", how: "unknown" };
}
