'use strict';

const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const cron     = require('node-cron');
const { v4: uuidv4 } = require('uuid');

const {
  classifyFixture, WEIGHTS_BY_CONTEXT, CONTEXT_CONFIG, LEAGUE_CONFIG,
  formScore, homeAdvScore, xgScore, defenseScore, momentumScore,
  h2hScore, standingsScore, injuryScore,
  computeModelProb, computeXGProxy, classifyCompetitionPhase,
  kelly, computeSuccessScore, weatherModifier,
  reloadXgStore, getXgStore,
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
} = require('./weightOptimiser');

const app  = express();
const PORT = process.env.PORT || 3000;

const API_SPORTS_KEY = process.env.API_SPORTS_KEY || '36e45a67eec7cabd0a51db8f2570f934';
const ODDS_API_KEY   = process.env.ODDS_API_KEY   || '822efb9daf359532c828e4205e6beb56';
const DATA_DIR       = process.env.DATA_DIR || path.join(__dirname, 'data');

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
      activeLeagues: ['1','39','140','78','135','61','2'], successThreshold: 40,
      decay: 0.05, formWindow: 6, h2hWindow: 5, kellyFraction: 0.5,
      weights: { form:18, homeAdv:12, xg:16, h2h:10, defense:14, momentum:10, injuries:8, standings:12 } };
    const settingsTmp = settingsDest + '.tmp';
    fs.writeFileSync(settingsTmp, JSON.stringify(defaults, null, 2));
    fs.renameSync(settingsTmp, settingsDest);
    console.log('[Data] Seeded settings.json with defaults');
  }
})();

const MIN_VALID_BYTES = 100;

