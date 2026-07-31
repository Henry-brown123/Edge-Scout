'use strict';

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const { getWOWYDeltas } = require('../teamProfiles');

const DATA_DIR        = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const TRANSFERS_PATH  = path.join(DATA_DIR, 'transfers.json');
const API_KEY         = process.env.API_SPORTS_KEY || '36e45a67eec7cabd0a51db8f2570f934';
const RATE_LIMIT_MS   = 300;
const CURRENT_SEASON  = parseInt(process.env.TRANSFER_SEASON || '2026', 10);

// The API-Sports /transfers endpoint does not accept a season filter (confirmed:
// passing one returns "The Season field do not exist" with 0 results) — it returns
// each player's full career transfer history instead. We fetch per team and filter
// to the current season's summer transfer window ourselves.
const WINDOW_START = `${CURRENT_SEASON}-06-01`;

// Club leagues only — national-team competitions (World Cup) have no club transfers.
const TRANSFER_LEAGUES = [
  { id: 39,  season: CURRENT_SEASON, name: 'Premier League'   },
  { id: 140, season: CURRENT_SEASON, name: 'La Liga'          },
  { id: 78,  season: CURRENT_SEASON, name: 'Bundesliga'       },
  { id: 135, season: CURRENT_SEASON, name: 'Serie A'          },
  { id: 61,  season: CURRENT_SEASON, name: 'Ligue 1'          },
  { id: 179, season: CURRENT_SEASON, name: 'Scottish Prem'    },
  { id: 88,  season: CURRENT_SEASON, name: 'Eredivisie'       },
  { id: 94,  season: CURRENT_SEASON, name: 'Primeira Liga'    },
  { id: 2,   season: CURRENT_SEASON, name: 'Champions League' },
  { id: 3,   season: CURRENT_SEASON, name: 'Europa League'    },
  { id: 848, season: CURRENT_SEASON, name: 'Conference League' },
];

const apiSports = axios.create({
  baseURL: 'https://v3.football.api-sports.io',
  headers: { 'x-apisports-key': API_KEY },
  timeout: 15000,
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readTransfers() {
  try { return JSON.parse(fs.readFileSync(TRANSFERS_PATH, 'utf8')); }
  catch { return {}; }
}
function saveTransfers(data) {
  fs.writeFileSync(TRANSFERS_PATH, JSON.stringify(data, null, 2));
}
function readPIR() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'pir-data.json'), 'utf8')); }
  catch { return {}; }
}

