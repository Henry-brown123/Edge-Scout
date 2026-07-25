'use strict';
// GBDT model — loaded by interface.js when gbdt-weights.json is present and passes validation.
// Contract: predict(homeFactors, awayFactors, weights, context, leagueConfig) → {home,draw,away}
// weights and leagueConfig are accepted for interface compatibility but unused — the GBDT learns
// its own feature weights from training data.

const path = require('path');
const fs   = require('fs');
const { computeModelProb, WEIGHTS_BY_CONTEXT, LEAGUE_CONFIG } = require('../scoring');

const WEIGHTS_PATH = path.join(__dirname, 'gbdt-weights.json');

let _model = null;
function loadModel() {
  if (_model) return _model;
  if (!fs.existsSync(WEIGHTS_PATH)) throw new Error('gbdt-weights.json not found — run models/gbdt-train.js first');
  _model = JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8'));
  const m = _model.metrics;
  console.log(`[model] GBDT loaded — trainedAt=${_model.trainedAt} trainN=${_model.trainN} testN=${_model.testN}`);
  console.log(`[model] Validation: log-loss ${m.logLossGBDT.toFixed(4)} (linear ${m.logLossLinear.toFixed(4)}) | Brier ${m.brierGBDT.toFixed(4)} (linear ${m.brierLinear.toFixed(4)})`);
  return _model;
}

// 24 features: 16 raw factors (home+away, normalised 0-1), 5 deltas, 3 context OHE
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

module.exports = { predict, buildFeatures };
