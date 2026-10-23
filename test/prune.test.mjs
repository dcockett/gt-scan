// Scan Log cleanup: the real SQL (lib/db.js pgStore) against an in-memory Postgres (PGlite), with a fake Airtable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { __setSqlForTests, pgStore, insertUpload } from "../lib/db.js";
import { runPrune, config, needed, toArchiveRow, SL, KEEP_HISTORY, SCAN_LOG, TOOLS } from "../lib/prune.js";

const DAY = 86400000;
const NOW = Date.parse("2026-12-01T12:00:00Z");

function fakeAirtable({ rows, tools }) {
  const live = new Map(rows.map((r) => [r.id, r]));
  const calls = { deletes: 0, lists: [] };
  return {
    live, calls,
    async listAll(table, opts = {}) {
      calls.lists.push({ table, opts });
      if (table === TOOLS) return tools;
      if (table === SCAN_LOG) {
        const m = /IS_AFTER\(CREATED_TIME\(\), '([^']+)'\)/.exec(opts.filterByFormula || "");
        return [...live.values()].filter((r) => !m || r.createdTime > m[1]);
      }
      return [];
    },
    async deleteRecords(table, ids) {
      assert.equal(table, SCAN_LOG, "only Scan Log is ever deleted from");
      assert.ok(ids.length <= 10);
      calls.deletes++;
      const gone = ids.filter((id) => !live.has(id));
      if (gone.length) { const e = new Error("Airtable 404: NOT_FOUND"); e.status = 404; throw e; }
      ids.forEach((id) => live.delete(id));
      return { records: ids.map((id) => ({ id, deleted: true })) };
    },
  };
}

function scanRow(i, { daysAgo, tool = "recToolPlain00000", photo = false }) {
  const t = new Date(NOW - daysAgo * DAY).toISOString();
  const f = { [SL.scan]: `tag${i}`, [SL.timestamp]: t, [SL.tool]: [tool], [SL.result]: "OK — in home hub", [SL.session]: ["recSess0000000001"] };
  if (photo) f[SL.photo] = [{ id: "att1", url: "x" }];
  return { id: "recSL" + String(i).padStart(12, "0"), createdTime: t, fields: f };
}

async function freshDb() {
  const pg = new PGlite();
  __setSqlForTests({ query: async (text, params) => (await pg.query(text, params)).rows });
  return pg;
}

test("toArchiveRow pulls ids, names, select names and photo flag", () => {
  const r = toArchiveRow({ id: "recA", createdTime: "2026-10-23T00:00:00.000Z", cellValuesByFieldId: {
    [SL.tool]: [{ id: "recT", name: "Grinder" }], [SL.result]: { name: "WRONG BOX" }, [SL.photo]: [{}], [SL.timestamp]: "2026-10-23T00:00:00.000Z" } });
  assert.equal(r.tool_id, "recT"); assert.equal(r.tool_name, "Grinder"); assert.equal(r.result, "WRONG BOX"); assert.equal(r.has_photo, true);
});

test("needed(): nothing until the trigger, then back down to the target", () => {
  assert.equal(needed(35000, { trigger: 35000, target: 30000 }), 0);
  assert.equal(needed(35001, { trigger: 35000, target: 30000 }), 5001);
});

test("config(): defaults, and delete only when PRUNE_MODE=delete", () => {
  const c = config({});
  assert.deepEqual([c.trigger, c.target, c.minAgeDays, c.maxDeletePerRun, c.deleteEnabled], [35000, 30000, 14, 2000, false]);
  assert.equal(config({ PRUNE_MODE: "Delete" }).deleteEnabled, true);
  assert.equal(config({ PRUNE_TRIGGER: "100", PRUNE_TARGET: "500" }).target, 100, "target never above trigger");
});

test("under the trigger: archives everything, deletes nothing", async () => {
  await freshDb();
  const at = fakeAirtable({ rows: Array.from({ length: 30 }, (_, i) => scanRow(i, { daysAgo: 40 - i })), tools: [] });
  const r = await runPrune({ store: pgStore, airtable: at, now: () => NOW, pauseMs: 0 }, { ...config({}), trigger: 50, target: 40 }, { allowDelete: true });
  assert.equal(r.archived, 30); assert.equal(r.liveCount, 30); assert.equal(r.deleted, 0); assert.equal(at.calls.deletes, 0);
  assert.equal(at.live.size, 30);
  const c = await pgStore.counts();
  assert.equal(c.archived_total, 30); assert.equal(c.live_in_airtable, 30);
});

test("dry run over the trigger: reports, deletes nothing", async () => {
  await freshDb();
  const at = fakeAirtable({ rows: Array.from({ length: 60 }, (_, i) => scanRow(i, { daysAgo: 100 - i })), tools: [] });
  const r = await runPrune({ store: pgStore, airtable: at, now: () => NOW, pauseMs: 0 }, { ...config({}), trigger: 50, target: 40 }, { allowDelete: false });
  assert.equal(r.mode, "dry-run"); assert.equal(r.needed, 20); assert.equal(r.wouldDelete, 20); assert.equal(r.deleted, 0);
  assert.equal(at.calls.deletes, 0); assert.equal(at.live.size, 60);
  assert.match(r.note, /DRY RUN/);
  const runs = await pgStore.recentRuns();
  assert.equal(runs.length, 1); assert.equal(runs[0].would_delete, 20);
});

