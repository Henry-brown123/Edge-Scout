'use strict';
// Linear model — wraps computeModelProb from scoring.js.
// scoreOneFixture calls model.predict() through interface.js so this can be
// swapped for a non-linear model in July without touching the scoring pipeline.

const { computeModelProb } = require('../scoring');

function predict(homeFactors, awayFactors, weights, context = 'club_domestic', leagueConfig = null) {
  return computeModelProb(homeFactors, awayFactors, weights, context, leagueConfig);
}

module.exports = { predict };
