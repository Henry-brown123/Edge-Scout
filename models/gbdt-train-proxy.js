'use strict';
// Diagnostic PROXY training script — legacy mode produces gbdt-proxy-diagnostic.json
// (single fixed holdout, Addendum 14). Walk-forward mode (Addendum 21) runs the same
// architecture as one block of a multi-block backtest: train strictly before a given
// date, test on a following window, score the block against closing odds, and append
// results to an accumulating pool rather than overwriting a single output file.
//
// Usage:
//   node models/gbdt-train-proxy.js                    — legacy single-holdout mode
//   WF_TRAIN_BEFORE=... WF_BLOCK_LABEL=block1 [WF_TEST_END=...] node models/gbdt-train-proxy.js
//     — walk-forward block mode. WF_TEST_END omitted = test through the end of
//     available data (used for the last/most recent block).
//
// NEVER wired into live scoring, live bet generation, or model-versioning —
// models/interface.js only ever looks for gbdt-weights.json, a different file.
//
// Legacy-mode HOLDOUT_START is chosen per docs/tier-calibration-analysis.md's
// evidence-table addendum: the most recent ~24 months of data, per-league sample
// sizes checked first (a true last-12-months window returned ~0 fixtures for 6 of 9
// leagues — their 2025-26 seasons hadn't started yet at capture time). Confirmed via
// /api/debug/date-distribution that this is entirely within the live model's own
// most recent retrain's reserved 20% test slice (train/test boundary 2022-11-13) —
// so it was never used to build the live model's decision trees either, though a
// portion of it likely contributed to the live model's own Platt-scaling fit (that
// fit uses the live model's whole reserved 20%, not a further-reserved slice of it).
// This script's own train/test split is entirely separate and internal to itself —
// see below.

const path = require('path');
const fs   = require('fs');
const { computeModelProb, WEIGHTS_BY_CONTEXT, LEAGUE_CONFIG, applyLeagueBiasCorrection, computeUnifiedEdge } = require('../scoring');
const { buildFeatures } = require('./gbdt-proxy');

const HOLDOUT_START = '2024-08-07T00:00:00.000Z';

// ─── WALK-FORWARD MODE PARAMS (Addendum 21) ───────────────────────────────────
const WF_TRAIN_BEFORE = process.env.WF_TRAIN_BEFORE || null;
const WF_TEST_END     = process.env.WF_TEST_END || null; // null = through end of data
const WF_BLOCK_LABEL  = process.env.WF_BLOCK_LABEL || null;
const WALK_FORWARD_MODE = !!WF_TRAIN_BEFORE;
// Phase 1 Part F — narrow, pick-type-scoped Platt correction. Opt-in via env var so
// the existing Addendum 21 walk-forward mechanism (Part E of the same brief) is
// completely unaffected unless explicitly enabled for a Part F run. Restricted to
// away picks (topOutcome==='away') in the 45-70% probability band specifically — the
// evidence (away picks ~3x more underconfident than home in the original 50-55%
// deep-dive) doesn't say anything about home or draw picks, or about away picks
// outside this band, so this must not touch either.
const WF_ENABLE_NARROW_AWAY_PLATT = process.env.WF_ENABLE_NARROW_AWAY_PLATT === 'true';
const NARROW_AWAY_BAND = { min: 0.45, max: 0.70 };
const NARROW_AWAY_MIN_FIT_N = 30; // below this, the inner-test subset is too thin for a stable 2-parameter fit — skip correction for this block rather than force one

// Carabao Cup — same held-aside population gbdt-train.js excludes
// (docs/tier-calibration-analysis.md Addenda 16-19, calibration-rules.md rule
// 10). Paper-only, no real-money pressure to fold it in, so it stays under
// rule 10's original permanent, whole-population exclusion.
const FULLY_EXCLUDED_LEAGUE_IDS = new Set([48]);

