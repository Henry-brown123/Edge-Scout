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
const DATA_DIR       = path.join(__dirname, 'data');

// ─── DATA PERSISTENCE ────────────────────────────────────────────────────────

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { return null; }
}

function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

const SETTINGS_DEFAULTS = {
  weights: { form:18, homeAdv:12, xg:16, h2h:10, defense:14, momentum:10, injuries:8, standings:12 },
  decay: 0.05, formWindow: 6, h2hWindow: 5, kellyFraction: 0.5,
  activeLeagues: ['1','39','140','78','135','61','2'], successThreshold: 40,
  calibrationFactor: 1.08,
  wowyActive: false,
};

function getSettings() {
  const stored = readJSON('settings.json');
  return stored ? { ...SETTINGS_DEFAULTS, ...stored } : { ...SETTINGS_DEFAULTS };
}

function getBankroll() {
  return readJSON('bankroll.json') || { initial: 1000, current: 1000, lastUpdated: null };
}

function getBets()         { return readJSON('bets.json')         || []; }
function getWatching()     { return readJSON('watching.json')     || []; }
function getCalibration()  { return readJSON('calibration.json')  || []; }
function getOddsHistory()  { return readJSON('odds-history.json') || []; }

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

async function fetchOddsForLeague(sport) {
  try {
    const { data } = await oddsApi.get(`/sports/${sport}/odds`, {
      params: { apiKey: ODDS_API_KEY, regions: 'uk,eu', markets: 'h2h', oddsFormat: 'decimal' },
    });
    const events = data || [];
    _oddsRawCache[sport] = events;
    const map = {};
    events.forEach(ev => {
      const bm = ev.bookmakers?.[0];
      const mkt = bm?.markets?.[0];
      if (mkt) {
        const key = `${ev.home_team}|${ev.away_team}`;
        map[key] = mkt.outcomes?.reduce((acc, o) => { acc[o.name] = o.price; return acc; }, {});
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

  const homeF = {
    form:      formScore(formFixtures, homeId, fw, d),
    homeAdv:   homeAdvScore(formFixtures, homeId, d),
    xg:        xgScore(formFixtures, homeId, statsCache, d),
    h2h:       h2hScore(h2hFixtures, homeId, hw, d),
    defense:   defenseScore(formFixtures, homeId, d),
    momentum:  momentumScore(formFixtures, homeId),
    injuries:  injuryScore(injuries, homeId),
    standings: standingsScore(standings, homeId),
  };
  const awayF = {
    form:      formScore(formFixtures, awayId, fw, d),
    homeAdv:   50,
    xg:        xgScore(formFixtures, awayId, statsCache, d),
    h2h:       100 - h2hScore(h2hFixtures, homeId, hw, d),
    defense:   defenseScore(formFixtures, awayId, d),
    momentum:  momentumScore(formFixtures, awayId),
    injuries:  injuryScore(injuries, awayId),
    standings: standingsScore(standings, awayId),
  };

  // Data confidence per team (capped at 1 when ≥15 fixtures available)
  const homeFormCount = formFixtures.filter(f =>
    f.teams?.home?.id === homeId || f.teams?.away?.id === homeId
  ).length;
  const awayFormCount = formFixtures.filter(f =>
    f.teams?.home?.id === awayId || f.teams?.away?.id === awayId
  ).length;
  const homeDataConf = Math.min(homeFormCount / 15, 1);
  const awayDataConf = Math.min(awayFormCount / 15, 1);
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

    const rH = Math.max(0.05, Math.min(0.85, cfg.homeBase + rankDiff * cfg.rankScale));
    const rA = Math.max(0.05, Math.min(0.85, cfg.awayBase - rankDiff * cfg.rankScale));
    const rD = Math.max(0.05, 1 - rH - rA);
    const rSum   = rH + rD + rA;
    const rankAdj = { home: rH / rSum, draw: rD / rSum, away: rA / rSum };

    probs = {
      home: dataConf * probs.home + (1 - dataConf) * rankAdj.home,
      draw: dataConf * probs.draw + (1 - dataConf) * rankAdj.draw,
      away: dataConf * probs.away + (1 - dataConf) * rankAdj.away,
    };
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
  const wowyActive = settings.wowyActive ?? false;
  const { probs: adjustedProbs, teamIntel } = applyTeamProfileModifiers(
    probs, homeProfile, awayProfile, context, dataConf, homeDays, awayDays, weatherForModifier,
    { wowyActive }
  );
  probs = adjustedProbs;

  // Build results for H/D/A
  const oddsKey    = `${homeName}|${awayName}`;
  const bookOdds   = oddsMap[oddsKey] || {};
  const lookup     = { 'Home Win': homeName, Draw: 'Draw', 'Away Win': awayName };
  const candidates = [
    { label: 'Home Win', prob: probs.home },
    { label: 'Draw',     prob: probs.draw },
    { label: 'Away Win', prob: probs.away },
  ];

  // Calibration correction: model consistently underpredicts top-pick outcomes by ~5pp.
  // Scale probs by calFactor for edge/EV/kelly/score calculations only.
  // Raw probs are preserved in modelProb for display.
  const calFactor = settings.calibrationFactor ?? 1.08;
  // Market efficiency: less efficient markets (Ligue 1 0.88) get a slight score boost vs
  // highly efficient markets (CL 0.96). Applied as 1/efficiency so range is ×1.04–×1.14.
  const effMult = 1 / (leagueConfig?.marketEfficiency ?? 1.0);

  const results = [];
  for (const c of candidates) {
    const odds      = bookOdds[lookup[c.label]] || (1 / c.prob * 1.06);
    const impliedP  = 1 / odds;
    const calProb   = Math.min(0.97, c.prob * calFactor); // corrected prob for value calculations
    const edge      = calProb - impliedP;
    const rawScore  = computeSuccessScore(calProb, odds, homeFormCount, dataConf);
    const finalScore = Math.round(rawScore * wxMod * effMult);
    const k         = kelly(calProb, odds, settings.kellyFraction, getBankroll().current);

    results.push({
      bet: c.label, modelProb: c.prob, bookOdds: odds, impliedProb: impliedP,
      edge, successScore: finalScore, kelly: k,
      ev: calProb * (odds - 1) - (1 - calProb),
    });
  }

  // Dynamic low-confidence sanity check (Fix 3):
  // Threshold shrinks as data confidence falls — at dataConf=0 for international,
  // any >10pp divergence from the market is flagged.
  const maxModelBookGap  = Math.max(...results.map(c => Math.abs(c.modelProb - c.impliedProb)));
  const gapThreshold     = Math.max(0, cfg.gapThresholdBase - (1 - dataConf) * 0.15);
  const lowConfidence    = maxModelBookGap > gapThreshold;
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
      }));
  };
  if (teamIntel.home) teamIntel.home.keyPlayers = wowyToKeyPlayers(homeId, true);
  if (teamIntel.away) teamIntel.away.keyPlayers = wowyToKeyPlayers(awayId, false);

  return {
    fix, homeName, awayName, homeF, awayF, probs, weather, weatherCondition, results,
    kickoff: fix.fixture?.date,
    context, competitionPhase, lowConfidence,
    homeDataConf, awayDataConf, dataConf,
    teamIntel,
  };
}

