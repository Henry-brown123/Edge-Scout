'use strict';
// Active model interface.
// Contract: module must export predict(homeFactors, awayFactors, weights, context, leagueConfig)
// returning { home, draw, away } probability triple summing to 1.
//
// Falls back to linear model if gbdt-weights.json is missing so the server
// can start cleanly on a fresh deploy before weights are present.

const path = require('path');
const fs   = require('fs');

const weightsPath = path.join(__dirname, 'gbdt-weights.json');
if (fs.existsSync(weightsPath)) {
  module.exports = require('./gbdt');
} else {
  console.warn('[model] gbdt-weights.json not found — falling back to linear model');
  module.exports = require('./linear');
}
