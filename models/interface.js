'use strict';
// Active model interface — swap this require() to upgrade to non-linear model.
// Contract: module must export predict(homeFactors, awayFactors, weights, context, leagueConfig)
// returning { home, draw, away } probability triple summing to 1.

module.exports = require('./linear');
