'use strict';

const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const cron     = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const session  = require('express-session');
const crypto   = require('crypto');

const {
  classifyFixture, WEIGHTS_BY_CONTEXT, CONTEXT_CONFIG, LEAGUE_CONFIG,
  formScore, homeAdvScore, xgScore, defenseScore, momentumScore,
  h2hScore, standingsScore, injuryScore,
  internationalFormScore, internationalQualityScore, lookupFIFARank,
  computeModelProb, applyLeagueBiasCorrection, computeXGProxy, classifyCompetitionPhase,
  kelly, computeSuccessScore, weatherModifier,
  reloadXgStore, getXgStore, lookupXg,
  scoreGoalsMarkets,
  stalenessMultiplier, applyStalenessPull,
} = require('./scoring');

const model = require('./models/interface');

const {
  getTeamProfiles,
  updateTeamProfiles,
  addResultToProfile,
  applyTeamProfileModifiers,
  updateWOWY,
  getWOWYDeltas,
} = require('./teamProfiles');

const {
  buildTeamIndex,
  buildStandingsIndex,
  scoreFixtureFromPool,
  optimiseWeights: optimiseModelWeights,
  optimiseLeagueWeights,
} = require('./weightOptimiser');

const app  = express();
const PORT = process.env.PORT || 3000;

const API_SPORTS_KEY = process.env.API_SPORTS_KEY || '36e45a67eec7cabd0a51db8f2570f934';
const ODDS_API_KEY   = process.env.ODDS_API_KEY;
if (!ODDS_API_KEY) console.warn('[Startup] ODDS_API_KEY not set — odds fetching will fail');
const DATA_DIR       = process.env.DATA_DIR || path.join(__dirname, 'data');

const APP_PASSWORD     = process.env.APP_PASSWORD;
const SESSION_SECRET   = process.env.SESSION_SECRET || 'dev-secret-change-in-prod';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
if (!APP_PASSWORD) console.warn('[Auth] WARNING: APP_PASSWORD not set — login will fail');
if (!process.env.SESSION_SECRET) console.warn('[Auth] WARNING: SESSION_SECRET not set — using insecure default');
if (!INTERNAL_API_KEY) console.warn('[Auth] WARNING: INTERNAL_API_KEY not set — API key auth disabled');
const RETRAIN_THRESHOLD = 500;

// ─── DATA PERSISTENCE ────────────────────────────────────────────────────────

// Ensure DATA_DIR exists on startup (handles fresh disk or missing local dir)
fs.mkdirSync(DATA_DIR, { recursive: true });
console.log(`[Data] process.env.DATA_DIR=${process.env.DATA_DIR ?? '(unset)'} → resolved DATA_DIR=${DATA_DIR}`);

// Seed static lookup files from repo if not already on disk
(function seedStaticFiles() {
  const seedDir = path.join(__dirname, 'seed');
  for (const file of ['stadiums.json', 'weights.json']) {
    const dest = path.join(DATA_DIR, file);
    const src  = path.join(seedDir, file);
    if (!fs.existsSync(dest) && fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`[Data] Seeded ${file} from repo`);
    }
  }
  // Seed settings.json with safe defaults if missing
  const settingsDest = path.join(DATA_DIR, 'settings.json');
  if (!fs.existsSync(settingsDest)) {
    const defaults = { calibrationFactor: 1.11, wowyActive: true,
      activeLeagues: ['1','39','140','78','135','61','2','179','88','94','3','848'], successThreshold: 40,
      decay: 0.05, formWindow: 6, h2hWindow: 5, kellyFraction: 0.5,
      weights: { form:18, homeAdv:12, xg:16, h2h:10, defense:14, momentum:10, injuries:8, standings:12 } };
    const settingsTmp = settingsDest + '.tmp';
    fs.writeFileSync(settingsTmp, JSON.stringify(defaults, null, 2));
    fs.renameSync(settingsTmp, settingsDest);
    console.log('[Data] Seeded settings.json with defaults');
  }
})();

const MIN_VALID_BYTES = 100;

// Per-file structural validators — for small state files, byte count is the wrong
// corruption signal (a healthy file can legitimately be under MIN_VALID_BYTES).
// Returns true/false to override the size heuristic, or null to fall back to it.
function structuralCheck(file, parsed) {
  if (parsed == null) return false;
  if (file === 'bankroll.json')     return typeof parsed.initial === 'number';
  if (file === 'watching.json')     return Array.isArray(parsed);
  if (file === 'transactions.json') return Array.isArray(parsed);
  return null;
}

function readJSON(file) {
  const fullPath = path.join(DATA_DIR, file);
  let size;
  try {
    size = fs.statSync(fullPath).size;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[Data] readJSON(${file}): ${e.message}`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (e) {
    console.warn(`[Data] readJSON(${file}): invalid JSON — ${e.message}`);
    return null;
  }
  const structural = structuralCheck(file, parsed);
  if (structural === false) {
    console.warn(`[Data] readJSON(${file}): failed structural validation, treating as missing`);
    return null;
  }
  if (structural === null && size < MIN_VALID_BYTES) {
    console.warn(`[Data] readJSON(${file}): ${size} bytes — possibly corrupt, treating as missing`);
    return null;
  }
  return parsed;
}

function writeJSON(file, data, options = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dest = path.join(DATA_DIR, file);
  const tmp  = dest + '.tmp';
  try {
    const serialised = JSON.stringify(data, null, 2);
    // Guard: never overwrite a substantial file with an empty structure, unless
    // the caller confirms the empty result is intentional (e.g. legitimate expiry).
    if (!options.allowEmpty && serialised.length < 10) {
      let existingSize = 0;
      try { existingSize = fs.statSync(dest).size; } catch {}
      if (existingSize >= MIN_VALID_BYTES) {
        console.error(`[Data] writeJSON(${file}): refused — would overwrite ${existingSize}b file with empty structure`);
        return;
      }
    }
    fs.writeFileSync(tmp, serialised);
    // Verify tmp is valid JSON before committing
    try { JSON.parse(fs.readFileSync(tmp, 'utf8')); } catch (verifyErr) {
      fs.unlinkSync(tmp);
      console.error(`[Data] writeJSON(${file}): tmp file failed JSON parse — keeping existing`);
      return;
    }
    fs.renameSync(tmp, dest);
  } catch (e) {
    console.error(`[Data] writeJSON(${file}): ${e.message}`);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

const SETTINGS_DEFAULTS = {
  weights: { form:18, homeAdv:12, xg:16, h2h:10, defense:14, momentum:10, injuries:8, standings:12 },
  decay: 0.05, formWindow: 6, h2hWindow: 5, kellyFraction: 0.5,
  activeLeagues: ['1','39','140','78','135','61','2','179','88','94','3','848'], successThreshold: 40,
  calibrationFactor: 1.08,
  wowyActive: true,
  // Enabled 2026-07-31 after reviewing netQualityDelta across 436 teams and fixing a
  // cup-competition-PIR artefact (Wolfsberger AC: -22.7 -> -9.4). See docs/july-upgrade-notes.md.
  transferModifierActive: true,
  preferExchange: true,
  preferExchangeBuffer: 5,
  leagueModes: {
    '39': 'paper', '140': 'paper_only', '135': 'paper', '78': 'paper',
    '61': 'paper', '2': 'paper', '1': 'paper', '179': 'paper',
    '88': 'paper', '94': 'paper', '3': 'paper', '848': 'paper',
  },
};

function getSettings() {
  const stored = readJSON('settings.json');
  return stored ? { ...SETTINGS_DEFAULTS, ...stored } : { ...SETTINGS_DEFAULTS };
}
function saveSettings(s) { writeJSON('settings.json', s); }

// ── Rate limit — single source of truth ──────────────────────────────────────
const { setRateLimited, isRateLimited, getRateLimitState, backfillCutoffReached } = require('./rateLimit');

function getBankroll() {
  const stored  = readJSON('bankroll.json') || { initial: 1000, lastUpdated: null };
  const initial = stored.initial || 1000;

  // Transactions shift the base: deposits add, withdrawals subtract, resets set a new anchor.
  // We replay transactions to find the current non-bet base, starting from initial.
  const txns = (readJSON('transactions.json') || []).slice().reverse(); // oldest first
  let base = initial;
  for (const t of txns) {
    if (t.type === 'reset')      { base = t.bankrollAfter; }
    else if (t.type === 'deposit')    { base += t.amount; }
    else if (t.type === 'withdrawal') { base -= t.amount; }
  }

  // Add bet P&L on top of the transaction-adjusted base (deduped by fixtureId)
  // Only count bets resolved AFTER the last reset transaction, to avoid double-counting cleared bets.
  const lastReset = txns.filter(t => t.type === 'reset').pop();
  const resetCutoff = lastReset ? new Date(lastReset.date).getTime() : 0;
  const bets = (readJSON('bets.json') || []).filter(b => !b.mode || b.mode === 'paper');
  const seen = new Set();
  let betPnl = 0;
  for (const b of bets) {
    if (b.result && b.pnl != null && !seen.has(b.fixtureId)) {
      const resolvedAt = b.resolvedAt ? new Date(b.resolvedAt).getTime() : Infinity;
      if (resolvedAt > resetCutoff) {
        seen.add(b.fixtureId);
        betPnl += b.pnl;
      }
    }
  }

  const current = parseFloat((base + betPnl).toFixed(2));
  return { ...stored, initial, current };
}

function roundStake(amount) {
  if (amount < 10)  return Math.round(amount / 0.5)  * 0.5;
  if (amount < 50)  return Math.round(amount / 5)    * 5;
  if (amount < 200) return Math.round(amount / 10)   * 10;
  return Math.round(amount / 25) * 25;
}

function getBets()         { return readJSON('bets.json')         || []; }
function getWatching()     { return readJSON('watching.json')     || []; }
function getCalibration()  { return readJSON('calibration.json')  || []; }
function getBookmakers()   { return readJSON('bookmakers.json')    || []; }
function saveBookmakers(list) { writeJSON('bookmakers.json', list); }

const DEFAULT_BOOKMAKERS = [
  { id: 'betfair_exchange', name: 'Betfair Exchange', tier: 1, commission: 0.02,  parentGroup: 'Flutter Entertainment',       balance: null, status: 'active', statusUpdatedAt: null, statusNotes: '', maxStake: null, maxStakeObserved: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: 'Exchange — lay/back, ~2% commission. No restrictions ever.' },
  { id: 'smarkets',         name: 'Smarkets',         tier: 1, commission: 0.02,  parentGroup: 'Smarkets',                    balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: 'Exchange — ~2% commission. No restrictions ever.' },
  { id: 'matchbook',        name: 'Matchbook',         tier: 1, commission: 0.015, parentGroup: 'Matchbook (Exchange)',         balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: 'Peer-to-peer exchange. 1.5% commission.' },
  { id: 'betdaq',           name: 'BETDAQ',            tier: 1, commission: 0.02,  parentGroup: 'BETDAQ',                      balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: 'UKGC-regulated peer-to-peer exchange. 2% commission. Back/lay markets.' },
  { id: 'pinnacle',         name: 'Pinnacle',          tier: 2, commission: null,  parentGroup: 'Pinnacle',                    balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: 'Sharp book. Highest limits, rarely restricts winners.' },
  { id: 'unibet',           name: 'Unibet',            tier: 2, commission: null,  parentGroup: 'Kindred Group',               balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: 'European book. Higher tolerance than UK soft.' },
  { id: 'betsson',          name: 'Betsson',           tier: 2, commission: null,  parentGroup: 'Betsson Group',               balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'nordicbet',        name: 'NordicBet',         tier: 2, commission: null,  parentGroup: 'Betsson Group',               balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'bet365',           name: 'Bet365',            tier: 3, commission: null,  parentGroup: 'Bet365 Group',                balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'william_hill',     name: 'William Hill',      tier: 3, commission: null,  parentGroup: 'Evoke (formerly 888 Holdings)', balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'ladbrokes',        name: 'Ladbrokes',         tier: 3, commission: null,  parentGroup: 'Entain',                      balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'coral',            name: 'Coral',             tier: 3, commission: null,  parentGroup: 'Entain',                      balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'paddy_power',      name: 'Paddy Power',       tier: 3, commission: null,  parentGroup: 'Flutter Entertainment',       balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'betfair_sb',       name: 'Betfair Sportsbook', tier: 3, commission: null, parentGroup: 'Flutter Entertainment',       balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: 'Separate account from Betfair Exchange.' },
  { id: 'skybet',           name: 'Sky Bet',           tier: 3, commission: null,  parentGroup: 'Flutter Entertainment',       balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'betway',           name: 'Betway',            tier: 3, commission: null,  parentGroup: 'Super Group',                 balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: '888sport',         name: '888sport',          tier: 3, commission: null,  parentGroup: 'Evoke (formerly 888 Holdings)', balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'betvictor',        name: 'BetVictor',         tier: 3, commission: null,  parentGroup: 'BetVictor Group',             balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'betfred',          name: 'Betfred',           tier: 3, commission: null,  parentGroup: 'Betfred Group',               balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'boylesports',      name: 'BoyleSports',       tier: 3, commission: null,  parentGroup: 'BoyleSports Group',           balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'quinnbet',         name: 'QuinnBet',          tier: 3, commission: null,  parentGroup: 'Quinn Group',                 balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: '10bet',            name: '10Bet',             tier: 3, commission: null,  parentGroup: 'TGP Europe',                  balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
];
function getOddsHistory()  { return readJSON('odds-history.json') || []; }
function getTournamentSeeds() { return readJSON('tournament-seeds.json') || null; }
function saveTournamentSeeds(data) { writeJSON('tournament-seeds.json', data); }

const WC_2026_SEEDS = {
  tournament: 'FIFA World Cup 2026',
  seedingDate: '2025-12-01',
  leagueId: 1,
  season: 2026,
  teams: {
    'Argentina': 1, 'France': 2, 'England': 3, 'Brazil': 4,
    'Belgium': 5, 'Portugal': 6, 'Spain': 7, 'Netherlands': 8,
    'Colombia': 9, 'Italy': 10, 'Germany': 11, 'Croatia': 12,
    'Morocco': 13, 'Switzerland': 14, 'Denmark': 15, 'USA': 16,
    'Mexico': 17, 'Uruguay': 18, 'Japan': 19, 'Senegal': 20,
    'Iran': 21, 'South Korea': 22, 'Australia': 23, 'Austria': 24,
    'Sweden': 25, 'Turkey': 26, 'Poland': 27, 'Ukraine': 28,
    'Wales': 29, 'Ecuador': 30, 'Canada': 31, 'Hungary': 32,
    'Serbia': 33, 'Norway': 34, 'Algeria': 35, 'Egypt': 36,
    'Tunisia': 37, 'Czechia': 38, 'Scotland': 39, 'Slovakia': 40,
    'Ghana': 41, 'Romania': 42, 'Bolivia': 43, 'Venezuela': 44,
    'Panama': 45, 'Paraguay': 46, 'South Africa': 47, 'Iraq': 48,
  },
};

function saveBets(bets)         { writeJSON('bets.json', bets); }
function saveWatching(list, options) { writeJSON('watching.json', list, options); }
function saveBankroll(br)       { writeJSON('bankroll.json', { ...br, lastUpdated: new Date().toISOString() }); }
function saveCalibration(list)  { writeJSON('calibration.json', list); }
function saveOddsHistory(list)  { writeJSON('odds-history.json', list); }
function getRealBets()          { return readJSON('real-bets.json') || []; }
function saveRealBets(list)     { writeJSON('real-bets.json', list); }

function getLeagueModes() {
  const settings = getSettings();
  const modes = { ...SETTINGS_DEFAULTS.leagueModes, ...(settings.leagueModes || {}) };
  // Sync paperTradeOnly array into leagueModes as paper_only
  const paperOnly = settings.paperTradeOnly || [];
  for (const lid of paperOnly) modes[String(lid)] = 'paper_only';
  return modes;
}

function getLeagueMode(leagueId) {
  return getLeagueModes()[String(leagueId)] || 'paper';
}

function getRealBankroll() {
  const bookmakers = getBookmakers();
  return bookmakers
    .filter(b => b.status === 'active' && b.balance != null && b.balance > 0)
    .reduce((sum, b) => sum + b.balance, 0);
}

function getEvKellyFraction(leagueId) {
  const KELLY_MAP = { half_kelly: 0.5, third_kelly: 0.33, quarter_kelly: 0.25 };
  const evCal = readJSON('ev-calibration.json');
  if (!evCal?.byLeague) return 0.33; // default third-kelly until calibrated
  const leagueName = (LEAGUES[String(leagueId)] || {}).name;
  const entry = evCal.byLeague.find(l => l.league === leagueName);
  return KELLY_MAP[entry?.kelly] ?? 0.33;
}

// On startup: tag all existing bets without a mode field as 'paper'
(function migrateBetModes() {
  try {
    const bets = readJSON('bets.json') || [];
    let changed = false;
    for (const b of bets) {
      if (!b.mode) { b.mode = 'paper'; changed = true; }
    }
    if (changed) writeJSON('bets.json', bets);
  } catch (e) { console.error('[Migration] bet modes:', e.message); }
})();

// Fixture stats: keyed by fixture ID (string). Each entry: { home: {xg, shotsOn, totalShots, possession}, away: {...} }
function getFixtureStats() { return readJSON('fixture-stats.json') || {}; }
function saveFixtureStats(data) { writeJSON('fixture-stats.json', data); }

// Lineups: keyed by fixture ID. Each entry: { home: {teamId, starters:[{id,name}], substitutes:[{id,name}], formation}, away: {...}, fetchedAt }
let _lineupsCache = null;
function getLineups() {
  if (_lineupsCache) return _lineupsCache;
  _lineupsCache = readJSON('lineups.json') || {};
  return _lineupsCache;
}
function saveLineups(data) { _lineupsCache = data; writeJSON('lineups.json', data); }

// Shared lineup parser — stores {id, name} objects so WOWY can use player names.
function parseApiLineup(teamEntry) {
  return {
    teamId:     teamEntry.team?.id,
    starters:   (teamEntry.startXI     || []).map(p => ({ id: p.player?.id, name: p.player?.name || null })).filter(p => p.id),
    substitutes:(teamEntry.substitutes || []).map(p => ({ id: p.player?.id, name: p.player?.name || null })).filter(p => p.id),
    formation:  teamEntry.formation || null,
  };
}

// ─── API CLIENTS ─────────────────────────────────────────────────────────────

const apiSports = axios.create({
  baseURL: 'https://v3.football.api-sports.io',
  headers: { 'x-apisports-key': API_SPORTS_KEY },
  timeout: 15000,
});

const oddsApi = axios.create({
  baseURL: 'https://api.the-odds-api.com/v4',
  timeout: 15000,
});

// ─── ODDS API CREDIT GUARD ──────────────────────────────────────────────────
// Reserve line: never let historical-odds work (backfills, consensus capture,
// calibration re-runs) consume the account below this many credits — that
// floor is set aside for ongoing live CLV capture on active leagues.
const ODDS_CREDITS_RESERVE = 1_000_000;
let _lastKnownOddsCredits = { remaining: null, checkedAt: null };

// Cheap balance check — /sports is free/near-free on the Odds API (not an odds
// pull), so this can be called before every batch without burning real quota.
async function checkOddsApiCredits() {
  try {
    const resp = await oddsApi.get('/sports', { params: { apiKey: ODDS_API_KEY } });
    const remaining = parseInt(resp.headers['x-requests-remaining'], 10);
    _lastKnownOddsCredits = { remaining: Number.isFinite(remaining) ? remaining : null, checkedAt: new Date().toISOString() };
    return _lastKnownOddsCredits;
  } catch (e) {
    // Fail loud, not silent — a broken balance check must not be mistaken for "plenty left".
    console.error(`[OddsCredits] Balance check FAILED: ${e.message} — treating as unknown, blocking non-essential work until resolved`);
    _lastKnownOddsCredits = { remaining: null, checkedAt: new Date().toISOString(), error: e.message };
    return _lastKnownOddsCredits;
  }
}

// Call before any historical-odds batch. Returns { ok, remaining, reason } —
// ok:false means stop non-essential historical work now (reserve breached,
// projected to breach, or balance is unknown because the check itself failed).
async function creditGuard(operationLabel, projectedCost = 0) {
  const { remaining, error } = await checkOddsApiCredits();
  if (remaining == null) {
    console.error(`[OddsCredits] GUARD BLOCKED — ${operationLabel}: balance unknown (${error || 'no data'}). Refusing to spend blind.`);
    return { ok: false, remaining: null, reason: 'balance_check_failed' };
  }
  if (remaining <= ODDS_CREDITS_RESERVE) {
    console.error(`[OddsCredits] GUARD BLOCKED — ${operationLabel}: ${remaining} remaining is at/below the ${ODDS_CREDITS_RESERVE} reserve line.`);
    return { ok: false, remaining, reason: 'reserve_breached' };
  }
  if (projectedCost > 0 && (remaining - projectedCost) < ODDS_CREDITS_RESERVE) {
    console.error(`[OddsCredits] GUARD WARNING — ${operationLabel}: projected cost ${projectedCost} would cross the reserve line (${remaining} remaining). Proceeding at reduced/partial scope is the caller's responsibility.`);
    return { ok: true, remaining, reason: 'would_breach_reserve', warning: true };
  }
  console.log(`[OddsCredits] Guard OK — ${operationLabel}: ${remaining} remaining, reserve line ${ODDS_CREDITS_RESERVE}.`);
  return { ok: true, remaining, reason: 'ok' };
}

app.get('/api/odds-credits-status', async (_req, res) => {
  const status = await checkOddsApiCredits();
  res.json({ ...status, reserveLine: ODDS_CREDITS_RESERVE, belowReserve: status.remaining != null ? status.remaining <= ODDS_CREDITS_RESERVE : null });
});

// Wire rate-limit detection into all API-Sports calls via interceptors.
// Response interceptor: detect quota error → setRateLimited() centrally.
// No request interceptor — existing loop guards handle early exit correctly.
apiSports.interceptors.response.use(
  response => {
    if (response.data?.errors?.requests) setRateLimited();
    return response;
  },
  error => {
    if (error.response?.status === 429) setRateLimited();
    return Promise.reject(error);
  }
);

// ─── LEAGUE METADATA ─────────────────────────────────────────────────────────

const LEAGUES = {
  '1':   { name: 'FIFA World Cup',      season: 2026, sport: 'soccer_fifa_world_cup' },
  '39':  { name: 'Premier League',      season: 2024, sport: 'soccer_epl' },
  '140': { name: 'La Liga',             season: 2024, sport: 'soccer_spain_la_liga' },
  '78':  { name: 'Bundesliga',          season: 2024, sport: 'soccer_germany_bundesliga' },
  '135': { name: 'Serie A',             season: 2024, sport: 'soccer_italy_serie_a' },
  '61':  { name: 'Ligue 1',             season: 2024, sport: 'soccer_france_ligue_one' },
  '2':   { name: 'Champions League',      season: 2024, sport: 'soccer_uefa_champs_league' },
  '179': { name: 'Scottish Premiership',  season: 2026, sport: 'soccer_spl' },
  '88':  { name: 'Eredivisie',            season: 2026, sport: 'soccer_netherlands_eredivisie' },
  '94':  { name: 'Primeira Liga',         season: 2026, sport: 'soccer_portugal_primeira_liga' },
  '3':   { name: 'Europa League',         season: 2024, sport: 'soccer_uefa_europa_league' },
  '848': { name: 'Conference League',     season: 2024, sport: 'soccer_uefa_europa_conference_league' },
};

// ─── BACKFILL CONFIG ──────────────────────────────────────────────────────────
// Leagues and seasons to fetch for profile backfill.
// International: WC qualifying + Nations League + friendlies give 20-40 data
//   points per team. Club: 3 seasons of top-5 leagues gives 80-120 per team.

const BACKFILL_CONFIG = [
  // ── International ──────────────────────────────────────────────────────────
  { leagueId: '1',  name: 'FIFA World Cup',              seasons: [2026, 2022] },
  { leagueId: '32', name: 'WC Qualifying UEFA',           seasons: [2024, 2020] },
  { leagueId: '34', name: 'WC Qualifying CONMEBOL',      seasons: [2026, 2022] },
  { leagueId: '31', name: 'WC Qualifying CONCACAF',      seasons: [2026, 2022] },
  { leagueId: '5',  name: 'FIFA Nations League',         seasons: [2024, 2022] },
  { leagueId: '10', name: 'International Friendlies',    seasons: [2025, 2024] },
  // ── Club — 3 seasons per top-5 league + CL ────────────────────────────────
  // NOTE (Option 3): PL 2024/25 season has ended. Seasons 2022/2023/2024 are
  // fetched here so club profiles are populated for the 2025/26 season when it
  // starts (August 2026). Re-run this backfill at season start to pick up 2025.
  { leagueId: '39',  name: 'Premier League',             seasons: [2024, 2023, 2022, 2021, 2020] },
  { leagueId: '140', name: 'La Liga',                    seasons: [2024, 2023, 2022, 2021, 2020] },
  { leagueId: '78',  name: 'Bundesliga',                 seasons: [2024, 2023, 2022, 2021, 2020] },
  { leagueId: '135', name: 'Serie A',                    seasons: [2024, 2023, 2022, 2021, 2020] },
  { leagueId: '61',  name: 'Ligue 1',                    seasons: [2024, 2023, 2022, 2021, 2020] },
  { leagueId: '2',   name: 'UEFA Champions League',      seasons: [2024, 2023, 2022, 2021, 2020] },
  // New leagues — added July 2026
  { leagueId: '179', name: 'Scottish Premiership',       seasons: [2024, 2023, 2022, 2021, 2020] },
  { leagueId: '88',  name: 'Eredivisie',                 seasons: [2024, 2023, 2022, 2021, 2020] },
  { leagueId: '94',  name: 'Primeira Liga',              seasons: [2024, 2023, 2022, 2021, 2020] },
  { leagueId: '3',   name: 'Europa League',              seasons: [2024, 2023, 2022] },
  { leagueId: '848', name: 'Conference League',          seasons: [2024, 2023, 2022] },
];

// FIFA_RANK_FALLBACK and lookupFIFARank are now exported from scoring.js

function rankToQuality(rank) {
  // rank 1 → 100, rank 55 → 50, rank 105 → 0 (clamped 5-100)
  return Math.max(5, Math.min(100, Math.round(105 - rank)));
}

// Lazy loader for tournament-seeds.json — returns { teamName: seedNumber }
let _tournamentSeeds = null;
function getTournamentSeeds() {
  if (_tournamentSeeds !== null) return _tournamentSeeds;
  const data = readJSON('tournament-seeds.json');
  _tournamentSeeds = data?.teams ?? {};
  return _tournamentSeeds;
}

function daysSinceLastMatch(formFixtures, teamId, kickoffDate) {
  const kickoff = new Date(kickoffDate).getTime();
  const recent  = formFixtures
    .filter(f =>
      ['FT', 'AET', 'PEN'].includes(f.fixture?.status?.short) &&
      (f.teams?.home?.id === teamId || f.teams?.away?.id === teamId) &&
      new Date(f.fixture?.date).getTime() < kickoff
    )
    .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
  if (!recent.length) return null;
  return Math.round((kickoff - new Date(recent[0].fixture.date).getTime()) / 86400000);
}

// ─── STADIUM COORDINATES ─────────────────────────────────────────────────────
// Loaded from data/stadiums.json — add new venues there, not here.

const _stadiumsData = readJSON('stadiums.json') || { venues: {}, cities: {} };
const VENUE_COORDS  = _stadiumsData.venues  || {};
const CITY_COORDS   = _stadiumsData.cities  || {};

function venueCoords(venueName, city) {
  if (venueName) {
    const vLower = venueName.toLowerCase();
    const key = Object.keys(VENUE_COORDS).find(k =>
      vLower.includes(k.toLowerCase()) || k.toLowerCase().includes(vLower)
    );
    if (key) return VENUE_COORDS[key];
  }
  if (city) {
    const cLower = city.toLowerCase();
    const key = Object.keys(CITY_COORDS).find(k => cLower.includes(k.toLowerCase()));
    if (key) return CITY_COORDS[key];
  }
  return null;
}

// ─── WEATHER CLASSIFICATION ───────────────────────────────────────────────────

function classifyWeather(precipProb, windSpeed) {
  if ((precipProb ?? 0) >= 70) return 'heavy_rain';
  if ((precipProb ?? 0) >= 40) return 'rain';
  if ((windSpeed  ?? 0) >= 30) return 'wind';
  return 'clear';
}

// ─── WEATHER ─────────────────────────────────────────────────────────────────