function readJSON(file) {
  const fullPath = path.join(DATA_DIR, file);
  try {
    const size = fs.statSync(fullPath).size;
    if (size < MIN_VALID_BYTES) {
      console.warn(`[Data] readJSON(${file}): ${size} bytes — possibly corrupt, treating as missing`);
      return null;
    }
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[Data] readJSON(${file}): ${e.message}`);
    return null;
  }
}

function writeJSON(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dest = path.join(DATA_DIR, file);
  const tmp  = dest + '.tmp';
  try {
    const serialised = JSON.stringify(data, null, 2);
    // Guard: never overwrite a substantial file with an empty structure
    if (serialised.length < 10) {
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
  activeLeagues: ['1','39','140','78','135','61','2'], successThreshold: 40,
  calibrationFactor: 1.08,
  wowyActive: true,
  preferExchange: true,
  preferExchangeBuffer: 5,
};

function getSettings() {
  const stored = readJSON('settings.json');
  return stored ? { ...SETTINGS_DEFAULTS, ...stored } : { ...SETTINGS_DEFAULTS };
}

// ── Rate limit — single source of truth ──────────────────────────────────────
const { setRateLimited, isRateLimited, getRateLimitState, backfillCutoffReached } = require('./rateLimit');

function getBankroll() {
  const stored  = readJSON('bankroll.json') || { initial: 1000, lastUpdated: null };
  const initial = stored.initial || 1000;
  // Compute current from resolved bets (deduplicated by fixtureId) so cached value can never be stale
  const bets    = readJSON('bets.json') || [];
  const seen    = new Set();
  let computed  = initial;
  for (const b of bets) {
    if (b.result && b.pnl != null && !seen.has(b.fixtureId)) {
      seen.add(b.fixtureId);
      computed += b.pnl;
    }
  }
  const current = parseFloat(computed.toFixed(2));
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
  { id: 'betfair_exchange', name: 'Betfair Exchange', tier: 1, balance: null, status: 'active', statusUpdatedAt: null, statusNotes: '', maxStake: null, maxStakeObserved: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: 'Exchange — lay/back, ~2% commission. No restrictions ever.' },
  { id: 'smarkets',         name: 'Smarkets',         tier: 1, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: 'Exchange — ~2% commission. No restrictions ever.' },
  { id: 'pinnacle',         name: 'Pinnacle',         tier: 2, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: 'Sharp book. Highest limits, rarely restricts winners.' },
  { id: 'unibet',           name: 'Unibet',           tier: 2, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: 'European book. Higher tolerance than UK soft.' },
  { id: 'betsson',          name: 'Betsson',          tier: 2, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'nordicbet',        name: 'NordicBet',        tier: 2, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'bet365',           name: 'Bet365',           tier: 3, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'william_hill',     name: 'William Hill',     tier: 3, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'ladbrokes',        name: 'Ladbrokes',        tier: 3, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'coral',            name: 'Coral',            tier: 3, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'paddy_power',      name: 'Paddy Power',      tier: 3, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'betfair_sb',       name: 'Betfair Sportsbook', tier: 3, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: 'Separate account from Betfair Exchange.' },
  { id: 'skybet',           name: 'Sky Bet',          tier: 3, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'betway',           name: 'Betway',           tier: 3, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: '888sport',         name: '888sport',         tier: 3, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'betvictor',        name: 'BetVictor',        tier: 3, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'betfred',          name: 'Betfred',          tier: 3, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'boylesports',      name: 'BoyleSports',      tier: 3, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'quinnbet',         name: 'QuinnBet',         tier: 3, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: '10bet',            name: '10Bet',            tier: 3, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: '' },
  { id: 'matchbook',        name: 'Matchbook',        tier: 3, balance: null, status: 'active', maxStake: null, lastUsed: null, betsThisWeek: 0, betsThisMonth: 0, totalBets: 0, totalStaked: 0, totalReturned: 0, restrictionSignals: [], notes: 'Exchange-style, low commission.' },
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
function saveWatching(list)     { writeJSON('watching.json', list); }
function saveBankroll(br)       { writeJSON('bankroll.json', { ...br, lastUpdated: new Date().toISOString() }); }
function saveCalibration(list)  { writeJSON('calibration.json', list); }
function saveOddsHistory(list)  { writeJSON('odds-history.json', list); }

// Fixture stats: keyed by fixture ID (string). Each entry: { home: {xg, shotsOn, totalShots, possession}, away: {...} }
function getFixtureStats() { return readJSON('fixture-stats.json') || {}; }
function saveFixtureStats(data) { writeJSON('fixture-stats.json', data); }

// Lineups: keyed by fixture ID. Each entry: { home: {teamId, starters:[{id,name}], substitutes:[{id,name}], formation}, away: {...}, fetchedAt }
function getLineups() { return readJSON('lineups.json') || {}; }
function saveLineups(data) { writeJSON('lineups.json', data); }

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
  '2':   { name: 'Champions League',    season: 2024, sport: 'soccer_uefa_champs_league' },
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
  { leagueId: '39',  name: 'Premier League',             seasons: [2024, 2023, 2022] },
  { leagueId: '140', name: 'La Liga',                    seasons: [2024, 2023, 2022] },
  { leagueId: '78',  name: 'Bundesliga',                 seasons: [2024, 2023, 2022] },
  { leagueId: '135', name: 'Serie A',                    seasons: [2024, 2023, 2022] },
  { leagueId: '61',  name: 'Ligue 1',                    seasons: [2024, 2023, 2022] },
  { leagueId: '2',   name: 'UEFA Champions League',      seasons: [2024, 2023, 2022] },
];

// ─── FIFA RANKING QUALITY ANCHOR ─────────────────────────────────────────────
// Hardcoded approximate FIFA rankings for WC 2026 teams + major leagues.
// Used to calibrate model when historical fixture data is thin (≤15 matches).

const FIFA_RANK_FALLBACK = {
  'Argentina':1,'France':2,'England':3,'Brazil':4,'Belgium':5,
  'Portugal':6,'Spain':7,'Netherlands':8,'Colombia':8,'Italy':9,
  'Germany':10,'Croatia':12,'Morocco':13,'Switzerland':14,'Denmark':14,
  'United States':15,'USA':15,'Mexico':16,'Uruguay':17,'Japan':19,
  'Senegal':18,'Austria':25,'Sweden':28,'Turkey':31,'Algeria':36,
  'Chile':35,'Norway':37,'Czechia':38,'Scotland':40,'Slovenia':42,
  'Slovakia':43,'Romania':46,'Nigeria':47,'Côte d\'Ivoire':50,'Ireland':50,
  'Costa Rica':51,'Canada':51,'Finland':52,'Cameroon':53,'Bosnia & Herzegovina':62,
  'Bosnia':62,'Venezuela':58,'Democratic Republic of Congo':59,'Iraq':59,
  'Qatar':66,'Iceland':67,'Honduras':73,'El Salvador':73,'Jordan':87,
  'China PR':91,'China':91,'Peru':93,'Indonesia':130,'Kuwait':145,
  'South Korea':23,'Australia':24,'Ecuador':45,'Ghana':60,'Jamaica':62,
  'Panama':64,'Saudi Arabia':56,'Iran':22,'Ukraine':22,'Poland':26,
  'Wales':29,'Hungary':27,'Serbia':33,'Egypt':36,'Tunisia':30,
  'Bolivia':82,'Paraguay':63,'New Zealand':90,'Palestine':95,'Georgia':74,
  'Tajikistan':105,'Thailand':115,'Vietnam':119,'India':127,'Uzbekistan':70,
};

function lookupFIFARank(teamName) {
  if (!teamName) return 55;
  const lower = teamName.toLowerCase();
  const key = Object.keys(FIFA_RANK_FALLBACK).find(k =>
    lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower)
  );
  return key ? FIFA_RANK_FALLBACK[key] : 55; // default: ~55th in world
}

function rankToQuality(rank) {
  // rank 1 → 100, rank 55 → 50, rank 105 → 0 (clamped 5-100)
  return Math.max(5, Math.min(100, Math.round(105 - rank)));
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

async function fetchOddsForLeague(sport) {
  try {
    const { data } = await oddsApi.get(`/sports/${sport}/odds`, {
      params: { apiKey: ODDS_API_KEY, regions: 'uk,eu', markets: 'h2h', oddsFormat: 'decimal' },
    });
    const events = data || [];
    _oddsRawCache[sport] = events;
    const map = {};
    events.forEach(ev => {
      const home = ev.home_team, away = ev.away_team;
      const key  = `${home}|${away}`;

      // Pinnacle: sharpest market — use for implied prob / edge signal
      const pinnacle    = ev.bookmakers?.find(b => b.title === 'Pinnacle');
      const pinnPrices  = _extractPrices(pinnacle);
      const pinnStripped = _pinnacleStripped(pinnPrices, home, away); // margin-free true probs

      // Best UK book: use for displayed odds and Kelly sizing
      const ukBook   = ev.bookmakers?.find(b => UK_BOOKS.has(b.title)) || ev.bookmakers?.[0];
      const ukPrices = _extractPrices(ukBook);

      // All exchanges: commission-adjusted prices from betfair_ex_*/smarkets/matchbook
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
      // Best exchange by home-team net price (kept for display fallback when outcome unknown)
      const bestExchange = allExchanges.reduce((best, ex) =>
        !best || (ex.net[home] || 0) > (best.net[home] || 0) ? ex : best, null);

      if (ukPrices) {
        // Top-level keys stay as {teamName: price} for backward compat (UK book odds)
        map[key] = { ...ukPrices, _pinnacleStripped: pinnStripped, _pinnacleRaw: pinnPrices, _exchangeOdds: bestExchange, _allExchangeOdds: allExchanges };
      }
    });
    return map;
  } catch { return {}; }
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

async function scoreOneFixture(fix, formFixtures, standings, statsCache, oddsMap, settings) {
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
  const weights  = settings.optimisedWeights?.[context] || WEIGHTS_BY_CONTEXT[context];
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

  const homeF = {
    form:      formScore(scoringPool, homeId, fw, d),
    homeAdv:   homeAdvScore(scoringPool, homeId, d),
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

  let probs = model.predict(homeF, awayF, weights, context, leagueConfig);

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
    const neutralVenue = context === 'international' &&
      (competitionPhase === 'group_stage' || competitionPhase === 'knockout');
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

  const { probs: adjustedProbs, teamIntel } = applyTeamProfileModifiers(
    probs, homeProfile, awayProfile, context, dataConf, homeDays, awayDays, weatherForModifier,
    { wowyActive, competitionPhase }
  );
  probs = adjustedProbs;

  // Build results for H/D/A
  // Canonical bet keys ('Home Win'/'Away Win'/'Draw') are preserved for resolution matching.
  // At neutral WC venues a display label is added so the UI shows team names instead of
  // directional labels — "Panama Win" not "Home Win" when neither team is at home.
  const neutralLabels = competitionPhase === 'group_stage' || competitionPhase === 'knockout';

  const oddsKey    = `${homeName}|${awayName}`;
  const bookOdds   = oddsMap[oddsKey] || {};
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
    const rawScore  = computeSuccessScore(calProb, displayOdds, homeFormCount, dataConf);
    const finalScore = Math.round(rawScore * wxMod * effMult);
    const k         = kelly(calProb, displayOdds, settings.kellyFraction, getBankroll().current);

    const entry = {
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
  const lowConfidence  = maxModelBookGap > gapThreshold || maxModelBookGap > tierThreshold;
  results.forEach(c => { c.lowConfidence = lowConfidence; });

  // WOWY key player signals — top movers by |delta| for each team, with confidence flag
  const wowyToKeyPlayers = (teamId, isHome) => {
    const deltas = getWOWYDeltas(teamId);
    return Object.entries(deltas)
      .filter(([, d]) => Math.abs(d.delta) >= 0.10) // only meaningful signals
      .sort((a, b) => Math.abs(b[1].delta) - Math.abs(a[1].delta))
      .slice(0, 3)
      .map(([pid, d]) => ({
        playerId: parseInt(pid, 10),
        name: d.name,
        delta: d.delta,
        withRate: d.withRate,
        withoutRate: d.withoutRate,
        wTotal: d.wTotal,
        woTotal: d.woTotal,
        confidence: d.confidence,
        selectionBias: d.selectionBias || false,
      }));
  };
  if (teamIntel.home) teamIntel.home.keyPlayers = wowyToKeyPlayers(homeId, true);
  if (teamIntel.away) teamIntel.away.keyPlayers = wowyToKeyPlayers(awayId, false);

  return {
    fix, homeName, awayName, homeF, awayF, probs, weather, weatherCondition, results,
    kickoff: fix.fixture?.date,
    context, competitionPhase, lowConfidence,
    homeDataConf, awayDataConf, dataConf,
    homeFormCount, awayFormCount, minFormCount, tierThreshold,
    teamIntel,
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

      // Accumulate for team profile rebuild (deduplicate by fixture ID)
      formFixtures.forEach(f => allFormFixtures.set(f.fixture?.id, f));

      // Standings
      const { data: sd } = await apiSports.get('/standings', { params: { league: leagueId, season: meta.season } });
      const standings = sd?.response?.[0]?.league?.standings || [];

      // Odds
      const oddsMap = await fetchOddsForLeague(meta.sport || 'soccer_epl');

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
          const scored = await scoreOneFixture(fix, formFixtures, standings, statsCache, oddsMap, settings);
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
            candidates:   scored.results,
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
              allCandidates:   scored.results,
              weather:         scored.weather,
              homeF:           scored.homeF,
              awayF:           scored.awayF,
              calId:           calEntry.id,
              lowConfidence:    scored.lowConfidence,
              context:          scored.context,
              competitionPhase: scored.competitionPhase,
              homeDataConf:     scored.homeDataConf,
              awayDataConf:     scored.awayDataConf,
              teamIntel:        scored.teamIntel,
              weatherCondition: scored.weatherCondition,
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
    const oddsMap   = await fetchOddsForLeague(meta.sport || 'soccer_epl');

    const scored = await scoreOneFixture(fix, formFixtures, standings, statsCache, oddsMap, settings);
    const best   = scored.results.reduce((a, b) => a.successScore > b.successScore ? a : b);
    persistOddsSnapshot(fix, scored, meta.sport || 'soccer_epl', 'pre_match_lock', leagueId, meta.name, settings);

    if (best.successScore < threshold) {
      console.log(`[PreMatch] ${scored.homeName} vs ${scored.awayName} DROPPED (score ${best.successScore} < ${threshold})`);
      return null;
    }
    if (scored.lowConfidence) {
      console.log(`[PreMatch] ${scored.homeName} vs ${scored.awayName} DROPPED — low confidence (model/book divergence too large for data level)`);
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

    // Lock the bet
    const br    = getBankroll();
    const betId = uuidv4();
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
      kellyFraction: settings.kellyFraction,
      kellStake:     best.kelly.stake,
      suggestedStake: roundStake(best.kelly.stake),
      displayStake:  roundStake(best.kelly.stake),
      bankrollAtLock: br.current,
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
        exchangeOdds:    (oddsMap[`${scored.homeName}|${scored.awayName}`] || {})._exchangeOdds    || null,
        allExchangeOdds: (oddsMap[`${scored.homeName}|${scored.awayName}`] || {})._allExchangeOdds || [],
        outcomeName: best.bet === 'Home Win' ? scored.homeName
                   : best.bet === 'Away Win' ? scored.awayName
                   : 'Draw',
        settings,
      }),
      // Placement confirmation fields (filled by user after manual placement)
      placementConfirmed: false,
      bookmakerUsed: null,
      bookmakerId:   null,
      actualOdds:    null,
      actualStake:   null,
      placedAt:      null,
    };

    const bets = getBets();
    if (bets.some(b => b.fixtureId === fix.fixture.id)) {
      console.log(`[PreMatch] Bet already exists for fixture ${fix.fixture.id} (${scored.homeName} vs ${scored.awayName}) — skipping duplicate`);
      return null;
    }
    bets.unshift(bet);
    saveBets(bets);

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

      const hg            = fix.goals?.home ?? 0;
      const ag            = fix.goals?.away ?? 0;
      const actualOutcome = hg > ag ? 'Home Win' : hg < ag ? 'Away Win' : 'Draw';
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

const _cronRunning = { backfill: false, morningScan: false, preMatch: false, resolve: false };
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
      saveWatching(futureW);
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

  console.log('[Scheduler] Crons active: backfill@00:05UTC · scan@07:00UTC · T-60@every-min · resolve@every-5min');
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

const HISTORICAL_BACKFILL_CONFIG = [
  { leagueId: '39',  name: 'Premier League',   seasons: [2024, 2023, 2022] },
  { leagueId: '140', name: 'La Liga',           seasons: [2024, 2023, 2022] },
  { leagueId: '135', name: 'Serie A',           seasons: [2024, 2023, 2022] },
  { leagueId: '78',  name: 'Bundesliga',        seasons: [2024, 2023, 2022] },
  { leagueId: '61',  name: 'Ligue 1',           seasons: [2024, 2023, 2022] },
  { leagueId: '2',   name: 'Champions League',  seasons: [2024, 2023, 2022] },
  { leagueId: '32',  name: 'WC Qual UEFA',      seasons: [2024, 2020] },
  { leagueId: '34',  name: 'WC Qual CONMEBOL',  seasons: [2026, 2022] },
  { leagueId: '31',  name: 'WC Qual CONCACAF',  seasons: [2026, 2022] },
  { leagueId: '5',   name: 'Nations League',    seasons: [2024, 2022] },
  { leagueId: '10',  name: 'Intl Friendlies',   seasons: [2024, 2023, 2022] },
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

    // ── Phase 1: Fetch missing league/season pairs ─────────────────────────
    for (const entry of allCombos) {
      const key = `${entry.leagueId}_${entry.season}`;
      if (existing.fetchedLeagues[key]) {
        const msg = `[Skip] ${entry.name} ${entry.season} (${existing.fetchedLeagues[key].count} cached)`;
        console.log(msg); onProgress?.(msg);
      } else {
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
        const record = scoreFixtureFromPool(fix, teamIndex, standingsIndex);
        if (record) {
          scoredMap.set(record.fixtureId, record);
          scored++;
        }

        // Incremental optimisation checkpoint
        if (scoredMap.size >= nextOptimiseAt && scoredMap.size >= OPTIMISE_EVERY) {
          const msg = `[Optimise] Checkpoint at ${scoredMap.size} records — running optimisation…`;
          console.log(msg); onProgress?.(msg);
          _runOptimisation([...scoredMap.values()], existing, onProgress);
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

app.use(cors());
app.use(express.json());
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

// GET / PUT bankroll
app.get('/api/bankroll', (_req, res) => res.json(getBankroll()));
app.post('/api/bankroll/reset', (_req, res) => {
  const br = { initial: 1000, current: 1000 };
  saveBankroll(br);
  saveBets([]);
  saveWatching([]);
  res.json(br);
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
      const weights = (settings.optimisedWeights?.[r.context]) || WEIGHTS_BY_CONTEXT[r.context] || WEIGHTS_BY_CONTEXT.club_domestic;
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

// Trigger pre-match scan for a specific watching entry
app.post('/api/scan/prematch/:watchId', async (req, res) => {
  const watching = getWatching();
  const entry    = watching.find(w => w.id === req.params.watchId);
  if (!entry) return res.status(404).json({ error: 'Not found in watching list' });
  const bet = await runPreMatchScan(entry);
  if (bet) {
    saveWatching(watching.filter(w => w.id !== entry.id));
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
  const bestPrice = eligible.find(b => b.id !== recommended?.id) || null;

  // Build routing warnings for signal/limited accounts
  const routingWarning = recommended
    ? (recommended.status === 'signal'  ? '⚠ Restriction signal — consider reduced stake'
       : recommended.status === 'limited' ? '⚠ Account limited — use maxStakeObserved cap'
       : null)
    : null;

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
      _startupStatus.phase = 'complete';
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
      _startupStatus.phase = 'complete';
      _startupStatus.completedAt = new Date().toISOString();
      return;
    }
    _startupStatus.phase = 'fixture-stats';
    console.log('[Backfill] Phase 3/3: fixture stats (budget: 1,000 calls)…');
    await runFixtureStatsBackfillFn({ budget: 1000 });
    const statsAfter = readJSON('fixture-stats.json') || {};
    console.log(`[Backfill] Phase 3 complete — ${Object.keys(statsAfter).length} stats on disk`);

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

  const initial = getBankroll().initial || 1000;
  const current = parseFloat((initial + unique.reduce((sum, b) => sum + b.pnl, 0)).toFixed(2));
  const br = getBankroll();
  if (br.current !== current) {
    saveBankroll({ ...br, current, initial });
    console.log(`[Migration] Bankroll recalculated from ${unique.length} unique resolved bets: £${br.current} → £${current}`);
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
  ];
  const result = {};
  for (const f of files) {
    const p = path.join(DATA_DIR, f);
    try { result[f] = fs.statSync(p).size; } catch { result[f] = null; }
  }
  res.json(result);
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

  res.json({
    server: { uptime: Math.floor(process.uptime()), startedAt: _serverStartedAt, nodeVersion: process.version },
    disk:   { dataDir: DATA_DIR, writable: diskWritable, files },
    data:   {
      historicalFixtures: hist?.fixtures?.length ?? 0,
      lineups:            Object.keys(lineups).length,
      lineupsTarget,
      stats:              Object.keys(stats).length,
      wowyHighConfidence: wowyHighConf,
      xgData:             { count: Object.keys(getXgStore()).length },
    },
    rateLimit:          getRateLimitState(),
    backfill:           { phase: _startupStatus.phase, startedAt: _startupStatus.startedAt, completedAt: _startupStatus.completedAt, lastRan: _cronLastRan.backfill },
    crons:              { backfill: { lastRan: _cronLastRan.backfill, schedule: '00:05 UTC daily' }, morningScan: { lastRan: _cronLastRan.morningScan, schedule: '07:00 UTC daily' } },
    apiQuotaUsedToday,
  });
});

app.get('/api/startup/status', (_req, res) => {
  const hist     = readJSON('backfill-historical.json');
  const stats    = readJSON('fixture-stats.json') || {};
  const lineups  = readJSON('lineups.json') || {};
  const profiles = require('./teamProfiles').readProfiles();
  const { getWOWYDeltas } = require('./teamProfiles');

  let wowyHighConf = 0;
  for (const p of Object.values(profiles)) {
    if (!p.playerDependency?.players) continue;
    const deltas = getWOWYDeltas(p.teamId);
    for (const d of Object.values(deltas)) {
      if (d.confidence === 'high' && !d.selectionBias) wowyHighConf++;
    }
  }

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
    saveWatching(future);
    console.log(`[Startup] Expired ${rawWatching.length - future.length} past-kickoff watching entries`);
  }

  // 5. Migrate stale calibration entries (idempotent — skips already-patched entries)
  migrateCalibrationProjectedBetKey();
  // 5b. Recalculate bankroll from unique resolved bets (fixes duplicate-bet inflation)
  recalculateBankroll();
  // 5c. Seed bookmakers.json if not yet on disk
  if (!readJSON('bookmakers.json')) {
    saveBookmakers(DEFAULT_BOOKMAKERS);
    console.log('[Startup] Seeded bookmakers.json with', DEFAULT_BOOKMAKERS.length, 'accounts');
  }
  // 5d. Seed tournament-seeds.json if not yet on disk
  if (!readJSON('tournament-seeds.json')) {
    saveTournamentSeeds(WC_2026_SEEDS);
    console.log('[Startup] Seeded tournament-seeds.json with WC 2026 seedings for', Object.keys(WC_2026_SEEDS.teams).length, 'teams');
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
