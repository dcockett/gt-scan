// Cockett Tools & Hubs — Scan Ingest v1.7 (Oct 23 2026)
// v1.7: every gun read also stamps the tool's Last Scanned By (who), next to Last Scanned (when) and Last Seen Site (where).
// v1.6 (crew Hub Check interface): a box scan stamps the hub's Last Scan At / By / Site / Summary.
//       Any gun read resets the tool's Visual Confirms in a Row to 0, and clears "Missing Tag" (and "Visual Confirm")
//       back to Confirmed (RFID) — the tag just proved it works. Damaged is never touched by a scan.
// v1.5 (junk-tag filter, approved by Aubrey Oct 23): only OUR tags become records.
//       Ours = zero-padded asset numbers (GreyTrunk / Metalcraft) or A6B6… (second vendor). Known tool/machine → Scan Log row as before.
//       Ours but not in Tools/Equipment → one row per tag in "Unknown Tags" (Status "Needs Review"; Times Seen / Last Seen updated after).
//       A tag set to "Blocked — Not Ours" there is skipped completely (only counted) until someone changes its status.
//       Retail packaging (starts with 3) and other-format tags → NO records; counted in the summary, listed in the report text.
// v1.4: every read stamps the tool/machine's Last Scanned + Last Seen Lat/Long/Site (where it physically was), Equipment too.
//       GS1 retail package tags (EPC starting with 3) are counted as "packaging" and kept out of the unknown count.
//       New session type "Sweep": no hub needed — logs every read and updates Last Scanned / Last Seen only; never
//       touches Current Hub, Daily Status or Consecutive Misses, builds no missing / wrong-box reports.
// v1.3: same-day passes stack — a Full Hub Audit counts anything already scanned in this box today as read, and
// Consecutive Misses is bumped at most once per day (Tools.Last Missed). v1.2: splits run-on strings from an HID gun.
// Two ways in, one script:
//   A) WEBHOOK — input variable `payload` (JSON string):
//      { hub: "Quad Con 006" | "recXXXX", type: "Full Hub Audit" | "Spot Check" | "Final Check — Ready to Roll" | "Check Out (borrow)" | "Check In (return)" | "Load Out" | "Return / Restock" | "Sweep",
//        by: "Dylan Cockett", lat, lng, accuracy, site, notes, source: "Handheld", tags: ["000000000000000000089708", ...] | "one per line" }
//      → creates the Scan Session itself (Ingest Status = Done so the form automation ignores it).
//   B) FORM / RECORD — input variable `sessionId` (record ID of a Scan Session created by the scan page / TagMatiks relay / form,
//      or by hand with tags pasted in Raw Payload). Reads Hub Scanned, Session Type, Scanned By, Raw Payload, GPS, Site, Notes off the record.
// What it does: matches each unique tag to a Tool or Equipment (strip leading zeros → Tag ID), writes one Scan Log row per unique read,
// sets Current Hub / Last Scanned / Last Seen / Daily Status on the tool, resets Consecutive Misses; for Full Hub Audit / Final Check builds the
// Missing + Wrong Box reports and bumps Consecutive Misses on unread home tools (→ Missing at 5 unless Damaged / Missing Tag);
// Final Check stamps the hub's Last Final Check + Result. Check Out sets Custody = Checked Out (+ Checked Out To); Check In clears it.
// Ends by writing Summary + Ingest Status (Done / Error) on the session. Rules: single-purpose writes; never delete; only our tags become records (v1.5).

const cfg = input.config();
const T = {
  tools: base.getTable('Tools'), equip: base.getTable('Equipment'), hubs: base.getTable('Hubs'),
  sessions: base.getTable('Scan Sessions'), log: base.getTable('Scan Log'), emp: base.getTable('Employees'),
  unk: base.getTable('Unknown Tags'),
};
const first = v => Array.isArray(v) && v.length ? v[0] : null;
const now = new Date();
const denver = d => d.toLocaleString('en-US', { timeZone: 'America/Denver' });
const ymd = now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
const MISS_LIMIT = 5;
const isPackaging = n => /^3[0-9A-F]{23}$/.test(n); // GS1 SGTIN/SSCC etc. from retail packaging — never a Cockett tag
// OUR tag formats. Add a vendor's pattern here if new tags come in a different format.
const isOurs = n => { const pad = String(n).toUpperCase().padStart(24, '0'); return /^0{12,}[0-9]+$/.test(pad) || pad.startsWith('A6B6'); };
const BLOCKED = 'Blocked — Not Ours', NEEDS_REVIEW = 'Needs Review';