async function fetchWeather(lat, lon, kickoffISO) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation_probability,windspeed_10m,weathercode,temperature_2m&timezone=auto&forecast_days=7`;
    const { data } = await axios.get(url, { timeout: 8000 });
    const kickoff = new Date(kickoffISO);
    const idx = data.hourly?.time?.findIndex(t => {
      const d = new Date(t);
      return Math.abs(d - kickoff) < 3600000;
    });
    if (idx >= 0) {
      return {
        precipProb:  data.hourly.precipitation_probability[idx],
        windSpeed:   data.hourly.windspeed_10m[idx],
        code:        data.hourly.weathercode[idx],
        temperature: data.hourly.temperature_2m[idx],
      };
    }
  } catch {}
  return null;
}

// ─── ODDS FETCHING ───────────────────────────────────────────────────────────

// Raw events cache keyed by sport — populated by fetchOddsForLeague, consumed by persistOddsSnapshot
const _oddsRawCache = {};

// UK soft books preferred for displayed odds and Kelly sizing (accessible, reliable prices)
const UK_BOOKS = new Set([
  'William Hill', 'Betfair', 'Coral', 'Ladbrokes', 'Sky Bet', 'Paddy Power',
  'Bet Victor', '888sport', 'Betfred (UK)', 'BoyleSports', 'Unibet (UK)',
  'Marathon Bet', 'Betway', 'LiveScore Bet', 'Virgin Bet', 'Grosvenor',
]);
// Exchange bookmakers — commission ~2% on Betfair, ~2% on Smarkets, ~1% on Matchbook
const EXCHANGE_COMMISSION = { betfair_ex_uk: 0.02, betfair_ex_eu: 0.02, smarkets: 0.02, matchbook: 0.01 };
const EXCHANGE_DISPLAY    = { betfair_ex_uk: 'Betfair Exchange', betfair_ex_eu: 'Betfair Exchange', smarkets: 'Smarkets', matchbook: 'Matchbook' };

// Extract {teamName: price, Draw: price} from a bookmaker h2h market
function _extractPrices(bm) {
  const mkt = bm?.markets?.find(m => m.key === 'h2h');
  if (!mkt) return null;
  return mkt.outcomes.reduce((acc, o) => { acc[o.name] = o.price; return acc; }, {});
}

// Pinnacle margin-stripped implied probs. Pinnacle overround ~3-4%; stripping gives
// near-true market probabilities — the sharpest available benchmark for edge calculation.
function _pinnacleStripped(prices, home, away) {
  if (!prices) return null;
  const h = prices[home], d = prices['Draw'], a = prices[away];
  if (!h || !d || !a) return null;
  const total = 1/h + 1/d + 1/a;
  return { [home]: (1/h)/total, Draw: (1/d)/total, [away]: (1/a)/total };
}

function _buildOddsMap(events) {
  const map = {};
  (events || []).forEach(ev => {
    const home = ev.home_team, away = ev.away_team;
    const key  = `${home}|${away}`;
    const pinnacle     = ev.bookmakers?.find(b => b.title === 'Pinnacle');
    const pinnPrices   = _extractPrices(pinnacle);
    const pinnStripped = _pinnacleStripped(pinnPrices, home, away);
    const ukBook   = ev.bookmakers?.find(b => UK_BOOKS.has(b.title)) || ev.bookmakers?.[0];
    const ukPrices = _extractPrices(ukBook);
    const allExchanges = [];
    for (const bm of (ev.bookmakers || [])) {
      const comm = EXCHANGE_COMMISSION[bm.key];
      if (comm == null) continue;
      const prices = _extractPrices(bm);
      if (!prices) continue;
      const net = {};
      for (const [k, v] of Object.entries(prices)) net[k] = parseFloat(((v - 1) * (1 - comm) + 1).toFixed(4));
      allExchanges.push({ name: EXCHANGE_DISPLAY[bm.key] || bm.title, key: bm.key, commission: comm, raw: prices, net });
    }
    const bestExchange = allExchanges.reduce((best, ex) =>
      !best || (ex.net[home] || 0) > (best.net[home] || 0) ? ex : best, null);
    if (ukPrices) {
      map[key] = { ...ukPrices, _pinnacleStripped: pinnStripped, _pinnacleRaw: pinnPrices, _exchangeOdds: bestExchange, _allExchangeOdds: allExchanges };
    }
  });
  return map;
}

// The Odds API and API-Sports use different team-name conventions for the same club
// (e.g. "Dundee United" vs "Dundee Utd"). An exact "home|away" key match misses these
// cases and previously fell through to a synthetic odds fallback derived from the
// model's own probability — silently fabricating "market" odds instead of using real
// ones. Fall back to fuzzy name matching (teamsMatch, defined below) before giving up.
function _lookupOddsEntry(oddsMap, homeName, awayName) {
  const exactKey = `${homeName}|${awayName}`;
  if (oddsMap[exactKey]) return oddsMap[exactKey];

  let matchedKey = null;
  for (const key of Object.keys(oddsMap)) {
    const sep = key.indexOf('|');
    if (sep === -1) continue;
    const h = key.slice(0, sep), a = key.slice(sep + 1);
    if (teamsMatch(h, homeName) && teamsMatch(a, awayName)) { matchedKey = key; break; }
  }
  if (!matchedKey) return {};

  const entry = oddsMap[matchedKey];
  const sep = matchedKey.indexOf('|');
  const providerHome = matchedKey.slice(0, sep), providerAway = matchedKey.slice(sep + 1);
  if (providerHome === homeName && providerAway === awayName) return entry;

  // Fuzzy-matched a different-provider name (e.g. "Dundee United" vs "Dundee Utd") —
  // re-key every price object from the odds provider's team names to the caller's
  // (API-Sports) names, so downstream `entry[homeName]`-style lookups still resolve.
  const rekey = (obj) => {
    if (!obj) return obj;
    const out = { ...obj };
    if (providerHome in out && providerHome !== homeName) { out[homeName] = out[providerHome]; delete out[providerHome]; }
    if (providerAway in out && providerAway !== awayName) { out[awayName] = out[providerAway]; delete out[providerAway]; }
    return out;
  };
  return {
    ...rekey(entry),
    _pinnacleStripped: rekey(entry._pinnacleStripped),
    _pinnacleRaw:      rekey(entry._pinnacleRaw),
    _exchangeOdds: entry._exchangeOdds
      ? { ...entry._exchangeOdds, raw: rekey(entry._exchangeOdds.raw), net: rekey(entry._exchangeOdds.net) }
      : null,
    _allExchangeOdds: (entry._allExchangeOdds || []).map(ex => ({ ...ex, raw: rekey(ex.raw), net: rekey(ex.net) })),
  };
}

// Build totals map: "HomeTeam|AwayTeam" → { "2.5": {over, under}, "1.5": {...}, "3.5": {...} }
// Uses Pinnacle when available (sharpest lines), falls back to first available bookmaker.
function _buildTotalsMap(events) {
  const map = {};
  for (const ev of (events || [])) {
    const key      = `${ev.home_team}|${ev.away_team}`;
    const pinnacle = ev.bookmakers?.find(b => b.title === 'Pinnacle');
    const ukBook   = ev.bookmakers?.find(b => UK_BOOKS.has(b.title)) || ev.bookmakers?.[0];
    const source   = pinnacle || ukBook;
    if (!source) continue;
    const totalsMkt = source.markets?.find(m => m.key === 'totals');
    if (!totalsMkt) continue;
    const lines = {};
    for (const o of (totalsMkt.outcomes || [])) {
      const pt = String(o.point);
      if (!lines[pt]) lines[pt] = {};
      if (o.name === 'Over')  lines[pt].over  = o.price;
      if (o.name === 'Under') lines[pt].under = o.price;
    }
    // BTTS odds from both_teams_to_score market, stored under 'btts' key
    const bttsMkt = source.markets?.find(m => m.key === 'both_teams_to_score');
    if (bttsMkt) {
      lines.btts = {};
      for (const o of (bttsMkt.outcomes || [])) {
        if (o.name === 'Yes') lines.btts.yes = o.price;
        if (o.name === 'No')  lines.btts.no  = o.price;
      }
    }
    if (Object.keys(lines).length > 0) map[key] = lines;
  }
  return map;
}

async function fetchOddsForLeague(sport) {
  try {
    // 'both_teams_to_score' (and the correctly-spelled 'btts') are rejected by this
    // Odds API plan/endpoint with a 422 — requesting either causes the WHOLE call to
    // fail, silently wiping out real h2h/totals odds for every fixture in the league
    // and falling back to a synthetic odds placeholder. Request only markets that are
    // confirmed to work; BTTS totals lines are simply unavailable until that's resolved.
    const { data } = await oddsApi.get(`/sports/${sport}/odds`, {
      params: { apiKey: ODDS_API_KEY, regions: 'uk,eu', markets: 'h2h,totals', oddsFormat: 'decimal' },
    });
    const events = data || [];
    _oddsRawCache[sport] = events;
    return { oddsMap: _buildOddsMap(events), totalsMap: _buildTotalsMap(events) };
  } catch (e) { console.error('[Odds] fetchOddsForLeague failed:', e.response?.status, e.response?.data?.message || e.message); return { oddsMap: {}, totalsMap: {} }; }
}

// Build the per-bookmaker market array for a fixture from cached raw events
function _buildBookmakerMarket(sport, homeName, awayName) {
  const events = _oddsRawCache[sport] || [];
  const ev = events.find(e => e.home_team === homeName && e.away_team === awayName);
  if (!ev) return [];
  return (ev.bookmakers || []).slice(0, 8).map(bm => {
    const mkt = bm.markets?.find(m => m.key === 'h2h');
    if (!mkt) return null;
    const get = name => mkt.outcomes?.find(o => o.name === name)?.price ?? null;
    return { name: bm.title, homeOdds: get(homeName), drawOdds: get('Draw'), awayOdds: get(awayName) };
  }).filter(Boolean);
}

function persistOddsSnapshot(fix, scored, sport, stage, leagueId, leagueName, settings) {
  try {
    const threshold = settings?.successThreshold || 40;
    const results   = scored.results || [];
    const best      = results.reduce((a, b) => a.successScore > b.successScore ? a : b, results[0]);
    const get       = label => results.find(r => r.bet === label);
    const hw = get('Home Win'), dr = get('Draw'), aw = get('Away Win');

    const market = _buildBookmakerMarket(sport, scored.homeName, scored.awayName);
    const bestBook = market[0] || { homeOdds: hw?.bookOdds ?? null, drawOdds: dr?.bookOdds ?? null, awayOdds: aw?.bookOdds ?? null };

    const record = {
      fixtureId:       fix.fixture.id,
      home:            scored.homeName,
      away:            scored.awayName,
      league:          leagueName,
      leagueId:        Number(leagueId),
      kickoff:         fix.fixture?.date,
      collectedAt:     new Date().toISOString(),
      stage,
      bookmakers: {
        best:   { homeOdds: bestBook.homeOdds, drawOdds: bestBook.drawOdds, awayOdds: bestBook.awayOdds },
        market,
      },
      impliedProbs: {
        home: bestBook.homeOdds ? parseFloat((1 / bestBook.homeOdds).toFixed(4)) : null,
        draw: bestBook.drawOdds ? parseFloat((1 / bestBook.drawOdds).toFixed(4)) : null,
        away: bestBook.awayOdds ? parseFloat((1 / bestBook.awayOdds).toFixed(4)) : null,
      },
      modelProbs: {
        home: hw?.modelProb ?? null,
        draw: dr?.modelProb ?? null,
        away: aw?.modelProb ?? null,
      },
      edge: {
        home: hw?.edge ?? null,
        draw: dr?.edge ?? null,
        away: aw?.edge ?? null,
      },
      successScore:    best?.successScore ?? null,
      recommendedBet:  (best?.successScore ?? 0) >= threshold ? best?.bet : null,
      locked:          stage === 'pre_match_lock',
      result:          null,
      outcome:         null,
      recommendedBetWon: null,
      resolvedAt:      null,
    };

    const history = getOddsHistory();
    const idx = history.findIndex(r => r.fixtureId === fix.fixture.id);
    if (idx >= 0) {
      // Preserve resolved fields; update everything else
      history[idx] = { ...history[idx], ...record,
        result:            history[idx].result,
        outcome:           history[idx].outcome,
        recommendedBetWon: history[idx].recommendedBetWon,
        resolvedAt:        history[idx].resolvedAt,
      };
    } else {
      history.push(record);
    }
    saveOddsHistory(history);
  } catch (e) {
    console.error('[OddsHistory] persist error:', e.message);
  }
}

// ─── CORE FIXTURE SCORER ─────────────────────────────────────────────────────

function _getWeightsForFixture(leagueId, context, settings) {
  const lid = String(leagueId);
  if (settings.leagueWeights?.[lid]) return settings.leagueWeights[lid];
  return settings.optimisedWeights?.[context] || WEIGHTS_BY_CONTEXT[context];
}

async function scoreOneFixture(fix, formFixtures, standings, statsCache, oddsMap, settings, totalsMap = {}) {
  const homeId   = fix.teams?.home?.id;
  const awayId   = fix.teams?.away?.id;
  const homeName = fix.teams?.home?.name;
  const awayName = fix.teams?.away?.name;

  // Determine fixture context once — drives weights, ranking scale, thresholds
  const leagueId    = fix.league?.id || settings._leagueId;
  const context     = classifyFixture(leagueId);
  const cfg         = CONTEXT_CONFIG[context];
  const leagueConfig = LEAGUE_CONFIG[parseInt(leagueId, 10)] || null;
  // Use optimised weights if available in settings, otherwise fall back to hand-tuned defaults
  const weights  = _getWeightsForFixture(leagueId, context, settings);
  const competitionPhase = classifyCompetitionPhase(fix, leagueId);

  // H2H + injuries in parallel (injuries skipped if pre-fetched at T-60)
  const [h2hRes, injRes] = await Promise.allSettled([
    apiSports.get('/fixtures/headtohead', { params: { h2h: `${homeId}-${awayId}`, last: 5 } }),
    fix._injuries ? Promise.resolve({ data: { response: fix._injuries } })
      : apiSports.get('/injuries', { params: { fixture: fix.fixture.id } }),
  ]);
  const h2hFixtures = h2hRes.status === 'fulfilled' ? h2hRes.value.data?.response || [] : [];
  const injuries    = injRes.status  === 'fulfilled' ? injRes.value.data?.response  || [] : [];

  const d  = settings.decay;
  const fw = settings.formWindow;
  const hw = settings.h2hWindow;

  // Fix 1: for international fixtures, supplement the current-competition form pool with
  // all international-league data from the historical backfill. WC 2026 fixtures have no
  // historical pool of their own, but every WC team has qualifying, Nations League, and
  // continental tournament data that should feed form, xG, defense, and momentum scores.
  const INTERNATIONAL_LEAGUE_IDS = new Set([1, 4, 5, 6, 7, 8, 9, 10, 32, 33, 34, 31, 960]);
  let scoringPool = formFixtures;
  if (context === 'international') {
    const hist = readJSON('backfill-historical.json');
    if (hist?.fixtures?.length) {
      const intlHistorical = hist.fixtures.filter(f =>
        INTERNATIONAL_LEAGUE_IDS.has(f.league?.id) &&
        f.fixture?.status?.short === 'FT'
      );
      // Merge: deduplicate by fixture id, prefer the live-fetch version if present
      const poolMap = new Map(intlHistorical.map(f => [f.fixture.id, f]));
      for (const f of formFixtures) poolMap.set(f.fixture.id, f);
      scoringPool = [...poolMap.values()]
        .sort((a, b) => new Date(b.fixture?.date) - new Date(a.fixture?.date));
    }
  }

  // Neutral venue: WC group stage and knockout are played at neutral sites — no home advantage.
  // Must be computed before homeF so the factor score reflects 50 (neutral) not Spain's home win rate.
  const neutralVenue = context === 'international' &&
    (competitionPhase === 'group_stage' || competitionPhase === 'knockout');

  const homeF = {
    form:      formScore(scoringPool, homeId, fw, d),
    homeAdv:   neutralVenue ? 50 : homeAdvScore(scoringPool, homeId, d),
    xg:        xgScore(scoringPool, homeId, statsCache, d),
    h2h:       h2hScore(h2hFixtures, homeId, hw, d),
    defense:   defenseScore(scoringPool, homeId, d),
    momentum:  momentumScore(scoringPool, homeId),
    injuries:  injuryScore(injuries, homeId),
    standings: standingsScore(standings, homeId, context),
  };
  const awayF = {
    form:      formScore(scoringPool, awayId, fw, d),
    homeAdv:   50,
    xg:        xgScore(scoringPool, awayId, statsCache, d),
    h2h:       100 - h2hScore(h2hFixtures, homeId, hw, d),
    defense:   defenseScore(scoringPool, awayId, d),
    momentum:  momentumScore(scoringPool, awayId),
    injuries:  injuryScore(injuries, awayId),
    standings: standingsScore(standings, awayId, context),
  };

  // Staleness pull: recencyAvg's decay is ordinal (per-game index), not calendar-based —
  // a fixture 76 days old at index 0 (e.g. the only data available at season start) gets
  // full weight otherwise. Discount form/momentum/defense/xg toward neutral based on how
  // long ago each team's most recent form-pool fixture was actually played. Every xG tier
  // in xgScore() (StatsBomb, API-Sports stats, goals proxy) draws from the same past-match
  // pool, so there's no separate "live" xG source to gate on here — it gets the same pull.
  const mostRecentFixtureDate = (teamId) => {
    const teamFixtures = scoringPool.filter(f => f.teams?.home?.id === teamId || f.teams?.away?.id === teamId);
    return teamFixtures[0]?.fixture?.date || null; // scoringPool is sorted most-recent-first
  };
  const homeStaleness = stalenessMultiplier(mostRecentFixtureDate(homeId));
  const awayStaleness = stalenessMultiplier(mostRecentFixtureDate(awayId));
  homeF.form     = applyStalenessPull(homeF.form,     homeStaleness);
  homeF.momentum = applyStalenessPull(homeF.momentum, homeStaleness);
  homeF.defense  = applyStalenessPull(homeF.defense,  homeStaleness);
  homeF.xg       = applyStalenessPull(homeF.xg,       homeStaleness);
  awayF.form     = applyStalenessPull(awayF.form,     awayStaleness);
  awayF.momentum = applyStalenessPull(awayF.momentum, awayStaleness);
  awayF.defense  = applyStalenessPull(awayF.defense,  awayStaleness);
  awayF.xg       = applyStalenessPull(awayF.xg,       awayStaleness);

  // International quality overrides: replace generic form + standings with
  // opponent-quality-weighted form and three-component quality signal.
  if (context === 'international') {
    const seeds = getTournamentSeeds();
    homeF.form     = internationalFormScore(homeId, scoringPool);
    awayF.form     = internationalFormScore(awayId, scoringPool);
    homeF.standings = internationalQualityScore(homeName, seeds);
    awayF.standings = internationalQualityScore(awayName, seeds);
  }

  // Data confidence per team (capped at 1 when ≥15 fixtures available).
  // For international fixtures, count from the full international scoring pool so that
  // qualifying and Nations League data contributes confidence, not just WC group stage.
  const homeFormCount = scoringPool.filter(f =>
    f.teams?.home?.id === homeId || f.teams?.away?.id === homeId
  ).length;
  const awayFormCount = scoringPool.filter(f =>
    f.teams?.home?.id === awayId || f.teams?.away?.id === awayId
  ).length;
  // Adjustment 1: for international fixtures, cap dataConf at 0.70 so the ranking anchor
  // always contributes at least 30% weight. Form data informs but quality signal is never
  // fully overridden — WC teams have thin cross-competition comparability.
  const confCap      = context === 'international' ? 0.70 : 1;
  const homeDataConf = Math.min(homeFormCount / 15, confCap);
  const awayDataConf = Math.min(awayFormCount / 15, confCap);
  const dataConf     = Math.min(homeDataConf, awayDataConf); // use the weaker team's confidence

  const rawProbs = model.predict(homeF, awayF, weights, context, leagueConfig);
  let probs = applyLeagueBiasCorrection(rawProbs, leagueId, LEAGUE_CONFIG);

  // FIFA ranking quality adjustment — anchors model when historical data is thin.
  // scale=0 for club_domestic means rankings have no effect there.
  if (cfg.rankScale > 0 && dataConf < 1) {
    const homeRank = lookupFIFARank(homeName);
    const awayRank = lookupFIFARank(awayName);
    const homeQ    = rankToQuality(homeRank);
    const awayQ    = rankToQuality(awayRank);
    const rankDiff = homeQ - awayQ; // positive = home ranked stronger

    // Adjustment 3: WC group stage and knockout fixtures are played at neutral venues.
    // Symmetric base at 0.34/0.34 (no home advantage); quality and form do the differentiation.
    // Lower than 0.38 so genuine underdogs can still be suppressed by the rank correction.
    // neutralVenue already declared above homeF so both factor score and prob anchor respect it.
    const anchorHomeBase = neutralVenue ? 0.34 : cfg.homeBase;
    const anchorAwayBase = neutralVenue ? 0.34 : cfg.awayBase;

    const rH = Math.max(0.05, Math.min(0.85, anchorHomeBase + rankDiff * cfg.rankScale));
    const rA = Math.max(0.05, Math.min(0.85, anchorAwayBase - rankDiff * cfg.rankScale));
    const rD = Math.max(0.05, 1 - rH - rA);
    const rSum   = rH + rD + rA;
    const rankAdj = { home: rH / rSum, draw: rD / rSum, away: rA / rSum };

    probs = {
      home: dataConf * probs.home + (1 - dataConf) * rankAdj.home,
      draw: dataConf * probs.draw + (1 - dataConf) * rankAdj.draw,
      away: dataConf * probs.away + (1 - dataConf) * rankAdj.away,
    };
  }

  // Adjustment 4: host nation tournament boost.
  // USA/Canada/Mexico are co-hosting WC 2026; host nations consistently outperform FIFA
  // ranking at major tournaments. Apply +8pp to host, redistributed from draw and opponent.
  // Only applies to international group stage and knockout, not qualifying.
  const HOST_NATIONS_2026 = new Set([2384, 5529, 16]); // USA, Canada, Mexico
  if (context === 'international' &&
      (competitionPhase === 'group_stage' || competitionPhase === 'knockout')) {
    const homeIsHost = HOST_NATIONS_2026.has(homeId);
    const awayIsHost = HOST_NATIONS_2026.has(awayId);
    if (homeIsHost || awayIsHost) {
      const BOOST = 0.08;
      if (homeIsHost) {
        const take = BOOST * 0.6; // 60% from draw, 40% from away
        probs = {
          home: Math.min(0.90, probs.home + BOOST),
          draw: Math.max(0.03, probs.draw - take),
          away: Math.max(0.03, probs.away - (BOOST - take)),
        };
      } else {
        const take = BOOST * 0.6;
        probs = {
          home: Math.max(0.03, probs.home - (BOOST - take)),
          draw: Math.max(0.03, probs.draw - take),
          away: Math.min(0.90, probs.away + BOOST),
        };
      }
      // Re-normalise after boost
      const bSum = probs.home + probs.draw + probs.away;
      probs = { home: probs.home / bSum, draw: probs.draw / bSum, away: probs.away / bSum };
    }
  }

  // Weather — fetch first so it can inform profile modifiers
  const kickoffDate = fix.fixture?.date;
  const coords = venueCoords(fix.fixture?.venue?.name, fix.fixture?.venue?.city);
  let weather = null;
  if (coords && kickoffDate) {
    weather = await fetchWeather(coords.lat, coords.lon, kickoffDate);
  }
  const weatherCondition    = classifyWeather(weather?.precipProb, weather?.windSpeed);
  const wxMod               = weatherModifier(weather) / 100; // 0.6–1.0 multiplier

  // Team profile modifiers (includes weather)
  const homeDays = kickoffDate ? daysSinceLastMatch(formFixtures, homeId, kickoffDate) : null;
  const awayDays = kickoffDate ? daysSinceLastMatch(formFixtures, awayId, kickoffDate) : null;
  const teamProfileMap = getTeamProfiles([homeId, awayId]);
  const homeProfile = teamProfileMap[homeId] || null;
  const awayProfile = teamProfileMap[awayId] || null;
  const weatherForModifier = weather ? {
    condition:         weatherCondition,
    precipProbability: weather.precipProb,
    windSpeedKmh:      weather.windSpeed,
  } : null;
  // Attach confirmed-absent WOWY players to profiles before modifier runs.
  // Compares today's confirmed lineup (from lineups.json) against WOWY-tracked player IDs.
  const wowyActive = settings.wowyActive ?? false;
  if (wowyActive && (homeProfile || awayProfile)) {
    const fixtureLineup = getLineups()[String(fix.fixture?.id)];
    if (fixtureLineup) {
      const presentIds = side => new Set([
        ...(fixtureLineup[side]?.starters  || []).map(p => String(p.id ?? p)),
        ...(fixtureLineup[side]?.substitutes || []).map(p => String(p.id ?? p)),
      ]);
      const homePresent = presentIds('home');
      const awayPresent = presentIds('away');
      const absentFrom = (profile, present) => {
        const deltas = getWOWYDeltas(profile.teamId);
        return Object.keys(deltas).filter(pid => !present.has(String(pid)));
      };
      if (homeProfile) homeProfile.confirmedAbsent = absentFrom(homeProfile, homePresent);
      if (awayProfile) awayProfile.confirmedAbsent = absentFrom(awayProfile, awayPresent);
    }
  }

  // Games played this season (from the live standings table) — drives the transfer
  // modifier's 10-matchday decay window in applyTeamProfileModifiers.
  const standingsFlat  = Array.isArray(standings?.[0]) ? standings.flat() : (standings || []);
  const homeMatchday   = standingsFlat.find(s => s.team?.id === homeId)?.all?.played ?? null;
  const awayMatchday   = standingsFlat.find(s => s.team?.id === awayId)?.all?.played ?? null;
  const currentSeason  = fix.league?.season ?? null;

  const { probs: adjustedProbs, teamIntel } = applyTeamProfileModifiers(
    probs, homeProfile, awayProfile, context, dataConf, homeDays, awayDays, weatherForModifier,
    { wowyActive, competitionPhase, homeMatchday, awayMatchday, season: currentSeason,
      transferModifierActive: settings.transferModifierActive === true }
  );
  probs = adjustedProbs;

  // Build results for H/D/A
  // Canonical bet keys ('Home Win'/'Away Win'/'Draw') are preserved for resolution matching.
  // At neutral WC venues a display label is added so the UI shows team names instead of
  // directional labels — "Panama Win" not "Home Win" when neither team is at home.
  const neutralLabels = competitionPhase === 'group_stage' || competitionPhase === 'knockout';

  const bookOdds   = _lookupOddsEntry(oddsMap, homeName, awayName);
  const lookup     = { 'Home Win': homeName, Draw: 'Draw', 'Away Win': awayName };
  const candidates = [
    { label: 'Home Win', displayLabel: neutralLabels ? `${homeName} Win` : null, prob: probs.home },
    { label: 'Draw',     displayLabel: null,                                      prob: probs.draw },
    { label: 'Away Win', displayLabel: neutralLabels ? `${awayName} Win` : null,  prob: probs.away },
  ];

  // Calibration correction: model consistently underpredicts top-pick outcomes by ~5pp.
  // Scale probs by calFactor for edge/EV/kelly/score calculations only.
  // Raw probs are preserved in modelProb for display.
  const calFactor = settings.calibrationFactor ?? 1.08;
  // Market efficiency: less efficient markets (Ligue 1 0.88) get a slight score boost vs
  // highly efficient markets (CL 0.96). Applied as 1/efficiency so range is ×1.04–×1.14.
  const effMult = 1 / (leagueConfig?.marketEfficiency ?? 1.0);

  const pinnStripped = bookOdds._pinnacleStripped; // margin-free Pinnacle true probs (or null)

  const results = [];
  for (const c of candidates) {
    const teamKey   = lookup[c.label];
    const displayOdds = bookOdds[teamKey] || (1 / c.prob * 1.06); // UK book odds for Kelly + display
    // Pinnacle margin-stripped probability is the sharpest available market benchmark.
    // Fall back to implied from display odds when Pinnacle is not present (e.g. WC fixtures).
    const impliedP  = pinnStripped?.[teamKey] ?? (1 / displayOdds);
    const calProb   = Math.min(0.97, c.prob * calFactor);
    const edge      = calProb - impliedP;
    const pinnacleEdgeVsMarket = pinnStripped ? calProb - (pinnStripped[teamKey] ?? (1 / displayOdds)) : null;
    const rawScore  = computeSuccessScore(calProb, displayOdds, homeFormCount, dataConf, pinnacleEdgeVsMarket, leagueId, context);
    let finalScore = Math.round(rawScore * wxMod * effMult);
    // Serie A's 20%+ edge band shows systematic overconfidence in the real GBDT
    // pipeline (-11.24% ROI on n=175, see docs/july-upgrade-notes.md) while the
    // 10-15% band is profitable — drop only the high-edge picks below the 40-point
    // lock threshold so they never lock as bets, leaving the rest of the league untouched.
    if (parseInt(leagueId, 10) === 135 && edge > 0.20) finalScore = Math.min(finalScore, 39);
    const k         = kelly(calProb, displayOdds, settings.kellyFraction, getBankroll().current);

    const entry = {
      market: 'match_outcome',
      bet: c.label, modelProb: c.prob, bookOdds: displayOdds, impliedProb: impliedP,
      edge, successScore: finalScore, kelly: k,
      ev: calProb * (displayOdds - 1) - (1 - calProb),
      pinnacleAvailable: !!pinnStripped,
    };
    if (c.displayLabel) entry.displayLabel = c.displayLabel;
    results.push(entry);
  }

  // Dynamic low-confidence sanity check (Fix 3):
  // Threshold shrinks as data confidence falls — at dataConf=0 for international,
  // any >10pp divergence from the market is flagged.
  const maxModelBookGap  = Math.max(...results.map(c => Math.abs(c.modelProb - c.impliedProb)));
  const gapThreshold     = Math.max(0, cfg.gapThresholdBase - (1 - dataConf) * 0.15);

  // Tiered fixture-count gate: lowConfidence threshold scales with the weaker team's
  // raw backfill count. Under 20 fixtures = near-guess territory; 35+ = real signal.
  // This is an ADDITIONAL gate — both must pass for a bet to unlock.
  const minFormCount   = Math.min(homeFormCount, awayFormCount);
  const tierThreshold  = minFormCount < 20 ? 0.08 : minFormCount < 35 ? 0.12 : 0.18;
  // Knockout international gate: model has shown systematic underdog inflation at WC knockout
  // stage (3 wrong bets at ~11pp gap). Cap effective threshold at 10pp for this context.
  const effectiveGapThreshold = (context === 'international' && competitionPhase === 'knockout')
    ? Math.min(gapThreshold, 0.10)
    : gapThreshold;
  const lowConfidence  = maxModelBookGap > effectiveGapThreshold || maxModelBookGap > tierThreshold;
  results.forEach(c => { c.lowConfidence = lowConfidence; });

  // Human-readable reason for the frontend — reflects whichever gate actually fired,
  // scaled to the real minFormCount tier rather than a fixed "<20" assumption (that
  // tier only applies when minFormCount<20; the 35-fixture and 35+ tiers use different
  // thresholds and need their own wording).
  let lowConfidenceReason = null;
  if (lowConfidence) {
    if (maxModelBookGap > tierThreshold) {
      const tierLabel = minFormCount < 20 ? 'fewer than 20' : minFormCount < 35 ? 'fewer than 35' : 'at least 35';
      lowConfidenceReason = `Insufficient data — ${tierLabel} fixtures in team pool (${minFormCount})`;
    } else {
      lowConfidenceReason = 'Large model/market divergence';
    }
  }

  // WOWY + PIR key player signals — sorted by combined importance score
  const wowyToKeyPlayers = (teamId, isHome) => {
    const deltas = getWOWYDeltas(teamId); // already enriched with pir/importanceScore
    return Object.entries(deltas)
      .filter(([, d]) => Math.abs(d.importanceScore ?? (d.delta * 100)) >= 10)
      .sort((a, b) => Math.abs(b[1].importanceScore ?? (b[1].delta * 100)) - Math.abs(a[1].importanceScore ?? (a[1].delta * 100)))
      .slice(0, 3)
      .map(([pid, d]) => ({
        playerId:       parseInt(pid, 10),
        name:           d.name,
        delta:          d.delta,
        withRate:       d.withRate,
        withoutRate:    d.withoutRate,
        wTotal:         d.wTotal,
        woTotal:        d.woTotal,
        confidence:     d.confidence,
        selectionBias:  d.selectionBias || false,
        pir:            d.pir ?? null,
        pirAvailable:   d.pirAvailable || false,
        importanceScore: d.importanceScore ?? null,
        conflictFlag:   d.conflictFlag || false,
      }));
  };
  if (teamIntel.home) teamIntel.home.keyPlayers = wowyToKeyPlayers(homeId, true);
  if (teamIntel.away) teamIntel.away.keyPlayers = wowyToKeyPlayers(awayId, false);

  const leagueMode  = getLeagueMode(leagueId);
  const paperTradeOnly = leagueMode === 'paper_only'
    || (settings.paperTradeOnly || []).includes(parseInt(leagueId, 10));
  const betMode = leagueMode === 'real' ? 'real' : 'paper';

  const goalsCandidates = scoreGoalsMarkets(
    homeName, awayName, fix.fixture?.date,
    totalsMap, getBankroll().current, settings.kellyFraction,
    homeF, awayF, leagueConfig
  );

  return {
    fix, homeName, awayName, homeF, awayF, probs, weather, weatherCondition, results,
    kickoff: fix.fixture?.date,
    context, competitionPhase, lowConfidence, maxModelBookGap, lowConfidenceReason,
    homeDataConf, awayDataConf, dataConf,
    homeFormCount, awayFormCount, minFormCount, tierThreshold,
    teamIntel, paperTradeOnly, betMode,
    goalsCandidates,
  };
}

// ─── MORNING SCAN ────────────────────────────────────────────────────────────

async function runMorningScan(leagueIds) {
  // Log current API quota usage so we can see how many calls remain at scan time
  try {
    const { data: statusData } = await apiSports.get('/status');
    const sub = statusData?.response?.subscription;
    const req = statusData?.response?.requests;
    if (req) {
      console.log(`[MorningScan] API quota — used: ${req.current}/${req.limit_day} (${Math.round((req.current/req.limit_day)*100)}%) | plan: ${sub?.plan || 'unknown'}`);
    }
  } catch { /* non-fatal — proceed even if status check fails */ }
  console.log(`[MorningScan] Starting for leagues: ${leagueIds.join(', ')}`);
  const settings  = getSettings();
  const today     = new Date().toISOString().split('T')[0];
  const scanStart = new Date().toISOString();
  const watching  = [];

  // Save scan-meta so the UI can display "Last scanned" even if it finds nothing
  writeJSON('scan-meta.json', { date: today, startedAt: scanStart, completedAt: null, count: 0 });

  // Accumulate deduplicated form fixtures across all leagues for team profile rebuild
  const allFormFixtures = new Map(); // fixtureId → fixture

  // Load historical backfill pool once — shared across all leagues, no API cost.
  const backfillData = readJSON('backfill-historical.json') || { fixtures: [] };
  const backfillFixtures = (backfillData.fixtures || [])
    .filter(f => f.fixture?.status?.short === 'FT');

  for (const leagueId of leagueIds) {
    const meta = LEAGUES[leagueId] || { season: 2024 };
    try {
      // Today's fixtures
      const { data: fd } = await apiSports.get('/fixtures', {
        params: { league: leagueId, season: meta.season, date: today, status: 'NS' },
      });
      const fixtures = fd?.response || [];
      if (!fixtures.length) continue;

      // Form data (last 2 seasons, 60 per season)
      const formSeasons = [meta.season, meta.season - 1];
      const formResults = await Promise.all(
        formSeasons.map(s => apiSports.get('/fixtures', { params: { league: leagueId, season: s, last: 60 } }).catch(() => ({ data: { response: [] } })))
      );
      const formFixtures = formResults.flatMap(r => r.data?.response || [])
        .filter(f => f.fixture?.status?.short === 'FT')
        .sort((a, b) => new Date(b.fixture?.date) - new Date(a.fixture?.date));

      // Blend with historical backfill for this league — gives form/momentum/defense/xG
      // access to the full backfilled history instead of just the live last=60 pool.
      // String() coercion: leagueId here is a string (from activeLeagues), but
      // f.league.id in the parsed JSON backfill store is a number.
      const leagueBackfill = backfillFixtures.filter(f => String(f.league?.id) === String(leagueId));

      const enrichedFormFixtures = [...formFixtures, ...leagueBackfill]
        .filter((f, i, arr) =>
          arr.findIndex(x => x.fixture?.id === f.fixture?.id) === i
        )
        .sort((a, b) => new Date(b.fixture?.date) - new Date(a.fixture?.date));

      // Accumulate for team profile rebuild (deduplicate by fixture ID)
      enrichedFormFixtures.forEach(f => allFormFixtures.set(f.fixture?.id, f));

      // Standings
      const { data: sd } = await apiSports.get('/standings', { params: { league: leagueId, season: meta.season } });
      const standings = sd?.response?.[0]?.league?.standings || [];

      // Odds
      const { oddsMap, totalsMap } = await fetchOddsForLeague(meta.sport || 'soccer_epl');

      // Pre-load fixture stats cache from disk (populated by pre-match lock and stats backfill)
      const fixtureStatsDb = getFixtureStats();
      const statsCache = {};
      for (const f of formFixtures) {
        const s = fixtureStatsDb[String(f.fixture?.id)];
        if (s) statsCache[f.fixture.id] = s;
      }

      // Existing calibration entries for today (avoid dupes on re-scan)
      const todayStr  = new Date().toISOString().split('T')[0];
      const calNow    = getCalibration().filter(c => !c.scoredAt?.startsWith(todayStr));

      for (const fix of fixtures) {
        try {
          const scored = await scoreOneFixture(fix, enrichedFormFixtures, standings, statsCache, oddsMap, settings, totalsMap);
          const best   = scored.results.reduce((a, b) => a.successScore > b.successScore ? a : b);
          persistOddsSnapshot(fix, scored, meta.sport || 'soccer_epl', 'morning', leagueId, meta.name, settings);
          const calEntry = {
            id:           uuidv4(),
            fixtureId:    fix.fixture.id,
            fixture:      `${scored.homeName} vs ${scored.awayName}`,
            leagueId,
            leagueName:   meta.name,
            kickoff:      fix.fixture?.date,
            scoredAt:     new Date().toISOString(),
            successScore:    best.successScore,
            projectedBet:    best.displayLabel || best.bet,
            projectedBetKey: best.bet,
            candidates:      [...scored.results, ...(scored.goalsCandidates || [])],
            betPlaced:    false,
            betId:        null,
            resolved:          false,
            resolvedAt:        null,
            actualResult:      null,
            topPickCorrect:    null,
            weatherCondition:  scored.weatherCondition,
            context:           scored.context,
            competitionPhase:  scored.competitionPhase,
            neutralVenue:      scored.teamIntel?.neutralVenue ?? false,
            modifierNotes:     scored.teamIntel?.modifierNotes ?? [],
            minFormCount:      scored.minFormCount ?? null,
            tierThreshold:     scored.tierThreshold ?? null,
          };
          calNow.push(calEntry);

          if (best.successScore >= 20) { // low threshold for WATCHING
            watching.push({
              id: uuidv4(),
              fixtureId:  fix.fixture.id,
              fixture:    `${scored.homeName} vs ${scored.awayName}`,
              leagueId,
              leagueName: meta.name,
              kickoff:    fix.fixture?.date,
              stage:      'WATCHING',
              scoredAt:   new Date().toISOString(),
              projectedScore:  best.successScore,
              projectedBet:    best.bet,
              modelProb:       best.modelProb,
              bookOdds:        best.bookOdds,
              impliedProb:     best.impliedProb,
              edge:            best.edge,
              ev:              best.ev,
              kelly:           best.kelly,
              allCandidates:   [...scored.results, ...(scored.goalsCandidates || [])],
              weather:         scored.weather,
              homeF:           scored.homeF,
              awayF:           scored.awayF,
              calId:           calEntry.id,
              lowConfidence:    scored.lowConfidence,
              maxModelBookGap:  scored.maxModelBookGap,
              lowConfidenceReason: scored.lowConfidenceReason,
              context:          scored.context,
              competitionPhase: scored.competitionPhase,
              homeDataConf:     scored.homeDataConf,
              awayDataConf:     scored.awayDataConf,
              teamIntel:        scored.teamIntel,
              weatherCondition: scored.weatherCondition,
              paperTradeOnly:   scored.paperTradeOnly,
            });
            console.log(`  [WATCHING] ${scored.homeName} vs ${scored.awayName} — score ${best.successScore}`);
          }
        } catch (e) { console.error(`  [MorningScan] score error ${fix.fixture?.id}: ${e.message}`); }
      }
      saveCalibration(calNow);
    } catch (e) { console.error(`[MorningScan] league ${leagueId} error: ${e.message}`); }
  }

  // Rebuild all team profiles from accumulated form fixtures
  if (allFormFixtures.size > 0) {
    updateTeamProfiles([...allFormFixtures.values()]);
  }

  saveWatching(watching);
  writeJSON('scan-meta.json', { date: today, startedAt: scanStart, completedAt: new Date().toISOString(), count: watching.length });
  console.log(`[MorningScan] Done. ${watching.length} fixtures watching.`);
  return watching;
}

// ─── PRE-MATCH SCAN (T-60) ───────────────────────────────────────────────────

async function runPreMatchScan(watchingEntry) {
  const settings  = getSettings();
  const leagueId  = watchingEntry.leagueId;
  const meta      = LEAGUES[leagueId] || { season: 2024 };
  const threshold = settings.successThreshold || 40;

  try {
    // Re-fetch fixture (gets confirmed lineup status)
    const { data: fd } = await apiSports.get('/fixtures', { params: { id: watchingEntry.fixtureId } });
    const fix = fd?.response?.[0];
    if (!fix) return null;

    // Multi-season form
    const formSeasons = [meta.season, meta.season - 1];
    const formResults = await Promise.all(
      formSeasons.map(s => apiSports.get('/fixtures', { params: { league: leagueId, season: s, last: 60 } }).catch(() => ({ data: { response: [] } })))
    );
    const formFixtures = formResults.flatMap(r => r.data?.response || [])
      .filter(f => f.fixture?.status?.short === 'FT')
      .sort((a, b) => new Date(b.fixture?.date) - new Date(a.fixture?.date));

    // Load historical backfill pool — same enrichment as runMorningScan, so the T-60
    // rescore sees the same team-pool size as the morning scan instead of falling back
    // to just the live last=60 fetch (which can trip the low-confidence gate on its own).
    const backfillData = readJSON('backfill-historical.json') || { fixtures: [] };
    const backfillFixtures = (backfillData.fixtures || [])
      .filter(f => f.fixture?.status?.short === 'FT');

    // Filter to current league and blend with live form fixtures
    const leagueBackfill = backfillFixtures.filter(f =>
      String(f.league?.id) === String(leagueId)
    );

    const enrichedFormFixtures = [...formFixtures, ...leagueBackfill]
      .filter((f, i, arr) =>
        arr.findIndex(x => x.fixture?.id === f.fixture?.id) === i
      )
      .sort((a, b) => new Date(b.fixture?.date) - new Date(a.fixture?.date));

    // Stats cache: load from disk first, then fetch any missing from recent 15 fixtures
    const fixtureStatsDb = getFixtureStats();
    const statsCache = {};
    for (const f of formFixtures) {
      const s = fixtureStatsDb[String(f.fixture?.id)];
      if (s) statsCache[f.fixture.id] = s;
    }

    const parseStats = ts => {
      const find   = t => ts.statistics?.find(s => s.type === t)?.value;
      const xgRaw  = find('expected_goals') ?? find('Expected Goals');
      const shotsOn    = parseInt(find('Shots on Goal') ?? 0) || 0;
      const totalShots = parseInt(find('Total Shots') ?? 0) || 0;
      const possession = parseFloat(String(find('Ball Possession') ?? '50%').replace('%', '')) / 100;
      const xg = xgRaw != null ? parseFloat(xgRaw) || null
        : (shotsOn || totalShots) ? computeXGProxy({ shotsOn, totalShots, possession }) : null;
      return { xg, shotsOn, totalShots, possession };
    };

    const statsToSave = {};
    for (const f of formFixtures.slice(0, 15)) {
      if (statsCache[f.fixture.id]) continue; // already loaded from disk
      try {
        const { data: st } = await apiSports.get('/fixtures/statistics', { params: { fixture: f.fixture.id } });
        if (st?.response?.length >= 2) {
          const entry = { home: parseStats(st.response[0]), away: parseStats(st.response[1]) };
          statsCache[f.fixture.id] = entry;
          statsToSave[f.fixture.id] = entry;
        }
      } catch {}
    }
    // Persist newly fetched stats so morning scan can use them without re-fetching
    if (Object.keys(statsToSave).length > 0) {
      saveFixtureStats({ ...fixtureStatsDb, ...statsToSave });
    }

    // Fetch lineups for the target fixture (available T-60 if teams submit early)
    try {
      const { data: lu } = await apiSports.get('/fixtures/lineups', { params: { fixture: fix.fixture.id } });
      if (lu?.response?.length >= 2) {
        const lineupEntry = {
          home:      parseApiLineup(lu.response[0]),
          away:      parseApiLineup(lu.response[1]),
          fetchedAt: new Date().toISOString(),
        };
        const lineups = getLineups();
        lineups[String(fix.fixture.id)] = lineupEntry;
        saveLineups(lineups);
      }
    } catch {}

    // Fetch confirmed injury/suspension list for this fixture
    try {
      const { data: injData } = await apiSports.get('/injuries', { params: { fixture: fix.fixture.id } });
      if (injData?.response?.length) {
        fix._injuries = injData.response;
      }
    } catch {}

    const { data: std } = await apiSports.get('/standings', { params: { league: leagueId, season: meta.season } });
    const standings = std?.response?.[0]?.league?.standings || [];
    const { oddsMap, totalsMap } = await fetchOddsForLeague(meta.sport || 'soccer_epl');

    const scored = await scoreOneFixture(fix, enrichedFormFixtures, standings, statsCache, oddsMap, settings, totalsMap);
    const best   = scored.results.reduce((a, b) => a.successScore > b.successScore ? a : b);
    persistOddsSnapshot(fix, scored, meta.sport || 'soccer_epl', 'pre_match_lock', leagueId, meta.name, settings);

    if (best.successScore < threshold) {
      console.log(`[PreMatch] ${scored.homeName} vs ${scored.awayName} DROPPED (score ${best.successScore} < ${threshold})`);
      return null;
    }
    if (scored.lowConfidence) {
      console.log(`[PreMatch] ${scored.homeName} vs ${scored.awayName} DROPPED — low confidence: ${scored.lowConfidenceReason} (max gap ${Math.round(scored.maxModelBookGap * 100)}pp)`);
      return null;
    }

    // Fix 5: hard minimum data requirement per context
    const dataMin = CONTEXT_CONFIG[scored.context]?.dataConfMin ?? 0.3;
    if (scored.homeDataConf < dataMin && scored.awayDataConf < dataMin) {
      console.log(`[PreMatch] ${scored.homeName} vs ${scored.awayName} DROPPED — insufficient data (home ${scored.homeDataConf.toFixed(2)}, away ${scored.awayDataConf.toFixed(2)}, min ${dataMin} for ${scored.context})`);
      return null;
    }

    // Fix 2: value consistency check — only acts when 10+ comparable resolved entries exist
    let consistencyWarning = null;
    try {
      const cal = getCalibration();
      const comparable = cal.filter(c => {
        if (!c.resolved) return false;
        const candidate = c.candidates?.find(x => x.bet === best.bet);
        if (!candidate) return false;
        return Math.abs((candidate.modelProb || 0) - best.modelProb) <= 0.05
            && Math.abs((c.successScore || 0) - best.successScore) <= 10;
      });
      if (comparable.length >= 10) {
        const wins   = comparable.filter(c => c.topPickCorrect).length;
        const histWR = wins / comparable.length;
        const gap    = best.modelProb - histWR;
        if (gap > 0.10) {
          consistencyWarning = `Historical win rate in similar bands: ${(histWR * 100).toFixed(0)}% vs model ${(best.modelProb * 100).toFixed(0)}% (${comparable.length} samples)`;
          console.log(`[PreMatch] CONSISTENCY WARNING: ${consistencyWarning}`);
        }
      }
    } catch {}

    // Lock the bet — mode-aware Kelly and bankroll
    const betMode   = scored.betMode || 'paper';
    const isReal    = betMode === 'real';
    const realBr    = isReal ? getRealBankroll() : null;
    const evKelly   = isReal ? getEvKellyFraction(leagueId) : settings.kellyFraction;
    const bankrollForKelly = isReal ? (realBr || 0) : getBankroll().current;
    const realKelly = kelly(best.modelProb * (settings.calibrationFactor ?? 1.08),
                            best.bookOdds, evKelly, bankrollForKelly);
    const br    = getBankroll();
    const betId = uuidv4();
    const routingOddsEntry = _lookupOddsEntry(oddsMap, scored.homeName, scored.awayName);
    const computedStake = scored.paperTradeOnly ? 0
      : isReal ? roundStake(realKelly.stake) : roundStake(best.kelly.stake);
    const bet   = {
      id:           betId,
      fixtureId:    fix.fixture.id,
      fixture:      `${scored.homeName} vs ${scored.awayName}`,
      leagueId,
      leagueName:   meta.name,
      kickoff:      fix.fixture?.date,
      expectedFinish: new Date(new Date(fix.fixture.date).getTime() + 110 * 60000).toISOString(),
      bet:          best.bet,
      successScore: best.successScore,
      modelProb:    best.modelProb,
      bookOdds:     best.bookOdds,
      impliedProb:  best.impliedProb,
      edge:         best.edge,
      ev:           best.ev,
      mode:          betMode,
      paperTradeOnly: scored.paperTradeOnly,
      kellyFraction: evKelly,
      kellStake:     computedStake,
      suggestedStake: computedStake,
      displayStake:  computedStake,
      bankrollAtLock: isReal ? (realBr || 0) : br.current,
      stage:        'RECOMMENDED',
      lockedAt:     new Date().toISOString(),
      result:       null,
      pnl:          null,
      resolvedAt:   null,
      homeF:               scored.homeF,
      awayF:               scored.awayF,
      weather:             scored.weather,
      weatherCondition:    scored.weatherCondition,
      consistencyWarning:  consistencyWarning,
      competitionPhase:    scored.competitionPhase,
      // Bookmaker routing recommendation at lock time
      routingRecommendation: selectBookmaker(roundStake(best.kelly.stake), best.edge, {
        exchangeOdds:    routingOddsEntry._exchangeOdds    || null,
        allExchangeOdds: routingOddsEntry._allExchangeOdds || [],
        outcomeName: best.bet === 'Home Win' ? scored.homeName
                   : best.bet === 'Away Win' ? scored.awayName
                   : 'Draw',
        settings,
      }),
      // Per-bookmaker odds snapshot at lock time (for bookmaker selection UI)
      oddsSnapshot: _buildBookmakerMarket(meta.sport || 'soccer_epl', scored.homeName, scored.awayName),
      // Three-state placement flow. Real-money bets require manual confirmation via
      // /api/bets/:id/confirm-placement (there's a real bookmaker to record). Paper bets
      // have nothing to physically place, so they auto-confirm here using the odds/stake
      // already captured at lock time — this is what makes them eligible for the T-5 CLV
      // cron without ever touching the bookmaker-confirmation fields.
      placementStatus: isReal ? 'pending_placement' : 'placed', // 'pending_placement' | 'placed' | 'skipped'
      // Placement confirmation fields (filled by user after manual placement for real bets;
      // auto-filled from lock-time odds/stake for paper bets — no bookmaker involved).
      placementConfirmed: !isReal,
      bookmakerUsed: null,
      bookmakerId:   null,
      actualOdds:    isReal ? null : best.bookOdds,
      actualStake:   isReal ? null : computedStake,
      placedAt:      isReal ? null : new Date().toISOString(),
      skippedAt:     null,
      skipReason:    null,
    };

    const bets = getBets();
    if (bets.some(b => b.fixtureId === fix.fixture.id)) {
      console.log(`[PreMatch] Bet already exists for fixture ${fix.fixture.id} (${scored.homeName} vs ${scored.awayName}) — skipping duplicate`);
      return null;
    }
    bets.unshift(bet);
    saveBets(bets);
    if (isReal) {
      const realBets = getRealBets();
      realBets.unshift(bet);
      saveRealBets(realBets);
    }

    // Mark calibration entry as bet placed
    if (watchingEntry.calId) {
      const cal = getCalibration();
      const ce  = cal.find(c => c.id === watchingEntry.calId);
      if (ce) { ce.betPlaced = true; ce.betId = betId; ce.stake = best.kelly.stake; saveCalibration(cal); }
    }

    console.log(`[PreMatch] LOCKED: ${bet.fixture} — ${bet.bet} (score ${bet.successScore}, stake £${bet.suggestedStake})`);
    return bet;
  } catch (e) {
    console.error(`[PreMatch] error ${watchingEntry.fixtureId}: ${e.message}`);
    return null;
  }
}

// ─── AUTO-RESOLUTION ────────────────────────────────────────────────────────

async function checkAndResolve() {
  const bets    = getBets();
  const cal     = getCalibration();
  const now     = Date.now();

  // Pending bets
  const pendingBets = bets.filter(b => b.stage === 'RECOMMENDED' && !b.result);
  // Unresolved calibration entries past expected finish (kickoff + 110m)
  const pendingCal  = cal.filter(c => !c.resolved && c.kickoff &&
    now > new Date(c.kickoff).getTime() + 110 * 60000);

  // Deduplicate fixture IDs to fetch — cover both bets and cal entries
  const fixtureIds = [...new Set([
    ...pendingBets.map(b => b.fixtureId),
    ...pendingCal.map(c => c.fixtureId),
  ])];

  if (!fixtureIds.length) return;

  let betsChanged = false;
  let calChanged  = false;

  for (const fid of fixtureIds) {
    try {
      const { data } = await apiSports.get('/fixtures', { params: { id: fid } });
      const fix    = data?.response?.[0];
      if (!fix) continue;
      const status = fix.fixture?.status?.short;
      if (!['FT', 'AET', 'PEN', 'AWD', 'WO'].includes(status)) continue;

      // h2h market settles on 90-minute FT result — use score.fulltime, not goals
      // (goals includes extra time and penalties for AET/PEN fixtures)
      const ftHome        = fix.score?.fulltime?.home ?? fix.goals?.home ?? 0;
      const ftAway        = fix.score?.fulltime?.away ?? fix.goals?.away ?? 0;
      const hg            = fix.goals?.home ?? 0;
      const ag            = fix.goals?.away ?? 0;
      const actualOutcome = ftHome > ftAway ? 'Home Win' : ftHome < ftAway ? 'Away Win' : 'Draw';
      const resolvedAt    = new Date().toISOString();
      const finalScore    = `${hg}-${ag}`;
      const homeName      = fix.teams?.home?.name;
      const awayName      = fix.teams?.away?.name;

      // Resolve all pending bets for this fixture, but credit P&L only once (first/canonical)
      const matchingBets = pendingBets.filter(b => b.fixtureId === fid);
      if (matchingBets.length) {
        const canonical = matchingBets[0];
        const won = actualOutcome === canonical.bet;
        const pnl = won
          ? parseFloat(((canonical.bookOdds - 1) * canonical.suggestedStake).toFixed(2))
          : -canonical.suggestedStake;
        matchingBets.forEach(b => {
          b.result     = won ? 'win' : 'loss';
          b.pnl        = b === canonical ? pnl : 0; // duplicates get 0 pnl, canonical gets real pnl
          b.stage      = 'RESOLVED';
          b.resolvedAt = resolvedAt;
          b.finalScore = finalScore;
        });
        const br = getBankroll();
        br.current = parseFloat((br.current + pnl).toFixed(2));
        saveBankroll(br);
        betsChanged = true;
        const dupNote = matchingBets.length > 1 ? ` (${matchingBets.length - 1} duplicates voided)` : '';
        console.log(`[Resolve] ${canonical.fixture} — ${canonical.bet} → ${canonical.result} (${finalScore}), P&L: £${pnl}, Bankroll: £${br.current}${dupNote}`);
      }

      // Resolve calibration entry
      const ce = pendingCal.find(c => c.fixtureId === fid);
      if (ce) {
        const neutralDisplay = ce.competitionPhase === 'group_stage' || ce.competitionPhase === 'knockout';
        const displayResult  = neutralDisplay
          ? (hg > ag ? `${homeName} Win` : hg < ag ? `${awayName} Win` : 'Draw')
          : actualOutcome;
        ce.resolved       = true;
        ce.resolvedAt     = resolvedAt;
        ce.actualResult   = displayResult;
        ce.finalScore     = finalScore;
        ce.topPickCorrect = actualOutcome === (ce.projectedBetKey || ce.projectedBet);
        calChanged = true;
        console.log(`[Calibration] ${ce.fixture} → actual: ${displayResult}, predicted: ${ce.projectedBet} (${ce.topPickCorrect ? '✓' : '✗'})`);
      }

      // Update odds history record with result
      try {
        const outcomeKey = hg > ag ? 'home' : hg < ag ? 'away' : 'draw';
        const history = getOddsHistory();
        const hi = history.findIndex(r => r.fixtureId === fid);
        if (hi >= 0) {
          const rec = history[hi];
          rec.result     = { homeGoals: hg, awayGoals: ag };
          rec.outcome    = outcomeKey;
          rec.recommendedBetWon = rec.recommendedBet
            ? (rec.recommendedBet === (outcomeKey === 'home' ? 'Home Win' : outcomeKey === 'away' ? 'Away Win' : 'Draw'))
            : null;
          rec.resolvedAt = resolvedAt;
          saveOddsHistory(history);
        }
      } catch {}

      // Incremental team profile update
      const homeId   = fix.teams?.home?.id;
      const awayId   = fix.teams?.away?.id;
      const homeWon  = actualOutcome === 'Home Win';
      const awayWon  = actualOutcome === 'Away Win';
      const isDraw   = actualOutcome === 'Draw';
      // Pull weatherCondition from the bet or calibration entry if available
      const resolvedBet = pendingBets.find(b => b.fixtureId === fid);
      const resolvedCe  = pendingCal.find(c => c.fixtureId === fid);
      const wxCond = resolvedBet?.weatherCondition || resolvedCe?.weatherCondition || null;
      if (homeId) addResultToProfile(homeId, true,  homeWon, isDraw, awayId, awayName, hg - ag, wxCond);
      if (awayId) addResultToProfile(awayId, false, awayWon, isDraw, homeId, homeName, ag - hg, wxCond);

      // WOWY update — if lineups were captured for this fixture, record player outcomes
      try {
        const lineups = getLineups();
        const fixLineup = lineups[String(fid)];
        if (fixLineup) {
          const homeResult = homeWon ? 'win' : isDraw ? 'draw' : 'loss';
          const awayResult = awayWon ? 'win' : isDraw ? 'draw' : 'loss';
          if (fixLineup.home?.starters?.length && homeId) {
            updateWOWY(homeId, fixLineup.home.starters, fixLineup.home.substitutes || [], homeResult);
          }
          if (fixLineup.away?.starters?.length && awayId) {
            updateWOWY(awayId, fixLineup.away.starters, fixLineup.away.substitutes || [], awayResult);
          }
        }
      } catch {}

    } catch (e) { console.error(`[Resolve] error ${fid}: ${e.message}`); }
  }

  if (betsChanged) saveBets(bets);
  if (calChanged)  saveCalibration(cal);

  // Fix 8 — Phase 2 readiness check: 50+ resolved calibration entries with lineup data
  const resolvedCal = getCalibration().filter(c => c.resolved);
  if (resolvedCal.length >= 50) {
    const meta = readJSON('scan-meta.json') || {};
    if (!meta.phase2Ready) {
      writeJSON('scan-meta.json', { ...meta, phase2Ready: true, phase2ReadyAt: new Date().toISOString() });
      console.log('[Phase2] Threshold reached — 50+ resolved calibration entries. Model is ready for Phase 2.');
    }
  }
}

// ─── SCHEDULER ───────────────────────────────────────────────────────────────

// ─── CLOSING ODDS FETCH FOR A SINGLE BET (T-5 CLV) ──────────────────────────
// Returns { closingOdds, bookmaker, snapshotTs } or { closingOdds: null }.
// Uses the same Odds API historical endpoint as the backfill.
async function fetchClosingOddsForBet(bet) {
  const sport = CLOSING_ODDS_SPORT_MAP[String(bet.leagueId)];
  if (!sport) return { closingOdds: null, bookmaker: null, snapshotTs: null };

  // The Odds API's historical endpoint rejects a milliseconds-precision timestamp
  // with 422 INVALID_HISTORICAL_TIMESTAMP — exact-second precision only.
  const kickoffIso = new Date(bet.kickoff).toISOString().split('.')[0] + 'Z';
  try {
    const resp = await oddsApi.get(`/historical/sports/${sport}/odds`, {
      params: { apiKey: ODDS_API_KEY, regions: 'uk,eu', markets: 'h2h',
                oddsFormat: 'decimal', date: kickoffIso },
    });
    const events = resp.data?.data || resp.data || [];
    const [home, away] = (bet.fixture || '').split(' vs ');
    const ev = events.find(e => teamsMatch(e.home_team, home) && teamsMatch(e.away_team, away));
    if (!ev) return { closingOdds: null, bookmaker: null, snapshotTs: null };

    // Prefer Pinnacle; no fallback — spec requires Pinnacle or null
    const bm = ev.bookmakers?.find(b => b.key === 'pinnacle');
    if (!bm) return { closingOdds: null, bookmaker: null, snapshotTs: null };

    const mkt = bm.markets?.find(m => m.key === 'h2h');
    if (!mkt) return { closingOdds: null, bookmaker: null, snapshotTs: null };

    // Validate snapshot is within 15 minutes of kickoff
    const snapTs  = bm.last_update || kickoffIso;
    const ageMins = Math.abs(new Date(kickoffIso) - new Date(snapTs)) / 60000;
    if (ageMins > 15) return { closingOdds: null, bookmaker: null, snapshotTs: snapTs };

    const get = name => mkt.outcomes?.find(o => teamsMatch(o.name, name))?.price ?? null;
    let closingOdds = null;
    if (bet.bet === 'Home Win') closingOdds = get(home);
    else if (bet.bet === 'Away Win') closingOdds = get(away);
    else closingOdds = get('Draw');

    return { closingOdds, bookmaker: bm.key, snapshotTs: snapTs };
  } catch (e) {
    console.error(`[CLV:fetch] ${bet.fixture}: ${e.message}`);
    return { closingOdds: null, bookmaker: null, snapshotTs: null };
  }
}

const _cronRunning = { backfill: false, morningScan: false, preMatch: false, resolve: false, clv: false };
const _cronLastRan = { backfill: null,  morningScan: null,  resolve: null };

function setupScheduler() {
  // 1. 00:05 UTC — nightly backfill chain
  cron.schedule('5 0 * * *', async () => {
    if (isRateLimited()) { console.log('[Cron:Backfill] Skipped — rate limited'); return; }
    if (_cronRunning.backfill) { console.log('[Cron:Backfill] Skipped — already running'); return; }
    _cronRunning.backfill = true;
    const t0 = Date.now();
    console.log('[Cron:Backfill] 00:05 UTC — starting nightly backfill chain');
    try {
      await runBackfillChain();
      console.log(`[Cron:Backfill] Complete in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      console.error(`[Cron:Backfill] Error: ${e.message}`);
    } finally {
      _cronRunning.backfill = false;
      _cronLastRan.backfill = new Date().toISOString();
    }
  }, { timezone: 'UTC' });

  // 2. 07:00 UTC — morning scan
  cron.schedule('0 7 * * *', async () => {
    if (isRateLimited()) { console.log('[Cron:MorningScan] Skipped — rate limited'); return; }
    if (_cronRunning.morningScan) { console.log('[Cron:MorningScan] Skipped — already running'); return; }
    _cronRunning.morningScan = true;
    const t0 = Date.now();
    console.log('[Cron:MorningScan] 07:00 UTC — starting morning scan');
    try {
      const leagues = getSettings().activeLeagues || ['1','39','140','78','135','61','2'];
      await runMorningScan(leagues);
      console.log(`[Cron:MorningScan] Complete in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      console.error(`[Cron:MorningScan] Error: ${e.message}`);
    } finally {
      _cronRunning.morningScan = false;
      _cronLastRan.morningScan = new Date().toISOString();
    }
  }, { timezone: 'UTC' });

  // 2b. Monday 06:00 UTC (before the morning scan) — weekly EV calibration refresh.
  // Keeps ev-calibration.json fresh for canGoLive() and getEvKellyFraction() (real-money
  // Kelly sizing), which otherwise only refresh when someone manually hits /api/ev-calibration.
  cron.schedule('0 6 * * 1', () => {
    try {
      runEvCalibration();
      console.log('[Cron:EVCalib] Weekly EV calibration refresh complete.');
    } catch (e) {
      console.error(`[Cron:EVCalib] Error: ${e.message}`);
    }
  }, { timezone: 'UTC' });

  // 3. Every minute — T-60 pre-match locks (±15 min random variation per fixture)
  cron.schedule('* * * * *', async () => {
    if (isRateLimited() || _cronRunning.preMatch) return;
    const watching = getWatching();
    const now = Date.now();
    // Assign a stable per-fixture daily offset (seeded by fixtureId + today's date)
    const today = new Date().toISOString().slice(0, 10);
    const getOffset = w => {
      if (w._lockOffset != null) return w._lockOffset;
      // Deterministic-ish: hash fixtureId + date into ±15 range
      const seed = (String(w.id || w.fixtureId || '') + today).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
      return (seed % 31) - 15; // -15 to +15 minutes
    };
    // Lock window: T-(60+offset) to T-(55+offset) — fires for 5 consecutive minutes
    const toScan = watching.filter(w => {
      const m = (new Date(w.kickoff).getTime() - now) / 60000;
      const off = getOffset(w);
      return m <= (60 + off) && m > (55 + off);
    });
    const locked = watching.filter(w => (new Date(w.kickoff).getTime() - now) / 60000 > (55 + getOffset(w)));
    if (!toScan.length) return;
    _cronRunning.preMatch = true;
    console.log(`[Cron:PreMatch] ${toScan.length} fixture(s) entering pre-match lock (T-60 ±15 min variation)`);
    try {
      await Promise.all(toScan.map(w => runPreMatchScan(w)));
      saveWatching(locked);
    } catch (e) {
      console.error(`[Cron:PreMatch] Error: ${e.message}`);
    } finally {
      _cronRunning.preMatch = false;
    }
  });

  // 4. Every 5 minutes — auto-resolve finished matches
  cron.schedule('*/5 * * * *', async () => {
    if (isRateLimited() || _cronRunning.resolve) return;
    _cronRunning.resolve = true;
    // Expire past-kickoff watching entries (catches entries that survive server restarts)
    const nowMs2 = Date.now();
    const rawW = getWatching();
    const futureW = rawW.filter(w => new Date(w.kickoff).getTime() > nowMs2);
    if (futureW.length < rawW.length) {
      saveWatching(futureW, { allowEmpty: true });
      console.log(`[Cron:Resolve] Expired ${rawW.length - futureW.length} past-kickoff watching entries`);
    }
    try {
      await checkAndResolve();
    } catch (e) {
      console.error(`[Cron:Resolve] Error: ${e.message}`);
    } finally {
      _cronRunning.resolve = false;
      _cronLastRan.resolve = new Date().toISOString();
    }
  });

  // 5. Every minute — T-5 closing odds + CLV for placed bets
  cron.schedule('* * * * *', async () => {
    if (isRateLimited() || _cronRunning.clv) return;
    const bets = getBets();
    const now  = Date.now();
    // Target: placed bets within 0–10 min of kickoff that haven't had CLV fetched yet
    const toFetch = bets.filter(b =>
      b.stage === 'RECOMMENDED' &&
      (b.placementStatus === 'placed' || b.placementConfirmed) &&
      b.closingOdds === undefined &&
      b.kickoff &&
      (() => { const m = (new Date(b.kickoff).getTime() - now) / 60000; return m >= -2 && m <= 8; })()
    );
    if (!toFetch.length) return;
    _cronRunning.clv = true;
    console.log(`[Cron:CLV] ${toFetch.length} bet(s) in T-5 window — fetching closing odds`);
    try {
      let changed = false;
      for (const bet of toFetch) {
        try {
          const result = await fetchClosingOddsForBet(bet);
          const fresh  = bets.find(b => b.id === bet.id);
          if (!fresh) continue;
          fresh.closingOdds          = result.closingOdds;
          fresh.closingOddsBookmaker = result.bookmaker;
          fresh.closingOddsAt        = result.snapshotTs;
          if (result.closingOdds != null && fresh.actualOdds != null) {
            fresh.clv = parseFloat((((fresh.actualOdds - result.closingOdds) / result.closingOdds) * 100).toFixed(2));
            console.log(`[CLV] ${fresh.fixture} — ${fresh.bet} — entry ${fresh.actualOdds}, closing ${result.closingOdds}, CLV ${fresh.clv >= 0 ? '+' : ''}${fresh.clv}%`);
          } else {
            fresh.clv = null;
            console.log(`[CLV] ${fresh.fixture} — ${fresh.bet} — no Pinnacle closing odds available`);
          }
          changed = true;
        } catch (e) {
          console.error(`[CLV] ${bet.fixture}: ${e.message}`);
        }
      }
      if (changed) saveBets(bets);
    } catch (e) {
      console.error(`[Cron:CLV] Error: ${e.message}`);
    } finally {
      _cronRunning.clv = false;
    }
  });

  console.log('[Scheduler] Crons active: backfill@00:05UTC · evCalib@Mon06:00UTC · scan@07:00UTC · T-60@every-min · resolve@every-5min · CLV@every-min');
}

// ─── PROFILE BACKFILL ────────────────────────────────────────────────────────

async function runProfileBackfill(onProgress) {
  const allFixtures = new Map(); // fixtureId → fixture (deduped across all fetches)
  const results = [];
  let apiCalls = 0;

  for (const entry of BACKFILL_CONFIG) {
    for (const season of entry.seasons) {
      try {
        const { data } = await apiSports.get('/fixtures', {
          params: { league: entry.leagueId, season, status: 'FT' },
        });
        apiCalls++;
        const raw      = data?.response || [];
        const fixtures = raw.filter(f =>
          ['FT', 'AET', 'PEN'].includes(f.fixture?.status?.short)
        );
        fixtures.forEach(f => allFixtures.set(f.fixture?.id, f));
        const msg = `[Backfill] ${entry.name} ${season}: ${fixtures.length}/${raw.length} FT fixtures (total deduped: ${allFixtures.size}) errors:${JSON.stringify(data?.errors||[])}`;
        console.log(msg);
        results.push({ league: entry.name, season, count: fixtures.length, raw: raw.length });
        if (onProgress) onProgress(msg);
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        const msg = `[Backfill] SKIP ${entry.name} ${season}: ${e.message}`;
        console.warn(msg);
        results.push({ league: entry.name, season, count: 0, error: e.message });
      }
    }
  }

  const allArr    = [...allFixtures.values()];
  const built     = updateTeamProfiles(allArr);
  const summary   = { apiCalls, totalFixtures: allFixtures.size, profilesBuilt: built, breakdown: results };
  console.log(`[Backfill] Done — ${allFixtures.size} fixtures → ${built} profiles`);
  return summary;
}

// ─── HISTORICAL BACKFILL ──────────────────────────────────────────────────────
// Fetches 3 seasons of completed fixtures per league, computes factor scores
// for every match using the pool as each team's form history, runs gradient
// descent weight optimisation (per context) every OPTIMISE_EVERY records.
// Persists raw fixtures + scored records to data/backfill-historical.json so
// re-runs only fetch missing league/season pairs.

// Domestic + Champions League extended to 2010 and Europa League to 2014 (2026-08-07):
// confirmed available via API-Sports' /leagues endpoint (season-depth check this week)
// and confirmed NOT to unlock any additional Odds API matching (their historical
// archive hard-floors at 2020-06-06 — verified via /historical/.../odds' own
// previous_timestamp/next_timestamp pointers returning null/2020-06-06 for six probed
// pre-2020 dates across two leagues). This grows the pure-calibration population only;
// it does not touch or require redoing any of the four validated leagues' train/test
// splits (PL/Ligue1/CL/Serie A) — those splits are defined by a testFrom date only,
// and every fixture added here is older than every one of those testFrom dates, so it
// can only enlarge the train side, never touch test. See docs/tier-calibration-analysis.md.
const HIST_SEASONS_2010 = [2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015, 2014, 2013, 2012, 2011, 2010];
const HIST_SEASONS_EUROPA_2014 = [2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015, 2014];
const HISTORICAL_BACKFILL_CONFIG = [
  { leagueId: '39',  name: 'Premier League',   seasons: HIST_SEASONS_2010 },
  { leagueId: '140', name: 'La Liga',           seasons: HIST_SEASONS_2010 },
  { leagueId: '135', name: 'Serie A',           seasons: HIST_SEASONS_2010 },
  { leagueId: '78',  name: 'Bundesliga',        seasons: HIST_SEASONS_2010 },
  { leagueId: '61',  name: 'Ligue 1',           seasons: HIST_SEASONS_2010 },
  { leagueId: '2',   name: 'Champions League',  seasons: HIST_SEASONS_2010 },
  { leagueId: '32',  name: 'WC Qual UEFA',      seasons: [2024, 2020] },
  { leagueId: '34',  name: 'WC Qual CONMEBOL',  seasons: [2026, 2022] },
  { leagueId: '31',  name: 'WC Qual CONCACAF',  seasons: [2026, 2022] },
  { leagueId: '5',   name: 'Nations League',    seasons: [2024, 2022] },
  { leagueId: '10',  name: 'Intl Friendlies',   seasons: [2024, 2023, 2022] },
  // New leagues — added July 2026. 2026 added here: these three leagues score live
  // fixtures against season 2026 (see LEAGUES config) but the historical config only
  // ever listed seasons through 2024, so the active season was never fetched at all —
  // not a caching-skip problem, a missing-season-entry problem.
  { leagueId: '179', name: 'Scottish Premiership', seasons: [2026, ...HIST_SEASONS_2010] },
  { leagueId: '88',  name: 'Eredivisie',            seasons: [2026, ...HIST_SEASONS_2010] },
  { leagueId: '94',  name: 'Primeira Liga',         seasons: [2026, ...HIST_SEASONS_2010] },
  { leagueId: '3',   name: 'Europa League',         seasons: HIST_SEASONS_EUROPA_2014 },
  // Conference League: UEFA competition only existed from the 2021-22 season —
  // API-Sports' own /leagues data confirms 2021 is the earliest season it has, so
  // there is no deeper archive to extend into here (checked, not assumed).
  { leagueId: '848', name: 'Conference League',     seasons: [2024, 2023, 2022, 2021] },
];

const OPTIMISE_EVERY = 500; // run weight optimisation after every N scored records

// Strip a raw API-Sports fixture down to fields needed for profiling + factor scoring.
function stripFixture(f) {
  return {
    fixture: { id: f.fixture.id, date: f.fixture.date, status: { short: f.fixture.status.short } },
    teams:   { home: { id: f.teams.home.id, name: f.teams.home.name },
               away: { id: f.teams.away.id, name: f.teams.away.name } },
    goals:   { home: f.goals.home, away: f.goals.away },
    score:   { fulltime: f.score?.fulltime || {} },
    league:  { id: f.league.id, name: f.league.name, season: f.league.season },
  };
}

let _historicalBackfillRunning = false;
let _historicalBackfillStatus  = null; // in-progress status for polling

async function runHistoricalBackfill({ rescore = false, onProgress } = {}) {
  if (_historicalBackfillRunning) return { error: 'already_running' };
  _historicalBackfillRunning = true;
  _historicalBackfillStatus  = { phase: 'fetching', leaguesDone: 0, totalLeagues: 0, fixturesFetched: 0, scored: 0, startedAt: new Date().toISOString() };

  try {
    // Load persisted data
    const existing = readJSON('backfill-historical.json') || {
      fetchedLeagues: {},
      fixtures:       [],
      scoredRecords:  [],
      optimisedWeights: null,
      accuracy:         null,
    };
    const previousScoredCount = existing.scoredRecords.length;

    // Detect corrupt state: league cache says fetched but fixture pool is empty.
    // This happens when the process is killed mid-write and JSON is truncated.
    // Clear the fetch cache so Phase 1 re-fetches everything from the API.
    if (existing.fixtures.length === 0 && Object.keys(existing.fetchedLeagues || {}).length > 0) {
      console.log('[HistoricalBackfill] Detected empty fixtures with stale fetch cache — clearing cache to force re-fetch');
      existing.fetchedLeagues = {};
      existing.scoredRecords  = [];
    }

    if (rescore) {
      existing.scoredRecords  = [];
      existing.optimisedWeights = null;
      existing.accuracy         = null;
      console.log('[HistoricalBackfill] rescore=true — cleared scored records, will re-score all fixtures');
    }

    const fixtureMap = new Map(existing.fixtures.map(f => [f.fixture?.id, f]));
    const scoredMap  = new Map(existing.scoredRecords.map(r => [r.fixtureId, r]));
    let   newCount   = 0;

    const allCombos = HISTORICAL_BACKFILL_CONFIG.flatMap(e => e.seasons.map(s => ({ ...e, season: s })));
    _historicalBackfillStatus.totalLeagues = allCombos.length;

    // ── Phase 1: Fetch missing league/season pairs, always refresh the active season ──
    // A season/league pair is cached forever once fetched — fine for completed past
    // seasons, but it means an active season's new results (e.g. today's fixtures) never
    // get added. Force a re-fetch for the current and previous season so new results
    // keep flowing in; older, genuinely-finished seasons stay skip-cached as before.
    const currentSeason = new Date().getFullYear();
    for (const entry of allCombos) {
      const key = `${entry.leagueId}_${entry.season}`;
      const isActiveSeason = entry.season >= currentSeason - 1;
      if (existing.fetchedLeagues[key] && !isActiveSeason) {
        const msg = `[Skip] ${entry.name} ${entry.season} (${existing.fetchedLeagues[key].count} cached)`;
        console.log(msg); onProgress?.(msg);
      } else {
        if (isActiveSeason) {
          const msg = `[Fetch] ${entry.name} ${entry.season} — active season, refreshing`;
          console.log(msg); onProgress?.(msg);
        }
        try {
          // status=FT returns all completed fixtures for a league/season in a single
          // response — no page parameter needed or supported on this endpoint.
          const { data } = await apiSports.get('/fixtures', {
            params: { league: entry.leagueId, season: entry.season, status: 'FT' },
          });

          // Detect rate limit — treat as a hard stop so the fetch cache isn't marked
          // complete and the next startup will retry rather than silently skip.
          if (data?.errors?.requests) {
            const msg = `[RateLimit] API daily limit reached — stopping Phase 1. Will resume on next startup.`;
            console.warn(msg); onProgress?.(msg);
            setRateLimited();
            // Only flush if we fetched something new — if fixtureMap is empty we have nothing
            // to write, and flushing would overwrite a valid on-disk file with an empty array.
            if (fixtureMap.size > 0) {
              existing.fixtures = [...fixtureMap.values()];
              const histPath = path.join(DATA_DIR, 'backfill-historical.json');
              const histTmp  = histPath + '.tmp';
              fs.writeFileSync(histTmp, JSON.stringify(existing));
              fs.renameSync(histTmp, histPath);
            }
            break; // stop processing further leagues
          }

          const raw      = data?.response || [];
          const fixtures = raw.filter(f => ['FT','AET','PEN'].includes(f.fixture?.status?.short));
          fixtures.forEach(f => { fixtureMap.set(f.fixture.id, stripFixture(f)); });
          newCount += fixtures.length;
          existing.fetchedLeagues[key] = { count: fixtures.length, fetchedAt: new Date().toISOString() };

          // Incremental save after each league — a kill now loses at most one league's data
          existing.fixtures = [...fixtureMap.values()];
          const histPath = path.join(DATA_DIR, 'backfill-historical.json');
          const histTmp  = histPath + '.tmp';
          fs.writeFileSync(histTmp, JSON.stringify(existing));
          fs.renameSync(histTmp, histPath);

          const msg = `[Fetch] ${entry.name} ${entry.season}: ${fixtures.length} fixtures (pool: ${fixtureMap.size})`;
          console.log(msg); onProgress?.(msg);
          await new Promise(r => setTimeout(r, 350));
        } catch (e) {
          const msg = `[Error] ${entry.name} ${entry.season}: ${e.message}`;
          console.warn(msg); onProgress?.(msg);
        }
      }
      _historicalBackfillStatus.leaguesDone++;
      _historicalBackfillStatus.fixturesFetched = fixtureMap.size;
    }

    // ── Phase 2: Score new fixtures (or re-score if cached records were cleared) ──
    const unscoredCount = [...fixtureMap.values()].filter(f => !scoredMap.has(f.fixture?.id)).length;
    if (newCount > 0 || unscoredCount > 0) {
      _historicalBackfillStatus.phase = 'scoring';
      const allFixtures    = [...fixtureMap.values()];
      const teamIndex      = buildTeamIndex(allFixtures);
      const standingsIndex = buildStandingsIndex(allFixtures);
      let   scored         = 0;
      let   nextOptimiseAt = Math.ceil(scoredMap.size / OPTIMISE_EVERY) * OPTIMISE_EVERY;
      if (nextOptimiseAt <= scoredMap.size) nextOptimiseAt += OPTIMISE_EVERY;

      for (const fix of allFixtures) {
        if (scoredMap.has(fix.fixture?.id)) continue;
        // One malformed fixture (e.g. from an older season with unexpected API shape)
        // must not silently kill the whole batch — isolate per-fixture so a single bad
        // record is skipped and logged rather than aborting everything after it.
        let record;
        try {
          record = scoreFixtureFromPool(fix, teamIndex, standingsIndex);
        } catch (e) {
          console.error(`[HistoricalBackfill] scoreFixtureFromPool failed for fixture ${fix.fixture?.id} (${fix.league?.id}/${fix.league?.season}): ${e.message}`);
          continue;
        }
        if (record) {
          scoredMap.set(record.fixtureId, record);
          scored++;
        }

        // Incremental optimisation + persistence checkpoint. Scoring has no per-record
        // save unlike Phase 1's per-league fetch writes — on a large catch-up run (e.g.
        // extending HISTORICAL_BACKFILL_CONFIG to cover many more seasons at once) a
        // process restart mid-scoring previously lost 100% of that run's scoring
        // progress, since only Phase 4 persisted scoredRecords. Saving here too means a
        // restart loses at most one checkpoint's worth of scoring, matching Phase 1's
        // resilience.
        if (scoredMap.size >= nextOptimiseAt && scoredMap.size >= OPTIMISE_EVERY) {
          const msg = `[Optimise] Checkpoint at ${scoredMap.size} records — running optimisation…`;
          console.log(msg); onProgress?.(msg);
          _runOptimisation([...scoredMap.values()], existing, onProgress);
          existing.scoredRecords = [...scoredMap.values()];
          existing.scoredCount   = scoredMap.size;
          const histPath = path.join(DATA_DIR, 'backfill-historical.json');
          const histTmp  = histPath + '.tmp';
          fs.writeFileSync(histTmp, JSON.stringify(existing));
          fs.renameSync(histTmp, histPath);
          nextOptimiseAt += OPTIMISE_EVERY;
        }
      }

      const msg = `[Score] ${scored} fixtures scored (total: ${scoredMap.size})`;
      console.log(msg); onProgress?.(msg);
      _historicalBackfillStatus.scored = scoredMap.size;
    }

    // ── Phase 3: Final weight optimisation ─────────────────────────────────
    const allRecords = [...scoredMap.values()];
    if (allRecords.length >= OPTIMISE_EVERY) {
      _historicalBackfillStatus.phase = 'optimising';
      const msg = `[Optimise] Final pass on ${allRecords.length} records…`;
      console.log(msg); onProgress?.(msg);
      _runOptimisation(allRecords, existing, onProgress);
    }

    // ── Phase 4: Persist ───────────────────────────────────────────────────
    existing.fixtures      = [...fixtureMap.values()];
    existing.scoredRecords = allRecords;
    existing.totalFixtures = fixtureMap.size;
    existing.scoredCount   = scoredMap.size;
    existing.lastUpdated   = new Date().toISOString();
    // Atomic write — temp file then rename so a mid-write kill can't corrupt the data
    const histPath = path.join(DATA_DIR, 'backfill-historical.json');
    const histTmp  = histPath + '.tmp';
    fs.writeFileSync(histTmp, JSON.stringify(existing));
    fs.renameSync(histTmp, histPath);

    // ── Phase 5: Rebuild team profiles ─────────────────────────────────────
    const profileCount = updateTeamProfiles(existing.fixtures);
    const msg2 = `[Profiles] Rebuilt ${profileCount} profiles from ${existing.totalFixtures} fixtures`;
    console.log(msg2); onProgress?.(msg2);

    const summary = {
      totalFixtures:    fixtureMap.size,
      scoredCount:      scoredMap.size,
      newFixtures:      newCount,
      profilesBuilt:    profileCount,
      optimisedWeights: existing.optimisedWeights,
      accuracy:         existing.accuracy,
      completedAt:      new Date().toISOString(),
    };
    writeJSON('backfill-historical-meta.json', summary);
    _historicalBackfillStatus = { ...summary, phase: 'complete' };
    console.log(`[HistoricalBackfill] Done — ${summary.totalFixtures} fixtures, ${summary.scoredCount} scored, ${profileCount} profiles`);
    checkAndRetrain(previousScoredCount, scoredMap.size);
    return summary;

  } catch (e) {
    console.error('[HistoricalBackfill] Fatal:', e.message);
    _historicalBackfillStatus = { phase: 'error', error: e.message };
    writeJSON('backfill-historical-meta.json', { error: e.message, completedAt: new Date().toISOString() });
    throw e;
  } finally {
    _historicalBackfillRunning = false;
  }
}

function checkAndRetrain(previousCount, newCount) {
  const prevBucket = Math.floor(previousCount / RETRAIN_THRESHOLD);
  const newBucket  = Math.floor(newCount      / RETRAIN_THRESHOLD);
  if (newBucket <= prevBucket) return;
  console.log(`[GBDT] Retrain threshold crossed (${previousCount} → ${newCount}) — starting retraining`);
  try {
    const { execSync } = require('child_process');
    execSync('node scripts/gbdt-train.js', {
      cwd:     __dirname,
      env:     { ...process.env, DATA_DIR: process.env.DATA_DIR },
      timeout: 300000,
      stdio:   'inherit',
    });
    console.log('[GBDT] Retraining complete — reloading model weights');
    // Clear the require cache so interface.js re-evaluates on next predict()
    const iface = path.join(__dirname, 'models/interface.js');
    const gbdt  = path.join(__dirname, 'models/gbdt.js');
    delete require.cache[require.resolve(iface)];
    delete require.cache[require.resolve(gbdt)];
  } catch (e) {
    console.error('[GBDT] Retraining failed:', e.message);
  }
}

// Run weight optimisation for all three contexts and mutate `existing` in place.
function _runOptimisation(records, existing, onProgress) {
  const optimisedWeights = existing.optimisedWeights || {};
  const accuracy         = existing.accuracy         || {};

  for (const ctx of ['club_domestic', 'club_european', 'international']) {
    const ctxRecords = records.filter(r => r.context === ctx);
    if (ctxRecords.length < 50) continue;
    const result = optimiseModelWeights(records, ctx);
    optimisedWeights[ctx] = result.weights;
    accuracy[ctx] = {
      accuracy:         result.accuracy,
      baseline:         result.baselineAccuracy,
      loss:             result.finalLoss,
      improvement:      result.improvement,
      count:            result.recordCount,
      optimisedAt:      new Date().toISOString(),
    };
    const msg = `[Optimise] ${ctx}: ${result.recordCount} records · accuracy ${(result.accuracy*100).toFixed(1)}% (baseline ${(result.baselineAccuracy*100).toFixed(1)}%, Δ${result.improvement >= 0 ? '+' : ''}${result.improvement}pp)`;
    console.log(msg); onProgress?.(msg);
  }

  existing.optimisedWeights = optimisedWeights;
  existing.accuracy         = accuracy;
  existing.lastOptimisedAt  = new Date().toISOString();
}

// ─── EXPRESS APP ─────────────────────────────────────────────────────────────

app.use(cors({
  origin: ['https://henry-brown123.github.io', /\.onrender\.com$/, /localhost/],
  optionsSuccessStatus: 200,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Auth ───────────────────────────────────────────────────────────────────────
// Render terminates TLS in front of the app; trust proxy so express-session sees
// the forwarded HTTPS and only marks the cookie Secure when actually in production.
app.set('trust proxy', 1);

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Edge Scout — Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0a0a0f;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #1a1a24;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 40px;
      width: 100%;
      max-width: 380px;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 32px;
    }
    .logo-icon {
      width: 32px; height: 32px;
      background: linear-gradient(135deg, #4cc9f0, #f72585);
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 16px;
    }
    .logo-text { font-size: 20px; font-weight: 700; }
    label {
      display: block;
      font-size: 11px;
      letter-spacing: 2px;
      color: rgba(255,255,255,0.4);
      margin-bottom: 8px;
      text-transform: uppercase;
    }
    input[type=password] {
      width: 100%;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      padding: 12px 16px;
      color: #fff;
      font-size: 14px;
      outline: none;
      margin-bottom: 16px;
    }
    input[type=password]:focus {
      border-color: #4cc9f0;
    }
    button {
      width: 100%;
      background: #4cc9f0;
      color: #0a0a0f;
      border: none;
      border-radius: 8px;
      padding: 12px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #38b6dc; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-icon">⚡</div>
      <div class="logo-text">Edge Scout</div>
    </div>
    <form method="POST" action="/login">
      <label>Password</label>
      <input type="password" name="password" placeholder="Enter password" autofocus>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;

function requireAuth(req, res, next) {
  // Allow health check
  if (req.path === '/health') return next();

  // Allow login routes
  if (req.path === '/login') return next();

  // Allow API key auth for programmatic access
  const apiKey = req.headers['x-api-key'];
  if (INTERNAL_API_KEY && apiKey && timingSafeEqual(apiKey, INTERNAL_API_KEY)) {
    return next();
  }

  // Check session for browser requests
  if (req.session?.authenticated) return next();

  // API requests return 401
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  // Browser requests redirect to login
  return res.redirect('/login');
}

app.use(requireAuth);

// GET /login — serve login page
app.get('/login', (req, res) => {
  if (req.session?.authenticated) return res.redirect('/');
  res.send(LOGIN_PAGE_HTML);
});

// POST /login — handle password submission
app.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (APP_PASSWORD && timingSafeEqual(password, APP_PASSWORD)) {
    req.session.authenticated = true;
    return res.redirect('/');
  }
  res.send(LOGIN_PAGE_HTML.replace('</form>',
    '<p style="color:#f72585;margin-top:8px">Incorrect password</p></form>'));
});

// POST /logout
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ── API-Sports proxy ──────────────────────────────────────────────────────────

const apiSportsProxy = async (endpoint, req, res) => {
  try {
    const { data } = await apiSports.get(endpoint, { params: req.query });
    res.json(data);
  } catch (e) { res.status(e.response?.status || 500).json({ error: e.message }); }
};

app.get('/api/fixtures',              (q,r) => apiSportsProxy('/fixtures', q, r));
app.get('/api/fixtures/statistics',   (q,r) => apiSportsProxy('/fixtures/statistics', q, r));
app.get('/api/standings',             (q,r) => apiSportsProxy('/standings', q, r));
app.get('/api/teams/statistics',      (q,r) => apiSportsProxy('/teams/statistics', q, r));
app.get('/api/predictions',           (q,r) => apiSportsProxy('/predictions', q, r));
app.get('/api/injuries',              (q,r) => apiSportsProxy('/injuries', q, r));
app.get('/api/head-to-head',          (q,r) => apiSportsProxy('/fixtures/headtohead', q, r));
app.get('/api/leagues',               (q,r) => apiSportsProxy('/leagues', q, r));
app.get('/api/status', async (_req, res) => {
  try { const { data } = await apiSports.get('/status'); res.json(data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Odds API proxy ────────────────────────────────────────────────────────────

app.get('/api/odds/sports', async (req, res) => {
  try { const { data } = await oddsApi.get('/sports', { params: { ...req.query, apiKey: ODDS_API_KEY } }); res.json(data); }
  catch (e) { res.status(e.response?.status || 500).json({ error: e.message }); }
});

app.get('/api/odds/events', async (req, res) => {
  try {
    const { sport, ...rest } = req.query;
    const { data, headers } = await oddsApi.get(`/sports/${sport}/odds`, {
      params: { ...rest, apiKey: ODDS_API_KEY, regions: 'uk,eu', markets: 'h2h', oddsFormat: 'decimal' },
    });
    res.set('X-Requests-Remaining', headers['x-requests-remaining'] || '');
    res.json(data);
  } catch (e) { res.status(e.response?.status || 500).json({ error: e.message }); }
});

// ── App state API ─────────────────────────────────────────────────────────────

// GET divergence report — fixtures where model and market disagree by >8pp
app.get('/api/divergence-report', (_req, res) => {
  const MIN_GAP_PP = 8;
  const cal = getCalibration();

  const rows = [];
  for (const entry of cal) {
    const candidates = entry.candidates || [];
    if (!candidates.length) continue;

    // Find top model pick
    const topModel = candidates.reduce((a, b) => a.modelProb > b.modelProb ? a : b);
    const gap = (topModel.modelProb - topModel.impliedProb) * 100;

    // Only track fixtures where model diverges from market by >8pp on the top pick
    if (Math.abs(gap) < MIN_GAP_PP) continue;

    // Determine who the market most preferred
    const topMarket = candidates.reduce((a, b) => a.impliedProb > b.impliedProb ? a : b);
    const modelHigherThanMarket = topModel.modelProb > topModel.impliedProb;

    // On resolved entries, did the model's top pick win?
    let modelWon = null;
    let marketWon = null;
    if (entry.resolved) {
      const resolveKey = entry.projectedBetKey || entry.projectedBet;
      modelWon  = entry.actualResult === resolveKey;
      marketWon = entry.actualResult === topMarket.bet;
    }

    rows.push({
      fixtureId:       entry.fixtureId,
      fixture:         entry.fixture,
      kickoff:         entry.kickoff,
      date:            (entry.kickoff || entry.scoredAt || '').slice(0, 10),
      competitionPhase: entry.competitionPhase,
      context:         entry.context,
      lowConfidence:   entry.candidates?.[0]?.lowConfidence ?? false,
      modelPick:       topModel.displayLabel || topModel.bet,
      modelPickKey:    topModel.bet,
      modelProb:       parseFloat((topModel.modelProb * 100).toFixed(1)),
      marketImplied:   parseFloat((topModel.impliedProb * 100).toFixed(1)),
      gapPP:           parseFloat(gap.toFixed(1)),
      marketTopPick:   topMarket.displayLabel || topMarket.bet,
      marketTopProb:   parseFloat((topMarket.impliedProb * 100).toFixed(1)),
      successScore:    topModel.successScore,
      resolved:        entry.resolved,
      actualResult:    entry.actualResult || null,
      modelWon,
      marketWon,
    });
  }

  rows.sort((a, b) => new Date(b.kickoff) - new Date(a.kickoff));

  // Summary stats (resolved only)
  const resolved = rows.filter(r => r.resolved);
  const modelCorrect  = resolved.filter(r => r.modelWon).length;
  const marketCorrect = resolved.filter(r => r.marketWon).length;

  const avgGap = (arr) => arr.length
    ? parseFloat((arr.reduce((s, r) => s + Math.abs(r.gapPP), 0) / arr.length).toFixed(1))
    : null;

  const summary = {
    tracked:           rows.length,
    resolved:          resolved.length,
    pending:           rows.length - resolved.length,
    modelCorrect,
    marketCorrect,
    neitherCorrect:    resolved.length - modelCorrect - marketCorrect + resolved.filter(r => r.modelWon && r.marketWon).length,
    avgGapOnModelWins: avgGap(resolved.filter(r => r.modelWon)),
    avgGapOnModelLoss: avgGap(resolved.filter(r => !r.modelWon && r.resolved)),
    modelAccuracy:     resolved.length ? parseFloat(((modelCorrect / resolved.length) * 100).toFixed(1)) : null,
  };

  res.json({ summary, rows });
});

// GET full state (bets, watching, bankroll)
app.get('/api/state', (_req, res) => {
  const scanMeta = readJSON('scan-meta.json') || {};
  const cal      = getCalibration();
  // Backfill competitionPhase on watching entries that predate the field being stored
  const watching = getWatching().map(w => {
    if (!w.competitionPhase && w.calId) {
      const ce = cal.find(c => c.id === w.calId);
      if (ce?.competitionPhase) return { ...w, competitionPhase: ce.competitionPhase };
    }
    return w;
  });
  res.json({
    bankroll:    getBankroll(),
    bets:        getBets(),
    watching,
    settings:    getSettings(),
    leagues:     LEAGUES,
    phase2Ready: !!scanMeta.phase2Ready,
  });
});

// ── Transactions helpers ───────────────────────────────────────────────────────
function getTransactions() { return readJSON('transactions.json') || []; }
function saveTransactions(txns) { writeJSON('transactions.json', txns); }
function addTransaction(type, amount, bankrollBefore, bankrollAfter, notes = '') {
  const txns = getTransactions();
  const id   = `txn_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  txns.unshift({ id, type, amount, bankrollBefore, bankrollAfter, date: new Date().toISOString(), notes });
  saveTransactions(txns);
  return txns[0];
}

// GET / PUT bankroll
app.get('/api/bankroll', (_req, res) => res.json(getBankroll()));

// Full reset: wipes bets + bankroll + watching, logs as 'reset' transaction
app.post('/api/bankroll/reset', (req, res) => {
  const amount = parseFloat(req.body?.amount) || 1000;
  const notes  = req.body?.notes  || '';
  const before = getBankroll().current;
  saveBankroll({ initial: amount });
  saveBets([]);
  saveWatching([]);
  addTransaction('reset', amount, before, amount, notes);
  res.json(getBankroll());
});

// Bankroll-only reset: does NOT touch bets/watching
app.post('/api/bankroll/reset-only', (req, res) => {
  const amount = parseFloat(req.body?.amount) || 1000;
  const notes  = req.body?.notes  || '';
  const before = getBankroll().current;
  saveBankroll({ initial: amount });
  addTransaction('reset', amount, before, amount, notes || 'Bankroll reset (bets kept)');
  res.json(getBankroll());
});

// Deposit — adds to current bankroll
app.post('/api/bankroll/deposit', (req, res) => {
  const amount = parseFloat(req.body?.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount must be positive' });
  const notes  = req.body?.notes || '';
  const before = getBankroll().current;
  const after  = parseFloat((before + amount).toFixed(2));
  const txn    = addTransaction('deposit', amount, before, after, notes);
  res.json({ bankroll: getBankroll(), transaction: txn });
});

// Withdrawal — deducts from current bankroll
app.post('/api/bankroll/withdraw', (req, res) => {
  const amount = parseFloat(req.body?.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount must be positive' });
  const before = getBankroll().current;
  if (amount > before) return res.status(400).json({ error: 'Cannot withdraw more than current bankroll' });
  const notes  = req.body?.notes || '';
  const after  = parseFloat((before - amount).toFixed(2));
  const txn = addTransaction('withdrawal', amount, before, after, notes);
  res.json({ bankroll: getBankroll(), transaction: txn });
});

// GET transactions
app.get('/api/transactions', (_req, res) => {
  const txns = getTransactions();
  // A reset that lowers the bankroll banks the difference as realized profit (counts as
  // withdrawn); a reset that raises it is a top-up (counts as deposited).
  let totalWithdrawn = txns.filter(t => t.type === 'withdrawal').reduce((s, t) => s + t.amount, 0);
  let totalDeposited = txns.filter(t => t.type === 'deposit').reduce((s, t) => s + t.amount, 0);
  for (const t of txns.filter(t => t.type === 'reset')) {
    const delta = t.bankrollBefore - t.bankrollAfter;
    if (delta > 0) totalWithdrawn += delta;
    else if (delta < 0) totalDeposited += -delta;
  }
  res.json({
    transactions: txns,
    totalWithdrawn: parseFloat(totalWithdrawn.toFixed(2)),
    totalDeposited: parseFloat(totalDeposited.toFixed(2)),
    netWithdrawn:   parseFloat((totalWithdrawn - totalDeposited).toFixed(2)),
  });
});

// GET settings / PUT settings
app.get('/api/settings', (_req, res) => res.json(getSettings()));
app.put('/api/settings', (req, res) => {
  const current  = getSettings();
  const updated  = { ...current, ...req.body };
  writeJSON('settings.json', updated);
  res.json(updated);
});

// GET bets
app.get('/api/bets',        (_req, res) => res.json(getBets()));
app.get('/api/calibration', (_req, res) => res.json(getCalibration()));
app.get('/api/scan-meta',   (_req, res) => res.json(readJSON('scan-meta.json') || {}));

// Model info — forces GBDT weights to load so startup log lines appear in Render logs.
app.get('/api/model-info', (_req, res) => {
  const fs = require('fs'), path = require('path');
  const weightsPath = path.join(__dirname, 'models/gbdt-weights.json');
  const hasWeights  = fs.existsSync(weightsPath);
  let meta = null;
  if (hasWeights) {
    try { meta = JSON.parse(fs.readFileSync(weightsPath, 'utf8')); } catch {}
  }
  // Invoke predict with a synthetic fixture to force model initialisation
  const testProbs = model.predict(
    { form:65, homeAdv:60, xg:62, h2h:50, defense:60, momentum:65, injuries:75, standings:58 },
    { form:55, homeAdv:50, xg:55, h2h:50, defense:55, momentum:55, injuries:75, standings:52 },
    null, 'club_domestic', null
  );
  res.json({
    active:      hasWeights ? 'gbdt' : 'linear',
    description: hasWeights ? 'GBDT + Platt scaling' : 'Linear weighted sum',
    trainedAt:   meta?.trainedAt ?? null,
    trainN:      meta?.trainN ?? null,
    testN:       meta?.testN ?? null,
    metrics:     meta?.metrics ?? null,
    hyperparams: meta?.hyperparams ?? null,
    testPredict: { home: +testProbs.home.toFixed(4), draw: +testProbs.draw.toFixed(4), away: +testProbs.away.toFixed(4) },
  });
});

// CLV report — aggregates CLV across all placed bets that have closing odds
app.get('/api/clv-report', (req, res) => {
  const bets = getBets();
  const mode   = req.query.mode || 'paper'; // 'paper' | 'real' | 'all'
  const fromTs = req.query.from ? new Date(req.query.from).getTime() : null;
  const toTs   = req.query.to   ? new Date(req.query.to).getTime()   : null;
  // All placed bets where CLV has been computed (closingOdds fetched, not necessarily resolved)
  const withClv = bets.filter(b => {
    if (mode === 'paper' && b.mode === 'real') return false;
    if (mode === 'real'  && b.mode !== 'real') return false;
    if (!((b.placementStatus === 'placed' || b.placementConfirmed) && b.clv != null)) return false;
    if (fromTs || toTs) {
      const t = new Date(b.lockedAt || b.placedAt || 0).getTime();
      if (fromTs && t < fromTs) return false;
      if (toTs   && t > toTs)   return false;
    }
    return true;
  });

  const avgClv     = withClv.length ? withClv.reduce((s, b) => s + b.clv, 0) / withClv.length : null;
  const last10     = withClv.slice(0, 10);
  const avgLast10  = last10.length ? last10.reduce((s, b) => s + b.clv, 0) / last10.length : null;

  // CLV distribution buckets: <-5, -5 to 0, 0 to 3, 3 to 7, 7 to 15, >15
  const buckets = [
    { label: '< −5%',   min: -Infinity, max: -5,       count: 0 },
    { label: '−5 to 0', min: -5,        max: 0,        count: 0 },
    { label: '0 to +3', min: 0,         max: 3,        count: 0 },
    { label: '+3 to +7',min: 3,         max: 7,        count: 0 },
    { label: '+7 to +15',min: 7,        max: 15,       count: 0 },
    { label: '> +15%',  min: 15,        max: Infinity,  count: 0 },
  ];
  for (const b of withClv) {
    const bucket = buckets.find(bk => b.clv >= bk.min && b.clv < bk.max);
    if (bucket) bucket.count++;
  }

  // By league
  const byLeague = {};
  for (const b of withClv) {
    const key = b.leagueName || 'Unknown';
    if (!byLeague[key]) byLeague[key] = { sum: 0, count: 0 };
    byLeague[key].sum   += b.clv;
    byLeague[key].count += 1;
  }
  const leagueBreakdown = Object.entries(byLeague)
    .map(([league, d]) => ({ league, avgClv: parseFloat((d.sum / d.count).toFixed(2)), count: d.count }))
    .sort((a, b) => b.count - a.count);

  // By score band
  const byBand = {};
  for (const b of withClv) {
    const band = b.successScore != null ? `${Math.floor(b.successScore / 10) * 10}–${Math.floor(b.successScore / 10) * 10 + 9}` : 'Unknown';
    if (!byBand[band]) byBand[band] = { sum: 0, count: 0 };
    byBand[band].sum   += b.clv;
    byBand[band].count += 1;
  }
  const bandBreakdown = Object.entries(byBand)
    .map(([band, d]) => ({ band, avgClv: parseFloat((d.sum / d.count).toFixed(2)), count: d.count }))
    .sort((a, b) => a.band.localeCompare(b.band));

  // Plain-English interpretation
  let interpretation = null;
  if (avgClv != null && withClv.length >= 3) {
    if (avgClv > 3)      interpretation = { level: 'strong',   avgClv: parseFloat(avgClv.toFixed(2)), n: withClv.length, text: `Your bets have beaten the closing line by an average of +${avgClv.toFixed(1)}% — this is strong evidence of genuine edge. The market consistently moves in your direction after you bet.` };
    else if (avgClv >= 0) interpretation = { level: 'moderate', avgClv: parseFloat(avgClv.toFixed(2)), n: withClv.length, text: `Your bets have beaten the closing line by an average of +${avgClv.toFixed(1)}% — a moderate signal. Slightly beating the closing line; monitor over more bets.` };
    else                   interpretation = { level: 'warning',  avgClv: parseFloat(avgClv.toFixed(2)), n: withClv.length, text: `The market is moving against your bets on average (${avgClv.toFixed(1)}%). Review model calibration — you may be buying into market sentiment rather than beating it.` };
  } else if (withClv.length > 0 && withClv.length < 3) {
    interpretation = { level: 'insufficient', avgClv: parseFloat((avgClv || 0).toFixed(2)), n: withClv.length, text: `${withClv.length} bet${withClv.length > 1 ? 's' : ''} with CLV data — need at least 3 for a meaningful signal.` };
  }

  res.json({
    n: withClv.length,
    avgClv:     avgClv    != null ? parseFloat(avgClv.toFixed(2))    : null,
    avgLast10:  avgLast10 != null ? parseFloat(avgLast10.toFixed(2)) : null,
    buckets,
    leagueBreakdown,
    bandBreakdown,
    interpretation,
    bets: withClv.map(b => ({
      id: b.id, fixture: b.fixture, bet: b.bet, leagueName: b.leagueName,
      successScore: b.successScore, actualOdds: b.actualOdds,
      closingOdds: b.closingOdds, clv: b.clv,
      closingOddsBookmaker: b.closingOddsBookmaker, placedAt: b.placedAt,
    })),
  });
});

// Bookmaker performance — computed live from bets, not relying on bookmaker counters
app.get('/api/bookmaker-performance', (req, res) => {
  const bets  = getBets();
  const books = getBookmakers();
  const mode   = req.query.mode || 'paper'; // 'paper' | 'real' | 'all'
  const fromTs = req.query.from ? new Date(req.query.from).getTime() : null;
  const toTs   = req.query.to   ? new Date(req.query.to).getTime()   : null;

  // Only count placed bets (placed or old placementConfirmed)
  const placed = bets.filter(b => {
    if (mode === 'paper' && b.mode === 'real') return false;
    if (mode === 'real'  && b.mode !== 'real') return false;
    if (!(b.placementStatus === 'placed' || b.placementConfirmed)) return false;
    if (fromTs || toTs) {
      const t = new Date(b.lockedAt || b.placedAt || 0).getTime();
      if (fromTs && t < fromTs) return false;
      if (toTs   && t > toTs)   return false;
    }
    return true;
  });

  const byBm = {};
  for (const b of placed) {
    const key  = b.bookmakerId || '__unknown__';
    const name = b.bookmakerUsed || 'Unknown';
    if (!byBm[key]) byBm[key] = { id: key, name, bets: 0, wins: 0, losses: 0, staked: 0, pnl: 0, avgOdds: 0, oddsSum: 0 };
    const row = byBm[key];
    row.bets++;
    row.staked  = parseFloat((row.staked  + (b.actualStake  || b.suggestedStake  || 0)).toFixed(2));
    if (b.result === 'win')  { row.wins++;   row.pnl = parseFloat((row.pnl + (b.pnl || 0)).toFixed(2)); }
    if (b.result === 'loss') { row.losses++; row.pnl = parseFloat((row.pnl + (b.pnl || 0)).toFixed(2)); }
    if (b.actualOdds)        { row.oddsSum += b.actualOdds; }
  }

  const rows = Object.values(byBm).map(r => {
    const resolved = r.wins + r.losses;
    const roi      = r.staked ? parseFloat(((r.pnl / r.staked) * 100).toFixed(1)) : null;
    const winRate  = resolved ? parseFloat(((r.wins / resolved) * 100).toFixed(1)) : null;
    const avgOdds  = r.bets   ? parseFloat((r.oddsSum / r.bets).toFixed(2)) : null;
    const bmMeta   = books.find(b => b.id === r.id) || {};
    return {
      id: r.id, name: r.name,
      tier: bmMeta.tier || null,
      status: bmMeta.status || 'active',
      parentGroup: bmMeta.parentGroup || null,
      bets: r.bets, wins: r.wins, losses: r.losses,
      pending: r.bets - resolved,
      staked: r.staked, pnl: r.pnl, roi, winRate, avgOdds,
    };
  }).filter(r => r.bets > 0).sort((a, b) => b.bets - a.bets);

  const totalPnl    = rows.reduce((s, r) => s + r.pnl,    0);
  const totalStaked = rows.reduce((s, r) => s + r.staked,  0);
  const totalBets   = rows.reduce((s, r) => s + r.bets,    0);
  const bestBm      = rows.filter(r => r.roi != null).sort((a, b) => b.roi - a.roi)[0] || null;
  const worstBm     = rows.filter(r => r.roi != null).sort((a, b) => a.roi - b.roi)[0] || null;

  res.json({
    rows,
    summary: {
      totalBets,
      totalStaked: parseFloat(totalStaked.toFixed(2)),
      totalPnl:    parseFloat(totalPnl.toFixed(2)),
      roi: totalStaked ? parseFloat(((totalPnl / totalStaked) * 100).toFixed(1)) : null,
      bestBm:  bestBm  ? { id: bestBm.id,  name: bestBm.name,  roi: bestBm.roi  } : null,
      worstBm: worstBm ? { id: worstBm.id, name: worstBm.name, roi: worstBm.roi } : null,
    },
  });
});

// Performance grouped by league — placed bets, period-filterable, mode-filterable.
app.get('/api/league-performance', (req, res) => {
  const mode   = req.query.mode || 'paper'; // 'paper' | 'real' | 'all'
  const fromTs = req.query.from ? new Date(req.query.from).getTime() : null;
  const toTs   = req.query.to   ? new Date(req.query.to).getTime()   : null;

  const placed = getBets().filter(b => {
    if (mode === 'paper' && b.mode === 'real') return false;
    if (mode === 'real'  && b.mode !== 'real') return false;
    if (!(b.placementStatus === 'placed' || b.placementConfirmed)) return false;
    if (fromTs || toTs) {
      const t = new Date(b.lockedAt || b.placedAt || 0).getTime();
      if (fromTs && t < fromTs) return false;
      if (toTs   && t > toTs)   return false;
    }
    return true;
  });

  const byLeague = {};
  for (const b of placed) {
    const key  = String(b.leagueId ?? '__unknown__');
    const name = b.leagueName || 'Unknown';
    if (!byLeague[key]) byLeague[key] = { leagueId: key, name, bets: 0, wins: 0, losses: 0, staked: 0, pnl: 0, oddsSum: 0 };
    const row = byLeague[key];
    row.bets++;
    row.staked = parseFloat((row.staked + (b.actualStake || b.suggestedStake || 0)).toFixed(2));
    if (b.result === 'win')  { row.wins++;   row.pnl = parseFloat((row.pnl + (b.pnl || 0)).toFixed(2)); }
    if (b.result === 'loss') { row.losses++; row.pnl = parseFloat((row.pnl + (b.pnl || 0)).toFixed(2)); }
    const odds = b.actualOdds || b.bookOdds;
    if (odds) row.oddsSum += odds;
  }

  const rows = Object.values(byLeague).map(r => {
    const resolved = r.wins + r.losses;
    const roi      = r.staked ? parseFloat(((r.pnl / r.staked) * 100).toFixed(1)) : null;
    const winRate  = resolved ? parseFloat(((r.wins / resolved) * 100).toFixed(1)) : null;
    const avgOdds  = r.bets   ? parseFloat((r.oddsSum / r.bets).toFixed(2)) : null;
    return {
      leagueId: r.leagueId, name: r.name,
      bets: r.bets, wins: r.wins, losses: r.losses,
      pending: r.bets - resolved,
      staked: r.staked, pnl: r.pnl, roi, winRate, avgOdds,
    };
  }).filter(r => r.bets > 0).sort((a, b) => b.bets - a.bets);

  const totalPnl    = rows.reduce((s, r) => s + r.pnl,    0);
  const totalStaked = rows.reduce((s, r) => s + r.staked,  0);
  const totalBets   = rows.reduce((s, r) => s + r.bets,    0);
  const bestLeague  = rows.filter(r => r.roi != null).sort((a, b) => b.roi - a.roi)[0] || null;
  const worstLeague = rows.filter(r => r.roi != null).sort((a, b) => a.roi - b.roi)[0] || null;

  res.json({
    rows,
    summary: {
      totalBets,
      totalStaked: parseFloat(totalStaked.toFixed(2)),
      totalPnl:    parseFloat(totalPnl.toFixed(2)),
      roi: totalStaked ? parseFloat(((totalPnl / totalStaked) * 100).toFixed(1)) : null,
      bestLeague:  bestLeague  ? { leagueId: bestLeague.leagueId,  name: bestLeague.name,  roi: bestLeague.roi }  : null,
      worstLeague: worstLeague ? { leagueId: worstLeague.leagueId, name: worstLeague.name, roi: worstLeague.roi } : null,
    },
  });
});

// ─── TIER PERFORMANCE TRACKER ──────────────────────────────────────────────────
// Live-vs-historical ROI by calibration tier — see docs/tier-calibration-analysis.md.
// HISTORICAL_TIER_BASELINE is the raw (uncorrected) per-tier ROI table, pooled
// across every league with a genuine train/test split, test-only fixtures,
// full observed probability range (widened 2026-08-07 from the original
// Addendum 2 scope of 4 leagues / 45-70% only — see Addendum 5). It's a static
// snapshot of a backtest, not live-computed — hard-coded deliberately so it
// can't silently drift if backtest data changes without a fresh, documented
// cycle. `decisionGrade` follows calibration-rules.md rule 6's ~300-400
// posEdge floor literally; only 40-45% currently clears it.
const HISTORICAL_TIER_BASELINE = {
  '<35%':   { n: 1,   roi: 2.61,   decisionGrade: false },
  '35-40%': { n: 249, roi: -0.134, decisionGrade: false },
  '40-45%': { n: 430, roi: -0.215, decisionGrade: true, ciExcludesZero: true }, // CI [-34.4%, -8.6%] — confirmed negative, the one decision-grade result in this table
  '45-50%': { n: 269, roi: 0.044,  decisionGrade: false },
  '50-55%': { n: 155, roi: 0.018,  decisionGrade: false },
  '55-60%': { n: 72,  roi: 0.286,  decisionGrade: false },
  '60-65%': { n: 26,  roi: 1.51,   decisionGrade: false }, // extreme outlier, n=26 — do not read as signal
  '65-70%': { n: 4,   roi: 0.818,  decisionGrade: false },
};
// Every league with a genuine train/test split as of 2026-08-07 — the original
// four (PL, Ligue 1, Champions League, Serie A) plus Scottish Premiership,
// Bundesliga, La Liga, Eredivisie, Primeira Liga.
const TIER_PERF_VALIDATED_LEAGUES = new Set([39, 61, 2, 135, 179, 78, 140, 88, 94]);
// Same threshold the codebase already uses to decide a league has "enough" live
// paper-trade evidence (see runEvCalibration()'s MIN_LIVE_PAPER_TRADES) — reused
// here so "enough live data to say something" means the same thing everywhere.
const TIER_PERF_MIN_LIVE_N = 10;
const TIER_EDGES_SHARED = [0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80];
const TIER_LABELS_SHARED = ['<35%', ...TIER_EDGES_SHARED.slice(0, -1).map((e, i) => `${Math.round(e*100)}-${Math.round(TIER_EDGES_SHARED[i+1]*100)}%`), '80%+'];
function tierOfProbShared(p) {
  if (p == null || isNaN(p)) return null;
  if (p < TIER_EDGES_SHARED[0]) return '<35%';
  for (let i = 0; i < TIER_EDGES_SHARED.length - 1; i++) {
    if (p >= TIER_EDGES_SHARED[i] && p < TIER_EDGES_SHARED[i+1]) return `${Math.round(TIER_EDGES_SHARED[i]*100)}-${Math.round(TIER_EDGES_SHARED[i+1]*100)}%`;
  }
  return '80%+';
}

app.get('/api/tier-performance', (req, res) => {
  const mode = req.query.mode || 'paper'; // 'paper' | 'real' | 'all'
  const resolved = getBets().filter(b => {
    if (mode === 'paper' && b.mode === 'real') return false;
    if (mode === 'real'  && b.mode !== 'real') return false;
    if (!(b.placementStatus === 'placed' || b.placementConfirmed)) return false;
    return b.result === 'win' || b.result === 'loss';
  });

  function groupByTier(bets) {
    const map = {};
    for (const b of bets) {
      const tier = tierOfProbShared(b.modelProb);
      if (!tier) continue;
      if (!map[tier]) map[tier] = { n: 0, staked: 0, pnl: 0 };
      map[tier].n++;
      map[tier].staked += (b.actualStake ?? b.suggestedStake ?? 0);
      map[tier].pnl    += (b.pnl || 0);
    }
    return map;
  }

  const validatedBets = resolved.filter(b => TIER_PERF_VALIDATED_LEAGUES.has(parseInt(b.leagueId, 10)));
  const otherBets      = resolved.filter(b => !TIER_PERF_VALIDATED_LEAGUES.has(parseInt(b.leagueId, 10)));
  const validatedByTier = groupByTier(validatedBets);
  const otherByTier     = groupByTier(otherBets);

  const rows = TIER_LABELS_SHARED.map(tier => {
    const hist = HISTORICAL_TIER_BASELINE[tier] || null;
    const live = validatedByTier[tier] || null;
    const liveN   = live ? live.n : 0;
    const liveRoi = live && live.staked ? +(live.pnl / live.staked).toFixed(4) : null;
    const liveThin = liveN < TIER_PERF_MIN_LIVE_N;

    let status;
    if (!hist) status = 'No baseline';
    else if (liveThin || liveRoi === null) status = 'Tracking';
    else status = ((liveRoi >= 0) === (hist.roi >= 0)) ? 'Consistent' : 'Diverging';

    return {
      tier,
      historical: hist ? { n: hist.n, roi: hist.roi, ciExcludesZero: !!hist.ciExcludesZero, thin: !hist.decisionGrade } : null,
      live: { n: liveN, roi: liveRoi, thin: liveThin },
      status,
    };
  });

  const otherLeagueActivity = TIER_LABELS_SHARED
    .map(tier => {
      const g = otherByTier[tier];
      if (!g || g.n === 0) return null;
      return { tier, n: g.n, roi: g.staked ? +(g.pnl / g.staked).toFixed(4) : null };
    })
    .filter(Boolean);

  res.json({
    scope: {
      validatedLeagueIds: [...TIER_PERF_VALIDATED_LEAGUES],
      minLiveN: TIER_PERF_MIN_LIVE_N,
      historicalSource: 'docs/tier-calibration-analysis.md Addendum 5 (widened 2026-08-07) — raw/uncorrected, test-only, pooled across all 9 validated leagues, full probability range. Platt correction never deployed live.',
      note: 'Live modelProb runs through applyTeamProfileModifiers (team profile/weather/WOWY) that the historical backfill population did not include — directionally comparable, not a perfect match.',
    },
    rows,
    otherLeagueActivity,
  });
});

app.get('/api/team-profile/:teamId', (req, res) => {
  const profiles = getTeamProfiles([parseInt(req.params.teamId, 10)]);
  const profile  = profiles[req.params.teamId] || null;
  if (!profile) return res.status(404).json({ error: 'No profile yet — run morning scan first' });
  res.json(profile);
});

// PATCH bet result (manual override)
app.patch('/api/bets/:id', (req, res) => {
  const bets = getBets();
  const bet  = bets.find(b => b.id === req.params.id);
  if (!bet) return res.status(404).json({ error: 'Not found' });

  const { result } = req.body;
  if (!['win','loss','void'].includes(result)) return res.status(400).json({ error: 'Invalid result' });

  if (bet.result) return res.status(400).json({ error: 'Already resolved' });

  const pnl = result === 'win'  ? parseFloat(((bet.bookOdds - 1) * bet.suggestedStake).toFixed(2))
            : result === 'loss' ? -bet.suggestedStake : 0;

  bet.result     = result;
  bet.pnl        = pnl;
  bet.stage      = 'RESOLVED';
  bet.resolvedAt = new Date().toISOString();

  const br   = getBankroll();
  br.current = parseFloat((br.current + pnl).toFixed(2));
  saveBankroll(br);
  saveBets(bets);
  res.json({ bet, bankroll: br });
});

// DELETE bet
app.delete('/api/bets/:id', (req, res) => {
  const bets = getBets().filter(b => b.id !== req.params.id);
  saveBets(bets);
  res.json({ ok: true });
});

// Trigger morning scan manually
app.post('/api/scan/morning', async (req, res) => {
  const leagues = req.body.leagues || getSettings().activeLeagues;
  res.json({ started: true, leagues });
  runMorningScan(leagues).catch(e => console.error('[ManualMorningScan]', e.message));
});

// Historical profile backfill — fetches 3 seasons of data per league and rebuilds all profiles
app.post('/api/backfill/profiles', async (req, res) => {
  const lines = [];
  res.json({ started: true, message: 'Backfill running in background — poll /api/backfill/status for progress' });
  try {
    const summary = await runProfileBackfill(msg => lines.push(msg));
    writeJSON('backfill-meta.json', { ...summary, completedAt: new Date().toISOString() });
    console.log('[Backfill] Summary written to backfill-meta.json');
  } catch (e) {
    console.error('[Backfill] Fatal error:', e.message);
    writeJSON('backfill-meta.json', { error: e.message, completedAt: new Date().toISOString() });
  }
});

app.get('/api/backfill/status', (_req, res) => {
  const meta = readJSON('backfill-meta.json');
  if (!meta) return res.json({ status: 'not_run' });
  if (meta.error) return res.json({ status: 'error', ...meta });
  res.json({ status: 'complete', ...meta });
});

// Historical backfill — full 3-season fetch, factor scoring, weight optimisation
// ?rescore=true clears all scored records and re-scores from the fixture pool (needed after factor function changes)
app.post('/api/backfill/historical', async (req, res) => {
  if (_historicalBackfillRunning) {
    return res.json({ started: false, message: 'Already running', status: _historicalBackfillStatus });
  }
  const rescore = req.query.rescore === 'true';
  res.json({ started: true, rescore, message: `Historical backfill running (rescore=${rescore}) — poll /api/backfill/historical/status` });
  runHistoricalBackfill({ rescore }).catch(e => console.error('[HistoricalBackfill]', e.message));
});

app.get('/api/backfill/historical/status', (_req, res) => {
  if (_historicalBackfillRunning) {
    return res.json({ running: true, ..._historicalBackfillStatus });
  }
  const meta = readJSON('backfill-historical-meta.json');
  if (!meta) return res.json({ status: 'not_run' });
  res.json({ running: false, status: meta.error ? 'error' : 'complete', ...meta });
});

// Apply optimised weights to settings (so live scoring uses them)
app.post('/api/backfill/historical/apply-weights', (req, res) => {
  const meta = readJSON('backfill-historical-meta.json');
  if (!meta?.optimisedWeights) return res.status(400).json({ error: 'No optimised weights available — run historical backfill first' });
  const settings = getSettings();
  settings.optimisedWeights = meta.optimisedWeights;
  writeJSON('settings.json', settings);
  res.json({ ok: true, optimisedWeights: meta.optimisedWeights });
});

// Run per-league weight optimisation and store results in settings.leagueWeights
let _leagueOptRunning = false;
app.post('/api/optimise/leagues', (req, res) => {
  if (_leagueOptRunning) return res.status(409).json({ error: 'Optimisation already running' });
  const data = readJSON('backfill-historical.json');
  if (!data?.scoredRecords?.length) return res.status(400).json({ error: 'No scored records — run historical backfill first' });

  _leagueOptRunning = true;
  res.json({ started: true, message: 'Per-league optimisation running in background' });

  setImmediate(async () => {
    try {
      const settings     = getSettings();
      const leagueWeights = { ...(settings.leagueWeights || {}) };
      const leagueMeta    = {};

      // Gather unique league IDs from records
      const leagueIds = [...new Set(data.scoredRecords.map(r => r.leagueId).filter(Boolean))];
      for (const lid of leagueIds) {
        const result = optimiseLeagueWeights(lid, data.scoredRecords);
        if (result) {
          leagueWeights[lid] = result.weights;
          leagueMeta[lid]    = {
            weights:         result.weights,
            defaultWeights:  result.defaultWeights,
            accuracy:        result.accuracy,
            baselineAccuracy: result.baselineAccuracy,
            improvement:     result.improvement,
            recordCount:     result.recordCount,
            optimisedAt:     result.optimisedAt,
          };
          console.log(`[LeagueOpt] League ${lid}: ${result.recordCount} records · accuracy ${(result.accuracy*100).toFixed(1)}% (Δ${result.improvement >= 0 ? '+' : ''}${result.improvement}pp)`);
        }
      }

      settings.leagueWeights     = leagueWeights;
      settings.leagueWeightsMeta = leagueMeta;
      writeJSON('settings.json', settings);
      console.log('[LeagueOpt] Complete — optimised', Object.keys(leagueWeights).length, 'leagues');
    } catch (e) {
      console.error('[LeagueOpt] Error:', e.message);
    } finally {
      _leagueOptRunning = false;
    }
  });
});

app.get('/api/optimise/leagues/status', (_req, res) => {
  const settings = getSettings();
  res.json({
    running: _leagueOptRunning,
    leagueWeights: settings.leagueWeights || {},
    leagueWeightsMeta: settings.leagueWeightsMeta || {},
  });
});

// Update per-league weights manually
app.put('/api/settings/league-weights', (req, res) => {
  const { leagueId, weights } = req.body;
  if (!leagueId || !weights) return res.status(400).json({ error: 'leagueId and weights required' });
  const keys = ['form','homeAdv','xg','h2h','defense','momentum','injuries','standings'];
  if (!keys.every(k => typeof weights[k] === 'number')) return res.status(400).json({ error: 'weights must include all 8 factors as numbers' });
  const sum = keys.reduce((a, k) => a + weights[k], 0);
  if (Math.abs(sum - 100) > 2) return res.status(400).json({ error: `weights must sum to 100 (got ${sum})` });
  const settings = getSettings();
  if (!settings.leagueWeights) settings.leagueWeights = {};
  settings.leagueWeights[String(leagueId)] = weights;
  writeJSON('settings.json', settings);
  res.json({ ok: true, leagueId, weights });
});

// Reset a league back to context defaults
app.delete('/api/settings/league-weights/:leagueId', (req, res) => {
  const settings = getSettings();
  if (settings.leagueWeights) delete settings.leagueWeights[req.params.leagueId];
  if (settings.leagueWeightsMeta) delete settings.leagueWeightsMeta[req.params.leagueId];
  writeJSON('settings.json', settings);
  res.json({ ok: true });
});

// ─── ODDS HISTORY ENDPOINTS ──────────────────────────────────────────────────

// Stats summary for Settings tab display
app.get('/api/odds-history/stats', (req, res) => {
  const history = getOddsHistory();
  if (!history.length) return res.json({ total: 0, resolved: 0, dateRange: null, byLeague: {}, byStage: {} });

  const dates = history.map(r => r.kickoff || r.collectedAt).filter(Boolean).sort();
  const byLeague = {};
  const byStage  = {};
  let resolved   = 0;

  for (const r of history) {
    const lg = r.league || 'Unknown';
    if (!byLeague[lg]) byLeague[lg] = { total: 0, resolved: 0 };
    byLeague[lg].total++;
    if (r.result) { byLeague[lg].resolved++; resolved++; }

    const s = r.stage || 'unknown';
    byStage[s] = (byStage[s] || 0) + 1;
  }

  res.json({
    total:     history.length,
    resolved,
    dateRange: { earliest: dates[0], latest: dates[dates.length - 1] },
    byLeague,
    byStage,
  });
});

// One-time historical backfill from The Odds API history endpoint
// Hits weekly snapshots over the last 90 days for each active league sport
let _oddsBackfillRunning = false;
app.post('/api/backfill/odds-history', async (req, res) => {
  if (_oddsBackfillRunning) return res.json({ error: 'already_running' });
  _oddsBackfillRunning = true;
  res.json({ started: true, message: 'Odds history backfill running in background' });

  const sports = [
    { sport: 'soccer_epl',                    league: 'Premier League',    leagueId: 39  },
    { sport: 'soccer_spain_la_liga',           league: 'La Liga',           leagueId: 140 },
    { sport: 'soccer_italy_serie_a',           league: 'Serie A',           leagueId: 135 },
    { sport: 'soccer_germany_bundesliga',      league: 'Bundesliga',        leagueId: 78  },
    { sport: 'soccer_france_ligue_one',        league: 'Ligue 1',           leagueId: 61  },
    { sport: 'soccer_uefa_champs_league',      league: 'Champions League',  leagueId: 2   },
    { sport: 'soccer_fifa_world_cup',          league: 'FIFA World Cup',    leagueId: 1   },
  ];

  // Weekly snapshots: Sunday at 12:00 UTC going back 13 weeks (~90 days)
  const snapshots = [];
  const now = new Date();
  for (let w = 1; w <= 13; w++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - w * 7);
    d.setUTCHours(12, 0, 0, 0);
    snapshots.push(d.toISOString());
  }

  let added = 0;
  const history = getOddsHistory();
  const existingIds = new Set(history.map(r => `${r.home}|${r.away}|${r.kickoff?.slice(0,10)}`));

  for (const { sport, league, leagueId } of sports) {
    for (const dateStr of snapshots) {
      try {
        const { data } = await oddsApi.get(`/sports/${sport}/odds-history`, {
          params: { apiKey: ODDS_API_KEY, regions: 'uk', markets: 'h2h', oddsFormat: 'decimal', date: dateStr },
        });
        const events = data?.data || data || [];
        for (const ev of events) {
          const kickoff = ev.commence_time;
          const dedupeKey = `${ev.home_team}|${ev.away_team}|${kickoff?.slice(0,10)}`;
          if (existingIds.has(dedupeKey)) continue;
          existingIds.add(dedupeKey);

          const market = (ev.bookmakers || []).slice(0, 8).map(bm => {
            const mkt = bm.markets?.find(m => m.key === 'h2h');
            if (!mkt) return null;
            const get = name => mkt.outcomes?.find(o => o.name === name)?.price ?? null;
            return { name: bm.title, homeOdds: get(ev.home_team), drawOdds: get('Draw'), awayOdds: get(ev.away_team) };
          }).filter(Boolean);
          const best = market[0] || {};

          history.push({
            fixtureId:    null, // no API-Sports ID available from odds-only backfill
            home:         ev.home_team,
            away:         ev.away_team,
            league,
            leagueId,
            kickoff,
            collectedAt:  dateStr,
            stage:        'historical_backfill',
            bookmakers:   { best: { homeOdds: best.homeOdds || null, drawOdds: best.drawOdds || null, awayOdds: best.awayOdds || null }, market },
            impliedProbs: {
              home: best.homeOdds ? parseFloat((1/best.homeOdds).toFixed(4)) : null,
              draw: best.drawOdds ? parseFloat((1/best.drawOdds).toFixed(4)) : null,
              away: best.awayOdds ? parseFloat((1/best.awayOdds).toFixed(4)) : null,
            },
            modelProbs:      null,
            edge:            null,
            successScore:    null,
            recommendedBet:  null,
            locked:          false,
            result:          null,
            outcome:         null,
            recommendedBetWon: null,
            resolvedAt:      null,
          });
          added++;
        }
        await new Promise(r => setTimeout(r, 300)); // gentle rate limit
      } catch (e) {
        console.error(`[OddsBackfill] ${sport} @ ${dateStr}: ${e.message}`);
      }
    }
    saveOddsHistory(history);
    console.log(`[OddsBackfill] ${league}: done (${added} total records so far)`);
  }

  console.log(`[OddsBackfill] Complete — ${added} new odds records`);
  _oddsBackfillRunning = false;
});

// ─── CLOSING ODDS BACKFILL ────────────────────────────────────────────────────
// Fetches Pinnacle closing odds (one snapshot per fixture near kickoff) for all
// historical fixtures in the 7 supported leagues across the last 2 seasons.
// Stores results in closing-odds.json keyed by API-Sports fixtureId.
// Groups fixtures by (sport, kickoff_hour) so fixtures sharing a kickoff time
// share one API call — typically 6-10 fixtures per call on a match day.
// Budget-capped: stops when creditsUsed reaches the configured limit.

const CLOSING_ODDS_SPORT_MAP = {
  '39':  'soccer_epl',
  '140': 'soccer_spain_la_liga',
  '135': 'soccer_italy_serie_a',
  '78':  'soccer_germany_bundesliga',
  '61':  'soccer_france_ligue_one',
  '2':   'soccer_uefa_champs_league',
  '1':   'soccer_fifa_world_cup',
  '179': 'soccer_spl',
  '88':  'soccer_netherlands_eredivisie',
  '94':  'soccer_portugal_primeira_liga',
  '3':   'soccer_uefa_europa_league',
  '848': 'soccer_uefa_europa_conference_league',
};

let _closingOddsStatus = {
  running: false, startedAt: null, completedAt: null, error: null,
  creditsUsed: 0, creditsRemaining: null,
  fixturesTotal: 0, fixturesMatched: 0, fixturesMissed: 0,
  apiCallsMade: 0, currentLeague: null,
};

function getClosingOdds() { return readJSON('closing-odds.json') || {}; }
function saveClosingOdds(data) { writeJSON('closing-odds.json', data); }

// Multi-book closing odds — captured from the SAME historical-odds responses the
// Pinnacle-only backfill already fetches, at zero extra API cost, so the sharp-books
// consensus benchmark (docs/calibration-rules.md-governed calibration work) can
// cover fixtures Pinnacle alone misses. Kept in a separate file from closing-odds.json
// on purpose — the Pinnacle-only EV calibration path must stay untouched.
const CONSENSUS_BOOKS = ['pinnacle', 'marathonbet', 'matchbook'];
function getClosingOddsMulti() { return readJSON('closing-odds-multi.json') || {}; }
function saveClosingOddsMulti(data) { writeJSON('closing-odds-multi.json', data); }

// Fuzzy team name match: normalise both strings and check overlap.
function normaliseTeam(name) {
  return (name || '')
    .normalize('NFD')                          // decompose accented chars (ã → a + combining tilde)
    .replace(/[̀-ͯ]/g, '')           // strip combining diacritical marks
    .toLowerCase()
    .replace(/\bfc\b|\baf\b|\bsc\b|\bac\b|\bcd\b|\bfk\b/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ').trim();
}
// Nicknames/shorthand that aren't substrings or shared tokens of the official name,
// so the checks below can never catch them (e.g. "Wolves" contains none of the
// same 4+ char tokens as "Wolverhampton Wanderers", despite being the same club).
// Confirmed root cause of the EPL backfill anomaly (2026-08-05) — api-football's
// short name "Wolves" never matched the Odds API's "Wolverhampton Wanderers" in
// ~600 fixtures, the entire aggregate "0 matches" result traced to this one gap.
// Add more here as they're found — each entry just needs to normaliseTeam() to
// the same key on both sides.
const TEAM_NICKNAME_ALIASES = {
  'wolves': 'wolverhampton wanderers',
  'spurs': 'tottenham hotspur',
  'gladbach': 'borussia monchengladbach',
  'atleti': 'atletico madrid',
  'psg': 'paris saint germain',
  // Confirmed 2026-08-05 — Primeira Liga backfill had a 47% miss rate entirely
  // traced to this one club: api-football's short name "Guimaraes" vs the Odds
  // API's "Vitória SC" (normaliseTeam strips "SC" as a club suffix, leaving
  // "vitoria" — neither side is a substring/token of the other otherwise).
  'guimaraes': 'vitoria',
  // Confirmed 2026-08-05 — Scottish Premiership: api-football's official
  // "Heart Of Midlothian" vs the Odds API's "Hearts". "heart" is a token of the
  // former but not an exact match of "hearts" (plural), so the token-overlap
  // check couldn't catch it either.
  'heart of midlothian': 'hearts',
};
function resolveTeamAlias(normalised) {
  return TEAM_NICKNAME_ALIASES[normalised] || normalised;
}
function teamsMatch(a, b) {
  const na = resolveTeamAlias(normaliseTeam(a)), nb = resolveTeamAlias(normaliseTeam(b));
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // token overlap — any shared word ≥4 chars
  const ta = na.split(' '), tb = nb.split(' ');
  return ta.some(w => w.length >= 4 && tb.includes(w));
}

async function runClosingOddsBackfill({ budgetCredits = 80000, leagueIds = null, debug = false } = {}) {
  if (_closingOddsStatus.running) return;
  _closingOddsStatus = {
    running: true, startedAt: new Date().toISOString(), completedAt: null, error: null,
    creditsUsed: 0, creditsRemaining: null,
    fixturesTotal: 0, fixturesMatched: 0, fixturesMissed: 0,
    apiCallsMade: 0, currentLeague: null,
    // Per-fixture request/response detail, only populated when debug:true — added
    // to diagnose the EPL anomaly (bulk-loop matching failing where an identical
    // isolated call succeeds) without relying on aggregate counters alone.
    debugEntries: debug ? [] : null,
  };
  console.log(`[ClosingOdds] Starting backfill — budget ${budgetCredits} credits${debug ? ' [DEBUG]' : ''}`);

  const guard = await creditGuard(`closing-odds backfill (leagues: ${leagueIds ? leagueIds.join(',') : 'all'})`, budgetCredits);
  if (!guard.ok) {
    _closingOddsStatus.running = false;
    _closingOddsStatus.completedAt = new Date().toISOString();
    _closingOddsStatus.error = `Credit guard blocked this run: ${guard.reason} (${guard.remaining ?? 'unknown'} remaining, reserve ${ODDS_CREDITS_RESERVE})`;
    console.error(`[ClosingOdds] ABORTED before any calls — ${_closingOddsStatus.error}`);
    return;
  }

  try {
    const hist = readJSON('backfill-historical.json');
    if (!hist?.fixtures?.length) throw new Error('backfill-historical.json empty or missing');

    const closing = getClosingOdds();
    const closingMulti = getClosingOddsMulti();
    const alreadyDone = new Set(Object.keys(closing).map(Number));

    // Build list of fixtures needing odds, grouped by (sport, kickoff_minute).
    // Was grouped by HOUR (date.slice(0,13), querying the top of the hour) — for any
    // fixture not kicking off exactly on the hour, that query landed before Pinnacle
    // had posted a line yet, silently missing real, available data. Confirmed via
    // direct comparison on live fixtures: hour-truncated queries showed no Pinnacle
    // in half of a random sample, while the exact-kickoff-minute query for the SAME
    // fixture found it every time. Minute-level grouping still batches fixtures that
    // genuinely kick off simultaneously (e.g. Saturday 3pm) into one API call.
    // Yield every 500 fixtures so the event loop stays responsive during the sync scan.
    const groups = new Map(); // key = "sport|2024-10-05T15:30" → [fixture, ...]
    let skipped = 0;
    let scanIdx = 0;
    for (const fix of hist.fixtures) {
      if (++scanIdx % 500 === 0) await new Promise(r => setImmediate(r));
      const fid   = fix.fixture?.id;
      const lid   = String(fix.league?.id);
      const sport = CLOSING_ODDS_SPORT_MAP[lid];
      const date  = fix.fixture?.date;
      if (!fid || !sport || !date) continue;
      if (leagueIds && !leagueIds.includes(lid)) { skipped++; continue; }
      // 5-season window: 2020/21 through 2024/25 (calendar year 2020+). Was hardcoded
      // to 2022+ (3 seasons) independent of HISTORICAL_BACKFILL_CONFIG — leagues with
      // 5 seasons of fixtures already fetched (La Liga, Bundesliga, Ligue 1, Primeira
      // Liga) had their 2020/2021 fixtures silently excluded from ever being matched
      // against Pinnacle closing odds, regardless of budget.
      const year = new Date(date).getUTCFullYear();
      if (year < 2020) { skipped++; continue; }
      if (alreadyDone.has(fid)) { skipped++; continue; }
      const minuteKey = date.slice(0, 16); // "2024-10-05T15:30"
      const groupKey = `${sport}|${minuteKey}`;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(fix);
    }
    _closingOddsStatus.fixturesTotal = [...groups.values()].reduce((s, g) => s + g.length, 0);
    console.log(`[ClosingOdds] ${_closingOddsStatus.fixturesTotal} fixtures to process in ${groups.size} API calls (${skipped} skipped)`);

    let saveCounter = 0;
    for (const [groupKey, fixtures] of groups) {
      if (_closingOddsStatus.creditsUsed >= budgetCredits) {
        console.log(`[ClosingOdds] Budget cap reached (${_closingOddsStatus.creditsUsed} credits) — stopping`);
        break;
      }
      const [sport, minuteKey] = groupKey.split('|');
      const kickoffIso = minuteKey + ':00Z';
      _closingOddsStatus.currentLeague = sport;
      const requestUrl = `/historical/sports/${sport}/odds`;
      const requestParams = { apiKey: '***', regions: 'uk,eu', markets: 'h2h', oddsFormat: 'decimal', date: kickoffIso };

      try {
        const resp = await oddsApi.get(requestUrl, {
          params: { ...requestParams, apiKey: ODDS_API_KEY },
        });
        const creditsLast      = parseInt(resp.headers['x-requests-last'] || '0', 10);
        const creditsRemaining = parseInt(resp.headers['x-requests-remaining'] || '0', 10);
        _closingOddsStatus.creditsUsed      += creditsLast;
        _closingOddsStatus.creditsRemaining  = creditsRemaining;
        _closingOddsStatus.apiCallsMade++;
        _lastKnownOddsCredits = { remaining: creditsRemaining, checkedAt: new Date().toISOString() };

        // Reserve check on every real response — free (piggybacks the header already
        // returned), catches the account crossing the line mid-run rather than only
        // at the very start or at true zero.
        if (creditsRemaining <= ODDS_CREDITS_RESERVE) {
          _closingOddsStatus.error = `Stopped: crossed the ${ODDS_CREDITS_RESERVE}-credit reserve line (${creditsRemaining} remaining) mid-run at ${groupKey}`;
          console.error(`[ClosingOdds] RESERVE LINE CROSSED — ${_closingOddsStatus.error}`);
          break;
        }

        const events = resp.data?.data || resp.data || [];

        if (debug) {
          console.log(`[ClosingOdds:DEBUG] REQUEST ${requestUrl} sport=${sport} date=${kickoffIso} -> ${events.length} events, credits ${creditsLast} used / ${creditsRemaining} left`);
        }

        for (const fix of fixtures) {
          const home = fix.teams?.home?.name;
          const away = fix.teams?.away?.name;
          const fid  = fix.fixture?.id;
          const ev   = events.find(e =>
            teamsMatch(e.home_team, home) && teamsMatch(e.away_team, away)
          );

          let debugEntry = null;
          if (debug) {
            debugEntry = {
              fixtureId: fid, home, away, sport, requestUrl, requestParams: { ...requestParams },
              eventCount: events.length,
              sampleEventTeams: events.slice(0, 3).map(e => `${e.home_team} vs ${e.away_team}`),
              matched: !!ev,
            };
          }

          if (!ev) {
            _closingOddsStatus.fixturesMissed++;
            if (debug) { debugEntry.outcome = 'no_event_match'; _closingOddsStatus.debugEntries.push(debugEntry); console.log(`[ClosingOdds:DEBUG] MISS ${home} vs ${away} — no matching event in ${events.length} returned`); }
            continue;
          }

          // Sharp-books consensus capture — pulls whichever of Pinnacle/Marathon Bet/
          // Matchbook are present in this SAME already-fetched response, regardless of
          // whether Pinnacle specifically matched below. Zero extra API cost. Written
          // to a separate file so the existing Pinnacle-only EV calibration path never
          // sees this data — consensus is additive, not a replacement.
          const multiEntry = {};
          for (const bookKey of CONSENSUS_BOOKS) {
            const cbm = ev.bookmakers?.find(b => b.key === bookKey);
            const cmkt = cbm?.markets?.find(m => m.key === 'h2h');
            if (!cmkt) continue;
            const cget = name => cmkt.outcomes?.find(o => teamsMatch(o.name, name))?.price ?? null;
            const home3 = cget(home), draw3 = cget('Draw'), away3 = cget(away);
            if (home3 && draw3 && away3) multiEntry[bookKey] = { homeOdds: home3, drawOdds: draw3, awayOdds: away3, lastUpdate: cbm.last_update || kickoffIso };
          }
          if (Object.keys(multiEntry).length > 0) closingMulti[fid] = { fixtureId: fid, snapshotTs: kickoffIso, books: multiEntry };

          // Prefer Pinnacle; fall back to first available bookmaker
          const bm = ev.bookmakers?.find(b => b.key === 'pinnacle') || ev.bookmakers?.[0];
          if (debug) { debugEntry.bookmakerKeys = ev.bookmakers?.map(b => b.key) || []; debugEntry.usedBookmaker = bm?.key || null; }
          if (!bm) {
            _closingOddsStatus.fixturesMissed++;
            if (debug) { debugEntry.outcome = 'no_bookmaker'; _closingOddsStatus.debugEntries.push(debugEntry); console.log(`[ClosingOdds:DEBUG] MISS ${home} vs ${away} — event matched but zero bookmakers`); }
            continue;
          }
          const mkt = bm.markets?.find(m => m.key === 'h2h');
          if (!mkt) {
            _closingOddsStatus.fixturesMissed++;
            if (debug) { debugEntry.outcome = 'no_h2h_market'; _closingOddsStatus.debugEntries.push(debugEntry); console.log(`[ClosingOdds:DEBUG] MISS ${home} vs ${away} — bookmaker ${bm.key} has no h2h market`); }
            continue;
          }
          const get = name => mkt.outcomes?.find(o => teamsMatch(o.name, name))?.price ?? null;

          closing[fid] = {
            fixtureId:   fid,
            homeOdds:    get(home),
            drawOdds:    get('Draw'),
            awayOdds:    get(away),
            bookmaker:   bm.key,
            collectedAt: bm.last_update || kickoffIso,
            snapshotTs:  kickoffIso,
          };
          _closingOddsStatus.fixturesMatched++;
          saveCounter++;
          if (debug) { debugEntry.outcome = 'matched'; debugEntry.odds = closing[fid]; _closingOddsStatus.debugEntries.push(debugEntry); console.log(`[ClosingOdds:DEBUG] HIT ${home} vs ${away} — bookmaker ${bm.key}`); }
        }

        // Save every 200 fixtures matched to guard against crashes
        if (saveCounter >= 200) { saveClosingOdds(closing); saveClosingOddsMulti(closingMulti); saveCounter = 0; }

        await new Promise(r => setTimeout(r, 250)); // ~4 req/s — well within limits
      } catch (e) {
        console.error(`[ClosingOdds] ${groupKey}: ${e.message}`);
        if (debug) {
          _closingOddsStatus.debugEntries.push({
            groupKey, sport, kickoffIso, requestUrl, requestParams,
            outcome: 'request_error', error: e.message, errorStatus: e.response?.status || null, errorBody: e.response?.data || null,
          });
          console.log(`[ClosingOdds:DEBUG] REQUEST ERROR ${sport} ${kickoffIso} — status ${e.response?.status}, ${JSON.stringify(e.response?.data)}`);
        }
        // Credits exhausted mid-run: stop immediately and fail loud, rather than
        // silently retrying every remaining group at 1s each (the earlier pattern —
        // a run left in this state looked "stuck" for minutes with nothing to show).
        if (e.response?.data?.error_code === 'OUT_OF_USAGE_CREDITS') {
          _closingOddsStatus.error = 'OUT_OF_USAGE_CREDITS — stopped immediately, did not retry remaining groups';
          console.error(`[ClosingOdds] CREDITS EXHAUSTED mid-run at ${groupKey} — stopping now (${_closingOddsStatus.fixturesMatched} matched, ${_closingOddsStatus.apiCallsMade} calls made this run)`);
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    saveClosingOdds(closing);
    saveClosingOddsMulti(closingMulti);
    _closingOddsStatus.running     = false;
    _closingOddsStatus.completedAt = new Date().toISOString();
    console.log(`[ClosingOdds] Done — matched ${_closingOddsStatus.fixturesMatched}, missed ${_closingOddsStatus.fixturesMissed}, credits used ${_closingOddsStatus.creditsUsed}`);
  } catch (e) {
    _closingOddsStatus.running = false;
    _closingOddsStatus.error   = e.message;
    console.error('[ClosingOdds] Fatal:', e.message);
  }
}

app.post('/api/backfill/closing-odds', (req, res) => {
  if (_closingOddsStatus.running) return res.json({ error: 'already_running', status: _closingOddsStatus });
  if (!ODDS_API_KEY) return res.status(500).json({ error: 'ODDS_API_KEY not set' });
  const budget = parseInt(req.query.budget || '80000', 10);
  const leagueIds = req.query.leagues ? req.query.leagues.split(',').map(s => s.trim()) : null;
  const debug = req.query.debug === 'true';
  res.json({ started: true, budget, leagueIds, debug, message: `Closing odds backfill starting — budget ${budget} credits${leagueIds ? `, leagues: ${leagueIds.join(',')}` : ''}${debug ? ' [DEBUG]' : ''}` });
  runClosingOddsBackfill({ budgetCredits: budget, leagueIds, debug }).catch(e => console.error('[ClosingOdds]', e.message));
});

app.get('/api/backfill/closing-odds/status', (req, res) => res.json(_closingOddsStatus));

// Per-league diagnostic: actual vs model home/draw/away rates from scored records
// GET /api/league/diagnostic?leagues=88,94  (omit for all leagues)
app.get('/api/league/diagnostic', (req, res) => {
  const data = readJSON('backfill-historical.json');
  if (!data?.scoredRecords?.length) return res.json({ leagues: {} });
  const filter = req.query.leagues ? new Set(req.query.leagues.split(',').map(s => s.trim())) : null;
  const settings = getSettings();

  const byLeague = {};
  for (const rec of data.scoredRecords) {
    const lid = String(rec.leagueId);
    if (filter && !filter.has(lid)) continue;
    if (!rec.actualOutcome) continue;
    if (!byLeague[lid]) byLeague[lid] = { home: 0, draw: 0, away: 0, total: 0,
      modelHomeSum: 0, modelDrawSum: 0, modelAwaySum: 0 };
    const b = byLeague[lid];
    b.total++;
    if (rec.actualOutcome === 'home') b.home++;
    else if (rec.actualOutcome === 'draw') b.draw++;
    else b.away++;

    // Model probabilities are never pre-computed/stored on scored records — scoreFixtureFromPool
    // only stores the raw homeFactors/awayFactors. Compute modelProb on the fly here instead,
    // the same way computeLogLoss (weightOptimiser.js) does. Without this, modelAvg was always
    // 0/0/0 for every league — this diagnostic never actually worked.
    if (rec.homeFactors && rec.awayFactors) {
      try {
        const weights     = _getWeightsForFixture(lid, rec.context, settings);
        const leagueConfig = LEAGUE_CONFIG[parseInt(lid, 10)] || null;
        const p = computeModelProb(rec.homeFactors, rec.awayFactors, weights, rec.context, leagueConfig);
        b.modelHomeSum += p.home;
        b.modelDrawSum += p.draw;
        b.modelAwaySum += p.away;
      } catch { /* skip malformed records */ }
    }
  }

  const result = {};
  for (const [lid, b] of Object.entries(byLeague)) {
    const cfg = LEAGUE_CONFIG[parseInt(lid)] || {};
    result[lid] = {
      name: cfg.name || lid,
      n: b.total,
      actual:  { home: +(b.home / b.total).toFixed(4), draw: +(b.draw / b.total).toFixed(4), away: +(b.away / b.total).toFixed(4) },
      modelAvg:{ home: +(b.modelHomeSum / b.total).toFixed(4), draw: +(b.modelDrawSum / b.total).toFixed(4), away: +(b.modelAwaySum / b.total).toFixed(4) },
      config:  { avgHomeWinRate: cfg.avgHomeWinRate, avgDrawRate: cfg.avgDrawRate, avgAwayWinRate: cfg.avgAwayWinRate,
                 homeAdvBaseWeight: cfg.homeAdvBaseWeight, drawBaseWeight: cfg.drawBaseWeight },
      delta:   {
        home: +((b.home / b.total) - (b.modelHomeSum / b.total)).toFixed(4),
        draw: +((b.draw / b.total) - (b.modelDrawSum / b.total)).toFixed(4),
        away: +((b.away / b.total) - (b.modelAwaySum / b.total)).toFixed(4),
      },
    };
  }
  res.json({ leagues: result });
});

// Calibration data from all historical scored records for Fix 3 chart
app.get('/api/backfill/historical/calibration', (req, res) => {
  const { computeModelProb, WEIGHTS_BY_CONTEXT } = require('./scoring');
  const data = readJSON('backfill-historical.json');
  if (!data?.scoredRecords?.length) return res.json({ bands: {}, total: 0 });

  const settings = getSettings();
  const bands = {
    '<40%':  { w: 0, l: 0, sum: 0 },
    '40–50%':{ w: 0, l: 0, sum: 0 },
    '50–60%':{ w: 0, l: 0, sum: 0 },
    '60–70%':{ w: 0, l: 0, sum: 0 },
    '70%+':  { w: 0, l: 0, sum: 0 },
  };

  for (const r of data.scoredRecords) {
    try {
      const weights = _getWeightsForFixture(r.leagueId, r.context, settings);
      const lc      = LEAGUE_CONFIG[parseInt(r.leagueId, 10)] || null;
      const probs   = computeModelProb(r.homeFactors, r.awayFactors, weights, r.context, lc);
      const predP   = probs[r.actualOutcome]; // probability assigned to the outcome that actually happened
      const topKey  = Object.entries(probs).sort((a,b) => b[1]-a[1])[0][0];
      const topProb = probs[topKey];

      const key = topProb >= 0.70 ? '70%+' : topProb >= 0.60 ? '60–70%' : topProb >= 0.50 ? '50–60%' : topProb >= 0.40 ? '40–50%' : '<40%';
      bands[key].sum += topProb;
      if (topKey === r.actualOutcome) bands[key].w++; else bands[key].l++;
    } catch {}
  }

  const result = {};
  for (const [k, v] of Object.entries(bands)) {
    const tot = v.w + v.l;
    if (!tot) continue;
    result[k] = {
      actual:  parseFloat((v.w / tot).toFixed(4)),
      avgPred: parseFloat((v.sum / tot).toFixed(4)),
      w: v.w, l: v.l, total: tot,
    };
  }

  res.json({ bands: result, total: data.scoredRecords.length });
});

// ── Fixture stats backfill ─────────────────────────────────────────────────────
// Fetches /fixtures/statistics for each PL/CL fixture in backfill-historical.json
// that doesn't already have an entry in fixture-stats.json. Resumes on re-call.

let _statsBackfillRunning = false;

app.post('/api/backfill/fixture-stats', async (req, res) => {
  if (_statsBackfillRunning) return res.json({ error: 'already_running' });
  _statsBackfillRunning = true;
  res.json({ started: true });

  const STATS_LEAGUES  = new Set([39, 2, 140, 135, 78, 61]);  // PL, CL, La Liga, Serie A, Bundesliga, Ligue 1
  const STATS_SEASONS  = new Set([2022, 2023, 2024]);

  try {
    const historical = readJSON('backfill-historical.json');
    if (!historical?.fixtures?.length) {
      console.log('[StatsBackfill] No historical fixtures found — run historical backfill first');
      return;
    }

    const byLeague2 = {};
    for (const f of historical.fixtures) {
      const lid = f.league?.id, sid = f.league?.season;
      if (!STATS_LEAGUES.has(lid) || !STATS_SEASONS.has(sid)) continue;
      (byLeague2[lid] = byLeague2[lid] || []).push(f);
    }
    const buckets2 = Object.values(byLeague2);
    const targets  = [];
    const maxLen2  = Math.max(...buckets2.map(b => b.length));
    for (let i = 0; i < maxLen2; i++) {
      for (const b of buckets2) { if (i < b.length) targets.push(b[i]); }
    }

    const statsDb    = getFixtureStats();
    const parseStats = ts => {
      const find   = t => ts.statistics?.find(s => s.type === t)?.value;
      const xgRaw  = find('expected_goals') ?? find('Expected Goals');
      const shotsOn    = parseInt(find('Shots on Goal') ?? 0) || 0;
      const totalShots = parseInt(find('Total Shots') ?? 0) || 0;
      const possession = parseFloat(String(find('Ball Possession') ?? '50%').replace('%', '')) / 100;
      const xg = xgRaw != null ? parseFloat(xgRaw) || null
        : (shotsOn || totalShots) ? computeXGProxy({ shotsOn, totalShots, possession }) : null;
      return { xg, shotsOn, totalShots, possession };
    };

    let fetched = 0, skipped = 0, errors = 0;
    for (const fix of targets) {
      const fid = String(fix.fixture?.id);
      if (statsDb[fid]) { skipped++; continue; }
      try {
        const { data } = await apiSports.get('/fixtures/statistics', { params: { fixture: fid } });
        if (data?.response?.length >= 2) {
          statsDb[fid] = { home: parseStats(data.response[0]), away: parseStats(data.response[1]) };
          fetched++;
        }
      } catch { errors++; }
      if (fetched % 50 === 0 && fetched > 0) {
        saveFixtureStats(statsDb);
        console.log(`[StatsBackfill] ${fetched} fetched, ${skipped} skipped, ${errors} errors`);
      }
      await new Promise(r => setTimeout(r, 600));
    }
    saveFixtureStats(statsDb);
    console.log(`[StatsBackfill] Done — ${fetched} new, ${skipped} cached, ${errors} errors. Total: ${Object.keys(statsDb).length}`);
  } catch (e) {
    console.error('[StatsBackfill] Fatal:', e.message);
  } finally {
    _statsBackfillRunning = false;
  }
});

app.get('/api/backfill/fixture-stats/status', (_req, res) => {
  const statsDb = getFixtureStats();
  res.json({ running: _statsBackfillRunning, count: Object.keys(statsDb).length });
});

// ── Lineups backfill + WOWY ───────────────────────────────────────────────────
// Fetches /fixtures/lineups for PL/CL historical fixtures and runs WOWY updates.

let _lineupsBackfillRunning = false;

app.post('/api/backfill/lineups', async (req, res) => {
  if (_lineupsBackfillRunning) return res.json({ error: 'already_running' });
  _lineupsBackfillRunning = true;

  // ?rebuild=true clears existing lineups + WOWY data so a clean re-run can add player names
  const rebuild = req.query.rebuild === 'true' || req.body?.rebuild === true;
  res.json({ started: true, rebuild });

  const LINEUP_LEAGUES = new Set([39, 2, 140, 135, 78, 61]);
  const LINEUP_SEASONS = new Set([2022, 2023, 2024]);

  try {
    const historical = readJSON('backfill-historical.json');
    if (!historical?.fixtures?.length) {
      console.log('[LineupsBackfill] No historical fixtures — run historical backfill first');
      return;
    }

    const targets = historical.fixtures.filter(f =>
      LINEUP_LEAGUES.has(f.league?.id) && LINEUP_SEASONS.has(f.league?.season)
    );

    // Rebuild mode: wipe lineups.json and clear playerDependency from all team profiles
    if (rebuild) {
      saveLineups({});
      const profiles = require('./teamProfiles').readProfiles();
      let cleared = 0;
      for (const p of Object.values(profiles)) {
        if (p.playerDependency) { p.playerDependency = null; cleared++; }
      }
      require('./teamProfiles').saveProfiles(profiles);
      console.log(`[LineupsBackfill] Rebuild mode — cleared lineups.json and ${cleared} team WOWY records`);
    }

    const lineupsDb = getLineups();
    let fetched = 0, skipped = 0, errors = 0, wowied = 0;
    for (const fix of targets) {
      const fid = String(fix.fixture?.id);
      if (lineupsDb[fid]) { skipped++; continue; }
      try {
        const { data } = await apiSports.get('/fixtures/lineups', { params: { fixture: fid } });
        if (data?.errors?.requests) {
          console.warn('[LineupsBackfill] API rate limit reached — saving progress and stopping');
          setRateLimited();
          saveLineups(lineupsDb);
          break;
        }
        if (data?.response?.length >= 2) {
          const entry = {
            home:      parseApiLineup(data.response[0]),
            away:      parseApiLineup(data.response[1]),
            fetchedAt: new Date().toISOString(),
          };
          lineupsDb[fid] = entry;
          fetched++;

          const hg = fix.goals?.home ?? 0;
          const ag = fix.goals?.away ?? 0;
          const outcome = hg > ag ? 'win' : hg < ag ? 'loss' : 'draw';
          const homeId = fix.teams?.home?.id;
          const awayId = fix.teams?.away?.id;
          if (homeId && entry.home?.starters?.length) {
            updateWOWY(homeId, entry.home.starters, entry.home.substitutes || [],
              outcome === 'win' ? 'win' : outcome === 'draw' ? 'draw' : 'loss');
            wowied++;
          }
          if (awayId && entry.away?.starters?.length) {
            updateWOWY(awayId, entry.away.starters, entry.away.substitutes || [],
              outcome === 'loss' ? 'win' : outcome === 'draw' ? 'draw' : 'loss');
            wowied++;
          }
        }
      } catch { errors++; }
      if (fetched % 50 === 0 && fetched > 0) {
        saveLineups(lineupsDb);
        console.log(`[LineupsBackfill] ${fetched} fetched, ${skipped} skipped, ${errors} errors, ${wowied} WOWY updates`);
      }
      await new Promise(r => setTimeout(r, 650));
    }
    saveLineups(lineupsDb);
    console.log(`[LineupsBackfill] Done — ${fetched} new, ${skipped} cached, ${errors} errors, ${wowied} WOWY updates. Total: ${Object.keys(lineupsDb).length}`);
  } catch (e) {
    console.error('[LineupsBackfill] Fatal:', e.message);
  } finally {
    _lineupsBackfillRunning = false;
  }
});

app.get('/api/backfill/lineups/status', (_req, res) => {
  const lineupsDb = getLineups();
  res.json({ running: _lineupsBackfillRunning, count: Object.keys(lineupsDb).length });
});

// StatsBomb xG import — runs scripts/import-statsbomb.js server-side
let _xgImportRunning = false;
app.post('/api/backfill/xg', async (req, res) => {
  if (_xgImportRunning) return res.json({ running: true, message: 'Import already in progress' });
  _xgImportRunning = true;
  res.json({ started: true, message: 'StatsBomb xG import running — check /api/server-status for count when complete' });
  const { execFile } = require('child_process');
  const scriptPath   = path.join(__dirname, 'scripts', 'import-statsbomb.js');
  execFile(process.execPath, [scriptPath], { env: { ...process.env, DATA_DIR } }, (err, stdout, stderr) => {
    _xgImportRunning = false;
    if (err) { console.error('[XgImport] Error:', err.message, stderr); return; }
    reloadXgStore();
    const store = getXgStore();
    console.log(`[XgImport] Complete — ${Object.keys(store).length} entries in xg-data.json`);
    console.log('[XgImport]', stdout.trim().split('\n').slice(-2).join(' | '));
  });
});

app.get('/api/backfill/xg/status', (_req, res) => {
  const store = getXgStore();
  res.json({ running: _xgImportRunning, count: Object.keys(store).length });
});

// Understat xG fetch — runs scripts/fetch-understat.js server-side
let _understatRunning = false;
app.post('/api/backfill/understat', (req, res) => {
  if (_understatRunning) return res.json({ running: true, message: 'Already in progress' });
  _understatRunning = true;
  res.json({ started: true, message: 'Understat xG fetch running — poll /api/backfill/understat/status' });
  const { execFile } = require('child_process');
  const scriptPath   = path.join(__dirname, 'scripts', 'fetch-understat.js');
  execFile(process.execPath, [scriptPath], { env: { ...process.env, DATA_DIR }, timeout: 300000 }, (err, stdout, stderr) => {
    _understatRunning = false;
    if (err) { console.error('[Understat] Error:', err.message, stderr); return; }
    reloadXgStore();
    const store = getXgStore();
    console.log(`[Understat] Complete — ${Object.keys(store).length} entries in xg-data.json`);
    console.log('[Understat]', stdout.trim().split('\n').slice(-4).join(' | '));
  });
});

app.get('/api/backfill/understat/status', (_req, res) => {
  const store = getXgStore();
  res.json({ running: _understatRunning, count: Object.keys(store).length });
});

// PIR (Player Impact Rating) fetch
let _pirRunning = false;
const _pirStatus = { running: false, startedAt: null, completedAt: null, count: 0, error: null };
app.post('/api/backfill/pir', (req, res) => {
  if (_pirRunning) return res.json({ running: true, message: 'PIR fetch already in progress' });
  _pirRunning = true;
  _pirStatus.running    = true;
  _pirStatus.startedAt  = new Date().toISOString();
  _pirStatus.completedAt = null;
  _pirStatus.error      = null;
  res.json({ started: true, message: 'PIR fetch running — poll /api/backfill/pir/status' });
  const { execFile } = require('child_process');
  const scriptPath   = path.join(__dirname, 'scripts', 'fetch-pir.js');
  const force = req.query.force === 'true' || req.body?.force === true;
  execFile(process.execPath, [scriptPath], {
    env: { ...process.env, DATA_DIR, API_SPORTS_KEY: process.env.API_SPORTS_KEY, PIR_FORCE: force ? '1' : '' },
    timeout: 1800000, // 30 min
  }, (err, stdout, stderr) => {
    _pirRunning = false;
    _pirStatus.running = false;
    _pirStatus.completedAt = new Date().toISOString();
    if (err) {
      _pirStatus.error = err.message;
      console.error('[PIR] Error:', err.message, stderr);
      return;
    }
    const { reloadPIRCache, getPIRData } = require('./teamProfiles');
    reloadPIRCache();
    const data = getPIRData();
    _pirStatus.count = Object.keys(data).length;
    console.log(`[PIR] Complete — ${_pirStatus.count} players in pir-data.json`);
    console.log('[PIR]', stdout.trim().split('\n').slice(-2).join(' | '));
  });
});

app.get('/api/backfill/pir/status', (_req, res) => {
  const { getPIRData } = require('./teamProfiles');
  const data = getPIRData();
  res.json({ ..._pirStatus, count: Object.keys(data).length });
});

// ─── LEAGUE × TIER HISTORICAL PERFORMANCE MATRIX ──────────────────────────────
// Reference/diagnostic view, NOT a live tracker and NOT a gate — see
// docs/tier-calibration-analysis.md Addendum 6. Static backtest snapshot
// (same population/methodology as Addenda 2 and 5: raw/uncorrected,
// test-only per VALIDATED_SPLITS, posEdge>=5%, 5pp tiers), hard-coded
// deliberately for the same reason HISTORICAL_TIER_BASELINE is — so it can't
// silently drift without a fresh, documented cycle. `shrunk` per cell is the
// empirical-Bayes estimate from shrinkage.js, pooling toward that tier's
// mean across all 9 leagues. `thin` marks n<30 (the same small-sample
// threshold runEvCalibration()'s bandStats() already uses) — finer-grained
// than the ~300-400 whole-cycle decision-grade floor, since a single
// league×tier cell is naturally a much smaller unit than a pooled tier.
const LEAGUE_TIER_MATRIX = {
  2:   { name: 'Champions League',      cells: { '35-40%': { n: 7,  roi: 1.3429,  ciLow: -0.3797, ciHigh: 3.0654,  thin: true,  shrunk: 0.2579  }, '40-45%': { n: 27, roi: 0.3737,  ciLow: -0.2844, ciHigh: 1.0318,  thin: true,  shrunk: -0.1404 }, '45-50%': { n: 15, roi: 0.224,   ciLow: -0.5892, ciHigh: 1.0372, thin: true, shrunk: 0.0753  }, '50-55%': { n: 13, roi: 0.2708,  ciLow: -0.5448, ciHigh: 1.0864, thin: true, shrunk: 0.1673  }, '55-60%': { n: 7,  roi: 0.3457,  ciLow: -0.619,  ciHigh: 1.3104, thin: true, shrunk: 0.286   }, '60-65%': { n: 3,  roi: -1,      ciLow: -1,      ciHigh: -1,     thin: true, shrunk: 0.449   } } },
  39:  { name: 'Premier League',        cells: { '35-40%': { n: 22, roi: -0.6464, ciLow: -1.1389, ciHigh: -0.1539, thin: true,  shrunk: -0.4063 }, '40-45%': { n: 59, roi: -0.08,   ciLow: -0.4314, ciHigh: 0.2714,  thin: false, shrunk: -0.1825 }, '45-50%': { n: 41, roi: 0.3329,  ciLow: -0.2398, ciHigh: 0.9056, thin: false, shrunk: 0.1502  }, '50-55%': { n: 18, roi: -0.5061, ciLow: -0.9477, ciHigh: -0.0645, thin: true, shrunk: -0.3314 }, '55-60%': { n: 8,  roi: 1.2863,  ciLow: -1.5835, ciHigh: 4.156,  thin: true, shrunk: 0.286   }, '60-65%': { n: 1,  roi: -1,      ciLow: -1,      ciHigh: -1,     thin: true, shrunk: 1.0176  }, '65-70%': { n: 1, roi: 0.88, ciLow: 0.88, ciHigh: 0.88, thin: true, shrunk: 0.8175 } } },
  61:  { name: 'Ligue 1',               cells: { '<35%':   { n: 1,  roi: 2.61,    ciLow: 2.61,    ciHigh: 2.61,    thin: true,  shrunk: 2.61    }, '35-40%': { n: 44, roi: 0.1548,  ciLow: -0.3724, ciHigh: 0.682,   thin: false, shrunk: 0.0665  }, '40-45%': { n: 56, roi: -0.2757, ciLow: -0.6099, ciHigh: 0.0585, thin: false, shrunk: -0.229  }, '45-50%': { n: 37, roi: 0.3462,  ciLow: -0.0637, ciHigh: 0.7562, thin: false, shrunk: 0.1479  }, '50-55%': { n: 10, roi: -0.788,  ciLow: -1.2035, ciHigh: -0.3725, thin: true, shrunk: -0.4062 }, '55-60%': { n: 11, roi: 0.15,    ciLow: -0.506,  ciHigh: 0.806,  thin: true, shrunk: 0.286   } } },
  78:  { name: 'Bundesliga',            cells: { '35-40%': { n: 26, roi: -0.3315, ciLow: -0.8726, ciHigh: 0.2096,  thin: true,  shrunk: -0.2471 }, '40-45%': { n: 51, roi: -0.3606, ciLow: -0.7028, ciHigh: -0.0183, thin: false, shrunk: -0.2463 }, '45-50%': { n: 39, roi: -0.1741, ciLow: -0.572,  ciHigh: 0.2238, thin: false, shrunk: -0.0341 }, '50-55%': { n: 14, roi: 0.4471,  ciLow: -0.1512, ciHigh: 1.0455, thin: true, shrunk: 0.2791  }, '55-60%': { n: 7,  roi: -0.0986, ciLow: -0.9416, ciHigh: 0.7445, thin: true, shrunk: 0.286   }, '60-65%': { n: 2,  roi: 0.76,    ciLow: 0.662,   ciHigh: 0.858,  thin: true, shrunk: 1.264   } } },
  88:  { name: 'Eredivisie',            cells: { '35-40%': { n: 19, roi: 0.1195,  ciLow: -0.7801, ciHigh: 1.0191,  thin: true,  shrunk: -0.0084 }, '40-45%': { n: 45, roi: -0.3433, ciLow: -0.7069, ciHigh: 0.0203,  thin: false, shrunk: -0.24   }, '45-50%': { n: 31, roi: 0.1406,  ciLow: -0.3456, ciHigh: 0.6269, thin: false, shrunk: 0.0733  }, '50-55%': { n: 15, roi: -0.712,  ciLow: -1.0968, ciHigh: -0.3272, thin: true, shrunk: -0.4383 }, '55-60%': { n: 5,  roi: -0.206,  ciLow: -1.1674, ciHigh: 0.7554, thin: true, shrunk: 0.286   } } },
  94:  { name: 'Primeira Liga',         cells: { '35-40%': { n: 36, roi: 0.0317,  ciLow: -0.6003, ciHigh: 0.6636,  thin: false, shrunk: -0.0262 }, '40-45%': { n: 52, roi: -0.2967, ciLow: -0.7272, ciHigh: 0.1338,  thin: false, shrunk: -0.2328 }, '45-50%': { n: 27, roi: -0.7163, ciLow: -1.0264, ciHigh: -0.4062, thin: true, shrunk: -0.1673 }, '50-55%': { n: 18, roi: 0.4556,  ciLow: -0.1041, ciHigh: 1.0152, thin: true, shrunk: 0.3096  }, '55-60%': { n: 5,  roi: 0.222,   ciLow: -0.7594, ciHigh: 1.2034, thin: true, shrunk: 0.286   }, '60-65%': { n: 5,  roi: 6.446,   ciLow: -1.5026, ciHigh: 14.3946, thin: true, shrunk: 4.2229 } } },
  135: { name: 'Serie A',               cells: { '35-40%': { n: 29, roi: -0.1766, ciLow: -0.7266, ciHigh: 0.3735,  thin: true,  shrunk: -0.1595 }, '40-45%': { n: 39, roi: -0.3108, ciLow: -0.7168, ciHigh: 0.0953,  thin: false, shrunk: -0.2316 }, '45-50%': { n: 18, roi: 0.2061,  ciLow: -0.3698, ciHigh: 0.782,  thin: true, shrunk: 0.0767   }, '50-55%': { n: 14, roi: 0.0164,  ciLow: -0.6266, ciHigh: 0.6594, thin: true, shrunk: 0.017    }, '55-60%': { n: 5,  roi: 1.072,   ciLow: 0.797,   ciHigh: 1.347,  thin: true, shrunk: 0.286   }, '60-65%': { n: 1,  roi: -1,      ciLow: -1,      ciHigh: -1,     thin: true, shrunk: 1.0176  } } },
  140: { name: 'La Liga',               cells: { '35-40%': { n: 44, roi: -0.3557, ciLow: -0.7403, ciHigh: 0.0289,  thin: false, shrunk: -0.2879 }, '40-45%': { n: 58, roi: -0.3657, ciLow: -0.6754, ciHigh: -0.056,  thin: false, shrunk: -0.2508 }, '45-50%': { n: 39, roi: 0.0795,  ciLow: -0.4093, ciHigh: 0.5683, thin: false, shrunk: 0.0564  }, '50-55%': { n: 30, roi: 0.142,   ciLow: -0.2774, ciHigh: 0.5614, thin: false, shrunk: 0.1133  }, '55-60%': { n: 15, roi: 0.104,   ciLow: -0.4476, ciHigh: 0.6556, thin: true, shrunk: 0.286   }, '60-65%': { n: 9,  roi: 0.9244,  ciLow: -1.6333, ciHigh: 3.4822, thin: true, shrunk: 1.1076  }, '65-70%': { n: 1, roi: 0.81, ciLow: 0.81, ciHigh: 0.81, thin: true, shrunk: 0.8175 } } },
  179: { name: 'Scottish Premiership',  cells: { '35-40%': { n: 22, roi: -0.4245, ciLow: -0.9531, ciHigh: 0.104,   thin: true,  shrunk: -0.2884 }, '40-45%': { n: 43, roi: 0.0053,  ciLow: -0.4128, ciHigh: 0.4235,  thin: false, shrunk: -0.1736 }, '45-50%': { n: 22, roi: -0.1423, ciLow: -0.6859, ciHigh: 0.4013, thin: true, shrunk: -0.0007  }, '50-55%': { n: 23, roi: 0.3461,  ciLow: -0.2143, ciHigh: 0.9065, thin: true, shrunk: 0.2537   }, '55-60%': { n: 9,  roi: -0.0089, ciLow: -0.8033, ciHigh: 0.7855, thin: true, shrunk: 0.286   }, '60-65%': { n: 5,  roi: 0.438,   ciLow: -0.269,  ciHigh: 1.145,  thin: true, shrunk: 0.9208  }, '65-70%': { n: 2, roi: 0.79, ciLow: 0.6136, ciHigh: 0.9664, thin: true, shrunk: 0.8175 } } },
};
const LEAGUE_TIER_MATRIX_TIER_ORDER = ['<35%','35-40%','40-45%','45-50%','50-55%','55-60%','60-65%','65-70%','70-75%','75-80%','80%+'];

app.get('/api/league-tier-matrix', (_req, res) => {
  const leagueIds = Object.keys(LEAGUE_TIER_MATRIX).map(Number);

  // n-weighted shrunk average per league (row) and per tier (column) — secondary
  // read only, see the doc addendum for why this shouldn't replace cell-level detail.
  const leagueAverages = leagueIds.map(id => {
    let wSum = 0, nSum = 0;
    for (const cell of Object.values(LEAGUE_TIER_MATRIX[id].cells)) { wSum += cell.shrunk * cell.n; nSum += cell.n; }
    return { leagueId: id, name: LEAGUE_TIER_MATRIX[id].name, n: nSum, avgShrunkRoi: nSum > 0 ? +(wSum / nSum).toFixed(4) : null };
  });
  const tierAverages = LEAGUE_TIER_MATRIX_TIER_ORDER.map(tier => {
    let wSum = 0, nSum = 0;
    for (const id of leagueIds) {
      const cell = LEAGUE_TIER_MATRIX[id].cells[tier];
      if (cell) { wSum += cell.shrunk * cell.n; nSum += cell.n; }
    }
    return { tier, n: nSum, avgShrunkRoi: nSum > 0 ? +(wSum / nSum).toFixed(4) : null };
  }).filter(t => t.n > 0);

  res.json({
    scope: {
      validatedLeagues: leagueIds.map(id => ({ id, name: LEAGUE_TIER_MATRIX[id].name })),
      tierLabels: LEAGUE_TIER_MATRIX_TIER_ORDER,
      note: 'Reference/diagnostic snapshot, not live-computed and not a gate. Raw = uncorrected posEdge ROI, test-only. Shrunk = empirical-Bayes estimate pooling toward the tier average across all 9 leagues. See docs/tier-calibration-analysis.md Addendum 6.',
    },
    matrix: LEAGUE_TIER_MATRIX,
    leagueAverages,
    tierAverages,
  });
});

// Transfer data fetch — completed transfers per team for the current season,
// used for the first-10-matchdays squad-quality modifier in applyTeamProfileModifiers.
let _transfersRunning = false;
const _transfersStatus = { running: false, startedAt: null, completedAt: null, count: 0, error: null };

app.post('/api/backfill/transfers', (req, res) => {
  if (_transfersRunning) return res.json({ running: true, message: 'Transfers fetch already in progress' });
  _transfersRunning = true;
  _transfersStatus.running     = true;
  _transfersStatus.startedAt   = new Date().toISOString();
  _transfersStatus.completedAt = null;
  _transfersStatus.error       = null;
  res.json({ started: true, message: 'Transfers fetch running — poll /api/backfill/transfers/status' });
  const { execFile } = require('child_process');
  const scriptPath   = path.join(__dirname, 'scripts', 'fetch-transfers.js');
  const season = req.query.season || req.body?.season || undefined;
  execFile(process.execPath, [scriptPath], {
    env: { ...process.env, DATA_DIR, API_SPORTS_KEY: process.env.API_SPORTS_KEY, TRANSFER_SEASON: season },
    timeout: 1800000, // 30 min
  }, (err, stdout, stderr) => {
    _transfersRunning = false;
    _transfersStatus.running = false;
    _transfersStatus.completedAt = new Date().toISOString();
    if (err) {
      _transfersStatus.error = err.message;
      console.error('[Transfers] Error:', err.message, stderr);
      return;
    }
    const { reloadTransfersCache, getTransfersData } = require('./teamProfiles');
    reloadTransfersCache();
    const data = getTransfersData();
    _transfersStatus.count = Object.keys(data).length;
    console.log(`[Transfers] Complete — ${_transfersStatus.count} teams in transfers.json`);
    console.log('[Transfers]', stdout.trim().split('\n').slice(-2).join(' | '));
  });
});

app.get('/api/backfill/transfers/status', (_req, res) => {
  const { getTransfersData } = require('./teamProfiles');
  const data = getTransfersData();
  res.json({ ..._transfersStatus, count: Object.keys(data).length });
});


app.get('/api/pir/analysis', (_req, res) => {
  const { getPIRData, readProfiles, playerImportanceScore } = require('./teamProfiles');
  const pirData = getPIRData();
  const entries = Object.values(pirData);

  // Top 10 by PIR score
  const scored = entries.filter(e => e.pir != null);
  const top10  = [...scored].sort((a, b) => b.pir - a.pir).slice(0, 10).map(e => ({
    name: e.playerName, team: e.teamName, league: e.leagueName,
    pir: e.pir, mins: e.minutesPlayed, rating: e.rating,
    goals90: e.goals90, assists90: e.assists90,
  }));

  // Per-league breakdown
  const byLeague = {};
  for (const e of entries) {
    const key = e.leagueName || 'Unknown';
    if (!byLeague[key]) byLeague[key] = { total: 0, scored: 0 };
    byLeague[key].total++;
    if (e.pir != null) byLeague[key].scored++;
  }

  // WOWY overlap — single pass through all profiles, no per-team getWOWYDeltas calls
  const profiles = readProfiles();
  let wowyTotal = 0, wowyWithPIR = 0;
  const conflicts = [];
  for (const profile of Object.values(profiles)) {
    const players = profile?.playerDependency?.players;
    if (!players) continue;
    for (const [pid, rec] of Object.entries(players)) {
      const w = rec.with, wo = rec.without;
      const wTotal = w.w + w.d + w.l, woTotal = wo.w + wo.d + wo.l;
      if (wTotal < 5 || woTotal < 3) continue;
      wowyTotal++;
      const pirEntry = pirData[pid];
      if (pirEntry) {
        wowyWithPIR++;
        const withRate    = (w.w + 0.5 * w.d) / wTotal;
        const withoutRate = (wo.w + 0.5 * wo.d) / woTotal;
        const delta = parseFloat((withRate - withoutRate).toFixed(3));
        const { importance, conflictFlag } = playerImportanceScore(delta, pirEntry);
        if (conflictFlag) conflicts.push({
          name: rec.name || pid, team: profile.name,
          wowy: Math.round(delta * 100), pir: pirEntry.pir, importance,
        });
      }
    }
  }

  const belowThreshold = entries.filter(e => e.minutesPlayed > 0 && e.minutesPlayed < 450).length;

  res.json({
    total: entries.length,
    scored: scored.length,
    belowMinutesThreshold: belowThreshold,
    top10,
    byLeague,
    wowyOverlap: { wowyTotal, wowyWithPIR, conflicts: conflicts.slice(0, 10) },
  });
});

// Trigger pre-match scan for a specific watching entry
app.post('/api/scan/prematch/:watchId', async (req, res) => {
  const watching = getWatching();
  const entry    = watching.find(w => w.id === req.params.watchId);
  if (!entry) return res.status(404).json({ error: 'Not found in watching list' });
  const bet = await runPreMatchScan(entry);
  if (bet) {
    saveWatching(watching.filter(w => w.id !== entry.id), { allowEmpty: true });
    res.json(bet);
  } else {
    res.json({ dropped: true });
  }
});

// Force resolve check now
app.post('/api/resolve/check', async (_req, res) => {
  await checkAndResolve();
  res.json({ ok: true });
});

// Health
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ─── BOOKMAKER ROUTING ────────────────────────────────────────────────────────

function startOfWeek() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return d;
}

// Maps bookmakers.json exchange IDs to Odds API keys for net-price lookup
const EXCHANGE_BM_KEYS = {
  betfair_exchange: ['betfair_ex_uk', 'betfair_ex_eu'],
  smarkets:         ['smarkets'],
  matchbook:        ['matchbook'],
};

function selectBookmaker(stake, edge, { exchangeOdds = null, allExchangeOdds = [], outcomeName = null, settings = null } = {}) {
  const books = getBookmakers();
  const now   = Date.now();
  const yesterday = now - 86400000;

  // "Prefer exchange" setting: recommend exchange even when a bookmaker offers up to X% better odds
  const preferExchange       = settings?.preferExchange ?? true;
  const preferExchangeBuffer = (settings?.preferExchangeBuffer ?? 5) / 100; // default 5%

  // Four-state status filter
  // restricted → never route; limited → only if no better option; signal → route with stake cap
  const VALID_STATUSES = new Set(['active', 'signal', 'limited']);
  const active = books.filter(b => {
    if (!VALID_STATUSES.has(b.status || 'active')) return false;       // restricted = excluded
    if (b.status === 'limited') {
      const cap = b.maxStakeObserved ?? b.maxStake;
      return cap == null || cap >= stake;                               // limited: honour observed cap
    }
    return b.maxStake == null || b.maxStake >= stake;
  });

  // Count tier-1 usage this week
  const t1WeeklyUse = active
    .filter(b => b.tier === 1)
    .reduce((sum, b) => sum + (b.betsThisWeek || 0), 0);

  const skip = [];
  const eligible = [];

  for (const b of active) {
    const usedYesterday = b.lastUsed && new Date(b.lastUsed).getTime() > yesterday;
    const overweekly    = (b.betsThisWeek || 0) >= 3 && b.tier === 3;

    if (b.tier === 3 && t1WeeklyUse < 3) {
      skip.push({ ...b, skipReason: 'Prefer exchange first' });
      continue;
    }
    if (b.tier === 3 && usedYesterday) {
      skip.push({ ...b, skipReason: 'Used yesterday' });
      continue;
    }
    if (overweekly) {
      skip.push({ ...b, skipReason: 'Used 3x this week' });
      continue;
    }
    eligible.push(b);
  }

  // For tier-1 exchanges, compute best net price for the specific outcome being recommended.
  // Falls back to 0 when exchange odds aren't available for this bookmaker.
  const exchangeNetFor = (bm) => {
    if (bm.tier !== 1 || !outcomeName || !allExchangeOdds.length) return 0;
    const keys = EXCHANGE_BM_KEYS[bm.id] || [];
    let best = 0;
    for (const ex of allExchangeOdds) {
      if (keys.includes(ex.key)) best = Math.max(best, ex.net[outcomeName] || 0);
    }
    return best;
  };

  // Sort: limited last → tier (high-stake) → for tier-1 use best net price desc → lastUsed asc
  eligible.sort((a, b) => {
    const aLim = (a.status === 'limited') ? 1 : 0;
    const bLim = (b.status === 'limited') ? 1 : 0;
    if (aLim !== bLim) return aLim - bLim;
    if (stake > 20 && a.tier !== b.tier) return a.tier - b.tier;
    // Within tier 1: best net price wins
    if (a.tier === 1 && b.tier === 1) {
      const netDiff = exchangeNetFor(b) - exchangeNetFor(a);
      if (Math.abs(netDiff) > 0.001) return netDiff;
    }
    const aLast = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
    const bLast = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
    return aLast - bLast;
  });

  let recommended = eligible[0] || null;
  // When recommended is an exchange, BEST PRICE shows the best non-exchange eligible book,
  // not a second exchange with slightly worse net odds.
  const bestPrice = recommended?.tier === 1
    ? eligible.find(b => b.tier !== 1) || null
    : eligible.find(b => b.id !== recommended?.id) || null;

  // Build routing warnings for signal/limited accounts and same parent group
  let routingWarning = recommended
    ? (recommended.status === 'signal'  ? '⚠ Restriction signal — consider reduced stake'
       : recommended.status === 'limited' ? '⚠ Account limited — use maxStakeObserved cap'
       : null)
    : null;

  if (!routingWarning && recommended?.parentGroup) {
    const recentSameGroup = books.find(b =>
      b.id !== recommended.id &&
      b.parentGroup === recommended.parentGroup &&
      b.lastUsed && new Date(b.lastUsed).getTime() > yesterday
    );
    if (recentSameGroup) {
      routingWarning = `⚠ Same parent group as ${recentSameGroup.name} (${recommended.parentGroup}) — consider rotating to different group`;
    }
  }

  // If preferExchange is on and the recommended book isn't an exchange, promote the
  // best exchange from eligible — as long as its net odds are within the buffer of the best book.
  if (preferExchange && recommended?.tier !== 1 && exchangeOdds) {
    const exchangeBook = eligible.find(b => b.tier === 1);
    if (exchangeBook) {
      // We promote the exchange if book odds advantage is within buffer
      // (we don't have per-book odds here, so we always promote within buffer)
      recommended = exchangeBook;
    }
  }

  // Resolve which specific exchange object corresponds to the recommended bookmaker,
  // and build an array of all exchange alternatives with their net prices for the outcome.
  const recommendedExchangeOdds = (() => {
    if (!recommended || recommended.tier !== 1 || !allExchangeOdds.length) return exchangeOdds;
    const keys = EXCHANGE_BM_KEYS[recommended.id] || [];
    return allExchangeOdds
      .filter(ex => keys.includes(ex.key))
      .sort((a, b) => (b.net[outcomeName] || 0) - (a.net[outcomeName] || 0))[0]
      || exchangeOdds;
  })();

  const alternativeExchanges = allExchangeOdds.filter(ex => {
    const recKeys = EXCHANGE_BM_KEYS[recommended?.id] || [];
    return !recKeys.includes(ex.key);
  });

  return {
    recommended,
    bestPrice,
    routingWarning,
    exchangeOdds: recommendedExchangeOdds,
    alternativeExchanges,
    outcomeName,
    skip: skip.slice(0, 5),
    eligible,
  };
}

// GET bookmakers
app.get('/api/bookmakers', (_req, res) => res.json(getBookmakers()));

app.get('/api/tournament-seeds', (_req, res) => {
  const data = getTournamentSeeds();
  if (!data) return res.status(404).json({ error: 'tournament-seeds.json not found' });
  res.json(data);
});

// PATCH bookmaker (update balance, status, notes, maxStake, maxStakeObserved, statusNotes)
app.patch('/api/bookmakers/:id', (req, res) => {
  const books = getBookmakers();
  const bm    = books.find(b => b.id === req.params.id);
  if (!bm) return res.status(404).json({ error: 'Not found' });
  const allowed = ['balance', 'status', 'maxStake', 'maxStakeObserved', 'notes', 'statusNotes', 'restrictionSignals'];
  allowed.forEach(k => { if (req.body[k] !== undefined) bm[k] = req.body[k]; });
  if (req.body.status && req.body.status !== (bm._prevStatus)) bm.statusUpdatedAt = new Date().toISOString();
  saveBookmakers(books);
  res.json(bm);
});

// POST confirm placement — updates bet record and bookmaker stats
// Re-run routing for a stored bet — uses in-memory odds cache (no API cost),
// falls back to a fresh fetch only if the cache is cold for this sport.
app.post('/api/bets/:id/reroute', async (req, res) => {
  const bets = getBets();
  const bet  = bets.find(b => b.id === req.params.id);
  if (!bet) return res.status(404).json({ error: 'Not found' });

  const meta = LEAGUES[String(bet.leagueId)];
  if (!meta) return res.status(400).json({ error: `No sport mapping for leagueId ${bet.leagueId}` });

  try {
    const events  = _oddsRawCache[meta.sport]?.length
      ? _oddsRawCache[meta.sport]
      : await oddsApi.get(`/sports/${meta.sport}/odds`, {
          params: { apiKey: ODDS_API_KEY, regions: 'uk,eu', markets: 'h2h', oddsFormat: 'decimal' },
        }).then(r => { _oddsRawCache[meta.sport] = r.data || []; return r.data || []; });
    const oddsMap = _buildOddsMap(events);
    const [home, away] = (bet.fixture || '').split(' vs ');
    const entry   = _lookupOddsEntry(oddsMap, home, away);
    const outcomeName = bet.bet === 'Home Win' ? home
                      : bet.bet === 'Away Win' ? away
                      : 'Draw';
    const routing = selectBookmaker(bet.suggestedStake || bet.displayStake || 0, bet.edge || 0, {
      exchangeOdds:    entry._exchangeOdds    || null,
      allExchangeOdds: entry._allExchangeOdds || [],
      outcomeName,
      settings: getSettings(),
    });
    bet.routingRecommendation = routing;
    saveBets(bets);
    res.json({ ok: true, routingRecommendation: routing });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bets/:id/confirm-placement', (req, res) => {
  const bets = getBets();
  const bet  = bets.find(b => b.id === req.params.id);
  if (!bet) return res.status(404).json({ error: 'Not found' });

  const { bookmakerId, bookmakerName, actualOdds, actualStake } = req.body;
  if (!bookmakerId || !bookmakerName) return res.status(400).json({ error: 'bookmakerId and bookmakerName required' });

  bet.bookmakerUsed = bookmakerName;
  bet.bookmakerId   = bookmakerId;
  bet.actualOdds    = parseFloat(actualOdds) || bet.bookOdds;
  bet.actualStake   = parseFloat(actualStake) || bet.suggestedStake;
  bet.placedAt      = new Date().toISOString();
  bet.placementConfirmed = true;
  bet.placementStatus    = 'placed';
  saveBets(bets);

  // Update bookmaker stats
  const books = getBookmakers();
  const bm    = books.find(b => b.id === bookmakerId);
  if (bm) {
    bm.lastUsed      = bet.placedAt;
    bm.betsThisWeek  = (bm.betsThisWeek  || 0) + 1;
    bm.betsThisMonth = (bm.betsThisMonth || 0) + 1;
    bm.totalBets     = (bm.totalBets     || 0) + 1;
    bm.totalStaked   = parseFloat(((bm.totalStaked || 0) + bet.actualStake).toFixed(2));
    saveBookmakers(books);
  }

  res.json({ bet, bookmaker: bm || null });
});

// POST skip a locked bet (no value / account not set up / other)
app.post('/api/bets/:id/skip', (req, res) => {
  const bets = getBets();
  const bet  = bets.find(b => b.id === req.params.id);
  if (!bet) return res.status(404).json({ error: 'Not found' });

  const { skipReason } = req.body;
  bet.placementStatus = 'skipped';
  bet.skippedAt       = new Date().toISOString();
  bet.skipReason      = skipReason || 'other';
  saveBets(bets);
  res.json({ bet });
});

// POST routing recommendation for a stake/edge pair
app.post('/api/bookmakers/route', (req, res) => {
  const { stake, edge } = req.body;
  const settings = getSettings();
  res.json(selectBookmaker(parseFloat(stake) || 0, parseFloat(edge) || 0, { settings }));
});

// POST log restriction signal — updates status based on signal severity
app.post('/api/bookmakers/:id/restriction', (req, res) => {
  const books = getBookmakers();
  const bm    = books.find(b => b.id === req.params.id);
  if (!bm) return res.status(404).json({ error: 'Not found' });

  const { type, notes, maxStakeObserved, newStatus } = req.body;
  const signal = {
    type:       type || 'other',
    detectedAt: new Date().toISOString(),
    notes:      notes || req.body.note || '',
  };
  bm.restrictionSignals = [...(bm.restrictionSignals || []), signal];

  // Auto-escalate status based on signal type if not explicitly overridden
  const prevStatus = bm.status || 'active';
  const escalate = newStatus || (
    type === 'stake_reduction'     ? 'signal'
    : type === 'slow_acceptance'   ? 'signal'
    : type === 'market_unavailable'? 'signal'
    : type === 'odds_mismatch'     ? 'signal'
    : type === 'kyc_request'       ? 'limited'
    : prevStatus
  );
  if (escalate !== prevStatus) {
    bm.status          = escalate;
    bm.statusUpdatedAt = new Date().toISOString();
  }
  if (notes)             bm.statusNotes       = notes;
  if (maxStakeObserved)  bm.maxStakeObserved  = parseFloat(maxStakeObserved);

  saveBookmakers(books);
  res.json(bm);
});

// ─── FACTOR DISTRIBUTION DIAGNOSTIC ─────────────────────────────────────────

app.get('/api/diagnostics/data-coverage', (req, res) => {
  const data     = readJSON('backfill-historical.json');
  const lineups  = readJSON('lineups.json') || {};
  const stats    = readJSON('fixture-stats.json') || {};
  const profiles = require('./teamProfiles').readProfiles();

  if (!data?.fixtures?.length) return res.json({ totalFixtures: 0, byLeague: {}, gaps: ['No historical data — run backfill first'] });

  const LEAGUE_NAMES = {
    1:'World Cup', 32:'WC Qualifying (UEFA)', 34:'WC Qualifying (CONMEBOL)',
    31:'WC Qualifying (CONCACAF)', 5:'Nations League', 10:'International Friendlies',
    39:'Premier League', 140:'La Liga', 135:'Serie A', 78:'Bundesliga', 61:'Ligue 1', 2:'Champions League',
  };

  const byLeague = {};
  let withLineups = 0, withStats = 0;

  for (const f of data.fixtures) {
    const lid  = f.league?.id;
    const sea  = f.league?.season;
    const fid  = String(f.fixture?.id);
    const name = LEAGUE_NAMES[lid] || `League ${lid}`;

    if (!byLeague[name]) byLeague[name] = { fixtures: 0, withLineups: 0, withStats: 0, seasons: new Set() };
    byLeague[name].fixtures++;
    byLeague[name].seasons.add(sea);
    if (lineups[fid]) { byLeague[name].withLineups++; withLineups++; }
    if (stats[fid])   { byLeague[name].withStats++;   withStats++; }
  }

  // Serialise season Sets
  for (const v of Object.values(byLeague)) v.seasons = [...v.seasons].sort();

  // WOWY high-confidence count
  let wowyHighConf = 0;
  for (const prof of Object.values(profiles)) {
    const players = prof.playerDependency?.players || {};
    for (const pd of Object.values(players)) {
      const wTotal  = (pd.with?.w||0) + (pd.with?.d||0) + (pd.with?.l||0);
      const woTotal = (pd.without?.w||0) + (pd.without?.d||0) + (pd.without?.l||0);
      if (wTotal >= 8 && woTotal >= 5) wowyHighConf++;
    }
  }

  // Identify gaps
  const gaps = [];
  for (const [name, v] of Object.entries(byLeague)) {
    const lineupPct = v.fixtures ? v.withLineups / v.fixtures : 0;
    const statsPct  = v.fixtures ? v.withStats   / v.fixtures : 0;
    if (lineupPct < 0.5) gaps.push(`${name} lineups ${Math.round(lineupPct*100)}%`);
    if (statsPct  < 0.3) gaps.push(`${name} xG stats ${Math.round(statsPct*100)}%`);
  }

  res.json({ totalFixtures: data.fixtures.length, withLineups, withStats, wowyHighConf, byLeague, gaps });
});

app.get('/api/diagnostics/factor-distribution', (req, res) => {
  const { computeModelProb: _unused, WEIGHTS_BY_CONTEXT: WBC } = require('./scoring');
  const data = readJSON('backfill-historical.json');
  if (!data?.scoredRecords?.length) return res.json({ error: 'No historical data' });

  const FACTORS = ['form', 'homeAdv', 'xg', 'h2h', 'defense', 'momentum', 'injuries', 'standings'];
  const acc = {};
  for (const f of FACTORS) acc[f] = { home: [], away: [] };

  for (const r of data.scoredRecords) {
    if (!r.homeFactors || !r.awayFactors) continue;
    for (const f of FACTORS) {
      if (r.homeFactors[f] != null) acc[f].home.push(r.homeFactors[f]);
      if (r.awayFactors[f] != null) acc[f].away.push(r.awayFactors[f]);
    }
  }

  const stats = (arr) => {
    if (!arr.length) return { mean: null, std: null, min: null, max: null, n: 0 };
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const std  = Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
    return { mean: parseFloat(mean.toFixed(2)), std: parseFloat(std.toFixed(2)), min: Math.min(...arr), max: Math.max(...arr), n: arr.length };
  };

  const result = {};
  for (const f of FACTORS) {
    const combined = [...acc[f].home, ...acc[f].away];
    result[f] = {
      home: stats(acc[f].home),
      away: stats(acc[f].away),
      combined: stats(combined),
      discriminating: stats(combined).std >= 10,
    };
  }

  res.json({ factors: result, totalRecords: data.scoredRecords.length });
});

// ─── BACKFILL CHAIN ──────────────────────────────────────────────────────────

let _startupStatus = { phase: 'idle', startedAt: null, completedAt: null, skipped: false, error: null };

async function runBackfillChain() {
  if (_cronRunning.backfill && _startupStatus.phase !== 'queued') {
    console.log('[Backfill] Already running — skipping duplicate invocation');
    return;
  }
  _startupStatus = { phase: 'historical', startedAt: new Date().toISOString(), completedAt: null, skipped: false, error: null };

  try {
    // Phase 1: historical fixture fetch + scoring (~30 API calls, always runs first)
    console.log('[Backfill] Phase 1/3: historical fixtures…');
    await runHistoricalBackfill({ rescore: false });

    const hist = readJSON('backfill-historical.json');
    if (!hist?.fixtures?.length) {
      console.warn('[Backfill] Historical returned 0 fixtures — rate-limited. The nightly 00:05 cron will retry tomorrow.');
      _startupStatus.phase = 'rate-limited';
      _startupStatus.retryAt = new Date(Date.now() + 90 * 60 * 1000).toISOString();
      return;
    }
    console.log(`[Backfill] Phase 1 complete — ${hist.fixtures.length} fixtures in pool`);

    // Phase 2: lineups (~5,000 budget, hard stop at 05:00 UTC)
    if (backfillCutoffReached()) {
      console.log('[Backfill] 05:00 UTC cutoff — skipping lineups/stats to reserve quota for morning scan');
      _startupStatus.phase = 'complete'; _wowyHighConfCache = null;
      _startupStatus.completedAt = new Date().toISOString();
      return;
    }
    _startupStatus.phase = 'lineups';
    console.log('[Backfill] Phase 2/3: lineups + WOWY (budget: 5,000 calls)…');
    await runLineupsBackfillFn({ rebuild: false, budget: 5000 });
    const lineupsAfter = readJSON('lineups.json');
    const lineupsCount = lineupsAfter ? Object.keys(lineupsAfter).length : 0;
    console.log(`[Backfill] Phase 2 complete — ${lineupsCount} lineups on disk`);

    // Phase 3: fixture stats (~1,000 budget, hard stop at 05:00 UTC)
    if (backfillCutoffReached()) {
      console.log('[Backfill] 05:00 UTC cutoff — skipping stats to reserve quota for morning scan');
      _startupStatus.phase = 'complete'; _wowyHighConfCache = null;
      _startupStatus.completedAt = new Date().toISOString();
      return;
    }
    _startupStatus.phase = 'fixture-stats';
    console.log('[Backfill] Phase 3/3: fixture stats (budget: 1,000 calls)…');
    await runFixtureStatsBackfillFn({ budget: 1000 });
    const statsAfter = readJSON('fixture-stats.json') || {};
    console.log(`[Backfill] Phase 3 complete — ${Object.keys(statsAfter).length} stats on disk`);

    // Phase 4: PIR refresh — weekly cadence, skip if data is < 7 days old
    const pirStore     = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'pir-data.json'), 'utf8')); } catch { return {}; } })();
    const pirEntries   = Object.values(pirStore);
    const pirNewest    = pirEntries.reduce((a, b) => (!a || b.updatedAt > a.updatedAt) ? b : a, null);
    const pirAgeDays   = pirNewest ? (Date.now() - new Date(pirNewest.updatedAt).getTime()) / 86400000 : Infinity;
    if (pirAgeDays >= 7) {
      if (backfillCutoffReached()) {
        console.log('[Backfill] 05:00 UTC cutoff — skipping PIR refresh');
      } else {
        _startupStatus.phase = 'pir';
        console.log('[Backfill] Phase 4: PIR refresh (data is ' + Math.round(pirAgeDays) + ' days old)…');
        try {
          const { run: runPIR } = require('./scripts/fetch-pir');
          await runPIR();
          const { reloadPIRCache, getPIRData } = require('./teamProfiles');
          reloadPIRCache();
          console.log(`[Backfill] Phase 4 complete — ${Object.keys(getPIRData()).length} PIR entries`);
        } catch (pirErr) {
          console.error('[Backfill] PIR phase error (non-fatal):', pirErr.message);
        }
      }
    } else {
      console.log(`[Backfill] PIR data is ${Math.round(pirAgeDays)} days old — skipping refresh`);
    }

    // Phase 5: Transfer data refresh — weekly cadence, skip if data is < 7 days old.
    // Transfers don't change daily, so a weekly cadence matches PIR's pattern.
    const transfersStore = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'transfers.json'), 'utf8')); } catch { return {}; } })();
    const transfersEntries = Object.values(transfersStore);
    const transfersNewest  = transfersEntries.reduce((a, b) => (!a || b.updatedAt > a.updatedAt) ? b : a, null);
    const transfersAgeDays = transfersNewest ? (Date.now() - new Date(transfersNewest.updatedAt).getTime()) / 86400000 : Infinity;
    if (transfersAgeDays >= 7) {
      if (backfillCutoffReached()) {
        console.log('[Backfill] 05:00 UTC cutoff — skipping transfers refresh');
      } else {
        _startupStatus.phase = 'transfers';
        console.log('[Backfill] Phase 5: transfers refresh (data is ' + Math.round(transfersAgeDays) + ' days old)…');
        try {
          const { run: runTransfers } = require('./scripts/fetch-transfers');
          await runTransfers();
          const { reloadTransfersCache, getTransfersData } = require('./teamProfiles');
          reloadTransfersCache();
          console.log(`[Backfill] Phase 5 complete — ${Object.keys(getTransfersData()).length} team transfer entries`);
        } catch (transfersErr) {
          console.error('[Backfill] Transfers phase error (non-fatal):', transfersErr.message);
        }
      }
    } else {
      console.log(`[Backfill] Transfers data is ${Math.round(transfersAgeDays)} days old — skipping refresh`);
    }

    _startupStatus.phase = 'complete';
    _startupStatus.completedAt = new Date().toISOString();
    console.log('[Backfill] Chain complete ✓');
  } catch (e) {
    _startupStatus.phase = 'error';
    _startupStatus.error = e.message;
    console.error('[Backfill] Chain error:', e.message);
  }
}

