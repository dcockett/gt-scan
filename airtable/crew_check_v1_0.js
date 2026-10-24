// Cockett Tools & Hubs — Crew Check v1.0 (Oct 23 2026)
// Runs when someone picks a Crew Check button on a tool (Hub Check interface). Turns the tap into the real change:
//   "Seen it — tag didn't read" → Daily Status Visual Confirm, Consecutive Misses 0, Visual Confirms in a Row +1
//   "Tag not reading"           → Daily Status Missing Tag
//   "Damaged"                   → Daily Status Damaged
// Damaged is never overwritten by a crew tap (only trusted people clear it in Daily Status). Crew can't set Missing or
// put a tool back to normal. Every tap logs a Scan Log row (Source Manual) with who did it, fills Status Set By / At,
// and clears Crew Check so the next tap registers. Input variable: recordId (the tool).

const { recordId } = input.config();
const tools = base.getTable('Tools'), log = base.getTable('Scan Log');
const t = await tools.selectRecordAsync(recordId, { fields: ['Tool Name', 'Tag ID', 'Crew Check', 'Crew Check By', 'Daily Status', 'Visual Confirms in a Row', 'Current Hub', 'Home Hub'] });
if (!t) throw new Error('Tool not found: ' + recordId);
const choice = t.getCellValueAsString('Crew Check');
if (!choice) { output.set('result', 'nothing to do'); }
else {
  const now = new Date();
  const ymd = now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
  const byCell = t.getCellValue('Crew Check By');
  const who = (byCell && (byCell.name || byCell.email)) || 'unknown';
  const ds = t.getCellValueAsString('Daily Status');
  const first = v => Array.isArray(v) && v.length ? v[0] : null;
  const hub = first(t.getCellValue('Current Hub')) || first(t.getCellValue('Home Hub'));

  let status;
  const f = { 'Crew Check': null, 'Status Set By': who, 'Status Set At': now };
  if (choice.startsWith('Seen it')) {
    status = 'Visual Confirm';
    f['Consecutive Misses'] = 0;
    f['Visual Confirms in a Row'] = (t.getCellValue('Visual Confirms in a Row') || 0) + 1;
  } else if (choice === 'Tag not reading') status = 'Missing Tag';
  else if (choice === 'Damaged') status = 'Damaged';
  else throw new Error('Unknown Crew Check choice: ' + choice);

  const keepDamaged = ds === 'Damaged' && status !== 'Damaged';
  if (!keepDamaged) f['Daily Status'] = { name: status };
  await tools.updateRecordAsync(recordId, f);

  const tag = t.getCellValueAsString('Tag ID');
  const row = {
    'Scan': `${tag || t.getCellValueAsString('Tool Name')} — ${ymd}`, 'Tag ID (as read)': tag, 'Tool': [{ id: recordId }],
    'Status': { name: status }, 'Source': { name: 'Manual' }, 'Timestamp': now, 'Scanned By': who,
    'Note': `Crew check: ${choice} (Hub Check interface)` + (ds === 'Missing' ? ' · tool was marked Missing — found' : '') + (keepDamaged ? ' · still Damaged (crew can\'t clear Damaged)' : ''),
  };
  if (hub) row['Hub'] = [{ id: hub.id }];
  await log.createRecordAsync(row);
  output.set('result', `${t.getCellValueAsString('Tool Name')}: ${choice} by ${who}`);
}