// ---- figure out which mode we're in ----
let p = cfg.payload;
let sessionId = cfg.sessionId ? String(cfg.sessionId).trim() : null;
let existing = null, skip = false;
if (sessionId) {
  const sq = await T.sessions.selectRecordsAsync({ fields: ['Session', 'Hub Scanned', 'Scanned By', 'Started', 'Latitude', 'Longitude', 'GPS Accuracy (m)', 'Site (snapped)', 'Session Type', 'Notes', 'Raw Payload', 'Ingest Status'] });
  existing = sq.getRecord(sessionId);
  if (!existing) throw new Error('Scan Session not found: ' + sessionId);
  if (existing.getCellValueAsString('Ingest Status') === 'Done') { output.set('summary', 'already processed'); skip = true; }
  const hubL = first(existing.getCellValue('Hub Scanned')), byL = first(existing.getCellValue('Scanned By'));
  p = {
    hub: hubL ? hubL.id : '', type: existing.getCellValueAsString('Session Type') || 'Full Hub Audit', by: byL ? byL.name : '',
    lat: existing.getCellValue('Latitude'), lng: existing.getCellValue('Longitude'), accuracy: existing.getCellValue('GPS Accuracy (m)'),
    site: existing.getCellValueAsString('Site (snapped)'), notes: existing.getCellValueAsString('Notes'),
    tags: existing.getCellValueAsString('Raw Payload'), source: 'Handheld', started: existing.getCellValue('Started'),
  };
} else {
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { throw new Error('payload is not valid JSON: ' + String(p).slice(0, 120)); } }
  if (!p || typeof p !== 'object') throw new Error('payload missing (webhook) and no sessionId (form)');
}

const fail = async (msg) => {
  if (sessionId) { try { await T.sessions.updateRecordAsync(sessionId, { 'Ingest Status': { name: 'Error' }, 'Summary': ('❌ ' + msg).slice(0, 250) }); } catch (e) {} }
  throw new Error(msg);
};

