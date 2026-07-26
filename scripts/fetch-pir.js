'use strict';

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const DATA_DIR        = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PIR_PATH        = path.join(DATA_DIR, 'pir-data.json');
const API_KEY         = process.env.API_SPORTS_KEY || '36e45a67eec7cabd0a51db8f2570f934';
const RATE_LIMIT_MS   = 300;
const PIR_REFRESH_DAYS = 7;
const FORCE_REFRESH   = process.env.PIR_FORCE === '1';

// Domestic leagues run first — their players get filed under domestic league.
// Cup leagues run last — players already in store keep their domestic entry (staleness check),
// but in force mode they're re-fetched and filed under their primary domestic league.
// Scottish, Eredivisie, Primeira Liga run after big 5 so their players aren't overwritten.
const PIR_LEAGUES = [
  { id: 39,  season: 2024, name: 'Premier League'   },
  { id: 140, season: 2024, name: 'La Liga'           },
  { id: 78,  season: 2024, name: 'Bundesliga'        },
  { id: 135, season: 2024, name: 'Serie A'           },
  { id: 61,  season: 2024, name: 'Ligue 1'           },
  { id: 179, season: 2024, name: 'Scottish Prem'     },
  { id: 88,  season: 2024, name: 'Eredivisie'        },
  { id: 94,  season: 2024, name: 'Primeira Liga'     },
  { id: 2,   season: 2024, name: 'Champions League'  },
  { id: 3,   season: 2024, name: 'Europa League'     },
  { id: 848, season: 2024, name: 'Conference League' },
];

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
  if (mins < 450) return null; // < 5 full games — per-90 too volatile
  const per90   = mins / 90;

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

// Fetch all team IDs for a league via standings
async function getTeamIds(leagueId, season) {
  try {
    const resp = await apiSports.get('/standings', { params: { league: leagueId, season } });
    const groups = resp.data?.response?.[0]?.league?.standings || [];
    // standings can be a nested array (groups) or flat array
    const flat = Array.isArray(groups[0]) ? groups.flat() : groups;
    return flat.map(s => ({ id: s.team?.id, name: s.team?.name })).filter(t => t.id);
  } catch (e) {
    console.error(`  [PIR] standings error league=${leagueId}: ${e.message}`);
    return [];
  }
}

// For cup competitions (CL/EL/Conference) use historical fixtures to gather team IDs
function getTeamIdsFromHistorical(leagueId) {
  try {
    const hist = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'backfill-historical.json'), 'utf8'));
    const seen = new Map();
    for (const f of (hist.fixtures || [])) {
      if (f.league?.id !== leagueId) continue;
      const h = f.teams?.home; const a = f.teams?.away;
      if (h?.id) seen.set(h.id, h.name);
      if (a?.id) seen.set(a.id, a.name);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  } catch { return []; }
}

async function fetchTeamPlayers(teamId, teamName, season, leagueId, leagueName, existing) {
  let page = 1;
  const updated = {};

  while (true) {
    let resp;
    try {
      resp = await apiSports.get('/players', { params: { team: teamId, season, page } });
    } catch (e) {
      console.error(`  [PIR] fetch error team=${teamId} page=${page}: ${e.message}`);
      break;
    }

    const players = resp.data?.response || [];
    const paging  = resp.data?.paging   || { current: 1, total: 1 };

    for (const p of players) {
      const playerId = p.player?.id;
      if (!playerId) continue;

      const s = p.statistics?.[0];
      // Skip players with no minutes (didn't play)
      if (!s?.games?.minutes || s.games.minutes === 0) continue;

      // Skip if refreshed recently (unless force mode)
      const ex = existing[String(playerId)];
      if (!FORCE_REFRESH && ex?.updatedAt) {
        const ageDays = (Date.now() - new Date(ex.updatedAt).getTime()) / 86400000;
        if (ageDays < PIR_REFRESH_DAYS) { updated[String(playerId)] = ex; continue; }
      }

      const pir = calculatePIR(p);
      if (pir === null) continue;

      const per90 = Math.max((s.games?.minutes || 75) / 90, 0.5);
      updated[String(playerId)] = {
        playerId,
        playerName:   p.player?.name   || null,
        teamId:       s.team?.id       || teamId,
        teamName:     s.team?.name     || teamName,
        leagueId,
        leagueName,
        season,
        pir,
        appearances:   s.games?.appearences || 0,
        minutesPlayed: s.games?.minutes     || 0,
        goals90:       parseFloat(((s.goals?.total    || 0) / per90).toFixed(3)),
        assists90:     parseFloat(((s.goals?.assists  || 0) / per90).toFixed(3)),
        keyPasses90:   parseFloat(((s.passes?.key     || 0) / per90).toFixed(3)),
        rating:        parseFloat(s.games?.rating || 6.5) || 6.5,
        updatedAt:     new Date().toISOString(),
      };
    }

    if (paging.current >= paging.total) break;
    page++;
    await sleep(RATE_LIMIT_MS);
  }

  return updated;
}

const CUP_LEAGUES = new Set([2, 3, 848]); // CL, EL, Conference — no standings, use historical

async function run() {
  console.log(`[PIR] Starting fetch — team-based approach${FORCE_REFRESH ? ' (FORCE mode)' : ''}...`);
  let existing = readPIR();

  // In force mode, strip all entries below the 450-min threshold before re-fetching.
  // This ensures the gate is applied cleanly to the full dataset.
  if (FORCE_REFRESH) {
    const before = Object.keys(existing).length;
    existing = Object.fromEntries(
      Object.entries(existing).filter(([, v]) => (v.minutesPlayed || 0) >= 450)
    );
    console.log(`[PIR] Force mode — stripped ${before - Object.keys(existing).length} sub-threshold entries, ${Object.keys(existing).length} kept`);
    savePIR(existing);
  }

  const all = { ...existing };
  let totalNew   = 0;

  for (const league of PIR_LEAGUES) {
    console.log(`[PIR] League: ${league.name} (${league.id})`);

    let teams;
    if (CUP_LEAGUES.has(league.id)) {
      teams = getTeamIdsFromHistorical(league.id);
    } else {
      teams = await getTeamIds(league.id, league.season);
      await sleep(RATE_LIMIT_MS);
      // Fallback to historical fixtures if standings returned nothing
      if (!teams.length) {
        console.log(`  [PIR] Standings returned 0 teams for ${league.name} — falling back to historical`);
        teams = getTeamIdsFromHistorical(league.id);
      }
    }

    if (!teams.length) {
      console.log(`  [PIR] No teams found for ${league.name} — skipping`);
      continue;
    }

    console.log(`  [PIR] ${teams.length} teams to fetch`);
    let leagueNew = 0;

    for (const team of teams) {
      const updated = await fetchTeamPlayers(team.id, team.name, league.season, league.id, league.name, all);
      const newEntries = Object.values(updated).filter(v => !v.updatedAt || !all[String(v.playerId)]?.updatedAt || v.updatedAt > all[String(v.playerId)].updatedAt);
      Object.assign(all, updated);
      leagueNew += Object.keys(updated).length;
      await sleep(RATE_LIMIT_MS);
    }

    console.log(`  [PIR] ${league.name} done — ${leagueNew} players`);
    totalNew += leagueNew;
    savePIR(all); // save after each league so progress isn't lost
  }

  console.log(`[PIR] Complete — ${totalNew} players processed, ${Object.keys(all).length} total in store`);
  return all;
}

module.exports = { run, calculatePIR };

if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