// ─── MORNING SCAN ────────────────────────────────────────────────────────────

async function runMorningScan(leagueIds) {
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
            successScore: best.successScore,
            projectedBet: best.bet,
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
      suggestedStake: best.kelly.stake,
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
    };

    const bets = getBets();
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

      // Resolve bet if exists
      const bet = pendingBets.find(b => b.fixtureId === fid);
      if (bet) {
        const won = actualOutcome === bet.bet;
        const pnl = won
          ? parseFloat(((bet.bookOdds - 1) * bet.suggestedStake).toFixed(2))
          : -bet.suggestedStake;
        bet.result     = won ? 'win' : 'loss';
        bet.pnl        = pnl;
        bet.stage      = 'RESOLVED';
        bet.resolvedAt = resolvedAt;
        bet.finalScore = finalScore;
        const br = getBankroll();
        br.current = parseFloat((br.current + pnl).toFixed(2));
        saveBankroll(br);
        betsChanged = true;
        console.log(`[Resolve] ${bet.fixture} — ${bet.bet} → ${bet.result} (${finalScore}), P&L: £${pnl}, Bankroll: £${br.current}`);
      }

      // Resolve calibration entry
      const ce = pendingCal.find(c => c.fixtureId === fid);
      if (ce) {
        ce.resolved       = true;
        ce.resolvedAt     = resolvedAt;
        ce.actualResult   = actualOutcome;
        ce.finalScore     = finalScore;
        ce.topPickCorrect = actualOutcome === ce.projectedBet;
        calChanged = true;
        console.log(`[Calibration] ${ce.fixture} → actual: ${actualOutcome}, predicted: ${ce.projectedBet} (${ce.topPickCorrect ? '✓' : '✗'})`);
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
      const homeName = fix.teams?.home?.name;
      const awayName = fix.teams?.away?.name;
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

function setupScheduler() {
  const settings = getSettings();

  // 07:00 UTC every day — morning scan
  cron.schedule('0 7 * * *', () => {
    console.log(`[Cron] 07:00 tick — running morning scan at ${new Date().toISOString()}`);
    const leagues = getSettings().activeLeagues || ['1','39','140','78','135','61','2'];
    runMorningScan(leagues).catch(e => console.error('[Cron:MorningScan]', e.message));
  });

  // Every minute — check for T-60 fixtures
  cron.schedule('* * * * *', () => {
    const watching = getWatching();
    const now      = Date.now();
    const locked   = [];
    const toScan   = [];

    watching.forEach(w => {
      const kickoff  = new Date(w.kickoff).getTime();
      const minsOut  = (kickoff - now) / 60000;
      if (minsOut <= 60 && minsOut > 55) toScan.push(w); // T-60 window
      else if (minsOut > 55)             locked.push(w);  // keep watching
    });

    if (toScan.length) {
      console.log(`[Cron] T-60 tick — ${toScan.length} fixture(s) entering pre-match scan`);
      Promise.all(toScan.map(w => runPreMatchScan(w))).catch(e => console.error('[Cron:PreMatch]', e.message));
      saveWatching(locked);
    }
  });

  // Every 5 minutes — auto-resolve finished matches
  cron.schedule('*/5 * * * *', () => {
    checkAndResolve().catch(e => console.error('[Cron:Resolve]', e.message));
  });

  console.log('[Scheduler] Cron jobs active (07:00 morning scan, T-60 pre-match, 5-min resolution)');
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
          const raw      = data?.response || [];
          const fixtures = raw.filter(f => ['FT','AET','PEN'].includes(f.fixture?.status?.short));
          fixtures.forEach(f => { fixtureMap.set(f.fixture.id, stripFixture(f)); });
          newCount += fixtures.length;
          existing.fetchedLeagues[key] = { count: fixtures.length, fetchedAt: new Date().toISOString() };
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
    // Compact JSON for large file
    fs.writeFileSync(path.join(DATA_DIR, 'backfill-historical.json'), JSON.stringify(existing));

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

// GET full state (bets, watching, bankroll)
app.get('/api/state', (_req, res) => {
  const scanMeta = readJSON('scan-meta.json') || {};
  res.json({
    bankroll:    getBankroll(),
    bets:        getBets(),
    watching:    getWatching(),
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

    const targets = historical.fixtures.filter(f => {
      const lid = f.league?.id;
      const sid = f.league?.season;
      return STATS_LEAGUES.has(lid) && STATS_SEASONS.has(sid);
    });

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

// ─── FACTOR DISTRIBUTION DIAGNOSTIC ─────────────────────────────────────────

app.get('/api/diagnostics/data-coverage', (req, res) => {
  const data     = readJSON('backfill-historical.json');
  const lineups  = readJSON('lineups.json') || {};
  const stats    = readJSON('fixture-stats.json') || {};
  const profiles = require('./teamProfiles').readProfiles();

  if (!data?.fixtures?.length) return res.json({ totalFixtures: 0, byLeague: {}, gaps: ['No historical data — run backfill first'] });

  const LEAGUE_NAMES = { 39:'Premier League', 140:'La Liga', 135:'Serie A', 78:'Bundesliga', 61:'Ligue 1', 2:'Champions League', 1:'World Cup' };

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

// ─── START ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Edge Scout running at http://localhost:${PORT}`);
  setupScheduler();

  // Keep-alive: ping own /health every 10 min to prevent Render free-tier spin-down
  if (process.env.NODE_ENV === 'production') {
    const SELF = `https://edge-scout.onrender.com`;
    setInterval(() => {
      axios.get(`${SELF}/health`).catch(() => {});
    }, 10 * 60 * 1000);
    console.log('[KeepAlive] Self-ping every 10 min enabled');
  }

  // On startup, strip any watching entries whose kickoff has already passed,
  // then rescan if we have no scan for today.
  const settings    = getSettings();
  const today       = new Date().toISOString().split('T')[0];
  const nowMs       = Date.now();
  const rawWatching = getWatching();
  const future      = rawWatching.filter(w => new Date(w.kickoff).getTime() > nowMs);
  if (future.length < rawWatching.length) {
    saveWatching(future);
    console.log(`[Startup] Removed ${rawWatching.length - future.length} past-kickoff entries from watching list`);
  }

  const scanMeta = readJSON('scan-meta.json');
  const stale    = !scanMeta || scanMeta.date !== today || !scanMeta.completedAt;
  if (stale) {
    console.log('[Startup] No completed scan for today — running morning scan…');
    runMorningScan(settings.activeLeagues).catch(e => console.error('[Startup:MorningScan]', e.message));
  } else {
    console.log(`[Startup] Today's scan already completed at ${scanMeta.completedAt} (${scanMeta.count} watching)`);
  }
});