async function getTeamIds(leagueId, season) {
  try {
    const resp = await apiSports.get('/standings', { params: { league: leagueId, season } });
    const groups = resp.data?.response?.[0]?.league?.standings || [];
    const flat = Array.isArray(groups[0]) ? groups.flat() : groups;
    return flat.map(s => ({ id: s.team?.id, name: s.team?.name })).filter(t => t.id);
  } catch (e) {
    console.error(`  [Transfers] standings error league=${leagueId}: ${e.message}`);
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

const CUP_LEAGUES = new Set([2, 3, 848]);

// Given one player's full career transfer history, find any transfer(s) within the
// current season's window where this team was on the "in" or "out" side.
function findSeasonTransfers(playerTransfers, teamId) {
  const inWindow = (playerTransfers || []).filter(t => t.date && t.date >= WINDOW_START);
  return {
    arrival:   inWindow.find(t => t.teams?.in?.id === teamId)  || null,
    departure: inWindow.find(t => t.teams?.out?.id === teamId) || null,
  };
}

// arrivals/departures: [{ playerId, wowyDelta? }]. pirData: full pir-data.json store.
function calculateNetQualityDelta(arrivals, departures, pirData) {
  const arrivalBoost = arrivals.reduce((sum, p) => {
    const pir = pirData[String(p.playerId)]?.pir ?? 50;
    return sum + (pir - 50) / 10; // above-average arrivals add positive delta
  }, 0);

  const departureDrag = departures.reduce((sum, p) => {
    const pir   = pirData[String(p.playerId)]?.pir ?? 50;
    const wowy  = p.wowyDelta || 0;
    const importance = (pir - 50) / 10 + wowy * 0.3;
    return sum - Math.max(0, importance); // losing important players = negative
  }, 0);

  return Math.round((arrivalBoost + departureDrag) * 10) / 10;
}

async function fetchTeamTransfers(teamId, teamName, pirData) {
  let resp;
  try {
    resp = await apiSports.get('/transfers', { params: { team: teamId } });
  } catch (e) {
    console.error(`  [Transfers] fetch error team=${teamId}: ${e.message}`);
    return null;
  }

  const players    = resp.data?.response || [];
  const wowyDeltas = getWOWYDeltas(teamId); // this team's own WOWY store, for departures
  const arrivals   = [];
  const departures = [];

  for (const p of players) {
    const playerId = p.player?.id;
    if (!playerId) continue;
    const { arrival, departure } = findSeasonTransfers(p.transfers, teamId);

    if (arrival) {
      arrivals.push({
        playerId,
        name:     p.player?.name || null,
        pir:      pirData[String(playerId)]?.pir ?? null,
        fromTeam: arrival.teams?.out?.name || null,
        date:     arrival.date,
      });
    }
    if (departure) {
      const wowy = wowyDeltas[String(playerId)] || null;
      departures.push({
        playerId,
        name:            p.player?.name || null,
        pir:             pirData[String(playerId)]?.pir ?? null,
        wowyDelta:       wowy?.delta ?? null,
        importanceScore: wowy?.importanceScore ?? null,
        toTeam:          departure.teams?.in?.name || null,
        date:            departure.date,
      });
    }
  }

  const netQualityDelta = calculateNetQualityDelta(
    arrivals.map(a => ({ playerId: a.playerId })),
    departures.map(d => ({ playerId: d.playerId, wowyDelta: d.wowyDelta })),
    pirData
  );

  // "Key" arrivals/departures are a display subset, not what feeds netQualityDelta
  // (that uses every arrival/departure found) — notable = above-average PIR arrivals,
  // and departures flagged high-importance per the >12 importanceScore threshold.
  const keyArrivals = arrivals
    .filter(a => a.pir != null && a.pir >= 60)
    .sort((a, b) => b.pir - a.pir)
    .slice(0, 5)
    .map(({ playerId, name, pir, fromTeam }) => ({ playerId, name, pir, fromTeam }));

  const keyDepartures = departures
    .filter(d => (d.importanceScore ?? 0) > 12)
    .sort((a, b) => (b.importanceScore || 0) - (a.importanceScore || 0))
    .slice(0, 5)
    .map(({ playerId, name, pir, wowyDelta, toTeam }) => ({ playerId, name, pir, wowyDelta, toTeam }));

  return {
    teamId,
    teamName,
    season: CURRENT_SEASON,
    netQualityDelta,
    keyArrivals,
    keyDepartures,
    totalArrivals:   arrivals.length,
    totalDepartures: departures.length,
    updatedAt: new Date().toISOString(),
  };
}

async function run() {
  console.log(`[Transfers] Starting fetch for season ${CURRENT_SEASON} (window >= ${WINDOW_START})...`);
  const pirData = readPIR();
  const all = readTransfers();
  let totalTeams = 0;

  for (const league of TRANSFER_LEAGUES) {
    console.log(`[Transfers] League: ${league.name} (${league.id})`);

    let teams;
    if (CUP_LEAGUES.has(league.id)) {
      teams = getTeamIdsFromHistorical(league.id);
    } else {
      teams = await getTeamIds(league.id, league.season);
      await sleep(RATE_LIMIT_MS);
      if (!teams.length) {
        console.log(`  [Transfers] Standings returned 0 teams for ${league.name} — falling back to historical`);
        teams = getTeamIdsFromHistorical(league.id);
      }
    }

    if (!teams.length) {
      console.log(`  [Transfers] No teams found for ${league.name} — skipping`);
      continue;
    }
    console.log(`  [Transfers] ${teams.length} teams to fetch`);

    for (const team of teams) {
      const record = await fetchTeamTransfers(team.id, team.name, pirData);
      if (record) {
        all[`${team.id}_${CURRENT_SEASON}`] = record;
        totalTeams++;
      }
      await sleep(RATE_LIMIT_MS);
    }
    saveTransfers(all);
  }

  console.log(`[Transfers] Complete — ${totalTeams} teams processed, ${Object.keys(all).length} total in store`);
  return all;
}

module.exports = { run, calculateNetQualityDelta, findSeasonTransfers };

if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
