'use strict';
// Diagnostic proxy GBDT model — NEVER used for live predictions, live scoring, or
// bet generation. NOT referenced by models/interface.js's routing anywhere. Exists
// solely so the "Comprehensive league x tier evidence table" task can get an
// out-of-sample read using current data patterns, without touching the live model.
//
// Trained by models/gbdt-train-proxy.js on everything BEFORE the holdout window
// (see that file for the exact cutoff), so its predictions on the holdout window
// are genuinely unseen by this specific model — see docs/tier-calibration-analysis.md
// for the full addendum this supports.
//
// Same predict()/buildFeatures() math as models/gbdt.js, pointed at a different,
// distinctly-named weights file so the two can never be confused or cross-loaded.

const path = require('path');
const fs   = require('fs');

const DATA_DIR     = process.env.DATA_DIR || path.join(__dirname, '../data');
const WEIGHTS_PATH = path.join(DATA_DIR, 'gbdt-proxy-diagnostic.json');

let _model = null;
let _modelMtimeMs = null;
function loadModel() {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(WEIGHTS_PATH).mtimeMs;
  } catch {
    throw new Error('gbdt-proxy-diagnostic.json not found — run models/gbdt-train-proxy.js first');
  }
  if (_model && _modelMtimeMs === mtimeMs) return _model;
  _model = JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8'));
  _modelMtimeMs = mtimeMs;
  console.log(`[proxy-model] loaded — trainedAt=${_model.trainedAt} trainN=${_model.trainN} holdoutStart=${_model.holdoutStart}`);
  return _model;
}

function buildFeatures(homeFactors, awayFactors, context) {
  const h = homeFactors;
  const a = awayFactors;
  return [
    h.form      / 100, a.form      / 100,
    h.homeAdv   / 100, a.homeAdv   / 100,
    h.xg        / 100, a.xg        / 100,
    h.h2h       / 100, a.h2h       / 100,
    h.defense   / 100, a.defense   / 100,
    h.momentum  / 100, a.momentum  / 100,
    h.injuries  / 100, a.injuries  / 100,
    h.standings / 100, a.standings / 100,
    (h.form      - a.form)      / 100,
    (h.xg        - a.xg)        / 100,
    (h.defense   - a.defense)   / 100,
    (h.momentum  - a.momentum)  / 100,
    (h.standings - a.standings) / 100,
    context === 'club_domestic' ? 1 : 0,
    context === 'club_european' ? 1 : 0,
    context === 'international' ? 1 : 0,
  ];
}

function traverseTree(node, x) {
  if (node.leaf) return node.value;
  return x[node.feature] <= node.threshold
    ? traverseTree(node.left,  x)
    : traverseTree(node.right, x);
}

function ensemblePredict(ensemble, x) {
  let F = ensemble.initValue;
  for (const tree of ensemble.trees) F += ensemble.lr * traverseTree(tree, x);
  return F;
}

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

function plattCalibrate(logOdds, platt) {
  return sigmoid(platt.A * logOdds + platt.B);
}

function predict(homeFactors, awayFactors, _weights, context = 'club_domestic', _leagueConfig = null) {
  const m = loadModel();
  const x = buildFeatures(homeFactors, awayFactors, context);

  const rawHome = ensemblePredict(m.classifiers.home, x);
  const rawDraw = ensemblePredict(m.classifiers.draw, x);
  const rawAway = ensemblePredict(m.classifiers.away, x);

  const pHome = plattCalibrate(rawHome, m.platt.home);
  const pDraw = plattCalibrate(rawDraw, m.platt.draw);
  const pAway = plattCalibrate(rawAway, m.platt.away);

  const sum = pHome + pDraw + pAway;
  return { home: pHome / sum, draw: pDraw / sum, away: pAway / sum };
}

function getVersion() {
  const m = loadModel();
  return `proxy-diagnostic-${m.trainedAt}`;
}

function getHoldoutStart() {
  return loadModel().holdoutStart;
}

module.exports = { predict, buildFeatures, getVersion, getHoldoutStart, loadModel };
