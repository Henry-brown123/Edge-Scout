'use strict';

const fs   = require('fs');
const path = require('path');

// ─── XG STORE (StatsBomb + future sources) ───────────────────────────────────
// Keyed as "{homeTeam}|{awayTeam}|{YYYY-MM-DD}". Loaded once at startup;
// reloaded on demand via reloadXgStore() after an import run.
const XG_STORE_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'xg-data.json');
let _xgStore = null;

function getXgStore() {
  if (_xgStore) return _xgStore;
  try { _xgStore = JSON.parse(fs.readFileSync(XG_STORE_PATH, 'utf8')); }
  catch { _xgStore = {}; }
  return _xgStore;
}

function reloadXgStore() { _xgStore = null; }

// Look up StatsBomb xG for a fixture. Tries exact date then ±1 day for timezone drift.
function lookupXg(homeName, awayName, dateStr) {
  const store = getXgStore();
  if (!homeName || !awayName || !dateStr) return null;
  const d = new Date(dateStr);
  for (let offset = 0; offset <= 1; offset++) {
    const candidate = new Date(d);
    candidate.setUTCDate(d.getUTCDate() + offset);
    const ds = candidate.toISOString().slice(0, 10);
    const entry = store[`${homeName}|${awayName}|${ds}`];
    if (entry) return entry;
    // Also try previous day
    const prev = new Date(d);
    prev.setUTCDate(d.getUTCDate() - offset);
    const ps = prev.toISOString().slice(0, 10);
    const prev_entry = store[`${homeName}|${awayName}|${ps}`];
    if (prev_entry) return prev_entry;
  }
  return null;
}

// ─── FIXTURE CONTEXT ─────────────────────────────────────────────────────────

function classifyFixture(leagueId) {
  const id = parseInt(leagueId, 10);
  // Includes WC/continental qualifying leagues (26-35) so team profiles built
  // from qualifying data are correctly classified as international, not club_domestic.
  const INTERNATIONAL = [1, 4, 5, 6, 7, 8, 9, 10, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 960];
  const CLUB_EUROPEAN = [2, 3, 848];
  if (INTERNATIONAL.includes(id)) return 'international';
  if (CLUB_EUROPEAN.includes(id))  return 'club_european';
  return 'club_domestic';
}

// ─── CONTEXT-AWARE WEIGHTS ────────────────────────────────────────────────────

const WEIGHTS_BY_CONTEXT = {
  club_domestic: {
    form: 22, homeAdv: 14, xg: 16, h2h: 10,
    defense: 14, momentum: 10, injuries: 8, standings: 6,
  },
  club_european: {
    form: 18, homeAdv: 10, xg: 14, h2h: 12,
    defense: 14, momentum: 12, injuries: 12, standings: 8,
  },
  international: {
    form: 14, homeAdv: 6, xg: 10, h2h: 14,
    defense: 12, momentum: 10, injuries: 18, standings: 16,
  },
};

// Keep DEFAULT_WEIGHTS as a named export for any callers that reference it directly
const DEFAULT_WEIGHTS = WEIGHTS_BY_CONTEXT.club_domestic;

// ─── CONTEXT-SPECIFIC CONFIG ─────────────────────────────────────────────────

const CONTEXT_CONFIG = {
  club_domestic: {
    awayMult:      0.88,   // strong home advantage
    rankScale:     0,      // rankings irrelevant — use real form data
    homeBase:      0.40,   // ranking base probs (not used when scale=0)
    awayBase:      0.35,
    dataConfMin:   0.4,    // minimum dataConf before pre-match lock
    gapThresholdBase: 0.25,
  },
  club_european: {
    awayMult:      0.92,
    rankScale:     0.003,
    homeBase:      0.35,
    awayBase:      0.40,
    dataConfMin:   0.3,
    gapThresholdBase: 0.20,
  },
  international: {
    awayMult:      0.97,   // near-neutral venues, minimal home advantage
    rankScale:     0.018,  // raised from 0.010 — anchor guaranteed 30% weight so needs more differentiation
    homeBase:      0.30,
    awayBase:      0.45,
    dataConfMin:   0.0,    // no min data requirement — use stricter gap threshold
    gapThresholdBase: 0.25, // raised — tiered fixture-count gate is now the binding constraint for international
  },
};

