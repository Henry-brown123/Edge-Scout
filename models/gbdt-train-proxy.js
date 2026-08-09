'use strict';
// Diagnostic PROXY training script — produces gbdt-proxy-diagnostic.json.
// Usage: node models/gbdt-train-proxy.js
//
// NEVER wired into live scoring, live bet generation, or model-versioning —
// models/interface.js only ever looks for gbdt-weights.json, a different file. This
// script's sole purpose is the "Comprehensive league x tier evidence table" task:
// train a model that has genuinely never seen a specific recent holdout window, so
// that window can be used for an honest out-of-sample calibration/ROI read using
// CURRENT data patterns — something the live model (trained on ~everything as of
// 2026-08-08) can no longer provide.
//
// HOLDOUT_START is chosen per docs/tier-calibration-analysis.md's evidence-table
// addendum: the most recent ~24 months of data, per-league sample sizes checked
// first (a true last-12-months window returned ~0 fixtures for 6 of 9 leagues —
// their 2025-26 seasons hadn't started yet at capture time). Confirmed via
// /api/debug/date-distribution that this is entirely within the live model's own
// most recent retrain's reserved 20% test slice (train/test boundary 2022-11-13) —
// so it was never used to build the live model's decision trees either, though a
// portion of it likely contributed to the live model's own Platt-scaling fit (that
// fit uses the live model's whole reserved 20%, not a further-reserved slice of it).
// This script's own train/test split is entirely separate and internal to itself —
// see below.

const path = require('path');
const fs   = require('fs');
const { computeModelProb, WEIGHTS_BY_CONTEXT, LEAGUE_CONFIG } = require('../scoring');
const { buildFeatures } = require('./gbdt-proxy');

const HOLDOUT_START = '2024-08-07T00:00:00.000Z';

// ─── HYPERPARAMETERS ─────────────────────────────────────────────────────────
// Identical to gbdt-train.js — this is a diagnostic proxy for the same live
// architecture, not a separate model design.
const N_TREES   = 200;
const DEPTH     = 3;
const LR        = 0.02;
const MIN_LEAF  = 10;
const SUBSAMPLE = 0.70;
const L2_LAMBDA = 1.0;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');

function loadData() {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'backfill-historical.json'), 'utf8'));
  const records = raw.scoredRecords || [];
  return records
    .filter(r => r.homeFactors && r.awayFactors && r.actualOutcome && r.context && r.date)
    .map(r => ({
      x:        buildFeatures(r.homeFactors, r.awayFactors, r.context),
      y:        r.actualOutcome,
      date:     r.date,
      context:  r.context,
      leagueId: r.leagueId,
      homeFactors: r.homeFactors,
      awayFactors: r.awayFactors,
    }));
}

// ─── OUTER SPLIT: holdout vs everything available to train on ────────────────
// The holdout is reserved ENTIRELY — it never contributes to tree-building, the
// inner train/test split below, or Platt-scaling. This is the population every
// later diagnostic read (calibration, edge-vs-ROI, threshold-ROI) scores against.
function splitHoldout(records) {
  const preHoldout = records.filter(r => r.date < HOLDOUT_START);
  const holdout     = records.filter(r => r.date >= HOLDOUT_START);
  return { preHoldout, holdout };
}

// ─── INNER SPLIT: this script's own time-stratified 80/20 of the pre-holdout pool
// only, for its own Platt-scaling fit and quality-gate diagnostics — mirrors
// gbdt-train.js's own internal split exactly, just scoped to a smaller pool.
function splitInner(records) {
  const sorted = records.slice().sort((a, b) => a.date < b.date ? -1 : 1);
  const cutoff = Math.floor(sorted.length * 0.8);
  return { train: sorted.slice(0, cutoff), test: sorted.slice(cutoff) };
}

// ─── MATH HELPERS (identical to gbdt-train.js) ────────────────────────────────
const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));
const mean = arr => arr.reduce((s, v) => s + v, 0) / arr.length;

