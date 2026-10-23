// Scan Log cleanup — Option C (Dylan, Oct 23 2026): prune by SIZE, not age.
//
// Every run:
//   1. ARCHIVE — copy every Scan Log row created since the last run into Postgres (scan_log). Idempotent upsert.
//   2. DECIDE  — live = rows still in Airtable (per the archive). If live > TRIGGER, the goal is to get back down to TARGET.
//   3. PICK    — oldest rows first, from the archive (so every candidate is already copied), skipping:
//                  · rows linked to a tool with "Keep Scan History" checked
//                  · rows with a photo
//                  · rows newer than MIN_AGE_DAYS
//   4. DELETE  — only when PRUNE_MODE=delete (and CRON_SECRET is set). Otherwise it's a dry run that reports
//                what it would delete. Deletes in batches of 10, marks each batch in Postgres right after.
// Deterministic code only — no agent decides anything here.

export const SCAN_LOG = "tblUYcNhA2w5EJDgy";
export const TOOLS = "tblt1mNexHRkG0aSq";
export const SL = {
  scan: "flds3vvFReWpL1Q3q",
  tagAsRead: "fld0Jpz3kMoPDAAgA",
  scannedBy: "fldHA2SNDsDJByQrp",
  status: "fldqt1EBvbV6EAYpB",
  source: "fldxsrTo3kMZIeghN",
  timestamp: "fld3rUls9yx8h6a2h",
  photo: "fldj8Dnz0AE0smaA1",
  note: "fldKwa06HJUnqNuGC",
  session: "fldlzDQyMFIOzpRPN",
  tool: "fldPYvy1yZ6IpVoUD",
  equipment: "fldvs78hUZ4iGTQGN",
  hub: "fld7JPpTw75FzuFq9",
  result: "fldTVxFGxBRvfgqIF",
};
export const KEEP_HISTORY = "fldyK8dn1kjCQR17u"; // Tools › Keep Scan History (checkbox)

export function config(env = process.env) {
  const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
  const trigger = int(env.PRUNE_TRIGGER, 35000);
  const target = Math.min(int(env.PRUNE_TARGET, 30000), trigger);
  return {
    trigger,
    target,
    minAgeDays: int(env.PRUNE_MIN_AGE_DAYS, 14),
    maxDeletePerRun: int(env.PRUNE_MAX_PER_RUN, 2000),
    deleteEnabled: String(env.PRUNE_MODE || "").toLowerCase() === "delete",
  };
}

const sel = (v) => (v && typeof v === "object" ? v.name || "" : v || "");
const link = (v) => (Array.isArray(v) && v.length ? v[0] : null);
const linkId = (v) => { const l = link(v); return l ? (typeof l === "string" ? l : l.id) : null; };
const linkName = (v) => { const l = link(v); return l && typeof l === "object" ? l.name || null : null; };

/** Airtable Scan Log record (fields keyed by field ID) → archive row. */
export function toArchiveRow(rec) {
  const f = rec.fields || rec.cellValuesByFieldId || {};
  return {
    airtable_id: rec.id,
    ts: f[SL.timestamp] || null,
    created_at: rec.createdTime || null,
    scan: f[SL.scan] || null,
    tag_as_read: f[SL.tagAsRead] || null,
    session_id: linkId(f[SL.session]),
    session_name: linkName(f[SL.session]),
    tool_id: linkId(f[SL.tool]),
    tool_name: linkName(f[SL.tool]),
    equipment_id: linkId(f[SL.equipment]),
    equipment_name: linkName(f[SL.equipment]),
    hub_id: linkId(f[SL.hub]),
    hub_name: linkName(f[SL.hub]),
    result: sel(f[SL.result]) || null,
    status: sel(f[SL.status]) || null,
    source: sel(f[SL.source]) || null,
    scanned_by: f[SL.scannedBy] || null,
    note: f[SL.note] || null,
    has_photo: Array.isArray(f[SL.photo]) && f[SL.photo].length > 0,
    fields: f,
  };
}