// ─── SCORING HELPERS ─────────────────────────────────────────────────────────

function recencyAvg(arr, decay = 0.05) {
  if (!arr.length) return 0;
  let sum = 0, wSum = 0;
  arr.forEach((v, i) => {
    const w = Math.exp(-decay * i);
    sum += v * w;
    wSum += w;
  });
  return wSum > 0 ? sum / wSum : 0;
}

function outcomePoints(fix, isHome) {
  const hg = fix.goals?.home ?? fix.score?.fulltime?.home;
  const ag = fix.goals?.away ?? fix.score?.fulltime?.away;
  if (hg == null || ag == null) return null;
  if (isHome) return hg > ag ? 3 : hg === ag ? 1 : 0;
  return ag > hg ? 3 : hg === ag ? 1 : 0;
}

function formScore(fixtures, teamId, window = 6, decay = 0.05) {
  const rel = fixtures
    .filter(f => (f.teams?.home?.id === teamId || f.teams?.away?.id === teamId) && f.fixture?.status?.short === 'FT')
    .slice(0, window);
  if (!rel.length) return 50;
  const pts = rel.map(f => outcomePoints(f, f.teams?.home?.id === teamId) ?? 1);
  return Math.round((recencyAvg(pts, decay) / 3) * 100);
}

function homeAdvScore(fixtures, teamId, decay = 0.05) {
  const home = fixtures
    .filter(f => f.teams?.home?.id === teamId && f.fixture?.status?.short === 'FT')
    .slice(0, 10);
  if (!home.length) return 50;
  return Math.round((recencyAvg(home.map(f => outcomePoints(f, true) ?? 1), decay) / 3) * 100);
}

function xgScore(fixtures, teamId, statsCache = {}, decay = 0.05) {
  const rel = fixtures
    .filter(f => (f.teams?.home?.id === teamId || f.teams?.away?.id === teamId) && f.fixture?.status?.short === 'FT')
    .slice(0, 8);
  if (!rel.length) return 50;
  const vals = rel.map(f => {
    const isHome   = f.teams?.home?.id === teamId;
    // Tier 1: StatsBomb / imported xG store (keyed by team name + date)
    const sbEntry = lookupXg(f.teams?.home?.name, f.teams?.away?.name, f.fixture?.date);
    if (sbEntry) return isHome ? sbEntry.home : sbEntry.away;
    // Tier 2: API-Sports fixture stats (real xG or shots proxy)
    const c = statsCache[f.fixture?.id];
    if (c) {
      const s = isHome ? c.home : c.away;
      if (s?.xg != null) return s.xg;
      if (s?.shotsOn != null) return s.shotsOn * 0.33;
    }
    // Tier 3: goals as last-resort proxy
    return isHome ? (f.goals?.home ?? 0) : (f.goals?.away ?? 0);
  });
  return Math.min(100, Math.round((recencyAvg(vals, decay) / 3) * 100));
}

function defenseScore(fixtures, teamId, decay = 0.05) {
  const rel = fixtures
    .filter(f => (f.teams?.home?.id === teamId || f.teams?.away?.id === teamId) && f.fixture?.status?.short === 'FT')
    .slice(0, 8);
  if (!rel.length) return 50;
  const conceded = rel.map(f => {
    const isHome = f.teams?.home?.id === teamId;
    return isHome ? (f.goals?.away ?? 0) : (f.goals?.home ?? 0);
  });
  return Math.max(0, Math.round(100 - (recencyAvg(conceded, decay) / 3) * 100));
}

function momentumScore(fixtures, teamId) {
  const finished = fixtures
    .filter(f => (f.teams?.home?.id === teamId || f.teams?.away?.id === teamId) && f.fixture?.status?.short === 'FT');

  const recent = finished.slice(0, 3);
  if (!recent.length) return 50;

  const season = finished.slice(0, 15);
  if (season.length < 5) return 50;

  const recentPts = recent.map(f => outcomePoints(f, f.teams?.home?.id === teamId) ?? 1);
  const recentRate = recentPts.reduce((a, b) => a + b, 0) / (recent.length * 3);

  const seasonPts = season.map(f => outcomePoints(f, f.teams?.home?.id === teamId) ?? 1);
  const seasonRate = seasonPts.reduce((a, b) => a + b, 0) / (season.length * 3);

  // Positive diff = hot streak above season average; negative = slump
  const diff = recentRate - seasonRate;
  return Math.max(0, Math.min(100, Math.round(50 + diff * 150)));
}

