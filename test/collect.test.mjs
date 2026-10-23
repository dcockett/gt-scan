// Merging TagMatiks' split uploads into one scan (lib/collect.js) against an in-memory fake Airtable.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { receiveChunk, finalizeSession, finalizeAfterQuiet, finalizeStale, groupToken, COLLECTING, QUIET_MS, STALE_MS, __resetForTests } from "../lib/collect.js";
import { voteHub } from "../lib/assign.js";

const F = { sessions: { rawPayload: "raw", started: "started", notes: "notes", ingestStatus: "status", type: "type", by: "by", lat: "lat", lng: "lng", site: "site", hub: "hub" } };
const T = { sessions: "tblS" };
const HUBS = { recQC6: "Quad Con 006", recQC4: "Quad Con 004" };
const homes = new Map([["1", "recQC6"], ["2", "recQC6"], ["3", "recQC6"], ["4", "recQC6"], ["7", "recQC4"], ["8", "recQC4"]]);
const P = (t) => t.padStart(24, "0");

function fake(start = Date.parse("2026-10-23T23:30:00Z")) {
  let t = start, n = 0;
  const rows = new Map();
  const deps = {
    T, F, rows,
    now: () => t, advance: (ms) => { t += ms; },
    sleep: async (ms) => { t += ms; },
    listAll: async () => [...rows.values()].map((r) => ({ ...r, fields: { ...r.fields } })),
    getRecord: async (_t, id) => { const r = rows.get(id); return { ...r, fields: { ...r.fields } }; },
    createRecord: async (_t, fields) => { const id = "recS" + ++n; const f = { ...fields }; if (typeof f.status === "string") f.status = { name: f.status }; rows.set(id, { id, createdTime: new Date(t).toISOString(), fields: f }); return rows.get(id); },
    updateRecord: async (_t, id, fields) => { const r = rows.get(id); for (const [k, v] of Object.entries(fields)) { if (v === null) delete r.fields[k]; else r.fields[k] = k === "status" && typeof v === "string" ? { name: v } : v; } return r; },
    assignHub: async ({ epcs }) => { const v = voteHub(epcs, homes); return v ? { hub: { id: v.hubId, name: HUBS[v.hubId] }, how: `tags voted ${v.votes}/${v.known}` } : null; },
    describeLeader: async () => "mostly something",
    snapSite: async ({ gunPlace }) => ({ site: "Cockett Yard - Lewiston UT", how: "test" }),
  };
  return deps;
}
const piece = (epcs, key, extra = {}) => ({ sled: "25074525100939", device: "25074525100939", by: "Dylan", person: { id: "recDylan", name: "Dylan Cockett" }, epcs: epcs.map(P), lat: 41.85, lng: -111.83, place: "Cache County, Utah", uploadKey: key, urlType: "", urlHub: "", ...extra });

beforeEach(() => __resetForTests());

test("pieces from the same sled + person merge into one Collecting session", async () => {
  const d = fake();
  const a = await receiveChunk(piece(["1", "2", "7"], "aaaaaaaaaa"), d);
  d.advance(4000);
  const b = await receiveChunk(piece(["3", "8", "1"], "bbbbbbbbbb"), d);
  assert.equal(a.sessionId, b.sessionId); assert.equal(a.chunk, 1); assert.equal(b.chunk, 2);
  const r = d.rows.get(a.sessionId);
  assert.equal(r.fields.status.name, COLLECTING);
  assert.deepEqual(r.fields.raw.split("\n").sort(), ["1", "2", "3", "7", "8"].map(P).sort(), "union, no duplicates");
});

test("the first piece's timer stands down; the last piece's timer files it once, vote on the whole scan", async () => {
  const d = fake();
  const a = await receiveChunk(piece(["1", "7"], "aaaaaaaaaa"), d);     // alone: 1 v 1 → would be unconfirmed
  const b = await receiveChunk(piece(["2", "3", "4"], "bbbbbbbbbb"), d); // together: 4 QC006 v 1 QC004 → QC006
  const first = await finalizeSession(a.sessionId, { expectChunks: a.chunk }, d);
  assert.equal(first.skipped, "a later piece will finalise");
  const last = await finalizeAfterQuiet(b.sessionId, b.chunk, d);
  assert.equal(last.hub, "Quad Con 006"); assert.equal(last.uploads, 2); assert.equal(last.tags, 5);
  const f = d.rows.get(a.sessionId).fields;
  assert.equal(f.status, undefined, "Ingest Status cleared → the automation fires");
  assert.deepEqual(f.hub, ["recQC6"]); assert.equal(f.type, "Full Hub Audit");
  assert.match(f.notes, /2 uploads merged into one scan \(5 tags\)/);
  assert.equal((await finalizeSession(a.sessionId, {}, d)).skipped, "not collecting", "never filed twice");
});

test("different people, or a gap past the window, make separate scans", async () => {
  const d = fake();
  const a = await receiveChunk(piece(["1"], "aaaaaaaaaa"), d);
  const b = await receiveChunk(piece(["2"], "bbbbbbbbbb", { by: "Aubrey", person: { id: "recA", name: "Aubrey" } }), d);
  assert.notEqual(a.sessionId, b.sessionId);
  d.advance(4 * 60 * 1000);
  const c = await receiveChunk(piece(["3"], "cccccccccc"), d);
  assert.notEqual(a.sessionId, c.sessionId);
  assert.notEqual(groupToken("x", "Dylan"), groupToken("x", "Aubrey"));
});

test("a scan the tags can't place is filed as an unconfirmed Sweep; a URL sweep stays a sweep", async () => {
  const d = fake();
  const a = await receiveChunk(piece(["1", "7"], "aaaaaaaaaa"), d);
  const r = await finalizeSession(a.sessionId, { expectChunks: 1 }, d);
  assert.equal(r.unconfirmed, true);
  assert.equal(d.rows.get(a.sessionId).fields.type, "Sweep");
  assert.match(d.rows.get(a.sessionId).fields.notes, /UNCONFIRMED box/);
  const s = await receiveChunk(piece(["1", "2", "3"], "dddddddddd", { by: "Shane", person: null, urlType: "Sweep" }), d);
  const rs = await finalizeSession(s.sessionId, { expectChunks: 1 }, d);
  assert.equal(rs.sweep, true); assert.equal(d.rows.get(s.sessionId).fields.hub, undefined, "a sweep never gets a box");
});

test("safety net files anything left Collecting after the stale window", async () => {
  const d = fake();
  const a = await receiveChunk(piece(["1", "2", "3"], "aaaaaaaaaa"), d);
  assert.deepEqual(await finalizeStale(d), [], "too fresh to touch");
  d.advance(STALE_MS + 1000);
  const out = await finalizeStale(d);
  assert.equal(out.length, 1); assert.equal(out[0].hub, "Quad Con 006");
  assert.match(d.rows.get(a.sessionId).fields.notes, /safety net/);
  assert.ok(QUIET_MS < STALE_MS);
});
