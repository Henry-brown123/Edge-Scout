'use strict';

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const DATA_DIR       = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PIR_PATH       = path.join(DATA_DIR, 'pir-data.json');
const API_KEY        = process.env.API_SPORTS_KEY;
const RATE_LIMIT_MS  = 300;

// Club leagues only — international teams don't have per-player stats via this endpoint
const PIR_LEAGUES = [
  { id: 39,  season: 2024, name: 'Premier League'   },
  { id: 140, season: 2024, name: 'La Liga'           },
  { id: 78,  season: 2024, name: 'Bundesliga'        },
  { id: 135, season: 2024, name: 'Serie A'           },
  { id: 61,  season: 2024, name: 'Ligue 1'           },
  { id: 2,   season: 2024, name: 'Champions League'  },
  { id: 179, season: 2024, name: 'Scottish Prem'     },
  { id: 88,  season: 2024, name: 'Eredivisie'        },
  { id: 94,  season: 2024, name: 'Primeira Liga'     },
  { id: 3,   season: 2024, name: 'Europa League'     },
  { id: 848, season: 2024, name: 'Conference League' },
];

const PIR_REFRESH_DAYS = 7;

const apiSports = axios.create({
  baseURL: 'https://v3.football.api-sports.io',
  headers: { 'x-apisports-key': API_KEY },
  timeout: 15000,
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readPIR() {
  try { return JSON.parse(fs.readFileSync(PIR_PATH, 'utf8')); }
  catch { return {}; }
}

function savePIR(data) {
  fs.writeFileSync(PIR_PATH, JSON.stringify(data, null, 2));
}

function calculatePIR(stats) {
  const s       = stats.statistics?.[0];
  if (!s) return null;
  const games   = s.games?.appearences || 1;
  const mins    = s.games?.minutes || (games * 75);
  const per90   = Math.max(mins / 90, 0.5); // avoid divide-by-near-zero

  const goals90     = (s.goals?.total    || 0) / per90;
  const assists90   = (s.goals?.assists  || 0) / per90;
  const keyPasses90 = (s.passes?.key     || 0) / per90;
  const dribbles90  = (s.dribbles?.success || 0) / per90;
  const defensive90 = ((s.tackles?.total || 0) + (s.interceptions?.total || 0)) / per90;
  const rating      = parseFloat(s.games?.rating || '6.5') || 6.5;

  const raw = (
    (goals90     * 25) +
    (assists90   * 15) +
    (keyPasses90 * 10) +
    (dribbles90  *  8) +
    (defensive90 *  7) +
    ((rating - 6.0) * 35)
  );

  return Math.min(100, Math.max(0, Math.round(raw)));
}

async function fetchLeague(leagueId, season, leagueName, existing) {
  let page = 1;
  let fetched = 0;
  const updated = {};

  while (true) {
    let resp;
    try {
      resp = await apiSports.get('/players/statistics', {
        params: { league: leagueId, season, page },
      });
    } catch (e) {
      console.error(`  [PIR] fetch error league=${leagueId} page=${page}: ${e.message}`);
      break;
    }

    const players  = resp.data?.response || [];
    const paging   = resp.data?.paging   || { current: 1, total: 1 };

    for (const p of players) {
      const playerId = p.player?.id;
      if (!playerId) continue;

      // Skip if refreshed within PIR_REFRESH_DAYS
      const ex = existing[String(playerId)];
      if (ex?.updatedAt) {
        const ageDays = (Date.now() - new Date(ex.updatedAt).getTime()) / 86400000;
        if (ageDays < PIR_REFRESH_DAYS) { updated[String(playerId)] = ex; fetched++; continue; }
      }

      const pir = calculatePIR(p);
      if (pir === null) continue;

      const s = p.statistics?.[0];
      updated[String(playerId)] = {
        playerId,
        playerName:   p.player?.name   || null,
        teamId:       s?.team?.id      || null,
        teamName:     s?.team?.name    || null,
        leagueId,
        leagueName,
        season,
        pir,
        appearances:  s?.games?.appearences || 0,
        minutesPlayed: s?.games?.minutes   || 0,
        goals90:      parseFloat(((s?.goals?.total || 0) / Math.max((s?.games?.minutes || 75) / 90, 0.5)).toFixed(3)),
        assists90:    parseFloat(((s?.goals?.assists || 0) / Math.max((s?.games?.minutes || 75) / 90, 0.5)).toFixed(3)),
        keyPasses90:  parseFloat(((s?.passes?.key || 0) / Math.max((s?.games?.minutes || 75) / 90, 0.5)).toFixed(3)),
        rating:       parseFloat(s?.games?.rating || 6.5) || 6.5,
        updatedAt:    new Date().toISOString(),
      };
      fetched++;
    }

    console.log(`  [PIR] ${leagueName} page ${paging.current}/${paging.total} — ${players.length} players`);

    if (paging.current >= paging.total) break;
    page++;
    await sleep(RATE_LIMIT_MS);
  }

  return { updated, fetched };
}

async function run() {
  if (!API_KEY) { console.error('[PIR] API_SPORTS_KEY not set'); process.exit(1); }

  console.log('[PIR] Starting fetch...');
  const existing = readPIR();
  const all = { ...existing };
  let totalFetched = 0;

  for (const league of PIR_LEAGUES) {
    console.log(`[PIR] League: ${league.name} (${league.id})`);
    const { updated, fetched } = await fetchLeague(league.id, league.season, league.name, all);
    Object.assign(all, updated);
    totalFetched += fetched;
    savePIR(all); // save after each league so progress isn't lost on interrupt
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`[PIR] Done — ${totalFetched} players processed, ${Object.keys(all).length} total in store`);
  return all;
}

module.exports = { run, calculatePIR };

if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