// One-time migration: backfill projectedBetKey on calibration entries that predate it.
// Safe to re-run — skips entries that already have the field.
function migrateCalibrationProjectedBetKey() {
  const CANONICAL = new Set(['Home Win', 'Away Win', 'Draw']);
  const cal = getCalibration();
  let patched = 0;
  for (const e of cal) {
    if (e.projectedBetKey) continue;
    if (e.projectedBet && CANONICAL.has(e.projectedBet)) {
      e.projectedBetKey = e.projectedBet;
      if (e.resolved && e.actualResult) {
        e.topPickCorrect = e.actualResult === e.projectedBetKey;
      }
      patched++;
    }
  }
  if (patched > 0) {
    writeJSON('calibration.json', cal);
    console.log(`[Migration] projectedBetKey backfilled on ${patched} calibration entries`);
  }
}

// Recalculate bankroll from unique resolved bets (one per fixtureId, first resolved wins).
// Runs at startup to recover from duplicate-bet inflation or missing bankroll.json.
function recalculateBankroll() {
  const bets     = getBets();
  const resolved = bets.filter(b => b.result && b.pnl != null);
  if (!resolved.length) return;

  // Deduplicate: keep only the first resolved bet per fixtureId
  const seen = new Set();
  const unique = [];
  for (const b of resolved) {
    if (!seen.has(b.fixtureId)) {
      seen.add(b.fixtureId);
      unique.push(b);
    }
  }

  // Remove duplicate bets (keep first per fixtureId, remove remaining)
  if (resolved.length > unique.length || bets.some(b => !b.result && unique.some(u => u.fixtureId === b.fixtureId))) {
    const keepIds = new Set(unique.map(b => b.id));
    // Keep all unresolved bets that are NOT duplicates of a resolved fixture, plus the one canonical resolved bet per fixture
    const deduped = bets.filter(b => {
      if (!b.result) return !seen.has(b.fixtureId); // drop pending duplicates of resolved fixtures
      return keepIds.has(b.id); // keep only canonical resolved bet
    });
    if (deduped.length < bets.length) {
      saveBets(deduped);
      console.log(`[Migration] Removed ${bets.length - deduped.length} duplicate bet entries`);
    }
  }
}

