'use strict';

const {
  formScore, homeAdvScore, xgScore, defenseScore, momentumScore,
  h2hScore, classifyFixture, WEIGHTS_BY_CONTEXT, computeModelProb,
} = require('./scoring');

// ─── RECENCY WEIGHT ───────────────────────────────────────────────────────────

function recencyWeight(fixtureDate) {
  const ageMonths = (Date.now() - new Date(fixtureDate).getTime()) / (1000 * 60 * 60 * 24 * 30.5);
  if (ageMonths <= 6)  return 1.0;
  if (ageMonths <= 18) return 0.7;
  if (ageMonths <= 36) return 0.4;
  return 0.15;
}

// ─── TEAM INDEX ───────────────────────────────────────────────────────────────
// Pre-groups fixtures by team, sorted descending so formScore/etc. get most-recent-first.

function buildTeamIndex(fixtures) {
  const idx = {};
  for (const f of fixtures) {
    const hid = f.teams?.home?.id;
    const aid = f.teams?.away?.id;
    if (hid) { if (!idx[hid]) idx[hid] = []; idx[hid].push(f); }
    if (aid) { if (!idx[aid]) idx[aid] = []; idx[aid].push(f); }
  }
  for (const id of Object.keys(idx)) {
    idx[id].sort((a, b) => new Date(b.fixture?.date) - new Date(a.fixture?.date));
  }
  return idx;
}

// ─── HISTORICAL FIXTURE SCORER ────────────────────────────────────────────────
// Computes factor scores for a single completed fixture using the full fixture
// pool as each team's form history. Excludes the match itself to avoid
// self-referential scoring. Uses goals as xg proxy (no stats API).
//
// Note: uses all-time pool data per team, not a rolling window prior to the
// match date. Introduces mild look-ahead bias acceptable for hyperparameter tuning.

function scoreFixtureFromPool(fix, teamIndex) {
  const homeId = fix.teams?.home?.id;
  const awayId = fix.teams?.away?.id;
  if (!homeId || !awayId) return null;

  const hg = Number(fix.goals?.home ?? fix.score?.fulltime?.home);
  const ag = Number(fix.goals?.away ?? fix.score?.fulltime?.away);
  if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;

  const fid     = fix.fixture?.id;
  const fixDate = fix.fixture?.date; // ISO string — lexicographic comparison is safe for dates

  // Only use fixtures completed BEFORE this match. teamIndex is sorted descending,
  // so filtering by date < fixDate preserves that order (most recent prior match first).
  // This eliminates look-ahead bias: a match from Aug 2024 only sees pre-Aug-2024 form.
  const homeFixtures = (teamIndex[homeId] || [])
    .filter(f => f.fixture?.id !== fid && f.fixture?.date < fixDate);
  const awayFixtures = (teamIndex[awayId] || [])
    .filter(f => f.fixture?.id !== fid && f.fixture?.date < fixDate);

  const h2h = homeFixtures.filter(f =>
    f.teams?.home?.id === awayId || f.teams?.away?.id === awayId
  ).slice(0, 5);

  const homeFactors = {
    form:      formScore(homeFixtures, homeId, 6, 0.05),
    homeAdv:   homeAdvScore(homeFixtures, homeId, 0.05),
    xg:        xgScore(homeFixtures, homeId, {}, 0.05),
    h2h:       h2hScore(h2h, homeId, 5, 0.05),
    defense:   defenseScore(homeFixtures, homeId, 0.05),
    momentum:  momentumScore(homeFixtures, homeId),
    injuries:  75,
    standings: 50,
  };
  const h2hAway = 100 - homeFactors.h2h;
  const awayFactors = {
    form:      formScore(awayFixtures, awayId, 6, 0.05),
    homeAdv:   50,
    xg:        xgScore(awayFixtures, awayId, {}, 0.05),
    h2h:       h2hAway,
    defense:   defenseScore(awayFixtures, awayId, 0.05),
    momentum:  momentumScore(awayFixtures, awayId),
    injuries:  75,
    standings: 50,
  };

  const context = classifyFixture(fix.league?.id);

  return {
    fixtureId:    fid,
    date:         fix.fixture?.date,
    leagueId:     String(fix.league?.id),
    context,
    homeTeamId:   homeId,
    awayTeamId:   awayId,
    homeTeamName: fix.teams?.home?.name,
    awayTeamName: fix.teams?.away?.name,
    homeFactors,
    awayFactors,
    actualOutcome: hg > ag ? 'home' : hg < ag ? 'away' : 'draw',
    goals:         { home: hg, away: ag },
    recencyWeight: recencyWeight(fix.fixture?.date),
  };
}

