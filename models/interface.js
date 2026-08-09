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
//
// Second bug fixed same day, found while re-verifying the fix above: this module used
// to decide gbdt-vs-linear exactly once, at require time (module.exports set based on
// whether the weights file existed at that single instant) — so a process that started
// before any retrain had written a weights file to the (now-correct) DATA_DIR path
// stayed on the linear fallback forever, never noticing a file that appeared later in
// its lifetime, for as long as that process kept running. Same class of bug as
// gbdt.js's mtime fix, one layer up. Fixed by checking file existence fresh on every
// call instead of caching the routing decision.

const path = require('path');
const fs     = require('fs');
const linear = require('./linear');
const gbdt   = require('./gbdt');

const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, '../data');
const weightsPath = path.join(DATA_DIR, 'gbdt-weights.json');

let _lastKnownHasWeights = null; // for one-line logging on actual transitions only
function activeModel() {
  const hasWeights = fs.existsSync(weightsPath);
  if (hasWeights !== _lastKnownHasWeights) {
    console.log(hasWeights
      ? '[model] gbdt-weights.json found — routing to GBDT'
      : '[model] gbdt-weights.json not found — falling back to linear model');
    _lastKnownHasWeights = hasWeights;
  }
  return hasWeights ? gbdt : linear;
}

function predict(homeFactors, awayFactors, weights, context, leagueConfig) {
  return activeModel().predict(homeFactors, awayFactors, weights, context, leagueConfig);
}

function getVersion() {
  return activeModel().getVersion();
}

module.exports = { predict, getVersion };
