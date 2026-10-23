// Postgres (Neon, via the Vercel Marketplace integration → DATABASE_URL) — the relay's own full history.
//   uploads   — every gun / page upload as it arrived (EPCs + GPS + raw payload), forever
//   scan_log  — a copy of every Airtable Scan Log row; rows pruned from Airtable stay here (in_airtable = false)
//   prune_runs — one row per cleanup run (what it saw, what it would / did delete)
//   meta      — small key/value (archive watermark)
// Everything here is best-effort for uploads (never blocks a scan) and strict for pruning (no copy → no delete).

import { neon } from "@neondatabase/serverless";

let _sql = null;
let _ready = null;

export function hasDb() {
  return !!process.env.DATABASE_URL;
}

export function sql() {
  if (_sql) return _sql;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set on the server");
  _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

/** Tests only: swap in another client with the same `.query(text, params) → rows[]` shape (PGlite). */
export function __setSqlForTests(q) {
  _sql = q;
  _ready = null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS uploads (
     id bigserial PRIMARY KEY,
     received_at timestamptz NOT NULL DEFAULT now(),
     source text, sled text, upload_key text, session_id text,
     hub_id text, hub_name text, session_type text, person text,
     lat double precision, lng double precision, site text, place text,
     tag_count int, epcs text[], raw jsonb)`,
  `CREATE INDEX IF NOT EXISTS uploads_received_at ON uploads (received_at)`,
  `CREATE TABLE IF NOT EXISTS scan_log (
     airtable_id text PRIMARY KEY,
     ts timestamptz, created_at timestamptz,
     scan text, tag_as_read text,
     session_id text, session_name text,
     tool_id text, tool_name text, equipment_id text, equipment_name text,
     hub_id text, hub_name text,
     result text, status text, source text, scanned_by text, note text,
     has_photo boolean NOT NULL DEFAULT false,
     fields jsonb,
     in_airtable boolean NOT NULL DEFAULT true,
     archived_at timestamptz NOT NULL DEFAULT now(),
     deleted_at timestamptz, delete_note text)`,
  `CREATE INDEX IF NOT EXISTS scan_log_live_ts ON scan_log (in_airtable, ts)`,
  `CREATE INDEX IF NOT EXISTS scan_log_tool ON scan_log (tool_id)`,
  `CREATE TABLE IF NOT EXISTS prune_runs (
     id bigserial PRIMARY KEY,
     ran_at timestamptz NOT NULL DEFAULT now(),
     mode text, archived int, live_count int, trigger_at int, target int,
     needed int, would_delete int, deleted int, protected_tools int, missing int,
     finished boolean, note text)`,
  `CREATE TABLE IF NOT EXISTS meta (key text PRIMARY KEY, value text, updated_at timestamptz NOT NULL DEFAULT now())`,
];

export async function ensureSchema() {
  if (!_ready) {
    _ready = (async () => {
      const q = sql();
      for (const s of SCHEMA) await q.query(s);
    })().catch((e) => {
      _ready = null;
      throw e;
    });
  }
  return _ready;
}

// ---------- uploads ----------

export async function insertUpload(u) {
  await ensureSchema();
  await sql().query(
    `INSERT INTO uploads (source, sled, upload_key, session_id, hub_id, hub_name, session_type, person, lat, lng, site, place, tag_count, epcs, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
    [u.source || null, u.sled || null, u.uploadKey || null, u.sessionId || null, u.hubId || null, u.hubName || null,
     u.type || null, u.person || null, Number.isFinite(u.lat) ? u.lat : null, Number.isFinite(u.lng) ? u.lng : null,
     u.site || null, u.place || null, Array.isArray(u.epcs) ? u.epcs.length : null, Array.isArray(u.epcs) ? u.epcs : null,
     JSON.stringify(u.raw ?? null)],
  );
}

// ---------- the store the prune job uses (same shape as the in-memory fake in test/prune.test.mjs) ----------

const COLS = ["airtable_id", "ts", "created_at", "scan", "tag_as_read", "session_id", "session_name", "tool_id", "tool_name",
  "equipment_id", "equipment_name", "hub_id", "hub_name", "result", "status", "source", "scanned_by", "note", "has_photo", "fields"];
const COLTYPES = { ts: "timestamptz", created_at: "timestamptz", has_photo: "boolean", fields: "jsonb" };

export const pgStore = {
  async init() {
    await ensureSchema();
  },
  async getMeta(key) {
    const r = await sql().query(`SELECT value FROM meta WHERE key = $1`, [key]);
    return r[0]?.value ?? null;
  },
  async setMeta(key, value) {
    await sql().query(`INSERT INTO meta (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, value]);
  },
  /** Upsert archive rows; returns how many were written. A row already marked deleted stays deleted. */
  async upsertScanLog(rows) {
    let n = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const def = COLS.map((c) => `${c} ${COLTYPES[c] || "text"}`).join(", ");
      const set = COLS.filter((c) => c !== "airtable_id").map((c) => `${c} = EXCLUDED.${c}`).join(", ");
      await sql().query(
        `INSERT INTO scan_log (${COLS.join(", ")})
         SELECT ${COLS.join(", ")} FROM jsonb_to_recordset($1::jsonb) AS x(${def})
         ON CONFLICT (airtable_id) DO UPDATE SET ${set}, archived_at = now()`,
        [JSON.stringify(chunk)],
      );
      n += chunk.length;
    }
    return n;
  },
  async liveCount() {
    const r = await sql().query(`SELECT count(*)::int AS n FROM scan_log WHERE in_airtable`);
    return r[0].n;
  },
  /** Oldest live rows that may go: not linked to a protected tool, no photo, older than `cutoff` (ISO time). */
  async candidates({ protectedTools, cutoff, limit }) {
    if (limit <= 0) return [];
    return sql().query(
      `SELECT airtable_id, tool_id, ts FROM scan_log
       WHERE in_airtable AND NOT has_photo
         AND coalesce(ts, created_at) < $1::timestamptz
         AND (tool_id IS NULL OR NOT (tool_id = ANY($2::text[])))
       ORDER BY coalesce(ts, created_at) ASC
       LIMIT $3`,
      [cutoff, protectedTools, limit],
    );
  },
  async markDeleted(ids, note) {
    if (!ids.length) return;
    await sql().query(`UPDATE scan_log SET in_airtable = false, deleted_at = now(), delete_note = $2 WHERE airtable_id = ANY($1::text[])`, [ids, note || null]);
  },
  async logRun(r) {
    await sql().query(
      `INSERT INTO prune_runs (mode, archived, live_count, trigger_at, target, needed, would_delete, deleted, protected_tools, missing, finished, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [r.mode, r.archived, r.liveCount, r.trigger, r.target, r.needed, r.wouldDelete, r.deleted, r.protectedTools, r.missing, r.finished, r.note || null],
    );
  },
  async recentRuns(limit = 10) {
    return sql().query(`SELECT * FROM prune_runs ORDER BY ran_at DESC LIMIT $1`, [limit]);
  },
  async counts() {
    const r = await sql().query(
      `SELECT (SELECT count(*)::int FROM scan_log) AS archived_total,
              (SELECT count(*)::int FROM scan_log WHERE in_airtable) AS live_in_airtable,
              (SELECT count(*)::int FROM scan_log WHERE NOT in_airtable) AS pruned_from_airtable,
              (SELECT count(*)::int FROM uploads) AS uploads`,
    );
    return r[0];
  },
};