function h2hScore(h2hFixtures, homeTeamId, window = 5, decay = 0.05) {
  const recent = h2hFixtures.slice(0, window);
  if (!recent.length) return 50;
  const pts = recent.map(f => outcomePoints(f, f.teams?.home?.id === homeTeamId) ?? 1);
  return Math.round((recencyAvg(pts, decay) / 3) * 100);
}

function standingsScore(standings, teamId, fixtureContext) {
  // Group standings within a 4-team WC/tournament group are meaningless for quality
  // differentiation — all qualifiers are elite and a "rank 2 of 4" score of 75
  // tells us nothing about relative team strength. Return neutral for international.
  if (fixtureContext === 'international') return 50;
  if (!standings?.length) return 50;
  const flat = Array.isArray(standings[0]) ? standings.flat() : standings;
  const entry = flat.find(s => s.team?.id === teamId);
  if (!entry) return 50;
  return Math.round(((flat.length - entry.rank + 1) / flat.length) * 100);
}

function injuryScore(injuries, teamId) {
  if (!injuries?.length) return 50;
  const team = injuries.filter(i => i.team?.id === teamId);
  if (!team.length) return 100;
  const posWeight = (pos = '') => {
    const p = pos.toLowerCase();
    if (p.includes('forward') || p.includes('attacker')) return 12;
    if (p.includes('midfielder')) return 9;
    if (p.includes('defender')) return 6;
    return 4;
  };
  const impact = team.reduce((s, i) => s + posWeight(i.player?.type || i.player?.position || ''), 0);
  return Math.max(0, Math.round(100 - impact));
}

// ─── LEAGUE CONFIG ────────────────────────────────────────────────────────────
// Per-league baseline rates and market efficiency used to tune draw probability
// and home advantage in computeModelProb, and to weight success scores.
// PL avgDrawRate (0.243) is the baseline — other leagues are expressed relative.

const LEAGUE_CONFIG = {
  39:  { name: 'Premier League',   avgHomeWinRate: 0.456, avgDrawRate: 0.243, avgAwayWinRate: 0.301, avgGoalsPerGame: 2.68, marketEfficiency: 0.95, drawBaseWeight: 1.00, homeAdvBaseWeight: 1.00 },
  140: { name: 'La Liga',          avgHomeWinRate: 0.461, avgDrawRate: 0.271, avgAwayWinRate: 0.268, avgGoalsPerGame: 2.58, marketEfficiency: 0.93, drawBaseWeight: 1.12, homeAdvBaseWeight: 1.02 },
  135: { name: 'Serie A',          avgHomeWinRate: 0.449, avgDrawRate: 0.272, avgAwayWinRate: 0.279, avgGoalsPerGame: 2.52, marketEfficiency: 0.91, drawBaseWeight: 1.12, homeAdvBaseWeight: 0.98 },
  78:  { name: 'Bundesliga',       avgHomeWinRate: 0.454, avgDrawRate: 0.234, avgAwayWinRate: 0.312, avgGoalsPerGame: 3.02, marketEfficiency: 0.92, drawBaseWeight: 0.96, homeAdvBaseWeight: 1.00 },
  61:  { name: 'Ligue 1',          avgHomeWinRate: 0.443, avgDrawRate: 0.258, avgAwayWinRate: 0.299, avgGoalsPerGame: 2.52, marketEfficiency: 0.88, drawBaseWeight: 1.06, homeAdvBaseWeight: 0.96 },
  2:   { name: 'Champions League',      avgHomeWinRate: 0.432, avgDrawRate: 0.245, avgAwayWinRate: 0.323, avgGoalsPerGame: 2.87, marketEfficiency: 0.96, drawBaseWeight: 1.01, homeAdvBaseWeight: 0.94 },
  1:   { name: 'World Cup',             avgHomeWinRate: 0.390, avgDrawRate: 0.224, avgAwayWinRate: 0.386, avgGoalsPerGame: 2.64, marketEfficiency: 0.94, drawBaseWeight: 0.92, homeAdvBaseWeight: 0.80 },
  179: { name: 'Scottish Premiership',  avgHomeWinRate: 0.451, avgDrawRate: 0.261, avgAwayWinRate: 0.288, avgGoalsPerGame: 2.71, marketEfficiency: 0.78, drawBaseWeight: 1.07, homeAdvBaseWeight: 1.02 },
  88:  { name: 'Eredivisie',            avgHomeWinRate: 0.463, avgDrawRate: 0.248, avgAwayWinRate: 0.289, avgGoalsPerGame: 3.12, marketEfficiency: 0.80, drawBaseWeight: 1.02, homeAdvBaseWeight: 1.04 },
  94:  { name: 'Primeira Liga',         avgHomeWinRate: 0.471, avgDrawRate: 0.258, avgAwayWinRate: 0.271, avgGoalsPerGame: 2.68, marketEfficiency: 0.79, drawBaseWeight: 1.06, homeAdvBaseWeight: 1.05 },
  3:   { name: 'Europa League',         avgHomeWinRate: 0.431, avgDrawRate: 0.248, avgAwayWinRate: 0.321, avgGoalsPerGame: 2.78, marketEfficiency: 0.88, drawBaseWeight: 1.02, homeAdvBaseWeight: 0.96 },
  848: { name: 'Conference League',     avgHomeWinRate: 0.441, avgDrawRate: 0.251, avgAwayWinRate: 0.308, avgGoalsPerGame: 2.65, marketEfficiency: 0.82, drawBaseWeight: 1.03, homeAdvBaseWeight: 0.98 },
};

