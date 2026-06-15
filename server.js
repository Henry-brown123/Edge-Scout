'use strict';

const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const cron     = require('node-cron');
const { v4: uuidv4 } = require('uuid');

const {
  classifyFixture, WEIGHTS_BY_CONTEXT, CONTEXT_CONFIG,
  formScore, homeAdvScore, xgScore, defenseScore, momentumScore,
  h2hScore, standingsScore, injuryScore,
  computeModelProb, kelly, computeSuccessScore, weatherModifier,
} = require('./scoring');

const {
  getTeamProfiles,
  updateTeamProfiles,
  addResultToProfile,
  applyTeamProfileModifiers,
} = require('./teamProfiles');

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

function getSettings() {
  return readJSON('settings.json') || {
    weights: { form:18, homeAdv:12, xg:16, h2h:10, defense:14, momentum:10, injuries:8, standings:12 },
    decay: 0.05, formWindow: 6, h2hWindow: 5, kellyFraction: 0.5,
    activeLeagues: ['1','39','140','78','135','61','2'], successThreshold: 40,
  };
}

function getBankroll() {
  return readJSON('bankroll.json') || { initial: 1000, current: 1000, lastUpdated: null };
}

function getBets()        { return readJSON('bets.json')        || []; }
function getWatching()    { return readJSON('watching.json')    || []; }
function getCalibration() { return readJSON('calibration.json') || []; }

function saveBets(bets)         { writeJSON('bets.json', bets); }
function saveWatching(list)     { writeJSON('watching.json', list); }
function saveBankroll(br)       { writeJSON('bankroll.json', { ...br, lastUpdated: new Date().toISOString() }); }
function saveCalibration(list)  { writeJSON('calibration.json', list); }

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
// Used for Open-Meteo weather fetches

const VENUE_COORDS = {
  // World Cup 2026
  'SoFi Stadium':              { lat: 33.9535,  lon: -118.3392 },
  'MetLife Stadium':           { lat: 40.8135,  lon: -74.0745  },
  'AT&T Stadium':              { lat: 32.7480,  lon: -97.0929  },
  'NRG Stadium':               { lat: 29.6847,  lon: -95.4107  },
  "Levi's Stadium":            { lat: 37.4032,  lon: -121.9698 },
  'Lincoln Financial Field':   { lat: 39.9008,  lon: -75.1675  },
  'Arrowhead Stadium':         { lat: 39.0489,  lon: -94.4839  },
  'BC Place':                  { lat: 49.2767,  lon: -123.1118 },
  'Estadio Azteca':            { lat: 19.3030,  lon: -99.1503  },
  'Estadio BBVA':              { lat: 25.6694,  lon: -100.2452 },
  'Estadio Akron':             { lat: 20.7067,  lon: -103.4601 },
  'BMO Field':                 { lat: 43.6332,  lon: -79.4187  },
  'Hard Rock Stadium':         { lat: 25.9580,  lon: -80.2389  },
  'Gillette Stadium':          { lat: 42.0909,  lon: -71.2643  },
  // Premier League
  'Anfield':                   { lat: 53.4308,  lon: -2.9608   },
  'Old Trafford':              { lat: 53.4631,  lon: -2.2913   },
  'Stamford Bridge':           { lat: 51.4816,  lon: -0.1910   },
  'Emirates Stadium':          { lat: 51.5549,  lon: -0.1084   },
  'Etihad Stadium':            { lat: 53.4831,  lon: -2.2004   },
  'Tottenham Hotspur Stadium': { lat: 51.6044,  lon: -0.0665   },
  'Villa Park':                { lat: 52.5090,  lon: -1.8847   },
  'St. James\' Park':          { lat: 54.9756,  lon: -1.6218   },
  'Goodison Park':             { lat: 53.4388,  lon: -2.9662   },
  'Molineux Stadium':          { lat: 52.5902,  lon: -2.1302   },
};