function buildTree(X, residuals, hessians, depth) {
  const n = X.length;
  const sumG = residuals.reduce((s, v) => s + v, 0);
  const sumH = hessians.reduce((s, v) => s + v, 0);
  if (depth >= DEPTH || n < MIN_LEAF * 2) {
    return { leaf: true, value: sumG / (sumH + L2_LAMBDA) };
  }

  const nFeatures = X[0].length;
  let bestGain = 0, bestFeature = -1, bestThreshold = 0;
  let bestLeftIdx = null, bestRightIdx = null;

  for (let fi = 0; fi < nFeatures; fi++) {
    const order = Array.from({length: n}, (_, i) => i).sort((a, b) => X[a][fi] - X[b][fi]);
    let gLeft = 0, hLeft = 0, gRight = sumG, hRight = sumH;

    for (let i = 0; i < n - 1; i++) {
      const idx = order[i];
      gLeft  += residuals[idx];  gRight -= residuals[idx];
      hLeft  += hessians[idx];   hRight -= hessians[idx];

      if (X[order[i]][fi] === X[order[i + 1]][fi]) continue;
      const nL = i + 1, nR = n - nL;
      if (nL < MIN_LEAF || nR < MIN_LEAF) continue;

      const gain = (gLeft ** 2) / (hLeft + L2_LAMBDA)
                 + (gRight ** 2) / (hRight + L2_LAMBDA)
                 - sumG ** 2 / (sumH + L2_LAMBDA);

      if (gain > bestGain) {
        bestGain      = gain;
        bestFeature   = fi;
        bestThreshold = (X[order[i]][fi] + X[order[i + 1]][fi]) / 2;
        bestLeftIdx   = order.slice(0, i + 1);
        bestRightIdx  = order.slice(i + 1);
      }
    }
  }

  if (bestFeature === -1) return { leaf: true, value: sumG / (sumH + L2_LAMBDA) };

  return {
    leaf:      false,
    feature:   bestFeature,
    threshold: bestThreshold,
    left:  buildTree(bestLeftIdx.map(i  => X[i]), bestLeftIdx.map(i  => residuals[i]), bestLeftIdx.map(i  => hessians[i]), depth + 1),
    right: buildTree(bestRightIdx.map(i => X[i]), bestRightIdx.map(i => residuals[i]), bestRightIdx.map(i => hessians[i]), depth + 1),
  };
}

function treePredict(node, x) {
  if (node.leaf) return node.value;
  return x[node.feature] <= node.threshold
    ? treePredict(node.left, x)
    : treePredict(node.right, x);
}

function trainClassifier(samples, classLabel) {
  const X = samples.map(s => s.x);
  const y = samples.map(s => s.y === classLabel ? 1 : 0);
  const n = X.length;
  const prior = y.reduce((s, v) => s + v, 0) / n;
  const initValue = Math.log((prior + 1e-6) / (1 - prior + 1e-6));

  const F = new Float64Array(n).fill(initValue);
  const trees = [];
  const subN = Math.floor(n * SUBSAMPLE);

  process.stdout.write(`  Training ${classLabel.padEnd(5)}: `);
  for (let t = 0; t < N_TREES; t++) {
    const probs = F.map(f => sigmoid(f));
    const gradients = y.map((yi, i) => yi - probs[i]);
    const hessians  = probs.map(p => p * (1 - p));

    const allIdx = Array.from({length: n}, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allIdx[i], allIdx[j]] = [allIdx[j], allIdx[i]];
    }
    const subIdx = allIdx.slice(0, subN);
    const subX = subIdx.map(i => X[i]);
    const subG = subIdx.map(i => gradients[i]);
    const subH = subIdx.map(i => hessians[i]);

    const tree = buildTree(subX, subG, subH, 0);
    trees.push(tree);

    for (let i = 0; i < n; i++) F[i] += LR * treePredict(tree, X[i]);

    if ((t + 1) % 30 === 0) process.stdout.write(`${t + 1} `);
  }
  console.log('done');

  return { trees, lr: LR, initValue };
}

function fitPlatt(logOdds, yBin) {
  let A = 1.0, B = 0.0;
  const lr = 0.005;
  const n  = logOdds.length;

  for (let iter = 0; iter < 2000; iter++) {
    let dA = 0, dB = 0;
    for (let i = 0; i < n; i++) {
      const p  = sigmoid(A * logOdds[i] + B);
      const e  = p - yBin[i];
      dA += e * logOdds[i];
      dB += e;
    }
    A -= (lr / n) * dA;
    B -= (lr / n) * dB;
  }
  return { A, B };
}

function ensembleRaw(classifier, x) {
  let F = classifier.initValue;
  for (const tree of classifier.trees) F += classifier.lr * treePredict(tree, x);
  return F;
}

function linearPredict(record) {
  const lid     = parseInt(record.leagueId, 10);
  const weights = WEIGHTS_BY_CONTEXT[record.context] || WEIGHTS_BY_CONTEXT.club_domestic;
  const lc      = LEAGUE_CONFIG[lid] || null;
  return computeModelProb(record.homeFactors, record.awayFactors, weights, record.context, lc);
}

const EPS = 1e-9;

