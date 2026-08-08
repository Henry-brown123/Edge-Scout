'use strict';
// Linear model — wraps computeModelProb from scoring.js.
// scoreOneFixture calls model.predict() through interface.js so this can be
// swapped for a non-linear model in July without touching the scoring pipeline.

const { computeModelProb } = require('../scoring');

function predict(homeFactors, awayFactors, weights, context = 'club_domestic', leagueConfig = null) {
  return computeModelProb(homeFactors, awayFactors, weights, context, leagueConfig);
}

// The linear model has no training run/timestamp — it's config-driven (LEAGUE_CONFIG
// + hand-tuned weights), only ever active as interface.js's fallback when
// gbdt-weights.json is missing. Fixed version string so bets logged under it are
// still distinguishable from any real GBDT version.
function getVersion() {
  return 'linear-fallback';
}

module.exports = { predict, getVersion };
