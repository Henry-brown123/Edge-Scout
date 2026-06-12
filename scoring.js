'use strict';

const DEFAULT_WEIGHTS = {
  form: 18, homeAdv: 12, xg: 16, h2h: 10,
  defense: 14, momentum: 10, injuries: 8, standings: 12,
};

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

function computeModelProb(homeFactors, awayFactors, weights = DEFAULT_WEIGHTS) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0) || 100;
  const score = f => (
    f.form * weights.form + f.homeAdv * weights.homeAdv + f.xg * weights.xg +
    f.h2h * weights.h2h + f.defense * weights.defense + f.momentum * weights.momentum +
    f.injuries * weights.injuries + f.standings * weights.standings
  ) / total;
  const homeScore = score(homeFactors);
  const awayAdj   = score(awayFactors) * 0.88;
  const drawScore = 50;
  const raw = homeScore + awayAdj + drawScore;
  return { home: homeScore / raw, draw: drawScore / raw, away: awayAdj / raw };
}

function kelly(prob, odds, fraction = 0.5, bankroll = 1000) {
  const b = odds - 1;
  const k = (b * prob - (1 - prob)) / b;
  const fracK = Math.max(0, k * fraction);
  return { fullKelly: k, fracKelly: fracK, stake: parseFloat((fracK * bankroll).toFixed(2)) };
}

// Success Score 0-99
// win probability (0-35) + value/edge (0-45) + confidence/data (0-19)
function computeSuccessScore(modelProb, bookOdds, formFixtureCount = 20) {
  const impliedProb = 1 / bookOdds;
  const edge = modelProb - impliedProb;
  if (edge <= 0) return 0;
  const winComp        = modelProb * 35;
  const valueComp      = Math.min(edge / 0.20, 1) * 45;
  const confidenceComp = Math.min(formFixtureCount / 50, 1) * 19;
  return Math.min(99, Math.round(winComp + valueComp + confidenceComp));
}

// Brief-specified recency decay brackets for backfill weight training
// last 6 months = 1.0, 6-18m = 0.7, 18m-3yr = 0.4, 3yr+ = 0.15
function historicalWeight(fixtureDate) {
  const ageMs = Date.now() - new Date(fixtureDate).getTime();
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
  DEFAULT_WEIGHTS,
  recencyAvg, outcomePoints, formScore, homeAdvScore, xgScore,
  defenseScore, momentumScore, h2hScore, standingsScore, injuryScore,
  computeModelProb, kelly, computeSuccessScore, historicalWeight, weatherModifier,
};