function logLoss(records, probFn) {
  let total = 0;
  for (const r of records) {
    const p = probFn(r);
    const pY = r.y === 'home' ? p.home : r.y === 'draw' ? p.draw : p.away;
    total += -Math.log(Math.max(EPS, pY));
  }
  return total / records.length;
}

function brierScore(records, probFn) {
  let total = 0;
  for (const r of records) {
    const p = probFn(r);
    total += (p.home - (r.y === 'home' ? 1 : 0)) ** 2
           + (p.draw - (r.y === 'draw' ? 1 : 0)) ** 2
           + (p.away - (r.y === 'away' ? 1 : 0)) ** 2;
  }
  return total / records.length;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  DIAGNOSTIC PROXY GBDT — never live, holdout-window training  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log(`Loading data... (DATA_DIR=${DATA_DIR})`);
  const all = loadData();
  const { preHoldout, holdout } = splitHoldout(all);
  console.log(`  Total qualifying: ${all.length}  |  Pre-holdout pool: ${preHoldout.length}  |  Holdout (>= ${HOLDOUT_START}): ${holdout.length}`);

  const { train, test } = splitInner(preHoldout);
  console.log(`  Pre-holdout split — Train: ${train.length}  |  Inner test (Platt/gates only): ${test.length}\n`);

  console.log(`Training (${N_TREES} trees, depth ${DEPTH}, lr ${LR})...`);
  const classifiers = {
    home: trainClassifier(train, 'home'),
    draw: trainClassifier(train, 'draw'),
    away: trainClassifier(train, 'away'),
  };

  console.log('\nFitting Platt scaling on inner test set (pre-holdout only)...');
  const platt = {};
  for (const cls of ['home', 'draw', 'away']) {
    const logOdds = test.map(r => ensembleRaw(classifiers[cls], r.x));
    const yBin    = test.map(r => r.y === cls ? 1 : 0);
    platt[cls]    = fitPlatt(logOdds, yBin);
    console.log(`  ${cls.padEnd(5)}: A=${platt[cls].A.toFixed(4)}  B=${platt[cls].B.toFixed(4)}`);
  }

  function gbdtProb(r) {
    const rawHome = ensembleRaw(classifiers.home, r.x);
    const rawDraw = ensembleRaw(classifiers.draw, r.x);
    const rawAway = ensembleRaw(classifiers.away, r.x);
    const pHome = sigmoid(platt.home.A * rawHome + platt.home.B);
    const pDraw = sigmoid(platt.draw.A * rawDraw + platt.draw.B);
    const pAway = sigmoid(platt.away.A * rawAway + platt.away.B);
    const s = pHome + pDraw + pAway;
    return { home: pHome / s, draw: pDraw / s, away: pAway / s };
  }

  console.log('\nComputing inner-test validation metrics (diagnostic only, not a gate for this script)...');
  const llGBDT   = logLoss(test, gbdtProb);
  const llLinear = logLoss(test, r => linearPredict(r));
  const bsGBDT   = brierScore(test, gbdtProb);
  const bsLinear = brierScore(test, r => linearPredict(r));
  console.log(`  Log-loss   — linear: ${llLinear.toFixed(4)}  proxy-gbdt: ${llGBDT.toFixed(4)}`);
  console.log(`  Brier      — linear: ${bsLinear.toFixed(4)}  proxy-gbdt: ${bsGBDT.toFixed(4)}`);

  // No quality gates, no "improvement over previously deployed" check — this proxy
  // is diagnostic-only and never deployed, so there is nothing to gate against.
  // Always write, so the holdout read can proceed regardless of how this compares
  // to the linear baseline on its own inner test set.
  const outPath = path.join(DATA_DIR, 'gbdt-proxy-diagnostic.json');
  const weightsOut = {
    trainedAt:    new Date().toISOString(),
    purpose:      'DIAGNOSTIC PROXY ONLY — never wired into live scoring, live bet generation, or model-versioning. See docs/tier-calibration-analysis.md.',
    holdoutStart: HOLDOUT_START,
    trainN:       train.length,
    innerTestN:   test.length,
    holdoutN:     holdout.length,
    hyperparams:  { nTrees: N_TREES, depth: DEPTH, lr: LR, minLeaf: MIN_LEAF },
    innerTestMetrics: { logLossLinear: llLinear, logLossProxyGbdt: llGBDT, brierLinear: bsLinear, brierProxyGbdt: bsGBDT },
    classifiers,
    platt,
  };
  fs.writeFileSync(outPath, JSON.stringify(weightsOut));
  console.log(`\n  Written: ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
  console.log(`  Holdout population (${holdout.length} fixtures, >= ${HOLDOUT_START}) reserved for separate diagnostic scoring — not touched by this script beyond counting it.`);
})();
