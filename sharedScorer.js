'use strict';
// ─── Shared scorer (Stage A, 2026-09-06) ─────────────────────────────────────
// One place for the two things every scoring path does: build the 8+8 factor
// scores, and turn them into probabilities. Addendum 45 (G1/G3) found that live
// scoring (server.js scoreOneFixture), the historical pool scorer
// (weightOptimiser.js scoreFixtureFromPool) and the validation path
// (server.js computeMatchedEdgeFixtures) each carried their own copy of these
// steps with quietly different definitions, so the threshold validated on one
// path was never the quantity live produced on another.
//
// Stage A is a behaviour-preserving lift: the bodies below are verbatim copies of
// the legacy code, parameterised, and every caller keeps its legacy code behind
// settings.scorerPath === 'legacy' (the default) with the shared path run in
// shadow and diffed. FEATURE_SPEC documents, per path, the definitions as they
// stand today — the differences are recorded here so Stage B can close them
// deliberately, not silently. Nothing in this file changes a number until
// scorerPath is switched.

const {
  formScore, homeAdvScore, xgScore, h2hScore, defenseScore, momentumScore,
  injuryScore, standingsScore, stalenessMultiplier, applyStalenessPull,
  internationalFormScore, internationalQualityScore,
  applyLeagueBiasCorrection, LEAGUE_CONFIG,
  CORRECTION_LAYER_RULES, applyVariableCorrectionLayer,
  lookupFIFARank,
} = require('./scoring');
const model = require('./models/interface');
const { applyTeamProfileModifiers } = require('./teamProfiles');

const SCORER_VERSION = 'shared-stageA-2026-09-06';

// What each path computes today (Stage A records; Stage B unifies).
const FEATURE_SPEC = {
  version: 'stageA-2026-09-06',
  live: {
    formWindow: 'settings.formWindow league-only fixtures (API last-60 x 2 seasons + pool leagueBackfill); cups excluded; international: pool of international leagues',
    xg: 'StatsBomb/Understat lookup -> API-Sports statistics (statsCache, fetched for the 15 most recent league fixtures) -> shots-on x0.33 -> goals',
    h2h: 'API-Sports /fixtures/headtohead last 5, any competition',
    injuries: 'API-Sports /injuries for the fixture (empty where coverage is absent -> 50)',
    standings: 'standingsScore(): current API table if played >= 1, else last-season proxy; cups: resolveCupStandingsScore()',
    staleness: 'applyStalenessPull on form/momentum/defense/xg by days since last match',
    awayHomeAdv: 50,
  },
  pool: {
    formWindow: 'last 6 pool fixtures for the team, ANY league in the pool (cups included), strictly before the fixture',
    xg: 'StatsBomb/Understat lookup -> goals (no stats cache)',
    h2h: 'last 5 meetings in the pool, any league',
    injuries: 'constant 50',
    standings: 'resolveStandingsScore(): own snapshot at fixture date if played >= 1, else domestic-blend timeline, else 50',
    staleness: 'none',
    awayHomeAdv: 50,
  },
};

const HOST_NATIONS_2026 = new Set([2384, 5529, 16]); // USA, Canada, Mexico

// ── Factors: live path (verbatim from scoreOneFixture) ──────────────────────
function buildLiveFactors(p) {
  const { scoringPool, homeId, awayId, homeName, awayName, h2hFixtures, injuries, standings,
    lastSeasonStandings, statsCache, context, neutralVenue, homeStandingsOverride, awayStandingsOverride,
    fw, d, hw, seeds } = p;

  const homeF = {
    form:      formScore(scoringPool, homeId, fw, d),
    homeAdv:   neutralVenue ? 50 : homeAdvScore(scoringPool, homeId, d),
    xg:        xgScore(scoringPool, homeId, statsCache, d),
    h2h:       h2hScore(h2hFixtures, homeId, hw, d),
    defense:   defenseScore(scoringPool, homeId, d),
    momentum:  momentumScore(scoringPool, homeId),
    injuries:  injuryScore(injuries, homeId),
    standings: homeStandingsOverride ?? standingsScore(standings, homeId, context, lastSeasonStandings),
  };
  const awayF = {
    form:      formScore(scoringPool, awayId, fw, d),
    homeAdv:   50,
    xg:        xgScore(scoringPool, awayId, statsCache, d),
    h2h:       100 - h2hScore(h2hFixtures, homeId, hw, d),
    defense:   defenseScore(scoringPool, awayId, d),
    momentum:  momentumScore(scoringPool, awayId),
    injuries:  injuryScore(injuries, awayId),
    standings: awayStandingsOverride ?? standingsScore(standings, awayId, context, lastSeasonStandings),
  };

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

  if (context === 'international') {
    homeF.form     = internationalFormScore(homeId, scoringPool);
    awayF.form     = internationalFormScore(awayId, scoringPool);
    homeF.standings = internationalQualityScore(homeName, seeds);
    awayF.standings = internationalQualityScore(awayName, seeds);
  }

  const homeFormCount = scoringPool.filter(f =>
    f.teams?.home?.id === homeId || f.teams?.away?.id === homeId
  ).length;
  const awayFormCount = scoringPool.filter(f =>
    f.teams?.home?.id === awayId || f.teams?.away?.id === awayId
  ).length;
  const confCap      = context === 'international' ? 0.70 : 1;
  const homeDataConf = Math.min(homeFormCount / 15, confCap);
  const awayDataConf = Math.min(awayFormCount / 15, confCap);
  const dataConf     = Math.min(homeDataConf, awayDataConf); // use the weaker team's confidence

  return { homeF, awayF, homeFormCount, awayFormCount, homeDataConf, awayDataConf, dataConf };
}

