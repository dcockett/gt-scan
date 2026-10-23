// GET /api/prune            — the daily cleanup (Vercel cron, see vercel.json). Dry run unless PRUNE_MODE=delete.
// GET /api/prune?status=1   — read-only: archive counts, settings, last 10 runs. Changes nothing.
//
// Deleting needs BOTH: env PRUNE_MODE=delete, and env CRON_SECRET set (Vercel's cron sends it as a Bearer token).
// When CRON_SECRET is set, only a caller carrying it can start a run at all.

import { listAll, deleteRecords } from "../lib/airtable.js";
import { hasDb, pgStore } from "../lib/db.js";
import { config, runPrune } from "../lib/prune.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") { res.status(405).json({ error: "GET only" }); return; }
  if (!hasDb()) { res.status(503).json({ error: "DATABASE_URL is not set — the history database isn't connected" }); return; }

  const url = new URL(req.url || "/", "http://x");
  const cfg = config();
  const secret = process.env.CRON_SECRET;
  const authed = !!secret && req.headers?.authorization === `Bearer ${secret}`;

  try {
    if (url.searchParams.get("status")) {
      await pgStore.init();
      res.status(200).json({
        settings: { trigger: cfg.trigger, target: cfg.target, minAgeDays: cfg.minAgeDays, maxPerRun: cfg.maxDeletePerRun,
          mode: cfg.deleteEnabled ? (secret ? "delete" : "delete requested but CRON_SECRET missing → dry run") : "dry run" },
        counts: await pgStore.counts(),
        recentRuns: await pgStore.recentRuns(10),
      });
      return;
    }
    if (secret && !authed) { res.status(401).json({ error: "cron only" }); return; }

    const report = await runPrune({ store: pgStore, airtable: { listAll, deleteRecords } }, cfg, { allowDelete: cfg.deleteEnabled && authed });
    console.log("[prune]", report);
    res.status(200).json(report);
  } catch (e) {
    console.error("[prune] error", e.message);
    res.status(500).json({ error: e.message || String(e) });
  }
}
