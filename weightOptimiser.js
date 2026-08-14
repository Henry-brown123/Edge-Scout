'use strict';

const {
  formScore, homeAdvScore, xgScore, defenseScore, momentumScore,
  h2hScore, classifyFixture, WEIGHTS_BY_CONTEXT, computeModelProb,
  CUP_LEAGUE_IDS_FOR_DOMESTIC_BLEND, DOMESTIC_LEAGUE_IDS_FOR_BLEND,
  UEFA_SINGLE_PHASE_SEASON_FLOOR, EURO_COMPETITION_PHASE_GAMES_FLOOR, rankToProxyScore,
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

// ─── STANDING INDEX ───────────────────────────────────────────────────────────
// Pre-builds a per-league-season-date standings snapshot used by scoreFixtureFromPool.
// For each fixture date, a team's rank is its cumulative points position among all
// teams in that league/season using only fixtures completed before that date.
// This avoids look-ahead bias and gives a genuine standings-based factor.
//
// Addendum 24 Part A/C: this rolling-points reconstruction is only a *meaningful*
// ranking for competitions that are genuinely one round-robin table — domestic
// leagues, and Champions/Europa/Conference League from the 2024-25 season onward
// (UEFA's single 36-team league-phase reform — see scoring.js's
// UEFA_SINGLE_PHASE_SEASON_FLOOR, confirmed live that /standings returns a real,
// current, single table for the current season). For anything else grouped under a
// leagueId_season key here — Carabao Cup's pure-knockout rounds, or CL/EL/Conf's
// old group-of-4 format — a "rank" computed this way mixes fixtures that never
// really competed against each other and isn't meaningful on its own (this was the
// exact bug: scoreFixtureFromPool used to trust this blindly for every competition,
// fabricating a standings number for Carabao Cup specifically). This function still
// builds the index unconditionally for every competition — that's correct and
// needed, not the bug — resolveStandingsScore() below is what decides whether a
// given leagueId/season's own table is trustworthy or whether to route to the
// domestic-blend timeline instead.
//
// Returns { byFixture: Map(fixtureId -> {homeRank, awayRank, leagueSize,
// homeGamesPlayed, awayGamesPlayed}), seasonEnd: Map(`${leagueId}_${season}` ->
// Map(teamId -> {rank, leagueSize})) }. seasonEnd is the final table each
// league-season reached — used as a same-competition "last season" fallback for
// domestic leagues and new-format Euro competitions (Carabao Cup and old-format
// Euro route through the domestic timeline instead, which has its own
// season-crossing behaviour — see buildDomesticTimeline below).
function buildStandingsIndex(fixtures) {
  const groups = {};
  for (const f of fixtures) {
    const lid = f.league?.id;
    const sea = f.league?.season;
    if (!lid || !sea) continue;
    const key = `${lid}_${sea}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(f);
  }

  const byFixture = new Map();
  const seasonEnd = new Map();

  for (const [key, leagueFixtures] of Object.entries(groups)) {
    const sorted = [...leagueFixtures].sort((a, b) => new Date(a.fixture?.date) - new Date(b.fixture?.date));

    const pts = {};    // teamId -> points
    const played = {}; // teamId -> games played

    for (const f of sorted) {
      const hid = f.teams?.home?.id;
      const aid = f.teams?.away?.id;
      const fid = f.fixture?.id;
      if (!hid || !aid || !fid) continue;

      // Compute standings BEFORE this match
      const allTeams = Object.keys(pts);
      const teamSet = new Set([...allTeams, String(hid), String(aid)]);
      const teamList = [...teamSet];
      teamList.sort((a, b) => (pts[b] || 0) - (pts[a] || 0));
      const leagueSize = teamList.length;

      const homeRank = teamList.indexOf(String(hid)) + 1;
      const awayRank = teamList.indexOf(String(aid)) + 1;
      byFixture.set(fid, {
        homeRank, awayRank, leagueSize,
        homeGamesPlayed: played[String(hid)] || 0,
        awayGamesPlayed: played[String(aid)] || 0,
      });

      // Update points AFTER recording standings (no look-ahead)
      const hg = Number(f.goals?.home ?? f.score?.fulltime?.home);
      const ag = Number(f.goals?.away ?? f.score?.fulltime?.away);
      if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;

      if (!pts[String(hid)]) pts[String(hid)] = 0;
      if (!pts[String(aid)]) pts[String(aid)] = 0;
      if (hg > ag) { pts[String(hid)] += 3; }
      else if (hg < ag) { pts[String(aid)] += 3; }
      else { pts[String(hid)] += 1; pts[String(aid)] += 1; }
      played[String(hid)] = (played[String(hid)] || 0) + 1;
      played[String(aid)] = (played[String(aid)] || 0) + 1;
    }

    // Final table this league-season reached — the season-end snapshot.
    const finalTeams = [...new Set(Object.keys(played))];
    finalTeams.sort((a, b) => (pts[b] || 0) - (pts[a] || 0));
    const finalMap = new Map();
    finalTeams.forEach((tid, i) => finalMap.set(tid, { rank: i + 1, leagueSize: finalTeams.length }));
    seasonEnd.set(key, finalMap);
  }

  return { byFixture, seasonEnd };
}

// ─── DOMESTIC STANDINGS TIMELINE (Addendum 24 Part C) ─────────────────────────
// Per-team chronological history of domestic-league standing, restricted to
// genuine domestic leagues (DOMESTIC_LEAGUE_IDS_FOR_BLEND — real round-robin
// competitions, the same set the live domestic-form blend already uses). Lets any
// fixture — domestic or cup — ask "what was this team's most recent domestic
// standing before date X" regardless of which competition the fixture actually
// being scored belongs to. Reuses buildStandingsIndex's exact rolling-points math
// (same function, filtered input) rather than a second copy of the algorithm.
//
// A useful side effect of "most recent snapshot before date X": for a team with
// zero games so far in its current domestic season, the most recent snapshot
// naturally comes from the END of its previous domestic season (the last fixture
// processed for that league-season group before the gap) — which is exactly the
// Part D last-season proxy, for free, without a second lookup structure. Deep
// gaps (more than one season back, e.g. from the recency gap Part B closed)
// degrade gracefully to whatever's actually there, not a crash or a wrong number.
function buildDomesticTimeline(fixtures) {
  const domesticFixtures = fixtures.filter(f => DOMESTIC_LEAGUE_IDS_FOR_BLEND.has(f.league?.id));
  const { byFixture } = buildStandingsIndex(domesticFixtures);
  const sorted = [...domesticFixtures].sort((a, b) => new Date(a.fixture?.date) - new Date(b.fixture?.date));

  const byTeam = {};
  for (const f of sorted) {
    const fid = f.fixture?.id;
    const snap = byFixture.get(fid);
    if (!snap) continue;
    const hid = f.teams?.home?.id, aid = f.teams?.away?.id;
    const date = f.fixture?.date;
    if (hid) { const k = String(hid); if (!byTeam[k]) byTeam[k] = []; byTeam[k].push({ date, rank: snap.homeRank, leagueSize: snap.leagueSize, gamesPlayed: snap.homeGamesPlayed }); }
    if (aid) { const k = String(aid); if (!byTeam[k]) byTeam[k] = []; byTeam[k].push({ date, rank: snap.awayRank, leagueSize: snap.leagueSize, gamesPlayed: snap.awayGamesPlayed }); }
  }
  return byTeam; // already chronological — built from the sorted loop above
}

// Most recent domestic snapshot for a team strictly before asOfDate, or null.
function lookupDomesticStanding(domesticTimeline, teamId, asOfDate) {
  const timeline = domesticTimeline[String(teamId)];
  if (!timeline?.length) return null;
  let result = null;
  for (const snap of timeline) {
    if (snap.date < asOfDate) result = snap; else break;
  }
  return result;
}

// Resolves one team's standings factor for one fixture — the historical-path
// equivalent of scoring.js's standingsScore(), same priority order:
// 1. Own-competition table, if it's a genuinely valid single round-robin (domestic
//    league, or Champions/Europa/Conference League from the single-league-phase
//    era) AND the team has played enough games in it to be meaningful — >=1 for
//    domestic (Part D's evidenced floor), >=3 for the Euro competition phase (the
//    brief's own separate prior finding for that competition type — see
//    EURO_COMPETITION_PHASE_GAMES_FLOOR in scoring.js for why these floors differ).
// 2. Domestic-blend timeline (Carabao Cup always; old-format Euro; or a thin
//    own-competition sample) — naturally includes the last-season fallback, see
//    buildDomesticTimeline's note above.
// 3. Neutral (50) — genuinely nothing available (e.g. a newly-tracked team with
//    no domestic history in the backfilled pool at all).
function resolveStandingsScore(fix, teamId, isHome, ownSnap, domesticTimeline) {
  const leagueId = parseInt(fix.league?.id, 10);
  const season = fix.league?.season;
  const fixDate = fix.fixture?.date;
  const isDomestic = DOMESTIC_LEAGUE_IDS_FOR_BLEND.has(leagueId);
  const isNewFormatEuro = CUP_LEAGUE_IDS_FOR_DOMESTIC_BLEND.has(leagueId) && leagueId !== 48 && season >= UEFA_SINGLE_PHASE_SEASON_FLOOR;

  if ((isDomestic || isNewFormatEuro) && ownSnap) {
    const gamesPlayed = isHome ? ownSnap.homeGamesPlayed : ownSnap.awayGamesPlayed;
    const floor = isNewFormatEuro ? EURO_COMPETITION_PHASE_GAMES_FLOOR : 1;
    if (gamesPlayed >= floor) {
      const rank = isHome ? ownSnap.homeRank : ownSnap.awayRank;
      return rankToProxyScore(rank, ownSnap.leagueSize);
    }
  }

  const domesticSnap = lookupDomesticStanding(domesticTimeline, teamId, fixDate);
  if (domesticSnap && domesticSnap.gamesPlayed >= 1) {
    return rankToProxyScore(domesticSnap.rank, domesticSnap.leagueSize);
  }

  return 50; // genuinely nothing available
}

// ─── HISTORICAL FIXTURE SCORER ────────────────────────────────────────────────
// Computes factor scores for a single completed fixture using the full fixture
// pool as each team's form history. Excludes the match itself to avoid
// self-referential scoring. Uses goals as xg proxy (no stats API).
//
// Note: standings computed from in-pool rolling points (no look-ahead).

// Statuses that mean the fixture has a final, confirmed result — never a live/in-progress
// score. Resolve-before-train guarantee: the historical-backfill fetch (server.js) already
// requests status=FT and filters to this same set before fixtures reach this function, but
// that filtering happens in the caller, not here — this function is called from more than
// one place, so it defends itself rather than trusting every caller to have pre-filtered.
const FINAL_RESULT_STATUSES = new Set(['FT', 'AET', 'PEN']);

// standingsIndex — the { byFixture, seasonEnd } object from buildStandingsIndex().
// domesticTimeline — from buildDomesticTimeline(); optional for backward
// compatibility (callers that don't pass it get the pre-Addendum-24 behaviour of
// "own-competition table or neutral", just without ever fabricating a knockout
// pseudo-table, since resolveStandingsScore only trusts a genuinely valid table).
function scoreFixtureFromPool(fix, teamIndex, standingsIndex, domesticTimeline) {
  const homeId = fix.teams?.home?.id;
  const awayId = fix.teams?.away?.id;
  if (!homeId || !awayId) return null;
  if (!FINAL_RESULT_STATUSES.has(fix.fixture?.status?.short)) return null;

  const hg = Number(fix.goals?.home ?? fix.score?.fulltime?.home);
  const ag = Number(fix.goals?.away ?? fix.score?.fulltime?.away);
  if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;

  const fid     = fix.fixture?.id;
  const fixDate = fix.fixture?.date;

  const homeFixtures = (teamIndex[homeId] || [])
    .filter(f => f.fixture?.id !== fid && f.fixture?.date < fixDate);
  const awayFixtures = (teamIndex[awayId] || [])
    .filter(f => f.fixture?.id !== fid && f.fixture?.date < fixDate);

  const h2h = homeFixtures.filter(f =>
    f.teams?.home?.id === awayId || f.teams?.away?.id === awayId
  ).slice(0, 5);

  // Addendum 24 Part A/C: standings resolved via resolveStandingsScore() — own
  // competition's table only when it's a genuinely valid single round-robin
  // (domestic, or new-format Euro), domestic-blend timeline otherwise (Carabao
  // Cup, old-format Euro, or a thin own-competition sample). Replaces the old
  // "trust this leagueId_season's rolling table unconditionally" logic, which is
  // exactly what fabricated a standings number for pure-knockout competitions.
  const ownSnap = standingsIndex?.byFixture?.get(fid);
  const homeStandings = resolveStandingsScore(fix, homeId, true,  ownSnap, domesticTimeline || {});
  const awayStandings = resolveStandingsScore(fix, awayId, false, ownSnap, domesticTimeline || {});

  const homeFactors = {
    form:      formScore(homeFixtures, homeId, 6, 0.05),
    homeAdv:   homeAdvScore(homeFixtures, homeId, 0.05),
    xg:        xgScore(homeFixtures, homeId, {}, 0.05),
    h2h:       h2hScore(h2h, homeId, 5, 0.05),
    defense:   defenseScore(homeFixtures, homeId, 0.05),
    momentum:  momentumScore(homeFixtures, homeId),
    injuries:  50,
    standings: homeStandings,
  };
  const h2hAway = 100 - homeFactors.h2h;
  const awayFactors = {
    form:      formScore(awayFixtures, awayId, 6, 0.05),
    homeAdv:   50,
    xg:        xgScore(awayFixtures, awayId, {}, 0.05),
    h2h:       h2hAway,
    defense:   defenseScore(awayFixtures, awayId, 0.05),
    momentum:  momentumScore(awayFixtures, awayId),
    injuries:  50,
    standings: awayStandings,
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

// Async, not for the math (still plain synchronous gradient descent) but so a large
// record population doesn't block Node's event loop for the whole 200-iteration run —
// each iteration scans the full `records` array ~17 times (2 evals/weight-key x 8 keys,
// plus one for the step itself), which at tens of thousands of records is real,
// multi-second-per-iteration work. Yielding every 20 iterations keeps every single
// blocking span short enough that the server can still answer requests (including
// Render's health check) while a large historical backfill is scoring/optimising in
// the background — this was the root cause of repeated crash/restarts when the
// Carabao Cup/League One/League Two ingestion pushed the population past ~65k records.
async function optimiseWeights(records, context, iterations = 200) {
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

    if ((iter + 1) % 20 === 0) await new Promise(r => setImmediate(r));
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

// ─── PER-LEAGUE OPTIMISER ─────────────────────────────────────────────────────
// Runs gradient descent on fixtures from a single league only.
// Returns null if fewer than 500 scored records (fall back to context defaults).

function optimiseLeagueWeights(leagueId, allRecords) {
  const leagueRecords = allRecords.filter(r => r.leagueId === String(leagueId));
  if (leagueRecords.length < 500) {
    console.log(`[WeightOpt] League ${leagueId}: only ${leagueRecords.length} records — using context defaults`);
    return null;
  }

  const context   = leagueRecords[0]?.context || 'club_domestic';
  const defaultW  = { ...(WEIGHTS_BY_CONTEXT[context] || WEIGHTS_BY_CONTEXT.club_domestic) };
  const keys      = Object.keys(defaultW);

  // Loss function using only this league's records
  function lossForLeague(w) {
    let loss = 0; let totalW = 0;
    for (const r of leagueRecords) {
      try {
        const p = computeModelProb(r.homeFactors, r.awayFactors, w, r.context);
        loss -= r.recencyWeight * Math.log(Math.max(p[r.actualOutcome], 1e-10));
        totalW += r.recencyWeight;
      } catch {}
    }
    return totalW > 0 ? loss / totalW : 999;
  }

  let w        = Object.fromEntries(keys.map(k => [k, Number(defaultW[k])]));
  let bestLoss = lossForLeague(w);
  let bestW    = { ...w };
  const lr     = 2.0;
  const eps    = 0.5;

  for (let iter = 0; iter < 200; iter++) {
    const grad = {};
    for (const k of keys) {
      const wp = { ...w, [k]: Math.max(0.1, w[k] + eps) };
      const wm = { ...w, [k]: Math.max(0.1, w[k] - eps) };
      grad[k]  = (lossForLeague(wp) - lossForLeague(wm)) / (2 * eps);
    }
    const nw  = {};
    for (const k of keys) nw[k] = Math.max(0.1, w[k] - lr * grad[k]);
    const sum = Object.values(nw).reduce((a, b) => a + b, 0);
    for (const k of keys) nw[k] = nw[k] * 100 / sum;
    const newLoss = lossForLeague(nw);
    if (newLoss < bestLoss) { bestLoss = newLoss; bestW = { ...nw }; }
    w = nw;
  }

  const rounded = {};
  for (const k of keys) rounded[k] = Math.max(1, Math.round(bestW[k]));
  const drift = 100 - Object.values(rounded).reduce((a, b) => a + b, 0);
  rounded[keys[0]] += drift;

  // Accuracy on this league's records using the league-specific weights
  let correct = 0;
  for (const r of leagueRecords) {
    try {
      const p    = computeModelProb(r.homeFactors, r.awayFactors, rounded, r.context);
      const pred = Object.entries(p).sort((a, b) => b[1] - a[1])[0][0];
      if (pred === r.actualOutcome) correct++;
    } catch {}
  }
  const accuracy         = parseFloat((correct / leagueRecords.length).toFixed(4));
  const baselineCorrect  = leagueRecords.filter(r => {
    try { const p = computeModelProb(r.homeFactors, r.awayFactors, defaultW, r.context); return Object.entries(p).sort((a, b) => b[1] - a[1])[0][0] === r.actualOutcome; } catch { return false; }
  }).length;
  const baselineAccuracy = parseFloat((baselineCorrect / leagueRecords.length).toFixed(4));

  return {
    leagueId:      String(leagueId),
    context,
    weights:       rounded,
    defaultWeights: defaultW,
    finalLoss:     parseFloat(bestLoss.toFixed(4)),
    accuracy,
    baselineAccuracy,
    improvement:   parseFloat(((accuracy - baselineAccuracy) * 100).toFixed(2)),
    recordCount:   leagueRecords.length,
    optimisedAt:   new Date().toISOString(),
  };
}

module.exports = {
  buildTeamIndex,
  buildStandingsIndex,
  buildDomesticTimeline,
  scoreFixtureFromPool,
  optimiseWeights,
  optimiseLeagueWeights,
  computeLogLoss,
  computeAccuracy,
  recencyWeight,
};
