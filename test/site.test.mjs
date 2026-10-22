import { test } from "node:test";
import assert from "node:assert/strict";
import { snapSite, metersBetween } from "../lib/site.js";

const YARD = { lat: 41.955, lng: -111.856 }, STOCKTON = { lat: 37.95, lng: -121.29 };
const hubs = [
  { id: "rec6", name: "Quad Con 006", site: "Cockett Yard - Lewiston UT", job: "", pos: YARD },
  { id: "rec4", name: "Quad Con 004", site: "1100 Navy Dr, Stockton CA", job: "Niagara Stockton", pos: STOCKTON },
  { id: "recN", name: "New trailer", site: "500 Plant Rd, Ocala FL", job: "Niagara Ocala", pos: null },
];
const noGeo = async () => null;
const nudge = (p, m) => ({ lat: p.lat + m / 111000, lng: p.lng });

test("metersBetween sanity", () => { assert.ok(Math.abs(metersBetween(YARD, nudge(YARD, 500)) - 500) < 5); });
test("assigned hub at its last spot → its site", async () => {
  const r = await snapSite({ ...nudge(YARD, 300), hubId: "rec6", gunPlace: "Cache County, Utah" }, { hubs, geocode: noGeo });
  assert.equal(r.site, "Cockett Yard - Lewiston UT");
});
test("Assigned Job wins over the address", async () => {
  const r = await snapSite({ ...STOCKTON, hubId: "rec4" }, { hubs, geocode: noGeo });
  assert.equal(r.site, "Niagara Stockton");
});
test("QC 004 scanned at the yard (mixed boxes) → yard, via the nearby hub", async () => {
  const r = await snapSite({ ...YARD, hubId: "rec4", gunPlace: "Cache County, Utah" }, { hubs, geocode: noGeo });
  assert.equal(r.site, "Cockett Yard - Lewiston UT"); assert.match(r.how, /near Quad Con 006/);
});
test("hub with no position yet, GPS at its geocoded address → its job", async () => {
  const OCALA = { lat: 29.19, lng: -82.14 };
  const r = await snapSite({ ...OCALA, hubId: "recN", gunPlace: "Marion County, Florida" }, { hubs, geocode: async (a) => (a.includes("Ocala") ? OCALA : null) });
  assert.equal(r.site, "Niagara Ocala");
});
test("nowhere known → gun's place; nothing at all → empty", async () => {
  assert.equal((await snapSite({ lat: 45, lng: -100, hubId: "rec6", gunPlace: "Somewhere County, SD" }, { hubs, geocode: noGeo })).site, "Somewhere County, SD");
  assert.equal((await snapSite({ lat: 45, lng: -100, hubId: null }, { hubs, geocode: noGeo })).site, "");
});
test("no GPS: assigned hub's site; sweep with no hub → gun place", async () => {
  assert.equal((await snapSite({ lat: NaN, lng: NaN, hubId: "rec4" }, { hubs, geocode: noGeo })).site, "Niagara Stockton");
  assert.equal((await snapSite({ lat: null, lng: null, gunPlace: "Cache County, Utah" }, { hubs, geocode: noGeo })).site, "Cache County, Utah");
});