// Checks data files on startup. Corrupt = exists but < MIN_VALID_BYTES.
// Queues backfill chain (30s delay) if any critical file is missing or corrupt.
function startupCheck() {
  const CRITICAL = ['backfill-historical.json', 'team-profiles.json', 'lineups.json'];
  const rebuildQueue = [];

  for (const file of CRITICAL) {
    const p = path.join(DATA_DIR, file);
    try {
      const size = fs.statSync(p).size;
      if (size < MIN_VALID_BYTES) {
        console.warn(`[Startup] ${file}: ${size} bytes — corrupt/empty shell, queuing rebuild`);
        rebuildQueue.push(file);
      }
    } catch {
      console.log(`[Startup] ${file}: not found — queuing rebuild`);
      rebuildQueue.push(file);
    }
  }

  if (rebuildQueue.length > 0) {
    console.log(`[Startup] Queuing backfill chain in 30s (needs: ${rebuildQueue.join(', ')})`);
    _startupStatus = { phase: 'queued', startedAt: null, completedAt: null, skipped: false, error: null, missing: rebuildQueue };
    setTimeout(() => runBackfillChain().catch(e => console.error('[Startup]', e.message)), 30000);
  } else {
    console.log('[Startup] All critical data files present — no backfill needed');
    _startupStatus = { phase: 'complete', skipped: true, completedAt: new Date().toISOString(), missing: [] };
  }
  // WOWY count is computed lazily on first /api/startup/status request (fast now — single profile read)
}