// ─── XG PROXY ─────────────────────────────────────────────────────────────────
// Estimates expected goals from shot statistics when official xG isn't available.
// Produces a value in the 0–5 range consistent with the xgScore() input scale.

function computeXGProxy({ shotsOn = 0, totalShots = 0, possession = 0.5 }) {
  return parseFloat(((shotsOn * 0.35) + (totalShots * 0.08) + (possession * 0.5)).toFixed(3));
}

// ─── COMPETITION PHASE ────────────────────────────────────────────────────────
// Returns the phase of competition for a fixture. Used to tag calibration records
// and (future) to adjust model behaviour per phase (knockout vs league mid-season).

function classifyCompetitionPhase(fix, leagueId) {
  const id    = parseInt(leagueId, 10);
  const round = (fix.league?.round || '').toLowerCase();

  // International tournaments — WC, Euros, Copa America, Nations League, AFCON, etc.
  const TOURNAMENT = [1, 4, 5, 6, 7, 8, 9, 10, 960];
  if (TOURNAMENT.includes(id)) {
    if (round.includes('group')) return 'group_stage';
    return 'knockout';
  }

  // European club competitions (CL, EL, Conference)
  if ([2, 3, 848].includes(id)) {
    if (round.includes('group') || round.includes('league phase')) return 'group_stage';
    return 'knockout';
  }

  // Domestic leagues — classify by gameweek number (assumes 38-game season)
  const gw = parseInt((round.match(/\d+/) || [])[0] || '0', 10);
  if (!gw) return 'league_mid';
  if (gw <= 8)  return 'league_early';
  if (gw >= 31) return 'league_late';
  return 'league_mid';
}

// ─── MODEL PROBABILITY ────────────────────────────────────────────────────────