// League One / League Two — date-split, mirrors gbdt-train.js exactly
// (calibration-rules.md rule 12, applied 2026-08-15). See gbdt-train.js's
// own comment for the full reasoning; kept in sync here rather than shared
// via a common module, matching this codebase's existing convention for
// these training-exclusion mirrors (explicit "mirrors X" comments rather
// than a shared abstraction — see server.js's TRAINING_HOLDOUT_LEAGUE_IDS /
// WEEKLY_RETRAIN_EXCLUDED_LEAGUE_IDS for the same pattern).
const DATE_SPLIT_LEAGUE_IDS = new Set([41, 42]);
const TRAINING_CUTOFF = '2026-08-11T09:00:00Z';

function isTrainingExcluded(leagueId, date) {
  const lid = parseInt(leagueId, 10);
  if (FULLY_EXCLUDED_LEAGUE_IDS.has(lid)) return true;
  if (DATE_SPLIT_LEAGUE_IDS.has(lid)) {
    if (!date) return true;
    return new Date(date).getTime() < new Date(TRAINING_CUTOFF).getTime();
  }
  return false;
}

// In-sample leagues walk-forward reports results for individually (Addendum 21).
// Conference League (848) is deliberately included in TRAINING (it's part of the
// live model's real training population, same as every other in-sample league) but
// is not in this list — its own walk-forward line is not reported, consistent with
// its existing validated_thin status (Addendum 20); its block-test results are
// still computed and stored for completeness/debugging, just not surfaced.
const WF_REPORTED_LEAGUE_IDS = new Set([39, 140, 135, 78, 61, 179, 88, 94, 2, 3]);

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
    .filter(r => !isTrainingExcluded(r.leagueId, r.date))
    .map(r => ({
      x:        buildFeatures(r.homeFactors, r.awayFactors, r.context),
      y:        r.actualOutcome,
      date:     r.date,
      context:  r.context,
      leagueId: r.leagueId,
      fixtureId: r.fixtureId,
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

// ─── WALK-FORWARD SPLIT (Addendum 21) ─────────────────────────────────────────
// Expanding window: "preHoldout" (the train pool) is everything strictly before
// WF_TRAIN_BEFORE — not just the block window itself — so each block's model is
// trained on the full history available at that point in time, same as how the
// live model and weekly retrain cycle are actually built. "holdout" here is this
// block's own test window, [WF_TRAIN_BEFORE, WF_TEST_END) or open-ended if
// WF_TEST_END is unset (the most recent block, tested through the end of data).
function splitWalkForwardBlock(records) {
  const preHoldout = records.filter(r => r.date < WF_TRAIN_BEFORE);
  const holdout     = records.filter(r =>
    r.date >= WF_TRAIN_BEFORE && (!WF_TEST_END || r.date < WF_TEST_END)
  );
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

// Async + periodic setImmediate yield — same memory-safety pattern gbdt-train.js
// uses (docs/model-versioning.md), added here for Addendum 21's walk-forward mode:
// this script previously ran fully synchronously, which was fine for a single
// one-off diagnostic run but risky run repeatedly (4 sequential blocks) on this
// 512MB instance without ever yielding back to the event loop.
async function trainClassifier(samples, classLabel) {
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
    if ((t + 1) % 20 === 0) await new Promise(r => setImmediate(r));
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

function logit(p) { return Math.log(p / (1 - p)); }

// Phase 1 Part F — fits a second-stage Platt correction on the SAME inner-test
// split ("Platt/gates only", never the block's true test holdout) the broad
// per-outcome Platt fit above already uses, restricted to away-pick predictions
// that already fall in the 45-70% band under the standard (broad-Platt +
// league-bias-corrected) pipeline. Chaining a second calibration layer onto an
// already-calibrated probability for a specific underperforming subregion is a
// standard, legitimate technique — this does not touch home or draw picks, or
// away picks outside the band, by construction (the picking logic itself is
// unchanged; only the confidence assigned to already-away picks in-band is
// adjusted). Returns null if the inner-test subset is too thin to fit stably.
function fitNarrowAwayPlatt(test, gbdtProb) {
  const logits = [];
  const yBins = [];
  for (const r of test) {
    const probs = applyLeagueBiasCorrection(gbdtProb(r), parseInt(r.leagueId, 10), LEAGUE_CONFIG);
    let topOutcome, modelProb;
    if (probs.home >= probs.draw && probs.home >= probs.away) { topOutcome = 'home'; modelProb = probs.home; }
    else if (probs.away >= probs.draw) { topOutcome = 'away'; modelProb = probs.away; }
    else { topOutcome = 'draw'; modelProb = probs.draw; }
    if (topOutcome !== 'away' || modelProb < NARROW_AWAY_BAND.min || modelProb >= NARROW_AWAY_BAND.max) continue;
    logits.push(logit(modelProb));
    yBins.push(r.y === 'away' ? 1 : 0);
  }
  if (logits.length < NARROW_AWAY_MIN_FIT_N) {
    return { fitted: false, reason: `only ${logits.length} away-picks-in-band in inner-test, need >=${NARROW_AWAY_MIN_FIT_N}`, n: logits.length };
  }
  const { A, B } = fitPlatt(logits, yBins);
  return { fitted: true, A, B, n: logits.length };
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

// ─── TIER CLASSIFICATION (5pp bins, matches TIER_LABELS_SHARED in server.js) ──
const TIER_EDGES = [0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80];
function tierOf(p) {
  if (p == null || isNaN(p)) return null;
  if (p < TIER_EDGES[0]) return '<35%';
  for (let i = 0; i < TIER_EDGES.length - 1; i++) {
    if (p >= TIER_EDGES[i] && p < TIER_EDGES[i + 1]) return `${Math.round(TIER_EDGES[i]*100)}-${Math.round(TIER_EDGES[i+1]*100)}%`;
  }
  return '80%+';
}

// ─── WALK-FORWARD BLOCK SCORING (Addendum 21) ─────────────────────────────────
// Scores this block's holdout population against closing-odds.json, same edge
// computation runEvCalibration() uses (rawProbs -> applyLeagueBiasCorrection),
// restricted to posEdge>=5% (this is what "Historical" ROI means everywhere else
// in the grid — the threshold reading, not the no-threshold Continuous reading).
// Returns raw per-bet records (not pre-aggregated) so the final pooling step
// across all 4 blocks can compute accurate variance/CI, not just a summed ROI.
function scoreWalkForwardBlock(holdout, gbdtProb, narrowAwayPlatt = null) {
  const closingOdds = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'closing-odds.json'), 'utf8'));
  const bets = [];
  let matchedN = 0;

  for (const r of holdout) {
    const lid = parseInt(r.leagueId, 10);
    const co  = closingOdds[r.fixtureId] || closingOdds[String(r.fixtureId)];
    if (!co || !co.homeOdds || !co.awayOdds || !co.drawOdds) continue;
    matchedN++;

    const rawProbs = gbdtProb(r);
    const probs    = applyLeagueBiasCorrection(rawProbs, lid, LEAGUE_CONFIG);

    let topOutcome, modelProb, pinnacleOdds;
    if (probs.home >= probs.draw && probs.home >= probs.away) { topOutcome = 'home'; modelProb = probs.home; pinnacleOdds = co.homeOdds; }
    else if (probs.away >= probs.draw) { topOutcome = 'away'; modelProb = probs.away; pinnacleOdds = co.awayOdds; }
    else { topOutcome = 'draw'; modelProb = probs.draw; pinnacleOdds = co.drawOdds; }
    if (!pinnacleOdds || pinnacleOdds <= 1) continue;

    // Phase 1 Part F — the pick itself (topOutcome/pinnacleOdds) is decided above,
    // unchanged. Only for an already-away pick already in the 45-70% band do we then
    // adjust the confidence (modelProb) used for the edge calculation below.
    let narrowCorrected = false;
    if (narrowAwayPlatt?.fitted && topOutcome === 'away' && modelProb >= NARROW_AWAY_BAND.min && modelProb < NARROW_AWAY_BAND.max) {
      modelProb = sigmoid(narrowAwayPlatt.A * logit(modelProb) + narrowAwayPlatt.B);
      narrowCorrected = true;
    }

    // Track A — unified edge: margin-stripped Pinnacle benchmark, absolute (not
    // relative) probability-point gap, matching entry.edge in scoreOneFixture.
    // applyCalFactor:false deliberately — this block's modelProb comes from a
    // freshly-trained proxy GBDT with its own fresh Platt-scaling fit just above
    // (a genuine per-block calibration correction), not the live model calFactor
    // was tuned against. Applying both would double-correct with no evidence
    // behind the combination.
    const { edge } = computeUnifiedEdge(modelProb, co, topOutcome, { applyCalFactor: false });
    if (edge < 0.05) continue; // posEdge>=5% threshold — Historical ROI semantics

    const won = r.y === topOutcome;
    const tier = tierOf(modelProb);
    if (!tier) continue;

    bets.push({ leagueId: lid, tier, pinnacleOdds, won, edge: +edge.toFixed(4), pickType: topOutcome, narrowCorrected });
  }

  return { matchedN, bets };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(WALK_FORWARD_MODE
    ? `║  WALK-FORWARD BLOCK GBDT — ${(WF_BLOCK_LABEL || '?').padEnd(35)}║`
    : '║  DIAGNOSTIC PROXY GBDT — never live, holdout-window training  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log(`Loading data... (DATA_DIR=${DATA_DIR})`);
  const all = loadData();
  const { preHoldout, holdout } = WALK_FORWARD_MODE ? splitWalkForwardBlock(all) : splitHoldout(all);
  const holdoutLabel = WALK_FORWARD_MODE
    ? `block [${WF_TRAIN_BEFORE}, ${WF_TEST_END || 'end of data'})`
    : `holdout (>= ${HOLDOUT_START})`;
  console.log(`  Total qualifying (excl. Carabao Cup/League One/League Two): ${all.length}  |  Pre-block/pre-holdout pool: ${preHoldout.length}  |  ${holdoutLabel}: ${holdout.length}`);

  const { train, test } = splitInner(preHoldout);
  console.log(`  Pre-block split — Train: ${train.length}  |  Inner test (Platt/gates only): ${test.length}\n`);

  console.log(`Training (${N_TREES} trees, depth ${DEPTH}, lr ${LR})...`);
  const classifiers = {
    home: await trainClassifier(train, 'home'),
    draw: await trainClassifier(train, 'draw'),
    away: await trainClassifier(train, 'away'),
  };

  console.log('\nFitting Platt scaling on inner test set (pre-block only)...');
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

  let narrowAwayPlatt = null;
  if (WALK_FORWARD_MODE && WF_ENABLE_NARROW_AWAY_PLATT) {
    console.log('\nFitting Phase 1 Part F narrow away-pick Platt correction (45-70% band, inner-test only)...');
    narrowAwayPlatt = fitNarrowAwayPlatt(test, gbdtProb);
    if (narrowAwayPlatt.fitted) {
      console.log(`  fitted on n=${narrowAwayPlatt.n} away-picks-in-band: A=${narrowAwayPlatt.A.toFixed(4)}  B=${narrowAwayPlatt.B.toFixed(4)}`);
    } else {
      console.log(`  SKIPPED — ${narrowAwayPlatt.reason}`);
    }
  }

  console.log('\nComputing inner-test validation metrics (diagnostic only, not a gate for this script)...');
  const llGBDT   = logLoss(test, gbdtProb);
  const llLinear = logLoss(test, r => linearPredict(r));
  const bsGBDT   = brierScore(test, gbdtProb);
  const bsLinear = brierScore(test, r => linearPredict(r));
  console.log(`  Log-loss   — linear: ${llLinear.toFixed(4)}  proxy-gbdt: ${llGBDT.toFixed(4)}`);
  console.log(`  Brier      — linear: ${bsLinear.toFixed(4)}  proxy-gbdt: ${bsGBDT.toFixed(4)}`);

  if (!WALK_FORWARD_MODE) {
    // ─── LEGACY SINGLE-HOLDOUT MODE — unchanged output shape from before Addendum 21 ───
    // No quality gates, no "improvement over previously deployed" check — this proxy
    // is diagnostic-only and never deployed, so there is nothing to gate against.
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
    return;
  }

  // ─── WALK-FORWARD BLOCK MODE (Addendum 21) ──────────────────────────────────
  console.log(`\nScoring block against closing-odds.json (posEdge>=5%, applyLeagueBiasCorrection)...`);
  const { matchedN, bets } = scoreWalkForwardBlock(holdout, gbdtProb, narrowAwayPlatt);
  console.log(`  Block test population: ${holdout.length}  |  Matched Pinnacle odds: ${matchedN}  |  posEdge>=5% bets: ${bets.length}`);

  // Block weights written for audit/debugging, not reloaded by the pooling step —
  // the pooling step only needs the raw bet outcomes appended below.
  const blockWeightsPath = path.join(DATA_DIR, `gbdt-walkforward-${WF_BLOCK_LABEL}.json`);
  fs.writeFileSync(blockWeightsPath, JSON.stringify({
    trainedAt: new Date().toISOString(),
    purpose: 'WALK-FORWARD BLOCK PROXY — never wired into live scoring. See docs/tier-calibration-analysis.md Addendum 21.',
    blockLabel: WF_BLOCK_LABEL, trainBefore: WF_TRAIN_BEFORE, testEnd: WF_TEST_END,
    trainN: train.length, innerTestN: test.length, blockTestN: holdout.length,
    innerTestMetrics: { logLossLinear: llLinear, logLossProxyGbdt: llGBDT, brierLinear: bsLinear, brierProxyGbdt: bsGBDT },
    classifiers, platt, narrowAwayPlatt,
  }));
  console.log(`  Block weights written: ${blockWeightsPath} (audit trail only)`);

  // Append raw bets to the accumulating pool.
  const rawBetsPath = path.join(DATA_DIR, 'walk-forward-raw-bets.json');
  const existingBets = fs.existsSync(rawBetsPath) ? JSON.parse(fs.readFileSync(rawBetsPath, 'utf8')) : [];
  const taggedBets = bets.map(b => ({ ...b, blockLabel: WF_BLOCK_LABEL }));
  fs.writeFileSync(rawBetsPath, JSON.stringify([...existingBets, ...taggedBets]));
  console.log(`  Appended ${taggedBets.length} bets to ${rawBetsPath} (pool now ${existingBets.length + taggedBets.length})`);

  // Append block summary to the audit log.
  const logPath = path.join(DATA_DIR, 'walk-forward-log.json');
  const existingLog = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
  existingLog.push({
    blockLabel: WF_BLOCK_LABEL,
    completedAt: new Date().toISOString(),
    trainBefore: WF_TRAIN_BEFORE,
    testEnd: WF_TEST_END,
    trainN: train.length,
    blockTestN: holdout.length,
    matchedN,
    posEdgeN: bets.length,
    logLossProxyGbdt: llGBDT,
    logLossLinear: llLinear,
  });
  fs.writeFileSync(logPath, JSON.stringify(existingLog));
  console.log(`  Block summary appended to ${logPath}\n`);
})().catch(e => {
  console.error(`\n[GBDT-Proxy] FATAL — ${WALK_FORWARD_MODE ? `walk-forward block ${WF_BLOCK_LABEL}` : 'training run'} failed: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