if (!skip) try {
  const type = String(p.type || 'Full Hub Audit');
  const isSweep = type === 'Sweep';
  const isAudit = type === 'Full Hub Audit' || type === 'Final Check — Ready to Roll';
  const isFinal = type === 'Final Check — Ready to Roll';
  const isCheckOut = type === 'Check Out (borrow)';
  const isCheckIn = type === 'Check In (return)';

  // ---- index tools + equipment by Tag ID (needed before parsing so run-on strings can be split on known tags) ----
  const norm = t => { const s = String(t || '').toUpperCase(); const stripped = s.replace(/^0+/, ''); return stripped || s; };
  const toolQ = await T.tools.selectRecordsAsync({ fields: ['Tool Name', 'Tag ID', 'Home Hub', 'Current Hub', 'Custody', 'Daily Status', 'Consecutive Misses', 'Last Scanned', 'Last Missed', 'Visual Confirms in a Row'] });
  const dayOf = d => d ? new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Denver' }) : '';
  const eqQ = await T.equip.selectRecordsAsync({ fields: ['Equipment Name', 'Tag ID', 'Home Hub', 'Current Hub'] });
  const toolByTag = new Map(), eqByTag = new Map();
  for (const r of toolQ.records) { const t = norm(r.getCellValueAsString('Tag ID')); if (t) toolByTag.set(t, r); }
  for (const r of eqQ.records) { const t = norm(r.getCellValueAsString('Tag ID')); if (t) eqByTag.set(t, r); }
  const knownPadded = []; // [padded24, normalizedTag]
  for (const k of toolByTag.keys()) knownPadded.push([k.padStart(24, '0'), k]);
  for (const k of eqByTag.keys()) if (!toolByTag.has(k)) knownPadded.push([k.padStart(24, '0'), k]);
  knownPadded.sort((a, b) => b[0].length - a[0].length);

  // ---- normalize tags ----
  let raw = p.tags;
  if (typeof raw === 'string') raw = raw.split(/[\s,;]+/);
  raw = (raw || []).map(t => String(t).trim()).filter(Boolean);
  if (!raw.length) await fail('No tags in the payload — nothing was scanned into the Tags box.');
  // A gun in HID mode with no Enter suffix types every EPC back to back as one long string. Split such run-ons:
  // pull out every known tag (as its 24-char zero-padded EPC), then chunk whatever is left into 24-char pieces.
  let runOn = false;
  const expanded = [];
  for (const t of raw) {
    const s = t.toUpperCase();
    if (s.length <= 24 || !/^[0-9A-F]+$/.test(s)) { expanded.push(t); continue; }
    runOn = true;
    let work = s;
    for (const [pad] of knownPadded) { let i; while ((i = work.indexOf(pad)) !== -1) { expanded.push(pad); work = work.slice(0, i) + ' '.repeat(pad.length) + work.slice(i + pad.length); } }
    for (const seg of work.split(/ +/).filter(Boolean)) { for (let i = 0; i < seg.length; i += 24) expanded.push(seg.slice(i, i + 24)); }
  }
  raw = expanded;
  const rawText = raw.join('\n');
  // EPC → Tag ID: GreyTrunk tags are the asset number zero-padded to 24 hex chars. Strip leading zeros; keep the original for the log.
  const uniq = new Map(); // normalized -> { epc, count }
  for (const t of raw) { const n = norm(t); const cur = uniq.get(n); if (cur) cur.count++; else uniq.set(n, { epc: t, count: 1 }); }

  // ---- resolve hub (a Sweep may have none) ----
  const hubQ = await T.hubs.selectRecordsAsync({ fields: ['Hub', 'Nickname', 'Type', 'Site / Location', 'Hub Status'] });
  const hubKey = String(p.hub || '').trim();
  let hub = hubKey ? (hubQ.records.find(r => r.id === hubKey)
    || hubQ.records.find(r => r.getCellValueAsString('Hub').toLowerCase() === hubKey.toLowerCase())
    || hubQ.records.find(r => (r.getCellValueAsString('Nickname') || '').toLowerCase() === hubKey.toLowerCase())) : null;
  if (!hub && !isSweep) await fail(hubKey ? `Hub not found: "${hubKey}" — pick the hub on the form.` : 'No hub on this session — pick the hub (or make it a Sweep).');
  const hubName = hub ? hub.getCellValueAsString('Hub') : '';

  // ---- where the reads happened (for Last Seen) ----
  const hasGps = p.lat != null && p.lng != null && p.lat !== '' && p.lng !== '';
  const seenSite = String(p.site || '').trim() || (hub ? hub.getCellValueAsString('Site / Location') : '');
  const seenFields = () => {
    const f = {};
    if (hasGps) { f['Last Seen Lat'] = Number(p.lat); f['Last Seen Long'] = Number(p.lng); }
    if (seenSite) f['Last Seen Site'] = seenSite.slice(0, 250);
    return f;
  };

  // ---- resolve scanner ----
  const empQ = await T.emp.selectRecordsAsync({ fields: ['Name'] });
  const byName = String(p.by || '').trim();
  const emp = byName ? empQ.records.find(r => r.getCellValueAsString('Name').toLowerCase() === byName.toLowerCase()) : null;

  // ---- create or claim the session ----
  const label = isSweep
    ? `Sweep — ${seenSite || ymd} — ${ymd} — ${byName || 'unknown'}`
    : `${hubName} — ${ymd} — ${byName || 'unknown'}${isFinal ? ' — FINAL' : ''}`;
  const started = p.started ? new Date(p.started) : now;
  if (!sessionId) {
    const sessionFields = {
      'Session': label, 'Started': started, 'Ended': now,
      'Session Type': { name: type }, 'Raw Payload': rawText.slice(0, 100000), 'Notes': p.notes || '',
      'Site (snapped)': p.site || '', 'Tools Read': 0, 'Tools Expected': 0, 'Ingest Status': { name: 'Done' }, 'Summary': 'processing…',
    };
    if (hub) sessionFields['Hub Scanned'] = [{ id: hub.id }];
    if (emp) sessionFields['Scanned By'] = [{ id: emp.id }];
    if (hasGps) { sessionFields['Latitude'] = Number(p.lat); sessionFields['Longitude'] = Number(p.lng); }
    if (p.accuracy != null) sessionFields['GPS Accuracy (m)'] = Math.round(Number(p.accuracy));
    sessionId = await T.sessions.createRecordAsync(sessionFields);
  } else {
    const claim = { 'Session': label, 'Ended': now, 'Summary': 'processing…' };
    if (!p.started) claim['Started'] = now;
    if (!existing.getCellValueAsString('Session Type')) claim['Session Type'] = { name: type };
    await T.sessions.updateRecordAsync(sessionId, claim);
  }

  // ---- process reads ----
  const logRows = [], toolUpd = [], eqUpd = [];
  const readToolIds = new Set();
  const wrongBox = [], unknown = [], packaging = [], foreign = [], blocked = [], confirmed = [], machines = [], awayFromHome = [];
  const unkQ = await T.unk.selectRecordsAsync({ fields: ['Tag (EPC)', 'Tag ID', 'Status', 'Times Seen'] });
  const unkByTag = new Map();
  for (const r of unkQ.records) { const t = norm(r.getCellValueAsString('Tag (EPC)') || r.getCellValueAsString('Tag ID')); if (t) unkByTag.set(t, r); }
  const unkCreate = [], unkUpdate = [];
  const stamp = now;
  for (const [n, info] of uniq) {
    const tool = toolByTag.get(n), eq = !tool ? eqByTag.get(n) : null;
    const row = { 'Scan': `${n} — ${ymd}`, 'Tag ID (as read)': info.epc, 'Session': [{ id: sessionId }],
      'Timestamp': stamp, 'Source': { name: p.source || 'Handheld' }, 'Scanned By': byName, 'Note': info.count > 1 ? `${info.count} reads` : '' };
    if (hub) row['Hub'] = [{ id: hub.id }];
    if (tool) {
      readToolIds.add(tool.id);
      const home = first(tool.getCellValue('Home Hub'));
      const name = tool.getCellValueAsString('Tool Name');
      row['Tool'] = [{ id: tool.id }]; row['Status'] = { name: 'Confirmed (RFID)' };
      const ds = tool.getCellValueAsString('Daily Status');
      const tagHealth = {}; // the tag just read → it works
      if (tool.getCellValue('Visual Confirms in a Row')) tagHealth['Visual Confirms in a Row'] = 0;
      if (ds === 'Missing Tag' || ds === 'Visual Confirm') tagHealth['Daily Status'] = { name: 'Confirmed (RFID)' };
      if (isSweep) {
        // sweep: record where it was seen, judge nothing (tag health still updates)
        row['Note'] = ['Sweep' + (seenSite ? ` at ${seenSite}` : ''), row['Note']].filter(Boolean).join(' · ');
        toolUpd.push({ id: tool.id, fields: { 'Last Scanned': stamp, 'Last Scanned By': byName, ...seenFields(), ...tagHealth } });
        awayFromHome.push(`${n} ${name} — home: ${home ? home.name : '(none)'}`);
      } else {
        const inHome = !!(home && home.id === hub.id);
        row['Result'] = { name: inHome ? 'OK — in home hub' : 'WRONG BOX' };
        const f = { 'Current Hub': [{ id: hub.id }], 'Last Scanned': stamp, 'Last Scanned By': byName, 'Consecutive Misses': 0, ...seenFields(), ...tagHealth };
        if (ds !== 'Damaged') f['Daily Status'] = { name: 'Confirmed (RFID)' };
        if (isCheckOut) { f['Custody'] = { name: 'Checked Out' }; if (emp) f['Checked Out To'] = [{ id: emp.id }]; }
        if (isCheckIn) { f['Custody'] = { name: 'In Hub' }; f['Checked Out To'] = []; }
        toolUpd.push({ id: tool.id, fields: f });
        if (inHome) confirmed.push(name); else wrongBox.push(`${n} ${name} — belongs in ${home ? home.name : '(no home hub)'}`);
      }
    } else if (eq) {
      row['Equipment'] = [{ id: eq.id }]; row['Status'] = { name: 'Confirmed (RFID)' }; row['Result'] = { name: 'Equipment' };
      const f = { 'Last Scanned': stamp, ...seenFields() };
      if (!isSweep) f['Current Hub'] = [{ id: hub.id }];
      eqUpd.push({ id: eq.id, fields: f });
      machines.push(eq.getCellValueAsString('Equipment Name'));
    } else {
      // not a tool or machine → no Scan Log row (v1.5)
      const u = unkByTag.get(n);
      if (u && u.getCellValueAsString('Status') === BLOCKED) { blocked.push(info.epc); continue; }
      if (isOurs(n)) {
        unknown.push(info.epc);
        const seen = { 'Last Seen': stamp, 'Last Seen Site': seenSite.slice(0, 250), 'Last Seen By': byName, 'Last Scan': [{ id: sessionId }] };
        if (u) unkUpdate.push({ id: u.id, fields: { ...seen, 'Times Seen': (u.getCellValue('Times Seen') || 0) + 1 } });
        else unkCreate.push({ fields: { 'Tag (EPC)': String(info.epc).toUpperCase().padStart(24, '0'), 'Tag ID': n, 'Status': { name: NEEDS_REVIEW }, 'First Seen': stamp, 'Times Seen': 1, ...seen } });
      } else if (isPackaging(n)) packaging.push(info.epc);
      else foreign.push(info.epc);
      continue;
    }
    logRows.push({ fields: row });
  }
  const batched = async (fn, rows) => { for (let i = 0; i < rows.length; i += 50) await fn(rows.slice(i, i + 50)); };
  await batched(rows => T.log.createRecordsAsync(rows), logRows);
  await batched(rows => T.tools.updateRecordsAsync(rows), toolUpd);
  await batched(rows => T.equip.updateRecordsAsync(rows), eqUpd);
  await batched(rows => T.unk.createRecordsAsync(rows), unkCreate);
  await batched(rows => T.unk.updateRecordsAsync(rows), unkUpdate);

  // ---- audit logic: expected vs read (same-day passes stack) ----
  let missing = [], expected = [], readTodayCount = 0;
  if (isAudit) {
    expected = toolQ.records.filter(r => { const h = first(r.getCellValue('Home Hub')); const c = r.getCellValueAsString('Custody'); return h && h.id === hub.id && (c === 'In Hub' || !c); });
    // "read today" = read in this pass, OR already scanned in THIS box earlier today (an earlier pass)
    const readToday = new Set(readToolIds);
    for (const r of expected) {
      if (readToday.has(r.id)) continue;
      const cur = first(r.getCellValue('Current Hub'));
      if (cur && cur.id === hub.id && dayOf(r.getCellValue('Last Scanned')) === ymd) readToday.add(r.id);
    }
    readTodayCount = expected.filter(r => readToday.has(r.id)).length;
    const missUpd = [];
    for (const r of expected) {
      if (readToday.has(r.id)) continue;
      const ds = r.getCellValueAsString('Daily Status');
      const already = String(r.getCellValue('Last Missed') || '').slice(0, 10) === ymd; // date-only field: compare the raw YYYY-MM-DD, never shift it through a timezone
      const misses = (r.getCellValue('Consecutive Misses') || 0) + (already ? 0 : 1);
      if (!already) {
        const f = { 'Consecutive Misses': misses, 'Last Missed': ymd };
        if (misses >= MISS_LIMIT && ds !== 'Damaged' && ds !== 'Missing Tag') f['Daily Status'] = { name: 'Missing' };
        missUpd.push({ id: r.id, fields: f });
      }
      missing.push(`${r.getCellValueAsString('Tag ID')} ${r.getCellValueAsString('Tool Name')}${ds === 'Damaged' || ds === 'Missing Tag' ? ` (${ds})` : ''} — miss #${misses}`);
    }
    await batched(rows => T.tools.updateRecordsAsync(rows), missUpd);
  }

  // ---- finish the session ----
  const tail = (unknown.length ? `\n\n${unknown.length} of our tag(s) not in Tools or Equipment — see Unknown Tags (Needs Review):\n` + unknown.join('\n') : '')
    + (blocked.length ? `\n\n${blocked.length} blocked tag(s) skipped (Unknown Tags › Blocked — Not Ours):\n` + blocked.join('\n') : '')
    + (packaging.length ? `\n\n${packaging.length} packaging tag(s) ignored (retail GS1 tags still on boxes/products):\n` + packaging.join('\n') : '')
    + (foreign.length ? `\n\n${foreign.length} other tag(s) ignored (not our number format):\n` + foreign.join('\n') : '')
    + (machines.length ? `\n\nMachines read: ${machines.join(', ')}` : '');
  let missingReport, wrongReport, summary;
  if (isSweep) {
    missingReport = `Sweep${seenSite ? ` at ${seenSite}` : ''} — no missing check.\n${readToolIds.size} tool(s) seen:\n` + (awayFromHome.join('\n') || '(none)') + tail;
    wrongReport = '(sweep — no wrong-box check)';
    summary = `Sweep · ${readToolIds.size} tools seen` + (machines.length ? ` · ${machines.length} machines` : '') + (unknown.length ? ` · ${unknown.length} new tag${unknown.length > 1 ? 's' : ''} to review` : '') + (packaging.length ? ` · ${packaging.length} packaging ignored` : '') + (foreign.length ? ` · ${foreign.length} other tags ignored` : '') + (blocked.length ? ` · ${blocked.length} blocked` : '');
  } else {
    missingReport = (isAudit ? (missing.length ? `${missing.length} of ${expected.length} not scanned today (${readTodayCount} scanned today, ${readToolIds.size} in this pass):\n` + missing.join('\n') : `✅ all ${expected.length} home tools scanned today`) : '(not an audit — no missing check)') + tail;
    wrongReport = wrongBox.length ? `${wrongBox.length} in the wrong box:\n` + wrongBox.join('\n') : '✅ nothing out of place';
    summary = `${readToolIds.size} read this pass` + (isAudit ? ` · ${readTodayCount} / ${expected.length} scanned today · ${missing.length} to go` : '') + ` · ${wrongBox.length} wrong box` + (machines.length ? ` · ${machines.length} machines` : '') + (unknown.length ? ` · ${unknown.length} new tag${unknown.length > 1 ? 's' : ''} to review` : '') + (packaging.length ? ` · ${packaging.length} packaging ignored` : '') + (foreign.length ? ` · ${foreign.length} other tags ignored` : '') + (blocked.length ? ` · ${blocked.length} blocked` : '') + (runOn ? ' · ⚠️ gun typed tags with no Enter between them (set the HID suffix)' : '');
  }
  await T.sessions.updateRecordAsync(sessionId, {
    'Tools Read': readToolIds.size, 'Tools Expected': expected.length,
    'Missing Report': missingReport, 'Wrong Box Report': wrongReport, 'Summary': summary.slice(0, 250), 'Ingest Status': { name: 'Done' },
  });

  // ---- hub side effects (not for a sweep) ----
  if (hub && !isSweep) {
    const hubF = { 'Last Scan At': now, 'Last Scan By': byName, 'Last Scan Site': seenSite.slice(0, 250), 'Last Scan Summary': summary.slice(0, 250) };
    if (hasGps) { hubF['Last Known Lat'] = Number(p.lat); hubF['Last Known Long'] = Number(p.lng); }
    if (p.site && !hub.getCellValueAsString('Site / Location')) hubF['Site / Location'] = String(p.site);
    if (isFinal) {
      hubF['Last Final Check'] = now;
      hubF['Last Final Check Result'] = missing.length || wrongBox.length
        ? `⚠️ ${missing.length} missing, ${wrongBox.length} wrong box (${readTodayCount}/${expected.length} scanned today)`
        : `✅ ${readTodayCount}/${expected.length} scanned today, nothing out of place`;
    }
    if (Object.keys(hubF).length) await T.hubs.updateRecordAsync(hub.id, hubF);
  }

  output.set('session', sessionId);
  output.set('summary', `${label}: ${summary}`);
  console.log(`${denver(now)} ${label}: ${summary}`);
} catch (e) {
  const msg = e && e.message ? e.message : String(e);
  if (sessionId) { try { await T.sessions.updateRecordAsync(sessionId, { 'Ingest Status': { name: 'Error' }, 'Summary': ('❌ ' + msg).slice(0, 250) }); } catch (e2) {} }
  throw e;
}