// Extracted backfill logic callable without HTTP context
async function runFixtureStatsBackfillFn({ budget = 2000 } = {}) {
  const STATS_LEAGUES = new Set([39, 2, 140, 135, 78, 61]);
  const STATS_SEASONS = new Set([2022, 2023, 2024]);
  const historical = readJSON('backfill-historical.json');
  if (!historical?.fixtures?.length) return;

  // Interleave by league so budget runs give proportional coverage to all 6 leagues,
  // not just whichever appears first in the historical array.
  const byLeague = {};
  for (const f of historical.fixtures) {
    const lid = f.league?.id, sid = f.league?.season;
    if (!STATS_LEAGUES.has(lid) || !STATS_SEASONS.has(sid)) continue;
    (byLeague[lid] = byLeague[lid] || []).push(f);
  }
  const buckets = Object.values(byLeague);
  const targets = [];
  const maxLen  = Math.max(...buckets.map(b => b.length));
  for (let i = 0; i < maxLen; i++) {
    for (const bucket of buckets) { if (i < bucket.length) targets.push(bucket[i]); }
  }
  const fixtureStatsDb = getFixtureStats();
  let fetched = 0, apiCalls = 0;
  for (const fix of targets) {
    if (backfillCutoffReached()) {
      saveFixtureStats(fixtureStatsDb);
      console.log(`[Startup:Stats] 05:00 UTC cutoff reached — stopping to preserve morning scan quota. ${fetched} fetched this run.`);
      return;
    }
    if (apiCalls >= budget) {
      saveFixtureStats(fixtureStatsDb);
      console.log(`[Startup:Stats] Budget of ${budget} API calls reached — stopping. ${fetched} fetched this run.`);
      return;
    }
    const fid = String(fix.fixture?.id);
    if (fixtureStatsDb[fid]) continue;
    try {
      const { data } = await apiSports.get('/fixtures/statistics', { params: { fixture: fid } });
      apiCalls++;
      if (data?.errors?.requests) {
        console.warn('[Startup:Stats] API rate limit reached — saving progress and stopping');
        setRateLimited();
        saveFixtureStats(fixtureStatsDb);
        return;
      }
      if (data?.response?.length >= 2) {
        const parseStats = ts => {
          const find = t => ts.statistics?.find(s => s.type === t)?.value;
          const xgRaw = find('expected_goals') ?? find('Expected Goals');
          const shotsOn = parseInt(find('Shots on Goal') ?? 0) || 0;
          const totalShots = parseInt(find('Total Shots') ?? 0) || 0;
          const possession = parseFloat(String(find('Ball Possession') ?? '50%').replace('%','')) / 100;
          const xg = xgRaw != null ? parseFloat(xgRaw) || null
            : (shotsOn || totalShots) ? computeXGProxy({ shotsOn, totalShots, possession }) : null;
          return { xg, shotsOn, totalShots, possession };
        };
        fixtureStatsDb[fid] = { home: parseStats(data.response[0]), away: parseStats(data.response[1]) };
        fetched++;
        if (fetched % 50 === 0) {
          saveFixtureStats(fixtureStatsDb);
          console.log(`[Startup:Stats] ${fetched} fetched, ${apiCalls} API calls used`);
        }
      }
      await new Promise(r => setTimeout(r, 350));
    } catch {}
  }
  saveFixtureStats(fixtureStatsDb);
  console.log(`[Startup:Stats] Done — ${fetched} fetched, ${apiCalls} API calls used`);
}

