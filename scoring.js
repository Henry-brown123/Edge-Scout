'use strict';

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
    rankScale:     0.010,
    homeBase:      0.30,
    awayBase:      0.45,
    dataConfMin:   0.0,    // no min data requirement — use stricter gap threshold
    gapThresholdBase: 0.10, // 10pp at full data confidence; formula clamps to 0 at dataConf=0
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
    const isHome = f.teams?.home?.id === teamId;
    const c = statsCache[f.fixture?.id];
    if (c) {
      const s = isHome ? c.home : c.away;
      if (s?.xg != null) return s.xg;
      if (s?.shotsOn != null) return s.shotsOn * 0.33;
    }
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
  const rel = fixtures
    .filter(f => (f.teams?.home?.id === teamId || f.teams?.away?.id === teamId) && f.fixture?.status?.short === 'FT')
    .slice(0, 3);
  if (!rel.length) return 50;
  const pts = rel.map(f => outcomePoints(f, f.teams?.home?.id === teamId) ?? 1);
  const w = pts[0] * 3 + (pts[1] ?? 1) * 2 + (pts[2] ?? 1);
  return Math.round((w / 12) * 100);
}

function h2hScore(h2hFixtures, homeTeamId, window = 5, decay = 0.05) {
  const recent = h2hFixtures.slice(0, window);
  if (!recent.length) return 50;
  const pts = recent.map(f => outcomePoints(f, f.teams?.home?.id === homeTeamId) ?? 1);
  return Math.round((recencyAvg(pts, decay) / 3) * 100);
}

function standingsScore(standings, teamId) {
  if (!standings?.length) return 50;
  const flat = Array.isArray(standings[0]) ? standings.flat() : standings;
  const entry = flat.find(s => s.team?.id === teamId);
  if (!entry) return 50;
  return Math.round(((flat.length - entry.rank + 1) / flat.length) * 100);
}

function injuryScore(injuries, teamId) {
  if (!injuries?.length) return 75;
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

// ─── MODEL PROBABILITY ────────────────────────────────────────────────────────

function computeModelProb(homeFactors, awayFactors, weights, context = 'club_domestic') {
  const cfg   = CONTEXT_CONFIG[context] || CONTEXT_CONFIG.club_domestic;
  const total = Object.values(weights).reduce((a, b) => a + b, 0) || 100;

  const score = f => (
    f.form * weights.form + f.homeAdv * weights.homeAdv + f.xg * weights.xg +
    f.h2h * weights.h2h + f.defense * weights.defense + f.momentum * weights.momentum +
    f.injuries * weights.injuries + f.standings * weights.standings
  ) / total;

  const homeScore = score(homeFactors);
  const awayAdj   = score(awayFactors) * cfg.awayMult;

  // Draw probability shrinks for mismatched teams, varies by context
  const qualityGap = Math.abs(homeScore - awayAdj);
  const drawScore  = Math.max(20, 35 - qualityGap * 0.3);

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

function computeSuccessScore(modelProb, bookOdds, formFixtureCount = 20, dataConf = 1) {
  const impliedProb = 1 / bookOdds;
  const edge = modelProb - impliedProb;
  if (edge <= 0) return 0;
  const winComp        = modelProb * 35;
  const valueComp      = Math.min(edge / 0.20, 1) * 45;
  const confidenceComp = Math.min(formFixtureCount / 50, 1) * 19;
  const raw            = Math.min(99, Math.round(winComp + valueComp + confidenceComp));
  const dataMultiplier = 0.4 + (dataConf * 0.6);
  return Math.round(raw * dataMultiplier);
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
  DEFAULT_WEIGHTS,
  recencyAvg, outcomePoints,
  formScore, homeAdvScore, xgScore, defenseScore,
  momentumScore, h2hScore, standingsScore, injuryScore,
  computeModelProb, kelly, computeSuccessScore,
  historicalWeight, weatherModifier,
};