// ── Factors: pool path (verbatim from scoreFixtureFromPool) ─────────────────
function buildPoolFactors(p) {
  const { homeFixtures, awayFixtures, h2h, homeId, awayId, homeStandings, awayStandings } = p;
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
  return { homeFactors, awayFactors };
}

// ── Probabilities (verbatim from scoreOneFixture, model -> bias -> correction ->
//    rank anchor -> host boost -> team-profile modifiers). Each stage can be
//    switched off through `options` so the validation path can reproduce exactly
//    what it computes today (model + bias correction only) in Stage A. ─────────
function scoreProbabilities(p) {
  const { homeF, awayF, weights, context, leagueId, leagueConfig, settings, cfg, dataConf,
    homeName, awayName, neutralVenue, competitionPhase, homeId, awayId,
    homeProfile, awayProfile, homeDays, awayDays, weatherForModifier,
    homeMatchday, awayMatchday, currentSeason, rankToQuality, options = {} } = p;

  const rawProbs = model.predict(homeF, awayF, weights, context, leagueConfig);
  let probs = applyLeagueBiasCorrection(rawProbs, leagueId, LEAGUE_CONFIG);

  let correctionVersion = null;
  if (options.correctionLayer !== false) {
    const deployedRuleIds = settings.deployedCorrectionRuleIds || [];
    const activeCorrectionRules = deployedRuleIds.length
      ? CORRECTION_LAYER_RULES.filter(r => deployedRuleIds.includes(r.id))
      : [];
    if (activeCorrectionRules.length) {
      const lidNum = parseInt(leagueId, 10);
      if (activeCorrectionRules.some(r => r.leagues.includes(lidNum))) {
        probs = applyVariableCorrectionLayer(probs, leagueId, activeCorrectionRules);
        correctionVersion = settings.deployedCorrectionVersion || null;
      }
    }
  }

  if (options.rankAdjust !== false && cfg.rankScale > 0 && dataConf < 1) {
    const homeRank = lookupFIFARank(homeName);
    const awayRank = lookupFIFARank(awayName);
    const homeQ    = rankToQuality(homeRank);
    const awayQ    = rankToQuality(awayRank);
    const rankDiff = homeQ - awayQ; // positive = home ranked stronger

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

  if (options.hostBoost !== false && context === 'international' &&
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
      const bSum = probs.home + probs.draw + probs.away;
      probs = { home: probs.home / bSum, draw: probs.draw / bSum, away: probs.away / bSum };
    }
  }

  let teamIntel = null;
  if (options.modifiers !== false) {
    const wowyActive = settings.wowyActive ?? false;
    const r = applyTeamProfileModifiers(
      probs, homeProfile, awayProfile, context, dataConf, homeDays, awayDays, weatherForModifier,
      { wowyActive, competitionPhase, homeMatchday, awayMatchday, season: currentSeason,
        transferModifierActive: settings.transferModifierActive === true,
        homeAwayMultiplierActive: settings.homeAwayMultiplierActive === true,
        congestionModifierActive: settings.congestionModifierActive === true,
        weatherModifierActive: settings.weatherModifierActive === true }
    );
    probs = r.probs;
    teamIntel = r.teamIntel;
  }

  return { rawProbs, probs, correctionVersion, teamIntel };
}

// Max absolute difference across two factor pairs and (optionally) two prob sets.
function diffScores(a, b) {
  let max = 0; const where = [];
  const cmp = (label, x, y) => { const dlt = Math.abs((x ?? NaN) - (y ?? NaN)); if (!(dlt <= max)) { if (Number.isNaN(dlt) || dlt > max) { max = Number.isNaN(dlt) ? Infinity : dlt; where.push(label); } } };
  for (const k of ['form', 'homeAdv', 'xg', 'h2h', 'defense', 'momentum', 'injuries', 'standings']) {
    cmp(`homeF.${k}`, a.homeF?.[k], b.homeF?.[k]);
    cmp(`awayF.${k}`, a.awayF?.[k], b.awayF?.[k]);
  }
  if (a.probs && b.probs) for (const k of ['home', 'draw', 'away']) cmp(`probs.${k}`, a.probs[k], b.probs[k]);
  return { maxDiff: max, where: where.slice(-3) };
}

module.exports = { SCORER_VERSION, FEATURE_SPEC, buildLiveFactors, buildPoolFactors, scoreProbabilities, diffScores };