async function runLineupsBackfillFn({ rebuild = false, budget = 7000 } = {}) {
  const LINEUP_LEAGUES = new Set([39, 2, 140, 135, 78, 61]);
  const LINEUP_SEASONS = new Set([2022, 2023, 2024]);
  const historical = readJSON('backfill-historical.json');
  if (!historical?.fixtures?.length) return;

  const targets = historical.fixtures.filter(f =>
    LINEUP_LEAGUES.has(f.league?.id) && LINEUP_SEASONS.has(f.league?.season)
  );
  if (rebuild) {
    saveLineups({});
    const profiles = require('./teamProfiles').readProfiles();
    for (const p of Object.values(profiles)) { if (p.playerDependency) p.playerDependency = null; }
    require('./teamProfiles').saveProfiles(profiles);
  }
  const lineupsDb = getLineups();
  let fetched = 0, apiCalls = 0;
  for (const fix of targets) {
    if (backfillCutoffReached()) {
      saveLineups(lineupsDb);
      console.log(`[Startup:Lineups] 05:00 UTC cutoff reached — stopping to preserve morning scan quota. ${fetched} fetched this run.`);
      return;
    }
    if (apiCalls >= budget) {
      saveLineups(lineupsDb);
      console.log(`[Startup:Lineups] Budget of ${budget} API calls reached — stopping. ${fetched} fetched this run.`);
      return;
    }
    const fid = String(fix.fixture?.id);
    if (lineupsDb[fid]) continue;
    try {
      const { data } = await apiSports.get('/fixtures/lineups', { params: { fixture: fid } });
      apiCalls++;
      if (data?.errors?.requests) {
        console.warn('[Startup:Lineups] API rate limit reached — saving progress and stopping');
        setRateLimited();
        saveLineups(lineupsDb);
        return;
      }
      if (data?.response?.length >= 2) {
        lineupsDb[fid] = {
          home: parseApiLineup(data.response[0]),
          away: parseApiLineup(data.response[1]),
          fetchedAt: new Date().toISOString(),
        };
        fetched++;
        const hg = fix.goals?.home ?? 0, ag = fix.goals?.away ?? 0;
        const outcome = hg > ag ? 'win' : hg < ag ? 'loss' : 'draw';
        const { updateWOWY } = require('./teamProfiles');
        updateWOWY(fix.teams?.home?.id, lineupsDb[fid].home.starters, lineupsDb[fid].home.substitutes || [], outcome);
        updateWOWY(fix.teams?.away?.id, lineupsDb[fid].away.starters, lineupsDb[fid].away.substitutes || [], outcome === 'win' ? 'loss' : outcome === 'loss' ? 'win' : 'draw');
        if (fetched % 50 === 0) {
          saveLineups(lineupsDb);
          console.log(`[Startup:Lineups] ${fetched} fetched, ${apiCalls} API calls used`);
        }
      }
      await new Promise(r => setTimeout(r, 350));
    } catch {}
  }
  saveLineups(lineupsDb);
  console.log(`[Startup:Lineups] Done — ${fetched} fetched, ${apiCalls} API calls used`);
}