test("delete: oldest first, skips Keep Scan History tools, photos and anything under 14 days; archive keeps every row", async () => {
  await freshDb();
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const daysAgo = 100 - i; // row 0 oldest
    let opts = { daysAgo };
    if (i < 5) opts.tool = "recToolKEEP00000"; // 5 oldest rows belong to a protected tool
    if (i === 5) opts.photo = true;            // next-oldest has a photo
    rows.push(scanRow(i, opts));
  }
  // 10 brand-new rows (under the 14-day floor)
  for (let i = 60; i < 70; i++) rows.push(scanRow(i, { daysAgo: 1 }));
  const tools = [{ id: "recToolKEEP00000", fields: { [KEEP_HISTORY]: true } }, { id: "recToolPlain00000", fields: {} }];
  const at = fakeAirtable({ rows, tools });
  const r = await runPrune({ store: pgStore, airtable: at, now: () => NOW, pauseMs: 0 }, { ...config({}), trigger: 50, target: 40 }, { allowDelete: true });
  assert.equal(r.liveCount, 70); assert.equal(r.needed, 30); assert.equal(r.protectedTools, 1);
  assert.equal(r.deleted, 30); assert.equal(at.live.size, 40);
  for (let i = 0; i < 6; i++) assert.ok(at.live.has(rows[i].id), `protected row ${i} kept`);
  for (let i = 6; i < 36; i++) assert.ok(!at.live.has(rows[i].id), `row ${i} (oldest unprotected) removed`);
  for (let i = 60; i < 70; i++) assert.ok(at.live.has(rows[i].id), `new row ${i} kept`);
  const c = await pgStore.counts();
  assert.equal(c.archived_total, 70, "every row still in Postgres"); assert.equal(c.live_in_airtable, 40); assert.equal(c.pruned_from_airtable, 30);
});

test("second run only copies new rows (watermark) and does nothing more once under the trigger", async () => {
  await freshDb();
  const rows = Array.from({ length: 60 }, (_, i) => scanRow(i, { daysAgo: 100 - i }));
  const at = fakeAirtable({ rows, tools: [] });
  const cfg = { ...config({}), trigger: 50, target: 40 };
  await runPrune({ store: pgStore, airtable: at, now: () => NOW, pauseMs: 0 }, cfg, { allowDelete: true });
  const r2 = await runPrune({ store: pgStore, airtable: at, now: () => NOW, pauseMs: 0 }, cfg, { allowDelete: true });
  assert.ok(r2.archived < 40, `re-copied only the 2-hour overlap, got ${r2.archived}`);
  assert.equal(r2.deleted, 0); assert.equal(r2.liveCount, 40);
});

test("a row someone already deleted by hand is marked gone, the rest still go", async () => {
  await freshDb();
  const rows = Array.from({ length: 60 }, (_, i) => scanRow(i, { daysAgo: 100 - i }));
  const at = fakeAirtable({ rows, tools: [] });
  const cfg = { ...config({}), trigger: 50, target: 40 };
  // archive first (dry run), then someone deletes row 3 in Airtable by hand
  await runPrune({ store: pgStore, airtable: at, now: () => NOW, pauseMs: 0 }, cfg, { allowDelete: false });
  at.live.delete(rows[3].id);
  const r = await runPrune({ store: pgStore, airtable: at, now: () => NOW, pauseMs: 0 }, cfg, { allowDelete: true });
  assert.equal(r.missing, 1); assert.equal(r.deleted, 19); assert.equal(at.live.size, 40);
});

test("per-run cap and the time budget stop it early, with a note", async () => {
  await freshDb();
  const rows = Array.from({ length: 80 }, (_, i) => scanRow(i, { daysAgo: 100 - i }));
  const at = fakeAirtable({ rows, tools: [] });
  const r = await runPrune({ store: pgStore, airtable: at, now: () => NOW, pauseMs: 0 }, { ...config({}), trigger: 50, target: 40, maxDeletePerRun: 15 }, { allowDelete: true });
  assert.equal(r.deleted, 15); assert.match(r.note, /capped at 15/);
  let t = NOW;
  const at2 = fakeAirtable({ rows: Array.from({ length: 80 }, (_, i) => scanRow(i, { daysAgo: 100 - i })), tools: [] });
  await freshDb();
  const r2 = await runPrune({ store: pgStore, airtable: at2, now: () => (t += 20000), pauseMs: 0, budgetMs: 45000 }, { ...config({}), trigger: 50, target: 40 }, { allowDelete: true });
  assert.ok(r2.deleted < 40); assert.match(r2.note, /time limit/);
});

test("uploads table takes a TagMatiks upload", async () => {
  const pg = await freshDb();
  await insertUpload({ source: "TagMatiks", sled: "1", uploadKey: "abc", sessionId: "recS", epcs: ["E1", "E2"], lat: 41.9, lng: -111.8, raw: [{ EPC: "E1" }] });
  const r = (await pg.query("SELECT sled, tag_count, epcs, raw FROM uploads")).rows[0];
  assert.equal(r.sled, "1"); assert.equal(r.tag_count, 2); assert.deepEqual(r.epcs, ["E1", "E2"]); assert.deepEqual(r.raw, [{ EPC: "E1" }]);
});