/** How many rows this run should remove (before protection / per-run cap). */
export function needed(liveCount, { trigger, target }) {
  return liveCount > trigger ? liveCount - target : 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * deps: { store, airtable: { listAll, deleteRecords }, now?: () => ms, pauseMs?, budgetMs? }
 * opts: { allowDelete } — the caller decides (PRUNE_MODE=delete AND an authorised cron call).
 */
export async function runPrune(deps, cfg, { allowDelete = false } = {}) {
  const { store, airtable } = deps;
  const now = deps.now || Date.now;
  const pause = deps.pauseMs ?? 220; // stay under Airtable's 5 requests/second, leaving room for the ingest automation
  const started = now();
  const deadline = started + (deps.budgetMs ?? 45000);
  const report = { mode: allowDelete ? "delete" : "dry-run", archived: 0, liveCount: 0, trigger: cfg.trigger, target: cfg.target,
    needed: 0, wouldDelete: 0, deleted: 0, protectedTools: 0, missing: 0, finished: false, note: "" };

  await store.init();

  // 1. archive everything created since the watermark (2 h overlap; the upsert makes re-copies harmless)
  const wm = await store.getMeta("scanlog_watermark");
  const since = wm ? new Date(new Date(wm).getTime() - 2 * 3600 * 1000).toISOString() : null;
  const recs = await airtable.listAll(SCAN_LOG, since ? { filterByFormula: `IS_AFTER(CREATED_TIME(), '${since}')` } : {});
  const rows = recs.map(toArchiveRow);
  report.archived = rows.length ? await store.upsertScanLog(rows) : 0;
  const newest = rows.reduce((m, r) => (r.created_at && (!m || r.created_at > m) ? r.created_at : m), wm);
  if (newest && newest !== wm) await store.setMeta("scanlog_watermark", newest);

  // 2. decide
  report.liveCount = await store.liveCount();
  report.needed = needed(report.liveCount, cfg);
  if (!report.needed) {
    report.finished = true;
    report.note = `under the trigger (${report.liveCount} of ${cfg.trigger}) — nothing to remove`;
    await store.logRun(report);
    return report;
  }

  // 3. pick (protected tools read fresh every run, so ticking the box later still protects older rows)
  const tools = await airtable.listAll(TOOLS, { fields: [KEEP_HISTORY] });
  const protectedTools = tools.filter((t) => t.fields?.[KEEP_HISTORY] === true).map((t) => t.id);
  report.protectedTools = protectedTools.length;
  const limit = Math.min(report.needed, cfg.maxDeletePerRun);
  const cutoff = new Date(now() - cfg.minAgeDays * 86400000).toISOString();
  const picks = await store.candidates({ protectedTools, cutoff, limit });
  report.wouldDelete = picks.length;
  const notes = [];
  if (picks.length < report.needed) notes.push(picks.length < limit
    ? `only ${picks.length} rows are old enough and unprotected — can't reach ${cfg.target} yet`
    : `capped at ${cfg.maxDeletePerRun} per run — the rest go on the next runs`);

  if (!allowDelete) {
    report.finished = true;
    notes.unshift(`DRY RUN — would remove the ${picks.length} oldest unprotected rows (set PRUNE_MODE=delete to do it)`);
    report.note = notes.join("; ");
    await store.logRun(report);
    return report;
  }

  // 4. delete, 10 at a time, marking each batch in Postgres right after Airtable confirms
  const ids = picks.map((p) => p.airtable_id);
  for (let i = 0; i < ids.length; i += 10) {
    if (now() > deadline) { notes.push("stopped at the time limit — continues next run"); break; }
    const batch = ids.slice(i, i + 10);
    try {
      await airtable.deleteRecords(SCAN_LOG, batch);
      await store.markDeleted(batch, "pruned (size cap)");
      report.deleted += batch.length;
    } catch (e) {
      // one bad id fails the whole batch — retry one by one; a row that's already gone is just marked
      for (const id of batch) {
        try {
          await airtable.deleteRecords(SCAN_LOG, [id]);
          await store.markDeleted([id], "pruned (size cap)");
          report.deleted++;
        } catch (e2) {
          if (e2.status === 404 || /NOT_FOUND|does not exist|INVALID_RECORDS/i.test(e2.message || "")) {
            await store.markDeleted([id], "already gone from Airtable");
            report.missing++;
          } else {
            notes.push(`stopped on an Airtable error: ${e2.message}`);
            report.note = notes.join("; ");
            await store.logRun(report);
            return report;
          }
        }
        await sleep(pause);
      }
    }
    await sleep(pause);
  }
  report.finished = report.deleted + report.missing === ids.length;
  report.note = notes.join("; ") || `removed ${report.deleted} oldest rows`;
  await store.logRun(report);
  return report;
}