function computeModelProb(homeFactors, awayFactors, weights, context = 'club_domestic', leagueConfig = null) {
  const cfg   = CONTEXT_CONFIG[context] || CONTEXT_CONFIG.club_domestic;
  const total = Object.values(weights).reduce((a, b) => a + b, 0) || 100;

  // League-specific home advantage weight (default 1.0 = no adjustment)
  const homeAdvMult = leagueConfig?.homeAdvBaseWeight ?? 1.0;

  const score = (f, isHome) => (
    f.form * weights.form +
    (isHome ? f.homeAdv * weights.homeAdv * homeAdvMult : f.homeAdv * weights.homeAdv) +
    f.xg * weights.xg + f.h2h * weights.h2h + f.defense * weights.defense +
    f.momentum * weights.momentum + f.injuries * weights.injuries + f.standings * weights.standings
  ) / total;

  const homeScore = score(homeFactors, true);
  const awayAdj   = score(awayFactors, false) * cfg.awayMult;

  // Draw base scaled by league's historical draw rate relative to PL baseline (0.243)
  const drawRateRatio = (leagueConfig?.avgDrawRate ?? 0.243) / 0.243;
  const qualityGap    = Math.abs(homeScore - awayAdj);
  const drawBase      = 35 * drawRateRatio;
  const drawScore     = Math.max(20 * drawRateRatio, drawBase - qualityGap * 0.3);

  const raw = homeScore + awayAdj + drawScore;
  return { home: homeScore / raw, draw: drawScore / raw, away: awayAdj / raw };
}

// ─── KELLY CRITERION ─────────────────────────────────────────────────────────

function kelly(prob, odds, fraction = 0.5, bankroll = 1000) {
  const b = odds - 1;
  const k = (b * prob - (1 - prob)) / b;
  const fracK = Math.max(0, k * fraction);
  return { fullKelly: k, fracKelly: fracK, stake: parseFloat((fracK * bankroll).toFixed(2)) };
}

// ─── SUCCESS SCORE ────────────────────────────────────────────────────────────
// 0-99: win probability (0-35) + value/edge (0-45) + confidence/data (0-19)
// dataConf multiplier suppresses scores when historical data is thin.
// At dataConf=0: multiplier = 0.4, so max raw 59 becomes ~24 (below 40 threshold).

function computeSuccessScore(modelProb, bookOdds, formFixtureCount = 20, dataConf = 1, pinnacleEdge = null) {
  const impliedProb = 1 / bookOdds;
  const edge = modelProb - impliedProb;
  if (edge <= 0) return 0;
  const winComp        = modelProb * 35;
  const valueComp      = Math.min(edge / 0.20, 1) * 45;
  const confidenceComp = Math.min(formFixtureCount / 50, 1) * 19;
  const raw            = Math.min(99, Math.round(winComp + valueComp + confidenceComp));
  const dataMultiplier = 0.4 + (dataConf * 0.6);
  const base           = Math.round(raw * dataMultiplier);
  // 20%+ edge vs Pinnacle confirmed 0% ROI at scale — suppress inflated scores
  const edgeVsPinnacle = pinnacleEdge !== null ? pinnacleEdge : edge;
  return edgeVsPinnacle > 0.20 ? Math.round(base * 0.5) : base;
}

// ─── SUPPORTING UTILITIES ─────────────────────────────────────────────────────

// Recency decay brackets for historical weight training
function historicalWeight(fixtureDate) {
  const ageMs     = Date.now() - new Date(fixtureDate).getTime();
  const ageMonths = ageMs / (1000 * 60 * 60 * 24 * 30.5);
  if (ageMonths <= 6)  return 1.0;
  if (ageMonths <= 18) return 0.7;
  if (ageMonths <= 36) return 0.4;
  return 0.15;
}

function weatherModifier(w) {
  if (!w) return 100;
  let score = 100;
  if ((w.precipProb ?? 0) > 70) score -= 15;
  else if ((w.precipProb ?? 0) > 40) score -= 8;
  if ((w.windSpeed ?? 0) > 40) score -= 12;
  else if ((w.windSpeed ?? 0) > 25) score -= 6;
  return Math.max(60, score);
}

module.exports = {
  classifyFixture,
  WEIGHTS_BY_CONTEXT,
  CONTEXT_CONFIG,
  LEAGUE_CONFIG,
  DEFAULT_WEIGHTS,
  recencyAvg, outcomePoints,
  formScore, homeAdvScore, xgScore, defenseScore,
  momentumScore, h2hScore, standingsScore, injuryScore,
  computeModelProb, computeXGProxy, classifyCompetitionPhase,
  kelly, computeSuccessScore,
  historicalWeight, weatherModifier,
  reloadXgStore, getXgStore,
};
