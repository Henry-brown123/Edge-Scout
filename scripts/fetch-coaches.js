'use strict';
// Item U (2026-09-09): pool manager (head-coach) tenures per club team from the
// API-Sports /coachs endpoint, so "manager change within the last N matches/days"
// can be TESTED as a feature (Addendum 46 listed it as untested with data
// available but not pooled). This script only pools data — nothing reads it
// into scoring yet; that is a separate, evidence-gated decision.
//
// Usage: node scripts/fetch-coaches.js            (DATA_DIR + API_SPORTS_KEY from env)
// Output: DATA_DIR/coaches.json —
//   { "<teamId>": { teamId, teamName, tenures: [{ coachId, coachName, start, end }],
//                   currentCoach: { coachId, coachName, since } | null, updatedAt } }
// One /coachs?team= call per club team present in backfill-historical.json (club
// competitions only — national teams are out of scope), ~300ms apart. The
// endpoint returns every coach whose career includes the team, each with a
// career array of {team, start, end}; we keep only the spells AT this team.

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const DATA_DIR      = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const COACHES_PATH  = path.join(DATA_DIR, 'coaches.json');
const HIST_PATH     = path.join(DATA_DIR, 'backfill-historical.json');
const API_KEY       = process.env.API_SPORTS_KEY;
if (!API_KEY) { console.error('API_SPORTS_KEY not set'); process.exit(1); }
const RATE_LIMIT_MS = 300;

// Mirrors teamProfiles.js INTERNATIONAL_LEAGUE_IDS — national-team competitions
// have no club managers to pool. Kept in lockstep by convention (no shared module).
const INTERNATIONAL_LEAGUE_IDS = new Set([1, 4, 5, 6, 7, 8, 9, 10, 32, 33, 34, 31, 960]);

const apiSports = axios.create({
  baseURL: 'https://v3.football.api-sports.io',
  headers: { 'x-apisports-key': API_KEY },
  timeout: 15000,
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readCoaches() {
  try { return JSON.parse(fs.readFileSync(COACHES_PATH, 'utf8')); } catch { return {}; }
}
function saveCoaches(data) {
  fs.writeFileSync(COACHES_PATH, JSON.stringify(data));
}

// Every club team that appears in the historical pool, with the most recent
// name seen for it. Cups and continental competitions are included (they are
// club competitions); international leagues are excluded.
function getClubTeamIds() {
  let hist;
  try { hist = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8')); } catch { return []; }
  const seen = new Map();
  for (const f of (hist.fixtures || [])) {
    const lid = f.league?.id;
    if (lid == null || INTERNATIONAL_LEAGUE_IDS.has(lid)) continue;
    for (const side of ['home', 'away']) {
      const t = f.teams?.[side];
      if (t?.id) seen.set(t.id, t.name || seen.get(t.id) || null);
    }
  }
  return [...seen.entries()].map(([id, name]) => ({ id, name }));
}

async function fetchTeamCoaches(teamId, teamName) {
  let resp;
  try {
    resp = await apiSports.get('/coachs', { params: { team: teamId } });
  } catch (e) {
    console.error(`  [Coaches] fetch error team=${teamId}: ${e.message}`);
    return null;
  }
  if (resp.data?.errors && Object.keys(resp.data.errors).length) {
    // Rate limit / plan errors come back as 200 with an errors object.
    const msg = JSON.stringify(resp.data.errors);
    console.error(`  [Coaches] API error team=${teamId}: ${msg}`);
    if (/request|limit/i.test(msg)) return { rateLimited: true };
    return null;
  }
  const coaches = resp.data?.response || [];
  const tenures = [];
  for (const c of coaches) {
    for (const spell of (c.career || [])) {
      if (spell.team?.id !== teamId) continue;
      if (!spell.start) continue;
      tenures.push({ coachId: c.id, coachName: c.name, start: spell.start, end: spell.end || null });
    }
  }
  tenures.sort((a, b) => a.start < b.start ? -1 : 1);
  // Current coach: an open-ended spell, latest start wins if several are open
  // (the API occasionally leaves a predecessor's end null).
  const open = tenures.filter(t => !t.end);
  const current = open.length ? open[open.length - 1] : null;
  return {
    teamId,
    teamName,
    tenures,
    currentCoach: current ? { coachId: current.coachId, coachName: current.coachName, since: current.start } : null,
    updatedAt: new Date().toISOString(),
  };
}

async function run() {
  const teams = getClubTeamIds();
  if (!teams.length) { console.log('[Coaches] No club teams found in backfill-historical.json — nothing to do'); return { teams: 0, fetched: 0 }; }
  const store = readCoaches();
  console.log(`[Coaches] ${teams.length} club teams; ${Object.keys(store).length} already pooled`);
  let fetched = 0, errors = 0, rateLimited = false;
  for (const t of teams) {
    const entry = await fetchTeamCoaches(t.id, t.name);
    if (entry?.rateLimited) { rateLimited = true; console.warn('[Coaches] Rate limit reached — saving progress and stopping'); break; }
    if (entry) { store[String(t.id)] = entry; fetched++; } else errors++;
    if (fetched % 50 === 0 && fetched > 0) { saveCoaches(store); console.log(`  [Coaches] ${fetched} fetched, ${errors} errors`); }
    await sleep(RATE_LIMIT_MS);
  }
  saveCoaches(store);
  const withCurrent = Object.values(store).filter(e => e.currentCoach).length;
  console.log(`[Coaches] Done — ${fetched} fetched, ${errors} errors${rateLimited ? ', stopped on rate limit' : ''}. ${Object.keys(store).length} teams on disk, ${withCurrent} with a current coach.`);
  return { teams: teams.length, fetched, errors, rateLimited, total: Object.keys(store).length, withCurrent };
}

module.exports = { run };

if (require.main === module) {
  run().catch(e => { console.error('[Coaches] FATAL:', e.message); process.exit(1); });
}