// ─── LOSS + ACCURACY ─────────────────────────────────────────────────────────

function computeLogLoss(records, weights, context) {
  let loss = 0;
  let totalW = 0;
  for (const r of records) {
    if (r.context !== context) continue;
    try {
      const p = computeModelProb(r.homeFactors, r.awayFactors, weights, context);
      const prob = p[r.actualOutcome];
      loss -= r.recencyWeight * Math.log(Math.max(prob, 1e-10));
      totalW += r.recencyWeight;
    } catch {}
  }
  return totalW > 0 ? loss / totalW : 999;
}

function computeAccuracy(records, weights, context) {
  let correct = 0;
  let total   = 0;
  for (const r of records) {
    if (r.context !== context) continue;
    try {
      const p    = computeModelProb(r.homeFactors, r.awayFactors, weights, context);
      const pred = Object.entries(p).sort((a, b) => b[1] - a[1])[0][0];
      if (pred === r.actualOutcome) correct++;
      total++;
    } catch {}
  }
  return total > 0 ? parseFloat((correct / total).toFixed(4)) : null;
}

// ─── GRADIENT DESCENT ────────────────────────────────────────────────────────
// Numerical gradient descent minimising recency-weighted cross-entropy loss.
// Weights are constrained to ≥1 and renormalised to sum to 100 after each step.

function optimiseWeights(records, context, iterations = 200) {
  const defaultW = { ...(WEIGHTS_BY_CONTEXT[context] || WEIGHTS_BY_CONTEXT.club_domestic) };
  const keys     = Object.keys(defaultW);

  // Work in float space to avoid integer-rounding traps.
  // Weights are kept proportional (sum to 100) by normalising after each step.
  // Only round to integers in the final output.
  let w        = Object.fromEntries(keys.map(k => [k, Number(defaultW[k])]));
  let bestLoss = computeLogLoss(records, w, context);
  let bestW    = { ...w };

  const lr  = 2.0;
  const eps = 0.5; // smaller epsilon for finer gradient estimation

  for (let iter = 0; iter < iterations; iter++) {
    const grad = {};
    for (const k of keys) {
      const wp = { ...w, [k]: Math.max(0.1, w[k] + eps) };
      const wm = { ...w, [k]: Math.max(0.1, w[k] - eps) };
      grad[k]  = (computeLogLoss(records, wp, context) - computeLogLoss(records, wm, context)) / (2 * eps);
    }

    // Gradient step in float space
    const nw = {};
    for (const k of keys) nw[k] = Math.max(0.1, w[k] - lr * grad[k]);

    // Renormalise to maintain proportional sum (not forced to 100 until output)
    const sum = Object.values(nw).reduce((a, b) => a + b, 0);
    const scale = 100 / sum;
    for (const k of keys) nw[k] *= scale;

    const newLoss = computeLogLoss(records, nw, context);
    if (newLoss < bestLoss) { bestLoss = newLoss; bestW = { ...nw }; }
    w = nw;
  }

  // Round to integers for output, fix rounding drift
  const rounded = {};
  for (const k of keys) rounded[k] = Math.max(1, Math.round(bestW[k]));
  const drift = 100 - Object.values(rounded).reduce((a, b) => a + b, 0);
  rounded[keys[0]] += drift;

  const accuracy         = computeAccuracy(records, rounded, context);
  const baselineAccuracy = computeAccuracy(records, defaultW, context);

  return {
    context,
    weights:           rounded,
    defaultWeights:    defaultW,
    finalLoss:         parseFloat(bestLoss.toFixed(4)),
    accuracy,
    baselineAccuracy,
    improvement:       accuracy != null && baselineAccuracy != null
                         ? parseFloat(((accuracy - baselineAccuracy) * 100).toFixed(2))
                         : null,
    recordCount:       records.filter(r => r.context === context).length,
  };
}

module.exports = {
  buildTeamIndex,
  scoreFixtureFromPool,
  optimiseWeights,
  computeLogLoss,
  computeAccuracy,
  recencyWeight,
};
