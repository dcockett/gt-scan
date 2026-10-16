# Grey Trunk Scan

Phone page for Cockett's RFID hub scans. The Zebra RFD40 sled is paired to the
iPhone as a Bluetooth keyboard (HID mode, Enter suffix); this page listens to
it, shows a live **scanned / total** counter for the hub, and on *Complete
scan* creates the Scan Session in the Grey Trunk Replacement 2.0 base and
shows the ingest verdict (wrong box / missing) on the spot.

Airtable still owns all the judgment — Current Hub, misses, wrong-box reports —
through the existing **Scan Ingest — form** automation. This page only counts.

## How it works

```
iPhone Safari ── /api/hubs ──▶ Vercel function ──▶ Airtable (Hubs: Tools Expected, Scanned Today; Employees)
   (page)     ── /api/scan ──▶ Vercel function ──▶ Airtable (create Scan Session, Raw Payload)
                                     │                      └─ "Scan Ingest — form" automation runs
                                     └── polls the session until Ingest Status = Done, returns Summary
```

- `public/index.html` — the whole page (no build step). Capture box uses
  `inputmode="none"` so iOS delivers the sled's keystrokes without popping the
  on-screen keyboard. Counter = unique 24-char EPCs read this pass. Run-on
  strings (no Enter between tags) are split every 24 chars, same as the
  Airtable script. Manual tag entry pads a label number to a full EPC.
- `api/hubs.js` — live hub list + crew, 60 s cache.
- `api/scan.js` — creates the session (same path as the Airtable form), waits
  for the automation, returns the verdict.
- `lib/epc.js` — the splitter, with tests in `test/`.

## Deploy (Vercel, free)

1. Push this repo to GitHub.
2. vercel.com → *Add New → Project* → import the repo. Framework: **Other**.
   Output directory: `public`. No build command.
3. *Environment Variables* → add `AIRTABLE_TOKEN` (a personal access token with
   `data.records:read` and `data.records:write` scoped to the Grey Trunk base).
4. Deploy. Open the URL on the phone → Share → **Add to Home Screen**.

To put it on `scan.cockettindustries.com` later: Vercel → Project → Domains →
add it, then create the CNAME it asks for wherever the domain's DNS lives.

## Run locally

```
npm test                       # splitter unit tests
AIRTABLE_TOKEN=... npm run dev  # http://localhost:3000 against the real base
```

For a fake base: `node test/mock-airtable.mjs` in one terminal, then
`AIRTABLE_TOKEN=x AIRTABLE_API_BASE=http://localhost:3999/v0 npm run dev`.

## Sled settings that this page assumes (123RFID Desktop → Configure)

- General → Bluetooth Host Type: **HID-Keyboard**
- General → iOS HID Virtual Keyboard: **ENABLE**
- Modify Data: **Append an enter key**
- Region: United States