// Raw file sizes — lets us verify disk contents without parsing the full JSON
app.get('/api/data/sizes', (_req, res) => {
  const files = [
    'backfill-historical.json', 'fixture-stats.json', 'lineups.json',
    'team-profiles.json', 'calibration.json', 'settings.json',
    'xg-data.json', 'closing-odds.json',
  ];
  const result = {};
  for (const f of files) {
    const p = path.join(DATA_DIR, f);
    try { result[f] = fs.statSync(p).size; } catch { result[f] = null; }
  }
  res.json(result);
});

function normaliseTeamName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\s+fc$/i, '')
    .replace(/\s+afc$/i, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Quick sample to inspect actual field values in both files
app.get('/api/diagnostics/ev-dataset-sample', (_req, res) => {
  const rawCo   = readJSON('closing-odds.json');
  const rawHist = readJSON('backfill-historical.json');
  const coArr   = Array.isArray(rawCo) ? rawCo : Object.entries(rawCo || {}).map(([k,v]) => ({_key: k, ...v}));
  const histArr = Array.isArray(rawHist) ? rawHist : Object.values(rawHist || {});
  // Also try matching the first CO fixture ID against historical
  const firstCoKey = Object.keys(rawCo || {})[0];
  const histById   = histArr.find(f => String(f.fixture?.id) === String(firstCoKey));
  res.json({
    closingOddsIsObject: !Array.isArray(rawCo),
    closingOddsFirstKey: firstCoKey,
    closingOddsSample:  coArr.slice(0, 3),
    historicalSample:   histArr.slice(0, 3).map(f => ({
      _fixtureId:  f.fixture?.id,
      fixtureDate: f.fixture?.date,
      homeTeam:    f.teams?.home?.name,
      awayTeam:    f.teams?.away?.name,
      goalsHome:   f.goals?.home,
      goalsAway:   f.goals?.away,
      league:      f.league?.name,
    })),
    histMatchForFirstCo: histById
      ? { fixtureId: histById.fixture?.id, home: histById.teams?.home?.name, date: histById.fixture?.date }
      : 'NOT FOUND — fixture ID not in historical',
  });
});

app.get('/api/diagnostics/ev-dataset', (_req, res) => {
  try {
    const rawCo      = readJSON('closing-odds.json');
    const rawHist    = readJSON('backfill-historical.json');

    // closing-odds.json may be an object (keyed by fixtureId) or array
    const coEntries  = Array.isArray(rawCo) ? rawCo : (rawCo ? Object.values(rawCo) : []);
    // backfill-historical.json may be an object with a fixtures array, or a plain array
    const historical = Array.isArray(rawHist) ? rawHist
                     : (rawHist?.fixtures ? rawHist.fixtures : (rawHist ? Object.values(rawHist) : []));

    // Peek at structure for debugging
    const coSample   = coEntries[0]   ? Object.keys(coEntries[0])   : [];
    const histSample = historical[0]  ? Object.keys(historical[0])  : [];

    const withPinnacle = coEntries.filter(e => e.pinnacleAvailable);

    // Build historical lookup by fixtureId (the only reliable shared key)
    const histById = {};
    for (const f of historical) {
      const id = String(f.fixture?.id || '');
      if (!id) continue;
      histById[id] = {
        goalsHome:  f.goals?.home,
        goalsAway:  f.goals?.away,
        league:     f.league?.name || 'Unknown',
        date:       (f.fixture?.date || '').slice(0, 10),
        homeTeam:   f.teams?.home?.name || '',
        awayTeam:   f.teams?.away?.name || '',
        hasResult:  f.goals?.home != null || f.goals?.away != null,
      };
    }

    // closing-odds.json is an object keyed by fixtureId
    const coObject = Array.isArray(rawCo) ? {} : (rawCo || {});

    let matched = 0;
    const byLeague = {};
    const dates    = [];

    for (const [fixtureId, e] of Object.entries(coObject)) {
      const isPinnacle = e.bookmaker === 'pinnacle';
      const hist = histById[String(fixtureId)];
      const league = hist?.league || 'Unknown';
      const date   = hist?.date   || (e.snapshotTs || '').slice(0, 10);

      if (!byLeague[league]) byLeague[league] = { total: 0, pinnacle: 0, matched: 0 };
      byLeague[league].total++;
      if (isPinnacle) byLeague[league].pinnacle++;

      if (isPinnacle && hist?.hasResult) {
        matched++;
        byLeague[league].matched++;
        if (date) dates.push(date);
      }
    }

    dates.sort();
    const leagueBreakdown = Object.entries(byLeague)
      .map(([league, d]) => ({ league, total: d.total, pinnacle: d.pinnacle, matched: d.matched }))
      .sort((a, b) => b.matched - a.matched);

    // Q1: how many existing entries already have bookmaker === 'pinnacle'
    const existingPinnacle = coEntries.filter(e => e.bookmaker === 'pinnacle');

    // Q2: date range of historical fixtures, broken down by league
    const TARGET_LEAGUES = ['Premier League','La Liga','Serie A','Bundesliga','Ligue 1'];
    const oneYearAgo = new Date(); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const histDates = [];
    const histByLeague = {};
    for (const f of historical) {
      if (f.goals?.home == null && f.goals?.away == null) continue;
      const date    = (f.fixture?.date || '').slice(0, 10);
      const league  = f.league?.name || 'Unknown';
      const country = f.league?.country || '';
      if (date) histDates.push(date);
      if (!histByLeague[league]) histByLeague[league] = { count: 0, dates: [] };
      histByLeague[league].count++;
      if (date) histByLeague[league].dates.push(date);
    }
    histDates.sort();

    // Q3: fixtures in the 5 target leagues in the last 12 months
    const recentTargetFixtures = historical.filter(f => {
      if (f.goals?.home == null && f.goals?.away == null) return false;
      const date   = (f.fixture?.date || '').slice(0, 10);
      const league = f.league?.name || '';
      return date >= oneYearAgo.toISOString().slice(0,10) && TARGET_LEAGUES.includes(league);
    });
    // Credits: Odds API historical endpoint costs ~10 credits per event returned per call.
    // One call per fixture date (batched by sport/date), returns all events that day.
    // Conservative estimate: 1 call per fixture = 10 credits each.
    const creditEstimate10  = recentTargetFixtures.length * 10;
    const creditEstimate20  = recentTargetFixtures.length * 20;

    const leagueSummary = Object.entries(histByLeague)
      .map(([league, d]) => {
        d.dates.sort();
        return { league, count: d.count, oldest: d.dates[0] || null, newest: d.dates[d.dates.length-1] || null };
      })
      .sort((a,b) => b.count - a.count);

    const recentByLeague = {};
    for (const f of recentTargetFixtures) {
      const l = f.league?.name || 'Unknown';
      recentByLeague[l] = (recentByLeague[l] || 0) + 1;
    }

    res.json({
      // Matching results (key questions)
      closingOddsTotal:    coEntries.length,
      pinnacleEntries:     existingPinnacle.length,
      matchedWithResult:   matched,
      matchedDateRange:    dates.length ? { oldest: dates[0], newest: dates[dates.length - 1] } : null,
      evReadySummary:      `${matched} of ${existingPinnacle.length} Pinnacle closing odds entries matched to a historical result`,
      leagueBreakdown,
      // Historical side
      historicalTotal:     historical.length,
      historicalWithResult: histDates.length,
      historicalDateRange: histDates.length ? { oldest: histDates[0], newest: histDates[histDates.length-1] } : null,
      leagueSummary,
      // Credit estimate (last 12 months, 5 target leagues)
      recentTargetFixtureCount:  recentTargetFixtures.length,
      recentTargetWindow:        `${oneYearAgo.toISOString().slice(0,10)} to today`,
      recentByLeague,
      creditEstimateAt10perCall: creditEstimate10,
      creditEstimateAt20perCall: creditEstimate20,
    });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0,5) });
  }
});

// ─── EV CALIBRATION ──────────────────────────────────────────────────────────

// Per-league calibration reliability audit — docs/calibration-rules.md, 2026-08-04.
// No league has ever passed a genuine time-based train/test split (rule 1), so every
// league is calibrationReliable: false today. The status/note explain why per league:
//   'tainted'   — base rates and/or homeAdvBaseWeight were fit against the full observed
//                 fixture set with no holdout (same pattern as the confirmed SPL
//                 circularity finding), and/or were tuned before the EV-calibration
//                 accuracy fix (35a3028) or the homeAdvBaseWeight live-wiring fix
//                 (adfb425) landed and never revalidated after either fix.
//   'untested'  — LEAGUE_CONFIG values are original defaults, never tuned against any
//                 data at all. Not circular, but not validated either.
// Flip a league's `reliable` to true only after it passes a clean split per the house
// rules — do not flip this by hand without doing the split.
const CALIBRATION_AUDIT = {
  39:  { reliable: true,  status: 'validated', note: 'Genuine time-based train/test split completed 2026-08-05 (train: 2020-09-12 to 2023-12-30, n=1330; test: 2023-12-30 to 2025-05-25, n=570, zero fixture overlap). Base rates tuned on train only (away-win rate corrected +4.3pp to match observed data, a documented recent PL trend), evaluated on test exactly once. The n/posEdgeN/roi below are the held-out test-set result — CI spans zero, posEdgeN below the rule-6 decision-grade floor, so no confirmed edge either way.' },
  135: { reliable: true,  status: 'validated', note: 'Genuine time-based train/test split completed 2026-08-04 (train: 2022-08-13 to 2024-09-15, n=798; test: 2024-09-16 to 2025-05-25, n=342, zero fixture overlap). Base rates tuned on train only, evaluated on test exactly once. The n/posEdgeN/roi below are the held-out test-set result, not the full-population figure — this is the only Serie A number that has never been touched by any tuning decision.' },
  179: { reliable: true,  status: 'validated', note: 'Genuine time-based train/test split completed 2026-08-07 (train: up to 2024-01-02, n=820; test: 2024-01-02 to 2025-05-25, n=352, zero fixture overlap). This is the split that resolves the confirmed SPL circularity finding from earlier this week — base rates are now tuned on train only. Home rate corrected -3.05pp and draw rate +2.28pp to match train-observed frequencies (a real, if modest, correction — SPL had been running notably hotter on home wins than the data actually supports). Test-set result: CI spans zero, posEdgeN=126 well below the rule-6 decision-grade floor — no confirmed edge either way, same pattern as PL/Ligue1.' },
  88:  { reliable: true,  status: 'validated', note: 'Genuine time-based train/test split completed 2026-08-07 (train: up to 2024-01-21, n=1115; test: 2024-01-21 to 2025-05-25, n=478, zero fixture overlap). Away-win rate corrected +2.54pp to match train-observed frequency; home/draw rates were already close to train reality and left unchanged beyond renormalisation. Test-set ROI is a concerning -17.9%, but posEdgeN=115 is far below rule-6\'s floor and the CI spans zero (-43.3%, +7.6%) — flagged as a number to watch as more data accumulates, not a confirmed negative edge.' },
  94:  { reliable: true,  status: 'validated', note: 'Genuine time-based train/test split completed 2026-08-07 (train: up to 2024-01-18, n=1077; test: 2024-01-18 to 2025-05-25, n=462, zero fixture overlap). Away-win rate corrected +5.77pp to match train-observed frequency — the largest single-league correction this cycle, consistent with this rate\'s known instability (it had already been reset once this week after being found stuck at a stale pre-pipeline-fix value). Test-set ROI +5.5%, CI spans zero (-34.9%, +46.0%), posEdgeN=143 below the decision-grade floor — no confirmed edge, but at least a positive-leaning, genuinely out-of-sample number for a base rate that has been unreliable all week.' },
  61:  { reliable: true,  status: 'validated', note: 'Genuine time-based train/test split completed 2026-08-05 (train: 2020-08-21 to 2023-11-03, n=1227; test: 2023-11-03 to 2025-05-21, n=526, zero fixture overlap). Base rates tuned on train only (home/away rates shifted ~3.4pp each way, same direction as the Premier League cycle), evaluated on test exactly once. The n/posEdgeN/roi below are the held-out test-set result — CI spans zero, posEdgeN below the rule-6 decision-grade floor, so no confirmed edge either way (test ROI landed almost exactly at zero).' },
  2:   { reliable: true,  status: 'validated', note: 'Genuine time-based train/test split completed 2026-08-05 (train: 2020-10-20 to 2024-03-12, n=444; test: 2024-03-12 to 2025-05-31, n=191, zero fixture overlap). CAVEAT: train posEdgeN=179 was already below the rule-6 300-400 decision-grade floor — the smallest training population of the four leagues validated today — because Champions League volume is structurally capped (the Odds API sport key only covers group stage onward, not qualifying rounds). Test-set result is a genuinely tempting +35.8% ROI with a CI that nearly excludes zero (-2.7%, +74.4%), but posEdgeN=72 is far too small to call this a finding — treat as a hint worth re-checking once more seasons of data accumulate, not a confirmed edge.' },
  78:  { reliable: true,  status: 'validated', note: 'Genuine time-based train/test split completed 2026-08-07 (train: up to 2024-01-20, n=1077; test: 2024-01-20 to 2025-05-25, n=462, zero fixture overlap). No base-rate adjustment needed — train-observed home/draw/away frequencies (45.5%/24.8%/29.7%) were already within 2pp of the existing config, so the prior full-population fit happened to land close to reality despite the methodology being tainted; homeAdvBaseWeight, previously re-tuned against the full population, is left as-is (out of scope for this cycle — see decisions flagged in docs/tier-calibration-analysis.md). Test-set ROI -20.2%, CI (-41.3%, +1.0%) comes closest of any league this week to excluding zero on the negative side, though posEdgeN=138 is still below the rule-6 floor — worth watching, not yet a confirmed finding.' },
  140: { reliable: true,  status: 'validated', note: 'Genuine time-based train/test split completed 2026-08-07 (train: up to 2024-01-12, n=1330; test: 2024-01-12 to 2025-05-25, n=570, zero fixture overlap). No base-rate adjustment needed — train-observed frequencies were within 2pp of the existing config. homeAdvBaseWeight, previously tuned against the full population (the exact overfitting risk this cycle exists to close), is left unchanged for now — out of scope, flagged for a dedicated follow-up. Test-set ROI -9.6%, CI spans zero (-30.8%, +11.6%), posEdgeN=196 below the decision-grade floor — no confirmed edge either way.' },
  1:   { reliable: false, status: 'untested', note: 'Deliberately left out of the 2026-08-07 train/test cycle — already confirmed structurally unvalidatable (near-zero pure-calibration population, see tier-calibration-analysis.md\'s Scope section; the tournament has also concluded, so no further data will accumulate). This is a documented decision, not an oversight.' },
  3:   { reliable: false, status: 'untested', note: 'Original defaults, never tuned. Too few matched Pinnacle fixtures to compute a reportable ROI at all.' },
  848: { reliable: false, status: 'untested', note: 'Original defaults, never tuned. Too few matched Pinnacle fixtures to compute a reportable ROI at all.' },
};

// Leagues with a genuine, documented train/test split (docs/calibration-rules.md
// rule 9). For these, runEvCalibration() reports the held-out test-set figure only
// — the fixtures on/after testFrom were never touched during tuning — rather than
// the full-population figure every other league still shows.
const VALIDATED_SPLITS = {
  135: { testFrom: '2024-09-16T00:00:00Z', splitCommit: 'f6f582b' }, // Serie A, 2026-08-04
  39:  { testFrom: '2023-12-30T15:00:00Z', splitCommit: '4cdc642' }, // Premier League, 2026-08-05
  61:  { testFrom: '2023-11-03T20:00:00Z', splitCommit: '27e0e2a' }, // Ligue 1, 2026-08-05
  2:   { testFrom: '2024-03-12T20:00:00Z', splitCommit: '6c5ad05' }, // Champions League, 2026-08-05
  179: { testFrom: '2024-01-02T15:00:00Z', splitCommit: 'ee97ca6' }, // Scottish Premiership, 2026-08-07
  78:  { testFrom: '2024-01-20T14:30:00Z', splitCommit: 'ee97ca6' }, // Bundesliga, 2026-08-07
  140: { testFrom: '2024-01-12T20:00:00Z', splitCommit: 'ee97ca6' }, // La Liga, 2026-08-07
  88:  { testFrom: '2024-01-21T13:30:00Z', splitCommit: 'ee97ca6' }, // Eredivisie, 2026-08-07
  94:  { testFrom: '2024-01-18T20:45:00Z', splitCommit: 'ee97ca6' }, // Primeira Liga, 2026-08-07
};

// Extracted so the weekly cron (setupScheduler) can refresh ev-calibration.json
// without going through HTTP — see the '0 6 * * 1' schedule below.
function runEvCalibration() {
    const historical     = readJSON('backfill-historical.json') || {};
    const scoredRecords  = historical.scoredRecords || [];
    const optWeights     = historical.optimisedWeights || {};
    const closingOdds    = readJSON('closing-odds.json') || {};   // keyed by fixtureId

    const { classifyFixture, applyLeagueBiasCorrection, LEAGUE_CONFIG } = require('./scoring');

    const BANDS = [
      { label: '< 0%',   min: -Infinity, max: 0    },
      { label: '0–5%',   min: 0,         max: 0.05 },
      { label: '5–10%',  min: 0.05,      max: 0.10 },
      { label: '10–15%', min: 0.10,      max: 0.15 },
      { label: '15–20%', min: 0.15,      max: 0.20 },
      { label: '20%+',   min: 0.20,      max: Infinity },
    ];

    const matched = [];
    for (const rec of scoredRecords) {
      const co = closingOdds[rec.fixtureId] || closingOdds[String(rec.fixtureId)];
      if (!co) continue;
      if (!rec.actualOutcome) continue;
      if (!rec.homeFactors || !rec.awayFactors) continue;

      const context    = rec.context || classifyFixture(rec.leagueId);
      const weights    = optWeights[context] || optWeights.club_domestic;
      if (!weights) continue;

      // Real live pipeline: GBDT model.predict() -> applyLeagueBiasCorrection(),
      // matching scoreOneFixture() exactly (server.js:882-883). computeModelProb
      // (the linear model) is never used for live predictions — see docs/july-upgrade-notes.md.
      const leagueId  = parseInt(rec.leagueId, 10);
      const rawProbs  = model.predict(rec.homeFactors, rec.awayFactors, weights, context, LEAGUE_CONFIG[leagueId]);
      const probs     = applyLeagueBiasCorrection(rawProbs, leagueId, LEAGUE_CONFIG);

      let topOutcome, modelProb, pinnacleOdds;
      if (probs.home >= probs.draw && probs.home >= probs.away) {
        topOutcome = 'home'; modelProb = probs.home; pinnacleOdds = co.homeOdds;
      } else if (probs.away >= probs.draw) {
        topOutcome = 'away'; modelProb = probs.away; pinnacleOdds = co.awayOdds;
      } else {
        topOutcome = 'draw'; modelProb = probs.draw; pinnacleOdds = co.drawOdds;
      }

      if (!pinnacleOdds || pinnacleOdds <= 1) continue;

      const pinnacleImplied = 1 / pinnacleOdds;
      const edge = (modelProb - pinnacleImplied) / pinnacleImplied;
      const won  = rec.actualOutcome === topOutcome;

      matched.push({ fixtureId: rec.fixtureId, leagueId: rec.leagueId, context,
        topOutcome, modelProb, pinnacleOdds, pinnacleImplied, edge, won, date: rec.date });
    }

    function bandStats(fixtures) {
      return BANDS.map(b => {
        const inBand = fixtures.filter(f => f.edge >= b.min && f.edge < b.max);
        const n = inBand.length;
        let roi = null;
        if (n > 0) {
          const total = inBand.reduce((s, f) => s + (f.won ? (f.pinnacleOdds - 1) : -1), 0);
          roi = parseFloat((total / n).toFixed(4));
        }
        return { band: b.label, n, roi, warning: n < 30 ? 'small_sample' : null };
      });
    }

    function kellyRec(roi) {
      if (roi === null || roi < 0) return 'flag_for_review';
      if (roi < 0.02) return 'quarter_kelly';
      if (roi < 0.05) return 'third_kelly';
      return 'half_kelly';
    }

    const posEdge = matched.filter(f => f.edge >= 0.05);
    let posRoi = null;
    if (posEdge.length > 0) {
      posRoi = parseFloat((posEdge.reduce((s, f) => s + (f.won ? (f.pinnacleOdds - 1) : -1), 0) / posEdge.length).toFixed(4));
    }

    // Per-league stats with per-band breakdown. Leagues with a VALIDATED_SPLITS
    // entry only contribute their held-out test-set fixtures here — the train
    // portion was used for tuning and must never appear in a reported ROI figure.
    const leagueMap = {};
    const leagueIds = {};
    for (const f of matched) {
      const lid   = parseInt(f.leagueId, 10);
      const split = VALIDATED_SPLITS[lid];
      if (split && new Date(f.date) < new Date(split.testFrom)) continue;
      const name = LEAGUE_CONFIG[lid]?.name || `League ${f.leagueId}`;
      if (!leagueMap[name]) leagueMap[name] = [];
      leagueMap[name].push(f);
      leagueIds[name] = lid;
    }
    const byLeague = Object.entries(leagueMap)
    .filter(([, fxs]) => fxs.length >= 100)
    .map(([league, fxs]) => {
      const posE = fxs.filter(f => f.edge >= 0.05);
      let roi = null;
      if (posE.length > 0) {
        roi = parseFloat((posE.reduce((s, f) => s + (f.won ? (f.pinnacleOdds - 1) : -1), 0) / posE.length).toFixed(4));
      }
      const lid  = leagueIds[league];
      const audit = CALIBRATION_AUDIT[lid] || { reliable: false, status: 'unknown', note: 'Not yet audited.' };
      return {
        league,
        leagueId: lid,
        n:       fxs.length,
        posEdgeN: posE.length,
        roi,
        kelly:   kellyRec(roi),
        bands:   bandStats(fxs),
        calibrationReliable: audit.reliable,
        calibrationStatus:   audit.status,
        calibrationNote:     audit.note,
      };
    }).sort((a, b) => b.n - a.n);

    const KELLY_FRACTION_MAP = { half_kelly: 0.5, third_kelly: 0.33, quarter_kelly: 0.25 };
    const overallKelly = kellyRec(posRoi);

    // Persist results and auto-update Kelly fraction in settings
    const result = {
      generatedAt:   new Date().toISOString(),
      summary: {
        totalMatched:        matched.length,
        positiveEdge:        posEdge.length,
        positiveEdgeRoi:     posRoi,
        kellyRecommendation: overallKelly,
      },
      bands:    bandStats(matched),
      byLeague,
    };
    writeJSON('ev-calibration.json', result);

    // Auto-update Kelly fraction and paperTradeOnly leagues based on calibration findings
    const settings = readJSON('settings.json') || {};
    const currentFraction = settings.kellyFraction ?? 0.5;
    const recommendedFraction = KELLY_FRACTION_MAP[overallKelly] ?? currentFraction;
    const kellyChanged = recommendedFraction !== currentFraction && overallKelly !== 'flag_for_review';
    if (kellyChanged) settings.kellyFraction = recommendedFraction;

    // Bidirectional paperTradeOnly management:
    // Add when ROI < 0 AND posEdgeN >= 30 (sufficient evidence of negative edge)
    // Remove when ROI > 0 AND posEdgeN >= 50 AND the league meets the minimum
    // calibration dataset standard (1,000+ matched Pinnacle fixtures — see
    // docs/july-upgrade-notes.md section 18) AND has accumulated live paper-trade
    // evidence this season — backfill ROI alone is not sufficient grounds to lift
    // the lock, no matter how large the historical sample.
    // Premier League (39) and Serie A (135) are never auto-removed regardless of
    // short-term fluctuation — both are already validated, live-eligible leagues.
    const NEVER_AUTO_REMOVE = new Set([39, 135]);
    // Confirmed-positive-GBDT-ROI leagues that must never be auto-*added* to
    // paperTradeOnly by a single bad calibration run (distinct from NEVER_AUTO_REMOVE,
    // which only guards the removal branch below and does nothing to stop an add).
    const PROTECT_FROM_AUTO_ADD = new Set([39, 78, 94, 179, 2]);
    const CURRENT_SEASON_START = new Date('2026-08-01T00:00:00Z');
    const MIN_CALIBRATION_FIXTURES = 1000;
    const MIN_LIVE_PAPER_TRADES = 10;
    function getLivePaperTradeCount(leagueId) {
      return getBets().filter(b =>
        parseInt(b.leagueId, 10) === leagueId &&
        b.mode === 'paper' &&
        b.lockedAt && new Date(b.lockedAt) >= CURRENT_SEASON_START
      ).length;
    }
    const leagueIdByName = Object.fromEntries(
      Object.entries(LEAGUE_CONFIG).map(([id, v]) => [v.name, parseInt(id, 10)])
    );
    const existingPaper = new Set(settings.paperTradeOnly || []);
    for (const l of byLeague) {
      const lid = leagueIdByName[l.league];
      if (!lid || l.roi === null) continue;
      if (l.roi < 0 && l.posEdgeN >= 30 && !PROTECT_FROM_AUTO_ADD.has(lid)) existingPaper.add(lid);
      const meetsCalibrationStandard = l.n >= MIN_CALIBRATION_FIXTURES;
      const hasLivePaperTrades = getLivePaperTradeCount(lid) >= MIN_LIVE_PAPER_TRADES;
      if (l.roi > 0 && l.posEdgeN >= 50 && meetsCalibrationStandard && hasLivePaperTrades && !NEVER_AUTO_REMOVE.has(lid)) {
        existingPaper.delete(lid);
      }
    }
    const newPaper = [...existingPaper];
    settings.paperTradeOnly = newPaper;
    writeJSON('settings.json', settings);

    return {
      ...result,
      kellyAutoUpdated:      kellyChanged,
      previousKellyFraction: currentFraction,
      paperTradeOnly:        newPaper,
    };
}

