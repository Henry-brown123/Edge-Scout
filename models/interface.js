'use strict';
// Active model interface.
// Contract: module must export predict(homeFactors, awayFactors, weights, context, leagueConfig)
// returning { home, draw, away } probability triple summing to 1, and
// getVersion() returning a string identifying which model/training run produced
// predictions — threaded onto every bet as `modelVersion` (see server.js scoreOneFixture).
//
// Falls back to linear model if gbdt-weights.json is missing so the server
// can start cleanly on a fresh deploy before weights are present.
//
// Bug fixed 2026-08-08 (docs/model-versioning.md): gbdt-weights.json used to live
// in this directory (models/) and was checked into git — meaning it was part of the
// ephemeral code checkout, not the persistent disk, so every single deploy silently
// reverted it to whatever was last committed, erasing any retrain's output the moment
// the next deploy ran. Moved to DATA_DIR, the same persistent disk every other
// generated data file already lives on, and removed from git.

const path = require('path');
const fs   = require('fs');

const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, '../data');
const weightsPath = path.join(DATA_DIR, 'gbdt-weights.json');
if (fs.existsSync(weightsPath)) {
  module.exports = require('./gbdt');
} else {
  console.warn('[model] gbdt-weights.json not found — falling back to linear model');
  module.exports = require('./linear');
}