function venueCoords(venueName, city) {
  if (venueName) {
    const match = Object.keys(VENUE_COORDS).find(k => venueName.includes(k) || k.includes(venueName));
    if (match) return VENUE_COORDS[match];
  }
  // Fallback city coords (rough)
  const cityFallback = {
    'Los Angeles': { lat: 34.0522, lon: -118.2437 }, 'New York': { lat: 40.7128, lon: -74.0060 },
    'Dallas': { lat: 32.7767, lon: -96.7970 }, 'Houston': { lat: 29.7604, lon: -95.3698 },
    'San Francisco': { lat: 37.7749, lon: -122.4194 }, 'Philadelphia': { lat: 39.9526, lon: -75.1652 },
    'Kansas City': { lat: 39.0997, lon: -94.5786 }, 'Vancouver': { lat: 49.2827, lon: -123.1207 },
    'Mexico City': { lat: 19.4326, lon: -99.1332 }, 'Toronto': { lat: 43.6532, lon: -79.3832 },
    'Miami': { lat: 25.7617, lon: -80.1918 }, 'Boston': { lat: 42.3601, lon: -71.0589 },
    'Liverpool': { lat: 53.4084, lon: -2.9916 }, 'Manchester': { lat: 53.4808, lon: -2.2426 },
    'London': { lat: 51.5074, lon: -0.1278 },
  };
  if (city) {
    const found = Object.keys(cityFallback).find(c => city.includes(c));
    if (found) return cityFallback[found];
  }
  return null;
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

async function fetchOddsForLeague(sport) {
  try {
    const { data } = await oddsApi.get(`/sports/${sport}/odds`, {
      params: { apiKey: ODDS_API_KEY, regions: 'uk,eu', markets: 'h2h', oddsFormat: 'decimal' },
    });
    const map = {};
    (data || []).forEach(ev => {
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

// ─── CORE FIXTURE SCORER ─────────────────────────────────────────────────────

async function scoreOneFixture(fix, formFixtures, standings, statsCache, oddsMap, settings) {
  const homeId   = fix.teams?.home?.id;
  const awayId   = fix.teams?.away?.id;
  const homeName = fix.teams?.home?.name;
  const awayName = fix.teams?.away?.name;

  // Determine fixture context once — drives weights, ranking scale, thresholds
  const leagueId = fix.league?.id || settings._leagueId;
  const context  = classifyFixture(leagueId);
  const cfg      = CONTEXT_CONFIG[context];
  const weights  = WEIGHTS_BY_CONTEXT[context];

  // H2H + injuries in parallel
  const [h2hRes, injRes] = await Promise.allSettled([
    apiSports.get('/fixtures/headtohead', { params: { h2h: `${homeId}-${awayId}`, last: 5 } }),
    apiSports.get('/injuries',            { params: { fixture: fix.fixture.id } }),
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

  let probs = computeModelProb(homeF, awayF, weights, context);

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

  // Team profile modifiers
  const kickoffDate = fix.fixture?.date;
  const homeDays = kickoffDate ? daysSinceLastMatch(formFixtures, homeId, kickoffDate) : null;
  const awayDays = kickoffDate ? daysSinceLastMatch(formFixtures, awayId, kickoffDate) : null;
  const teamProfileMap = getTeamProfiles([homeId, awayId]);
  const homeProfile = teamProfileMap[homeId] || null;
  const awayProfile = teamProfileMap[awayId] || null;
  const { probs: adjustedProbs, teamIntel } = applyTeamProfileModifiers(
    probs, homeProfile, awayProfile, context, dataConf, homeDays, awayDays
  );
  probs = adjustedProbs;

  // Weather
  const coords = venueCoords(fix.fixture?.venue?.name, fix.fixture?.venue?.city);
  let weather = null;
  if (coords && fix.fixture?.date) {
    weather = await fetchWeather(coords.lat, coords.lon, fix.fixture.date);
  }
  const wxMod = weatherModifier(weather) / 100; // 0.6–1.0 multiplier

  // Build results for H/D/A
  const oddsKey    = `${homeName}|${awayName}`;
  const bookOdds   = oddsMap[oddsKey] || {};
  const lookup     = { 'Home Win': homeName, Draw: 'Draw', 'Away Win': awayName };
  const candidates = [
    { label: 'Home Win', prob: probs.home },
    { label: 'Draw',     prob: probs.draw },
    { label: 'Away Win', prob: probs.away },
  ];

  const results = [];
  for (const c of candidates) {
    const odds       = bookOdds[lookup[c.label]] || (1 / c.prob * 1.06);
    const impliedP   = 1 / odds;
    const edge       = c.prob - impliedP;
    // Pass dataConf so scores are suppressed when data is thin (Fix 2)
    const rawScore   = computeSuccessScore(c.prob, odds, homeFormCount, dataConf);
    const finalScore = Math.round(rawScore * wxMod);
    const k          = kelly(c.prob, odds, settings.kellyFraction, getBankroll().current);

    results.push({
      bet: c.label, modelProb: c.prob, bookOdds: odds, impliedProb: impliedP,
      edge, successScore: finalScore, kelly: k,
      ev: c.prob * (odds - 1) - (1 - c.prob),
    });
  }

  // Dynamic low-confidence sanity check (Fix 3):
  // Threshold shrinks as data confidence falls — at dataConf=0 for international,
  // any >10pp divergence from the market is flagged.
  const maxModelBookGap  = Math.max(...results.map(c => Math.abs(c.modelProb - c.impliedProb)));
  const gapThreshold     = Math.max(0, cfg.gapThresholdBase - (1 - dataConf) * 0.15);
  const lowConfidence    = maxModelBookGap > gapThreshold;
  results.forEach(c => { c.lowConfidence = lowConfidence; });

  return {
    fix, homeName, awayName, homeF, awayF, probs, weather, results,
    kickoff: fix.fixture?.date,
    context, lowConfidence,
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

      // Existing calibration entries for today (avoid dupes on re-scan)
      const todayStr  = new Date().toISOString().split('T')[0];
      const calNow    = getCalibration().filter(c => !c.scoredAt?.startsWith(todayStr));

      for (const fix of fixtures) {
        try {
          const scored = await scoreOneFixture(fix, formFixtures, standings, {}, oddsMap, settings);
          const best   = scored.results.reduce((a, b) => a.successScore > b.successScore ? a : b);
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
            resolved:     false,
            resolvedAt:   null,
            actualResult: null,
            topPickCorrect: null,
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
              lowConfidence:   scored.lowConfidence,
              context:         scored.context,
              homeDataConf:    scored.homeDataConf,
              awayDataConf:    scored.awayDataConf,
              teamIntel:       scored.teamIntel,
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

    // Stats cache for recent 15 fixtures
    const statsCache = {};
    for (const f of formFixtures.slice(0, 15)) {
      try {
        const { data: st } = await apiSports.get('/fixtures/statistics', { params: { fixture: f.fixture.id } });
        if (st?.response?.length >= 2) {
          const parse = ts => {
            const find = t => ts.statistics?.find(s => s.type === t)?.value;
            const xgRaw = find('expected_goals') ?? find('Expected Goals');
            return { xg: xgRaw != null ? parseFloat(xgRaw) || null : null, shotsOn: parseInt(find('Shots on Goal') ?? 0) || 0 };
          };
          statsCache[f.fixture.id] = { home: parse(st.response[0]), away: parse(st.response[1]) };
        }
      } catch {}
    }

    const { data: std } = await apiSports.get('/standings', { params: { league: leagueId, season: meta.season } });
    const standings = std?.response?.[0]?.league?.standings || [];
    const oddsMap   = await fetchOddsForLeague(meta.sport || 'soccer_epl');

    const scored = await scoreOneFixture(fix, formFixtures, standings, statsCache, oddsMap, settings);
    const best   = scored.results.reduce((a, b) => a.successScore > b.successScore ? a : b);

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
      homeF:        scored.homeF,
      awayF:        scored.awayF,
      weather:      scored.weather,
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

      // Incremental team profile update
      const homeId   = fix.teams?.home?.id;
      const awayId   = fix.teams?.away?.id;
      const homeName = fix.teams?.home?.name;
      const awayName = fix.teams?.away?.name;
      const homeWon  = actualOutcome === 'Home Win';
      const awayWon  = actualOutcome === 'Away Win';
      const isDraw   = actualOutcome === 'Draw';
      if (homeId) addResultToProfile(homeId, true,  homeWon, isDraw, awayId, awayName, hg - ag);
      if (awayId) addResultToProfile(awayId, false, awayWon, isDraw, homeId, homeName, ag - hg);

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