// ─── SHARP-BOOKS CONSENSUS EV CALIBRATION ─────────────────────────────────────
// Additive, parallel path — does NOT replace or alter runEvCalibration() above,
// which stays the sole input to paperTradeOnly/Kelly auto-management and any
// real-money gating. This exists purely to expand the usable calibration
// population beyond Pinnacle-only matches, per docs/calibration-rules.md-governed
// backtesting work. Validated 2026-08 (Part C of the sharp-books scoping):
// Marathon Bet and Matchbook both track Pinnacle within <1pp mean deviation,
// correlation >0.997, full depth back to 2020 — the two candidates judged close
// enough to Pinnacle to stand in for it, not a general "any book" pool.
//
// For a fixture with a strict Pinnacle match, its actual Pinnacle odds are used
// unchanged (same figure as the Pinnacle-only path). For a fixture WITHOUT a
// Pinnacle match, if closing-odds-multi.json has Marathon Bet and/or Matchbook
// for it, this averages their de-vigged (overround-removed) implied
// probabilities into one blended "fair" probability per outcome, then converts
// that back to an equivalent no-vig odds figure (1/probability) to use as the
// stand-in payout price. That's a simplification worth being explicit about:
// no-vig odds are more generous than any real bookmaker's actual price (real
// books keep their margin), so this is appropriate for gauging whether edge
// exists against a fair consensus line — it is NOT a live-stakeable price and
// must never be treated as one.
function devigOdds(homeOdds, drawOdds, awayOdds) {
  const ih = 1 / homeOdds, id = 1 / drawOdds, ia = 1 / awayOdds;
  const overround = ih + id + ia;
  return { home: ih / overround, draw: id / overround, away: ia / overround };
}

function computeConsensusOdds(fixtureId) {
  const multi = getClosingOddsMulti()[fixtureId];
  if (!multi?.books) return null;
  const probs = [];
  for (const bookKey of CONSENSUS_BOOKS) {
    const b = multi.books[bookKey];
    if (!b) continue;
    probs.push(devigOdds(b.homeOdds, b.drawOdds, b.awayOdds));
  }
  if (probs.length === 0) return null;
  const avg = key => probs.reduce((s, p) => s + p[key], 0) / probs.length;
  const home = avg('home'), draw = avg('draw'), away = avg('away');
  return {
    homeOdds: +(1 / home).toFixed(3),
    drawOdds: +(1 / draw).toFixed(3),
    awayOdds: +(1 / away).toFixed(3),
    booksUsed: Object.keys(multi.books).filter(k => CONSENSUS_BOOKS.includes(k)),
  };
}

function runEvCalibrationConsensus() {
  const historical    = readJSON('backfill-historical.json') || {};
  const scoredRecords = historical.scoredRecords || [];
  const optWeights    = historical.optimisedWeights || {};
  const closingOdds   = readJSON('closing-odds.json') || {};
  const { classifyFixture, applyLeagueBiasCorrection, LEAGUE_CONFIG } = require('./scoring');

  const BANDS = [
    { label: '< 0%',   min: -Infinity, max: 0    },
    { label: '0–5%',   min: 0,         max: 0.05 },
    { label: '5–10%',  min: 0.05,      max: 0.10 },
    { label: '10–15%', min: 0.10,      max: 0.15 },
    { label: '15–20%', min: 0.15,      max: 0.20 },
    { label: '20%+',   min: 0.20,      max: Infinity },
  ];

  const matched = [];
  let pinnacleN = 0, consensusN = 0;
  for (const rec of scoredRecords) {
    if (!rec.actualOutcome || !rec.homeFactors || !rec.awayFactors) continue;
    const context = rec.context || classifyFixture(rec.leagueId);
    const weights  = optWeights[context] || optWeights.club_domestic;
    if (!weights) continue;

    const co = closingOdds[rec.fixtureId] || closingOdds[String(rec.fixtureId)];
    let sourceOdds = null, source = null;
    if (co) { sourceOdds = co; source = 'pinnacle'; }
    else {
      const consensus = computeConsensusOdds(String(rec.fixtureId));
      if (consensus) { sourceOdds = consensus; source = 'consensus'; }
    }
    if (!sourceOdds) continue;

    const leagueId  = parseInt(rec.leagueId, 10);
    const rawProbs  = model.predict(rec.homeFactors, rec.awayFactors, weights, context, LEAGUE_CONFIG[leagueId]);
    const probs     = applyLeagueBiasCorrection(rawProbs, leagueId, LEAGUE_CONFIG);

    let topOutcome, modelProb, bookOdds;
    if (probs.home >= probs.draw && probs.home >= probs.away) { topOutcome = 'home'; modelProb = probs.home; bookOdds = sourceOdds.homeOdds; }
    else if (probs.away >= probs.draw) { topOutcome = 'away'; modelProb = probs.away; bookOdds = sourceOdds.awayOdds; }
    else { topOutcome = 'draw'; modelProb = probs.draw; bookOdds = sourceOdds.drawOdds; }
    if (!bookOdds || bookOdds <= 1) continue;

    const impliedProb = 1 / bookOdds;
    const edge = (modelProb - impliedProb) / impliedProb;
    const won  = rec.actualOutcome === topOutcome;
    if (source === 'pinnacle') pinnacleN++; else consensusN++;

    matched.push({ fixtureId: rec.fixtureId, leagueId: rec.leagueId, context, source,
      topOutcome, modelProb, bookOdds, impliedProb, edge, won, date: rec.date });
  }

  function bandStats(fixtures) {
    return BANDS.map(b => {
      const inBand = fixtures.filter(f => f.edge >= b.min && f.edge < b.max);
      const n = inBand.length;
      let roi = null;
      if (n > 0) {
        const total = inBand.reduce((s, f) => s + (f.won ? (f.bookOdds - 1) : -1), 0);
        roi = parseFloat((total / n).toFixed(4));
      }
      return { band: b.label, n, roi, warning: n < 30 ? 'small_sample' : null };
    });
  }

  const posEdge = matched.filter(f => f.edge >= 0.05);
  const posRoi = posEdge.length
    ? parseFloat((posEdge.reduce((s, f) => s + (f.won ? (f.bookOdds - 1) : -1), 0) / posEdge.length).toFixed(4))
    : null;

  const leagueMap = {};
  for (const f of matched) {
    const lid  = parseInt(f.leagueId, 10);
    const name = LEAGUE_CONFIG[lid]?.name || `League ${f.leagueId}`;
    (leagueMap[name] = leagueMap[name] || []).push(f);
  }
  const byLeague = Object.entries(leagueMap)
    .filter(([, fxs]) => fxs.length >= 100)
    .map(([league, fxs]) => {
      const posE = fxs.filter(f => f.edge >= 0.05);
      const roi = posE.length
        ? parseFloat((posE.reduce((s, f) => s + (f.won ? (f.bookOdds - 1) : -1), 0) / posE.length).toFixed(4))
        : null;
      const pinN = fxs.filter(f => f.source === 'pinnacle').length;
      return {
        league, n: fxs.length, posEdgeN: posE.length, roi,
        pinnacleN: pinN, consensusN: fxs.length - pinN,
        bands: bandStats(fxs),
      };
    }).sort((a, b) => b.n - a.n);

  return {
    generatedAt: new Date().toISOString(),
    note: 'Additive consensus path — Pinnacle-strict fixtures use real Pinnacle odds; the rest use no-vig fair odds averaged across whichever of Marathon Bet/Matchbook are available. Calibration/backtesting use only, never a live price.',
    summary: {
      totalMatched: matched.length, pinnacleN, consensusN,
      positiveEdge: posEdge.length, positiveEdgeRoi: posRoi,
    },
    byLeague,
  };
}

app.get('/api/ev-calibration-consensus', (_req, res) => {
  try {
    res.json(runEvCalibrationConsensus());
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0, 5) });
  }
});

app.get('/api/ev-calibration', (_req, res) => {
  try {
    res.json(runEvCalibration());
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0, 5) });
  }
});

// TEMP diagnostic — Final Pre-Retrain Baseline (task: "Final historical snapshot,
// permanent walk-forward infrastructure, bug fix, and first controlled retrain").
// Runs the exact live pipeline (model.predict + applyLeagueBiasCorrection, the
// same call shape as runEvCalibration() and every prior tier-calibration temp
// endpoint this week) over the current full scored population, restricted to
// each of the 9 VALIDATED_SPLITS leagues' held-out test-only fixtures — the
// last read before that split's purpose is retired and everything merges into
// train for the retrain. Europa League / Conference League have no validated
// split, so they're reported separately against their full population with an
// explicit non-held-out caveat, not mixed into the pooled/validated figures.
// Zero API calls — pure local computation over already-ingested data.
app.get('/api/debug/final-pretrain-baseline', (_req, res) => {
  try {
    const historical    = readJSON('backfill-historical.json') || {};
    const scoredRecords = historical.scoredRecords || [];
    const optWeights    = historical.optimisedWeights || {};
    const closingOdds   = readJSON('closing-odds.json') || {};
    const { classifyFixture, applyLeagueBiasCorrection, LEAGUE_CONFIG } = require('./scoring');
    const { empiricalBayesShrink, varianceForRoi } = require('./shrinkage');

    const WORLD_CUP_ID = 1;
    const TIERS = [
      { label: '<35%',   lo: -Infinity, hi: 0.35 },
      { label: '35-40%', lo: 0.35, hi: 0.40 },
      { label: '40-45%', lo: 0.40, hi: 0.45 },
      { label: '45-50%', lo: 0.45, hi: 0.50 },
      { label: '50-55%', lo: 0.50, hi: 0.55 },
      { label: '55-60%', lo: 0.55, hi: 0.60 },
      { label: '60-65%', lo: 0.60, hi: 0.65 },
      { label: '65-70%', lo: 0.65, hi: 0.70 },
      { label: '70-75%', lo: 0.70, hi: 0.75 },
      { label: '75-80%', lo: 0.75, hi: 0.80 },
      { label: '80%+',   lo: 0.80, hi: Infinity },
    ];
    const ROI_TIER_LABELS = ['<35%', '35-40%', '40-45%', '45-50%', '50-55%', '55-60%', '60-65%', '65-70%'];

    // ── Score every in-scope fixture through the real live pipeline ──
    const scored = [];
    for (const rec of scoredRecords) {
      const lid = parseInt(rec.leagueId, 10);
      if (!LEAGUE_CONFIG[lid] || lid === WORLD_CUP_ID) continue;
      if (!rec.homeFactors || !rec.awayFactors || !rec.actualOutcome) continue;

      const context = rec.context || classifyFixture(lid);
      const weights = optWeights[context] || optWeights.club_domestic;
      if (!weights) continue;

      let probs;
      try {
        const rawProbs = model.predict(rec.homeFactors, rec.awayFactors, weights, context, LEAGUE_CONFIG[lid]);
        probs = applyLeagueBiasCorrection(rawProbs, lid, LEAGUE_CONFIG);
      } catch { continue; }

      let topOutcome, modelProb;
      if (probs.home >= probs.draw && probs.home >= probs.away) { topOutcome = 'home'; modelProb = probs.home; }
      else if (probs.away >= probs.draw)                        { topOutcome = 'away'; modelProb = probs.away; }
      else                                                       { topOutcome = 'draw'; modelProb = probs.draw; }
      const won = rec.actualOutcome === topOutcome;

      let pinnacleOdds = null, edge = null;
      const co = closingOdds[rec.fixtureId] || closingOdds[String(rec.fixtureId)];
      if (co) {
        pinnacleOdds = topOutcome === 'home' ? co.homeOdds : topOutcome === 'away' ? co.awayOdds : co.drawOdds;
        if (pinnacleOdds && pinnacleOdds > 1) edge = (modelProb - (1 / pinnacleOdds)) / (1 / pinnacleOdds);
        else pinnacleOdds = null;
      }

      scored.push({ fixtureId: rec.fixtureId, leagueId: lid, date: rec.date, topOutcome, modelProb, won, pinnacleOdds, edge });
    }

    const validatedIds = Object.keys(VALIDATED_SPLITS).map(Number);
    const validatedTest = scored.filter(r => {
      const s = VALIDATED_SPLITS[r.leagueId];
      return s && new Date(r.date) >= new Date(s.testFrom);
    });
    const unvalidated = { 3: scored.filter(r => r.leagueId === 3), 848: scored.filter(r => r.leagueId === 848) };

    // ── Calibration tables ──
    function calibTable(pop) {
      return TIERS.map(t => {
        const inTier = pop.filter(r => r.modelProb >= t.lo && r.modelProb < t.hi);
        const n = inTier.length;
        if (!n) return { tier: t.label, n: 0 };
        const meanPred = inTier.reduce((s, r) => s + r.modelProb, 0) / n;
        const hitRate  = inTier.filter(r => r.won).length / n;
        return { tier: t.label, n, meanPred: +(meanPred * 100).toFixed(1), hitRate: +(hitRate * 100).toFixed(1), errorPp: +((meanPred - hitRate) * 100).toFixed(1) };
      });
    }
    const pooledCalibValidated = calibTable(validatedTest);
    const perLeagueCalibValidated = {};
    for (const lid of validatedIds) perLeagueCalibValidated[lid] = calibTable(validatedTest.filter(r => r.leagueId === lid));
    const calibUnvalidated = { 3: calibTable(unvalidated[3]), 848: calibTable(unvalidated[848]) };

    // ── ROI (posEdge >= 5%, same threshold as runEvCalibration/Addendum 6) ──
    function roiFor(pop) {
      const posEdge = pop.filter(r => r.edge != null && r.edge >= 0.05);
      const n = posEdge.length;
      if (!n) return { n: 0, roi: null, sampleVariance: null };
      const returns = posEdge.map(r => r.won ? (r.pinnacleOdds - 1) : -1);
      const roi = returns.reduce((s, x) => s + x, 0) / n;
      const sampleVariance = returns.reduce((s, x) => s + (x - roi) ** 2, 0) / n;
      return { n, roi: +(roi * 100).toFixed(1), sampleVariance };
    }
    const roiPooled = {};
    const roiGrid = {};
    for (const label of ROI_TIER_LABELS) {
      const t = TIERS.find(x => x.label === label);
      roiPooled[label] = roiFor(validatedTest.filter(r => r.modelProb >= t.lo && r.modelProb < t.hi));
      roiGrid[label] = {};
      for (const lid of validatedIds) {
        roiGrid[label][lid] = roiFor(validatedTest.filter(r => r.leagueId === lid && r.modelProb >= t.lo && r.modelProb < t.hi));
      }
    }
    // Shrinkage per tier, pooling across the 9 validated leagues (same pattern as Addendum 6)
    const shrunkGrid = {};
    for (const label of ROI_TIER_LABELS) {
      const cells = validatedIds
        .map(lid => ({ id: lid, n: roiGrid[label][lid].n, value: (roiGrid[label][lid].roi ?? 0) / 100, sampleVariance: roiGrid[label][lid].sampleVariance }))
        .filter(c => c.n > 0);
      shrunkGrid[label] = empiricalBayesShrink(cells, varianceForRoi);
    }
    const roiUnvalidated = {
      3:   roiFor(unvalidated[3]),
      848: roiFor(unvalidated[848]),
    };

    res.json({
      scope: {
        validatedLeagueIds:   validatedIds,
        unvalidatedLeagueIds: [3, 848],
        totalScoredInScope:   scored.length,
        validatedTestN:       validatedTest.length,
        europaN:              unvalidated[3].length,
        conferenceN:          unvalidated[848].length,
      },
      pooledCalibValidated,
      perLeagueCalibValidated,
      calibUnvalidated,
      roiPooled,
      roiGrid,
      shrunkGrid,
      roiUnvalidated,
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0, 8) });
  }
});

// ─── LEAGUE MODES ─────────────────────────────────────────────────────────────

const LEAGUE_NAMES_MAP = {
  '39': 'Premier League', '140': 'La Liga', '135': 'Serie A', '78': 'Bundesliga',
  '61': 'Ligue 1', '2': 'Champions League', '1': 'World Cup', '179': 'Scottish Premiership',
  '88': 'Eredivisie', '94': 'Primeira Liga', '3': 'Europa League', '848': 'Conference League',
};

function getLivePaperRecord(leagueId) {
  const lid = String(leagueId);
  const bets = getBets().filter(b => String(b.leagueId) === lid && (!b.mode || b.mode === 'paper'));
  const resolved = bets.filter(b => b.result && b.pnl != null);
  const wins     = resolved.filter(b => b.result === 'win').length;
  const staked   = resolved.reduce((s, b) => s + (b.suggestedStake || 0), 0);
  const returned = resolved.reduce((s, b) => s + (b.suggestedStake || 0) + (b.pnl || 0), 0);
  const roi = staked > 0 ? (returned - staked) / staked : null;
  return { total: bets.length, resolved: resolved.length, wins, losses: resolved.length - wins, roi };
}

function canGoLive(leagueId) {
  const evCal = readJSON('ev-calibration.json');
  const leagueName = LEAGUE_NAMES_MAP[String(leagueId)];
  const leagueEv = evCal?.byLeague?.find(l => l.league === leagueName);
  const paperRecord = getLivePaperRecord(leagueId);
  const activeAccounts = getBookmakers().filter(b => b.status === 'active' && b.balance != null && b.balance > 0);
  return {
    evPositive:      { met: (leagueEv?.roi ?? -1) > 0, value: leagueEv?.roi ?? null, fixtures: leagueEv?.posEdgeN ?? 0 },
    paperTrades50:   { met: paperRecord.resolved >= 50,  value: paperRecord.resolved, required: 50 },
    paperRoiPositive:{ met: paperRecord.roi != null && paperRecord.roi > 0, value: paperRecord.roi },
    fundedAccounts:  { met: activeAccounts.length >= 3,  value: activeAccounts.length, required: 3 },
    allMet: (leagueEv?.roi ?? -1) > 0 && paperRecord.resolved >= 50 && (paperRecord.roi ?? -1) > 0 && activeAccounts.length >= 3,
  };
}

app.get('/api/league-modes', (_req, res) => {
  try {
    const modes   = getLeagueModes();
    const evCal   = readJSON('ev-calibration.json');
    const leagues = Object.keys(LEAGUE_NAMES_MAP).map(lid => {
      const name       = LEAGUE_NAMES_MAP[lid];
      const mode       = modes[lid] || 'paper';
      const leagueEv   = evCal?.byLeague?.find(l => l.league === name);
      const paperRec   = getLivePaperRecord(lid);
      const check      = canGoLive(lid);
      return { leagueId: lid, name, mode, ev: leagueEv || null, paperRecord: paperRec, goLiveCheck: check };
    });
    res.json({ leagues, realBankroll: getRealBankroll() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/league-modes/:leagueId', (req, res) => {
  try {
    const { leagueId } = req.params;
    const { mode } = req.body;
    if (!['paper', 'real', 'disabled'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
    const currentMode = getLeagueMode(leagueId);
    if (currentMode === 'paper_only') return res.status(403).json({ error: 'League is locked to paper_only by EV calibration' });
    const settings = readJSON('settings.json') || {};
    settings.leagueModes = { ...getLeagueModes(), [String(leagueId)]: mode };
    writeJSON('settings.json', settings);
    res.json({ leagueId, mode });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/go-live-check/:leagueId', (req, res) => {
  try {
    const lid = req.params.leagueId;
    res.json({ leagueName: LEAGUE_NAMES_MAP[String(lid)] || `League ${lid}`, ...canGoLive(lid) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/go-live/:leagueId', (req, res) => {
  try {
    const { leagueId } = req.params;
    const check = canGoLive(leagueId);
    if (!check.allMet) return res.status(400).json({ error: 'Go Live conditions not met', check });
    const settings = readJSON('settings.json') || {};
    settings.leagueModes = { ...getLeagueModes(), [String(leagueId)]: 'real' };
    writeJSON('settings.json', settings);
    console.log(`[GoLive] League ${leagueId} (${LEAGUE_NAMES_MAP[leagueId]}) switched to REAL money`);
    res.json({ leagueId, leagueName: LEAGUE_NAMES_MAP[String(leagueId)] || `League ${leagueId}`, mode: 'real', check });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/performance/paper', (_req, res) => {
  try {
    const bets     = getBets().filter(b => !b.mode || b.mode === 'paper');
    const resolved = bets.filter(b => b.result && b.pnl != null);
    const wins     = resolved.filter(b => b.result === 'win');
    const staked   = resolved.reduce((s, b) => s + (b.suggestedStake || 0), 0);
    const pnl      = resolved.reduce((s, b) => s + (b.pnl || 0), 0);
    const roi      = staked > 0 ? pnl / staked : null;
    const br       = getBankroll();
    res.json({
      mode:     'paper',
      bankroll: br.current,
      total:    bets.length,
      resolved: resolved.length,
      wins:     wins.length,
      losses:   resolved.length - wins.length,
      winRate:  resolved.length > 0 ? wins.length / resolved.length : null,
      staked, pnl, roi,
      bets,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/performance/real', (_req, res) => {
  try {
    const bets     = getBets().filter(b => b.mode === 'real');
    const resolved = bets.filter(b => b.result && b.pnl != null);
    const wins     = resolved.filter(b => b.result === 'win');
    const staked   = resolved.reduce((s, b) => s + (b.suggestedStake || 0), 0);
    const pnl      = resolved.reduce((s, b) => s + (b.pnl || 0), 0);
    const roi      = staked > 0 ? pnl / staked : null;
    const bookmakers = getBookmakers().filter(b => b.status === 'active');
    const realBankroll = bookmakers.filter(b => b.balance != null && b.balance > 0)
      .reduce((s, b) => s + b.balance, 0);
    const bookmakerBreakdown = bookmakers
      .filter(b => b.balance != null)
      .map(b => ({ name: b.name, balance: b.balance, status: b.status }))
      .sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));
    res.json({
      mode:     'real',
      realBankroll, bookmakerBreakdown,
      total:    bets.length,
      resolved: resolved.length,
      wins:     wins.length,
      losses:   resolved.length - wins.length,
      winRate:  resolved.length > 0 ? wins.length / resolved.length : null,
      staked, pnl, roi,
      bets,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// TEMPORARY diagnostic endpoint — remove after enriched form pool verification.
app.get('/api/debug/league-backfill', (req, res) => {
  const leagueId = req.query.league;
  const data = readJSON('backfill-historical.json') || { fixtures: [] };
  const fixtures = (data.fixtures || [])
    .filter(f => f.fixture?.status?.short === 'FT')
    .filter(f => String(f.league?.id) === String(leagueId));
  res.json(fixtures);
});

const _serverStartedAt = new Date().toISOString();

app.get('/api/server-status', async (_req, res) => {
  // Disk writability check
  const testFile = path.join(DATA_DIR, '.write-test');
  let diskWritable = false;
  try { fs.writeFileSync(testFile, 'ok'); fs.unlinkSync(testFile); diskWritable = true; } catch {}

  // API quota — non-fatal if rate-limited or fails
  let apiQuotaUsedToday = null;
  if (!isRateLimited()) {
    try {
      const { data: sd } = await apiSports.get('/status');
      apiQuotaUsedToday = sd?.response?.requests?.current ?? null;
    } catch {}
  }

  const hist    = readJSON('backfill-historical.json');
  const stats   = readJSON('fixture-stats.json') || {};
  const lineups = readJSON('lineups.json') || {};
  const profiles = require('./teamProfiles').readProfiles();
  const { getWOWYDeltas: _gwd } = require('./teamProfiles');
  let wowyHighConf = 0;
  for (const p of Object.values(profiles)) {
    if (!p.playerDependency?.players) continue;
    for (const d of Object.values(_gwd(p.teamId))) {
      if (d.confidence === 'high' && !d.selectionBias) wowyHighConf++;
    }
  }

  const DATA_FILES = ['backfill-historical.json','fixture-stats.json','lineups.json','team-profiles.json','calibration.json','settings.json'];
  const files = DATA_FILES.map(f => {
    const p = path.join(DATA_DIR, f);
    try { const s = fs.statSync(p); return { name: f, sizeBytes: s.size, exists: true, healthy: s.size >= MIN_VALID_BYTES }; }
    catch { return { name: f, sizeBytes: null, exists: false, healthy: false }; }
  });

  const lineupsTarget = (hist?.fixtures || []).filter(f =>
    [39, 2, 140, 135, 78, 61].includes(f.league?.id) && [2022, 2023, 2024].includes(f.league?.season)
  ).length;

  const scoredCount   = hist?.scoredRecords?.length ?? 0;
  const nextRetrainAt = Math.ceil((scoredCount + 1) / RETRAIN_THRESHOLD) * RETRAIN_THRESHOLD;
  let gbdtMeta = null;
  try {
    const wp = path.join(__dirname, 'models/gbdt-weights.json');
    if (fs.existsSync(wp)) gbdtMeta = JSON.parse(fs.readFileSync(wp, 'utf8'));
  } catch {}

  res.json({
    server: { uptime: Math.floor(process.uptime()), startedAt: _serverStartedAt, nodeVersion: process.version, buildMarker: 'odds-fetch-fix-v2' },
    disk:   { dataDir: DATA_DIR, writable: diskWritable, files },
    data:   {
      historicalFixtures: hist?.fixtures?.length ?? 0,
      lineups:            Object.keys(lineups).length,
      lineupsTarget,
      stats:              Object.keys(stats).length,
      wowyHighConfidence: wowyHighConf,
      xgData:             { count: Object.keys(getXgStore()).length },
      pir: (() => {
        const { getPIRData } = require('./teamProfiles');
        const pd = getPIRData();
        const entries = Object.values(pd);
        const mostRecent = entries.reduce((a, b) => (!a || b.updatedAt > a.updatedAt) ? b : a, null);
        return { count: entries.length, lastUpdated: mostRecent?.updatedAt ?? null };
      })(),
      transfers: (() => {
        const { getTransfersData } = require('./teamProfiles');
        const td = getTransfersData();
        const entries = Object.values(td);
        const mostRecent = entries.reduce((a, b) => (!a || b.updatedAt > a.updatedAt) ? b : a, null);
        return { count: entries.length, lastUpdated: mostRecent?.updatedAt ?? null };
      })(),
    },
    rateLimit:          getRateLimitState(),
    backfill:           { phase: _startupStatus.phase, startedAt: _startupStatus.startedAt, completedAt: _startupStatus.completedAt, lastRan: _cronLastRan.backfill },
    crons:              { backfill: { lastRan: _cronLastRan.backfill, schedule: '00:05 UTC daily' }, morningScan: { lastRan: _cronLastRan.morningScan, schedule: '07:00 UTC daily' } },
    model: {
      type:          gbdtMeta ? 'gbdt' : 'linear',
      trainedAt:     gbdtMeta?.trainedAt ?? null,
      trainN:        gbdtMeta?.trainN ?? null,
      logLoss:       gbdtMeta?.validation?.logLoss ?? gbdtMeta?.metrics?.logLossGBDT ?? null,
      scoredCount,
      nextRetrainAt,
    },
    apiQuotaUsedToday,
  });
});

// Cache expensive WOWY count — recompute only when profiles change (startup/backfill)
let _wowyHighConfCache = null;
function getWOWYHighConfCount() {
  if (_wowyHighConfCache !== null) return _wowyHighConfCache;
  const { readProfiles } = require('./teamProfiles');
  const profiles = readProfiles(); // read once — getWOWYDeltas re-reads per team, so inline instead
  let count = 0;
  for (const profile of Object.values(profiles)) {
    if (!profile.playerDependency?.players) continue;
    for (const [, rec] of Object.entries(profile.playerDependency.players)) {
      const w = rec.with, wo = rec.without;
      const wTotal = w.w + w.d + w.l, woTotal = wo.w + wo.d + wo.l;
      if (wTotal < 5 || woTotal < 3) continue;
      const withoutRate = (wo.w + 0.5 * wo.d) / woTotal;
      const selectionBias = withoutRate > 0.85 && woTotal < 15
        && ((w.w + 0.5 * w.d) / wTotal - withoutRate) < 0;
      if ((wTotal >= 8 && woTotal >= 5) && !selectionBias) count++;
    }
  }
  _wowyHighConfCache = count;
  return count;
}

app.get('/api/startup/status', (_req, res) => {
  const hist    = readJSON('backfill-historical.json');
  const stats   = readJSON('fixture-stats.json') || {};
  const lineups = readJSON('lineups.json') || {};
  const wowyHighConf = getWOWYHighConfCount();

  const fixtureCount  = hist?.fixtures?.length ?? 0;
  const statsCount    = Object.keys(stats).length;
  const lineupsCount  = Object.keys(lineups).length;
  const lineupsTarget = hist?.fixtures?.filter(f =>
    [39, 2, 140, 135, 78, 61].includes(f.league?.id) &&
    [2022, 2023, 2024].includes(f.league?.season)
  ).length ?? 0;

  res.json({
    ..._startupStatus,
    apiRateLimited: isRateLimited(),
    counts: {
      historicalFixtures: fixtureCount,
      stats: statsCount,
      lineups: lineupsCount,
      lineupsTarget,
      lineupsRemaining: Math.max(0, lineupsTarget - lineupsCount),
      wowyHighConfidence: wowyHighConf,
    },
  });
});

// ─── START ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const startTs = new Date().toISOString();
  console.log(`[Startup] ── Edge Scout ── ${startTs}`);
  console.log(`[Startup] DATA_DIR: ${DATA_DIR}  (env DATA_DIR=${process.env.DATA_DIR ?? '(unset)'})`);

  // 1. Confirm disk is writable
  const testFile = path.join(DATA_DIR, '.write-test');
  try {
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    console.log('[Startup] Disk writable ✓');
  } catch (e) {
    console.error(`[Startup] Disk NOT writable: ${e.message}`);
  }

  // 2. Log data file state
  const DATA_FILES = ['backfill-historical.json','fixture-stats.json','lineups.json','team-profiles.json'];
  for (const f of DATA_FILES) {
    const p = path.join(DATA_DIR, f);
    try {
      const size = fs.statSync(p).size;
      const status = size < MIN_VALID_BYTES ? `⚠ ${size}b (possibly corrupt)` : `${(size/1024).toFixed(0)}KB ✓`;
      console.log(`[Startup] ${f}: ${status}`);
    } catch {
      console.log(`[Startup] ${f}: missing`);
    }
  }

  // 3. Setup cron scheduler
  setupScheduler();

  // 4. Expire stale watching entries
  const nowMs = Date.now();
  const rawWatching = getWatching();
  const future = rawWatching.filter(w => new Date(w.kickoff).getTime() > nowMs);
  if (future.length < rawWatching.length) {
    saveWatching(future, { allowEmpty: true });
    console.log(`[Startup] Expired ${rawWatching.length - future.length} past-kickoff watching entries`);
  }

  // 5. Migrate stale calibration entries (idempotent — skips already-patched entries)
  migrateCalibrationProjectedBetKey();
  // 5b. Recalculate bankroll from unique resolved bets (fixes duplicate-bet inflation)
  recalculateBankroll();
  // 5b2. Repair bankroll.json if missing/unparsable/structurally invalid (not just small —
  // a healthy {initial, lastUpdated} file is legitimately well under MIN_VALID_BYTES)
  {
    const brPath = path.join(DATA_DIR, 'bankroll.json');
    let brSize = 0;
    let needsRepair = false;
    try {
      brSize = fs.statSync(brPath).size;
      const parsed = JSON.parse(fs.readFileSync(brPath, 'utf8'));
      if (typeof parsed.initial !== 'number') needsRepair = true;
    } catch {
      needsRepair = true;
    }
    try {
      if (needsRepair) {
        const repaired = getBankroll();
        writeJSON('bankroll.json', { initial: repaired.initial, lastUpdated: new Date().toISOString() });
        console.log(`[Startup] Repaired corrupt bankroll.json (was ${brSize}b) — initial: ${repaired.initial}, current: ${repaired.current}`);
      }
    } catch { /* file missing — will be created on first save */ }
  }
  // 5c. Seed bookmakers.json if not yet on disk, or migrate existing entries
  {
    const existing = readJSON('bookmakers.json');
    if (!existing) {
      saveBookmakers(DEFAULT_BOOKMAKERS);
      console.log('[Startup] Seeded bookmakers.json with', DEFAULT_BOOKMAKERS.length, 'accounts');
    } else {
      const defaults = Object.fromEntries(DEFAULT_BOOKMAKERS.map(b => [b.id, b]));
      let changed = false;
      // Patch each existing entry with any missing/updated fields from defaults
      for (const b of existing) {
        const def = defaults[b.id];
        if (!def) continue;
        if (b.parentGroup == null && def.parentGroup) { b.parentGroup = def.parentGroup; changed = true; }
        if (b.commission == null && def.commission != null) { b.commission = def.commission; changed = true; }
        if (b.id === 'matchbook' && b.tier !== 1) { b.tier = 1; changed = true; }
      }
      // Add BETDAQ if not present
      if (!existing.find(b => b.id === 'betdaq')) {
        existing.splice(3, 0, defaults['betdaq']); // after Matchbook in tier-1 group
        changed = true;
      }
      if (changed) {
        saveBookmakers(existing);
        console.log('[Startup] Migrated bookmakers.json — added parentGroup, commission, BETDAQ, Matchbook tier fix');
      }
    }
  }
  // 5d. Seed tournament-seeds.json if not yet on disk
  if (!readJSON('tournament-seeds.json')) {
    saveTournamentSeeds(WC_2026_SEEDS);
    console.log('[Startup] Seeded tournament-seeds.json with WC 2026 seedings for', Object.keys(WC_2026_SEEDS.teams).length, 'teams');
  }

  // 5e. Consistency check — auto-sync activeLeagues with LEAGUE_CONFIG so settings.json
  // on the persistent disk can never silently fall behind the code's league list.
  {
    const settings           = getSettings();
    const configuredLeagues  = Object.keys(LEAGUE_CONFIG);
    const activeLeagues      = settings.activeLeagues || [];
    const missingFromActive  = configuredLeagues.filter(id => !activeLeagues.includes(id));
    if (missingFromActive.length > 0) {
      console.warn(`[Startup] WARNING: ${missingFromActive.length} leagues in LEAGUE_CONFIG but missing from activeLeagues: ${missingFromActive.join(', ')}`);
      console.warn(`[Startup] Auto-adding missing leagues to activeLeagues: ${missingFromActive.join(', ')}`);
      settings.activeLeagues = [...new Set([...activeLeagues, ...missingFromActive])];
      saveSettings(settings);
    }
  }

  // 6. Queue backfill chain if data is missing/corrupt
  startupCheck();

  // 6. Morning scan if today's has not completed (runs regardless of backfill state —
  //    scan fetches its own form data from the API, doesn't depend on historical backfill)
  const today = new Date().toISOString().split('T')[0];
  const scanMeta = readJSON('scan-meta.json');
  if (!scanMeta || scanMeta.date !== today || !scanMeta.completedAt) {
    if (!isRateLimited()) {
      console.log('[Startup] No completed scan for today — running morning scan…');
      runMorningScan(getSettings().activeLeagues).catch(e => console.error('[Startup:MorningScan]', e.message));
    } else {
      console.log('[Startup] Morning scan deferred — API rate limited (quota resets midnight UTC)');
    }
  } else {
    console.log(`[Startup] Today's scan already completed at ${scanMeta.completedAt} (${scanMeta.count} watching)`);
  }

  // 7. Summary
  const hist = readJSON('backfill-historical.json');
  const lin  = readJSON('lineups.json') || {};
  const st   = readJSON('fixture-stats.json') || {};
  console.log(`[Startup] Data counts — fixtures: ${hist?.fixtures?.length ?? 0}, lineups: ${Object.keys(lin).length}, stats: ${Object.keys(st).length}`);
  console.log(`[Startup] Next scheduled: backfill@00:05UTC · scan@07:00UTC`);
  console.log(`[Startup] Ready on :${PORT}`);
});
