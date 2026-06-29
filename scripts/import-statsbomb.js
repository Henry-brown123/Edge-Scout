#!/usr/bin/env node
'use strict';

// Fetches StatsBomb open data for WC 2022 (competition 43, season 106).
// Sums shot.statsbomb_xg per team from each match's events file.
// Writes to data/xg-data.json keyed as "{home}|{away}|{date}".

const fs   = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const OUT_FILE  = path.join(DATA_DIR, 'xg-data.json');
const DELAY_MS  = 300;

const MATCHES_URL = 'https://raw.githubusercontent.com/statsbomb/open-data/master/data/matches/43/106.json';
const EVENTS_BASE = 'https://raw.githubusercontent.com/statsbomb/open-data/master/data/events';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'edge-scout-xg-import/1.0' } }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks))); }
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Load existing store to merge into (don't wipe entries from other sources)
  let store = {};
  try { store = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch {}
  const before = Object.keys(store).length;

  console.log('Fetching WC 2022 match list…');
  const matches = await fetchJSON(MATCHES_URL);
  console.log(`${matches.length} matches found`);

  let imported = 0;
  let errors   = 0;

  for (const m of matches) {
    const matchId   = m.match_id;
    const homeTeam  = m.home_team?.home_team_name;
    const awayTeam  = m.away_team?.away_team_name;
    const date      = m.match_date; // YYYY-MM-DD
    const key       = `${homeTeam}|${awayTeam}|${date}`;

    if (!matchId || !homeTeam || !awayTeam || !date) {
      console.warn(`  Skipping malformed match entry (id=${matchId})`);
      errors++;
      continue;
    }

    try {
      await delay(DELAY_MS);
      const events = await fetchJSON(`${EVENTS_BASE}/${matchId}.json`);

      const xg = { home: 0, away: 0 };
      for (const ev of events) {
        if (ev.type?.name !== 'Shot') continue;
        const xgVal = ev.shot?.statsbomb_xg ?? 0;
        if (ev.team?.name === homeTeam) xg.home += xgVal;
        else                            xg.away += xgVal;
      }
      xg.home = parseFloat(xg.home.toFixed(4));
      xg.away = parseFloat(xg.away.toFixed(4));

      store[key] = { home: xg.home, away: xg.away, source: 'statsbomb', matchId };
      imported++;
      console.log(`  [${imported}/${matches.length}] ${homeTeam} ${xg.home.toFixed(2)} — ${xg.away.toFixed(2)} ${awayTeam}  (${date})`);
    } catch (e) {
      console.error(`  ERROR match ${matchId} (${homeTeam} vs ${awayTeam}): ${e.message}`);
      errors++;
    }
  }

  // Atomic write
  const tmp = OUT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, OUT_FILE);

  const after = Object.keys(store).length;
  console.log(`\nDone — ${imported} matches imported, ${errors} errors`);
  console.log(`xg-data.json: ${before} entries before → ${after} entries now`);
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
