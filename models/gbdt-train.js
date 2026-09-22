'use strict';
// GBDT training script — run once to produce gbdt-weights.json.
// Usage: node models/gbdt-train.js
//
// Reads data/backfill-historical.json, performs time-stratified 80/20 split,
// trains three one-vs-rest gradient-boosted classifiers (home/draw/away),
// fits Platt scaling calibration, then validates against linear baseline.
// Writes gbdt-weights.json only if all three quality gates are met.

const path = require('path');
const fs   = require('fs');
const { computeModelProb, WEIGHTS_BY_CONTEXT, LEAGUE_CONFIG, RETIRED_LEAGUE_IDS, applyLeagueBiasCorrection, applyVariableCorrectionLayer, CORRECTION_LAYER_RULES, marginStrippedImplied } = require('../scoring');
const { buildFeatures } = require('./gbdt');
const { attachRegime, buildLeagueHomeRateIndex } = require('../regime');

// ─── HYPERPARAMETERS ─────────────────────────────────────────────────────────
const N_TREES   = 200;
const DEPTH     = 3;
const LR        = 0.02;
const MIN_LEAF  = 10;
const SUBSAMPLE = 0.70; // stochastic subsampling per tree — reduces overfitting
const L2_LAMBDA = 1.0;  // L2 regularisation on leaf values (Newton step)

// ─── DATA LOADING ─────────────────────────────────────────────────────────────
// Bug fixed 2026-08-08 (docs/model-versioning.md): this used to always read the
// checked-in local data/backfill-historical.json snapshot regardless of DATA_DIR,
// so the live model silently never trained on production data. server.js passes
// DATA_DIR into this script's env (checkAndRetrain / runGbdtRetrain) specifically
// so this resolves the same way server.js's own DATA_DIR does — falls back to the
// local data/ dir only when DATA_DIR truly isn't set (e.g. run standalone in dev).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');

// ─── RETRAIN GATE + VERSION ARCHIVE (2026-09-09, item I) ─────────────────────
// Every version that has ever been deployed is kept under DATA_DIR/model-archive/
// (gbdt-weights-<trainedAt>.json + index.json) so any past fixture can be
// re-scored with exactly the version that scored it live, and so a version
// change is recoverable without a redeploy. Rejected candidates are NOT
// archived (their stats go to retrain-gate-result.json instead).
//
// The improvement gate used to compare the candidate's log-loss on ITS OWN
// newest-20% slice against the number the deployed weights file stored from
// ITS OWN (older, different) slice — not like-for-like, and it rejected every
// weekly cycle from 2026-08-08 onwards. It now scores BOTH models on the same
// paired window (the candidate's held-out slice, restricted to fixtures after
// the deployed model's own tree boundary so it is out-of-sample for both) and
// decides on the paired per-fixture log-loss difference.
//
// Policy: 'non-inferiority' (default) adopts the candidate unless it is
// significantly or materially WORSE than the deployed model on that window —
// the weekly walk-forward cycle exists to fold newly-resolved fixtures into a
// fixed recipe, and with a fixed recipe two candidates a week apart are
// statistically indistinguishable, so any superiority test freezes the model
// (which is exactly what happened). 'superiority' keeps the old semantics
// (adopt only if better by GATE_BETTER_MARGIN) on the now like-for-like
// window. Flip the one constant to change policy; the gate result records
// which policy decided.
// ─── STANDALONE PER-LEAGUE MODE (2026-09-16, Addendum 54) ───────────────────
// LEAGUE_ID=<id> trains a model on that league's rows ONLY (every season,
// including rows before its rule-12 cutoff — the "excluded from training
// forever" clause is retired: banked backtests are immutable via the archive),
// writes gbdt-weights-<id>.json, keeps its own archive under
// model-archive/league-<id>/, gates only against its own previous version on
// its own out-of-sample window, and never touches the domestic aggregate or
// the pocket gates. No other league's rows or performance enter its path.
const LEAGUE_ID          = process.env.LEAGUE_ID ? parseInt(process.env.LEAGUE_ID, 10) : null;
const STANDALONE         = Number.isFinite(LEAGUE_ID);
// TRAIN_BEFORE=<iso>: cap the rows the model sees (trees AND Platt) at this date.
// Walk-forward design for a standalone league's investigation: trees on rows
// before TRAIN_BEFORE, cell selection on a later window that the trees never
// saw, one test look after that. The final live model is then retrained on all
// rows with the same fixed recipe; the forward shadow validates model + cell.
const TRAIN_BEFORE       = process.env.TRAIN_BEFORE || null;
// STANDALONE_TRAIN_ALL=1 (2026-09-21, Addendum 65 follow-up): a standalone model
// under forward validation must not learn from the rows that validate it. By
// default a standalone league's rows on/after its date-split cutoff
// (DATE_SPLIT_CUTOFFS below — the pre-registration date) are excluded from
// BOTH trees and Platt, so the weekly retrain can never fold the forward window
// into the model being read. The pooled model already lives under the same
// exclusion. Set STANDALONE_TRAIN_ALL=1 only once the league is cut over
// (STANDALONE_ACTIVE) and its forward window is closed as evidence.
const STANDALONE_TRAIN_ALL = process.env.STANDALONE_TRAIN_ALL === '1';
// RECENCY_HALF_LIFE=<seasons> (2026-09-17, Addendum 62): sample weight
// 0.5^(ageSeasons / halfLife), anchored at the newest TRAINING row, applied to the
// Newton gradients and hessians (and the class prior). Evaluation (Platt fit,
// quality gates, paired gate) stays unweighted — a test must not down-weight the
// evidence it dislikes. Unset = every row weight 1 (the recipe as it always was).
const RECENCY_HALF_LIFE  = process.env.RECENCY_HALF_LIFE ? parseFloat(process.env.RECENCY_HALF_LIFE) : null;
const RUN_TAG            = process.env.RUN_TAG || '';
// REGIME_FEATURES=none|flag|rate|both (FD-2, 2026-09-20, Addendum 63): which of the
// two regime features (buildFeatures indices 24 closedDoors, 25 leagueHomeRate)
// the trees may split on. Masked features are zeroed in the TRAINING matrix only;
// a tree never splits on a constant, so at prediction time the live value is
// simply ignored. 'none' (default) is the recipe as it stands — bit-for-bit the
// 24-feature model when TRAIN_SEED is fixed.
const REGIME_FEATURES    = (process.env.REGIME_FEATURES || 'none').toLowerCase();
if (!['none', 'flag', 'rate', 'both'].includes(REGIME_FEATURES)) { console.error(`REGIME_FEATURES must be none|flag|rate|both, got ${REGIME_FEATURES}`); process.exit(1); }
const REGIME_MASK        = { none: [false, false], flag: [true, false], rate: [false, true], both: [true, true] }[REGIME_FEATURES];
function maskRegime(x) { if (REGIME_FEATURES === 'both') return x; const y = x.slice(); if (!REGIME_MASK[0]) y[24] = 0; if (!REGIME_MASK[1]) y[25] = 0; return y; }
// TRAIN_SEED=<int>: seed the subsampling RNG so a control and a candidate that
// differ only in features draw the same subsamples (mulberry32). Unset = Math.random.
const TRAIN_SEED         = process.env.TRAIN_SEED ? parseInt(process.env.TRAIN_SEED, 10) : null;
const rng = (() => { if (!Number.isFinite(TRAIN_SEED)) return Math.random; let a = TRAIN_SEED >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
const WEIGHTS_SUFFIX     = (TRAIN_BEFORE ? `-wf${TRAIN_BEFORE.slice(0, 10)}` : '') + (RECENCY_HALF_LIFE ? `-hl${RECENCY_HALF_LIFE}` : '') + (REGIME_FEATURES !== 'none' ? `-rg${REGIME_FEATURES}` : '') + (RUN_TAG ? `-${RUN_TAG}` : '');
const WEIGHTS_FILE       = STANDALONE ? `gbdt-weights-${LEAGUE_ID}${WEIGHTS_SUFFIX}.json` : 'gbdt-weights.json';
const ARCHIVE_DIR        = STANDALONE ? path.join(DATA_DIR, 'model-archive', `league-${LEAGUE_ID}`) : path.join(DATA_DIR, 'model-archive');
const GATE_POLICY        = 'non-inferiority'; // | 'superiority'
// GATE_DRY_RUN=1 (2026-09-14): train a candidate, run the full paired gate with
// its breakdown, archive the candidate as 'dry-run', write the result to
// retrain-gate-dryrun.json — and never touch gbdt-weights.json. Exists so a
// rejection can be diagnosed on demand without risking a deploy.
const GATE_DRY_RUN       = process.env.GATE_DRY_RUN === '1';
const GATE_WORSE_Z       = 1.645;  // reject if candidate worse with one-sided p<0.05
const GATE_WORSE_ABS     = 0.002;  // reject if candidate worse by this much regardless of z
const GATE_BETTER_MARGIN = 0.001;  // superiority policy only: adopt if better by this much
// Mirrors server.js KNOWN_TREE_BOUNDARIES: the one deployed version that
// predates the treeBoundary field (Addendum 14's reproduction of its split).
const KNOWN_TREE_BOUNDARIES = { '2026-08-08T20:56:33.315Z': '2022-11-14T00:00:00Z' };

// ─── POCKET-AWARE GATE (2026-09-15, Addendum 53) ──────────────────────────────
// The domestic paired gate cannot see a league that contributes a few dozen rows
// to the window (League Two: 72), so a candidate can be adopted while measurably
// worse on the one league real money depends on. For every entry here the
// candidate must ALSO be non-inferior on that league's own population:
//   hard: paired log-loss on every scored record of the league (pre-cutoff rows
//         are out-of-sample for both models — they never train), same thresholds
//         as the main gate;
//   soft: the live pocket rule's beyond-market residual (actual − Pinnacle
//         margin-stripped closing probability) on the matched rows must not fall
//         by more than 2 SE against the deployed model's own reading.
// The probability chain is the live one for a unified league: model → league
// bias correction → deployed correction layer (settings.deployedCorrectionRuleIds).
// Mirrors server.js's rule constants for the league (kept in lockstep by hand).
const POCKET_GATES = [
  { leagueId: 42, label: 'League Two live rule 9/40', factor: 0.93, edgeMin: 0.09, probMin: 0.40, cutoff: '2026-08-11T09:00:00Z' }, // Addendum 53 (2026-09-15)
  { leagueId: 41, label: 'League One pocket 12/50 year-round', factor: 0.93, edgeMin: 0.12, probMin: 0.50, cutoff: '2026-08-11T09:00:00Z' }, // Addendum 58 (2026-09-17)
  { leagueId: 41, label: 'League One pocket Jan–May 5/45', factor: 0.93, edgeMin: 0.05, probMin: 0.45, months: [1, 5], cutoff: '2026-08-11T09:00:00Z' }, // Addendum 58
];

function loadPocketRecords(leagueId) {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'backfill-historical.json'), 'utf8'));
  attachRegime(raw.scoredRecords || [], buildLeagueHomeRateIndex(raw.fixtures || [])); // FD-2
  return (raw.scoredRecords || [])
    .filter(r => parseInt(r.leagueId, 10) === leagueId && r.context === 'club_domestic' && r.homeFactors && r.awayFactors && r.actualOutcome && r.date)
    .map(r => ({ x: buildFeatures(r.homeFactors, r.awayFactors, r.context), y: r.actualOutcome, date: r.date, context: r.context, leagueId: r.leagueId, fixtureId: r.fixtureId, homeFactors: r.homeFactors, awayFactors: r.awayFactors }));
}

function pocketGate(gate, candFn, depFn) {
  const recs = loadPocketRecords(gate.leagueId);
  if (!recs.length) return { ...gate, skipped: 'no records' };
  let closing = {}, settings = {};
  try { closing = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'closing-odds.json'), 'utf8')); } catch {}
  try { settings = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8')); } catch {}
  // 2026-09-22 (Part 6 check): the gate no longer mirrors the chain by hand — candidate and
  // deployed raw probabilities go through sharedScorer.scoreProbabilities itself (pooled
  // template, validation options), so every stage the live chain has — bias, correction
  // layer, regime offset, anything added later — is the one the gate measures.
  const { scoreProbabilities } = require('../sharedScorer'); const { WEIGHTS_BY_CONTEXT, CONTEXT_CONFIG } = require('../scoring');
  const chain = (raw, rec) => scoreProbabilities({ rawProbsOverride: raw, homeF: rec?.homeFactors || {}, awayF: rec?.awayFactors || {}, weights: WEIGHTS_BY_CONTEXT.club_domestic, context: 'club_domestic', leagueId: gate.leagueId, leagueConfig: LEAGUE_CONFIG[gate.leagueId], settings, cfg: CONTEXT_CONFIG.club_domestic, dataConf: 1, modelKey: 'pooled', options: { rankAdjust: false, hostBoost: false, modifiers: false } }).probs;
  // hard: paired log-loss on the league's own records (raw model probabilities, same currency as the main gate)
  const ll = pairedLogLoss(recs, candFn, depFn);
  // soft: pocket residual under the live chain on matched pre-cutoff rows
  const cell = (fn) => {
    const rows = [];
    for (const r of recs) {
      if (r.date >= gate.cutoff) continue;
      const co = closing[r.fixtureId] || closing[String(r.fixtureId)];
      if (!co || co.bookmaker !== 'pinnacle' || !(co.homeOdds > 1 && co.drawOdds > 1 && co.awayOdds > 1)) continue;
      const p = chain(fn(r), r);
      const pick = p.home >= p.draw && p.home >= p.away ? 'home' : p.away >= p.draw ? 'away' : 'draw';
      const calProb = Math.min(0.97, p[pick] * gate.factor);
      const stripped = marginStrippedImplied(co);
      if (gate.months) { const mo = new Date(r.date).getUTCMonth() + 1; if (mo < gate.months[0] || mo > gate.months[1]) continue; }
      if (!(calProb - stripped[pick] >= gate.edgeMin && p[pick] >= gate.probMin)) continue;
      const won = r.y === pick;
      rows.push({ bm: (won ? 1 : 0) - stripped[pick], pnl: won ? co[`${pick}Odds`] - 1 : -1 });
    }
    const n = rows.length; if (!n) return { n: 0 };
    const bm = rows.reduce((a, x) => a + x.bm, 0) / n;
    const sd = Math.sqrt(rows.reduce((a, x) => a + (x.bm - bm) ** 2, 0) / Math.max(1, n - 1));
    return { n, beyondMarketPp: +(bm * 100).toFixed(2), sePp: +((sd / Math.sqrt(n)) * 100).toFixed(2), roiClosePct: +((rows.reduce((a, x) => a + x.pnl, 0) / n) * 100).toFixed(1) };
  };
  const cand = cell(candFn), dep = cell(depFn);
  const hardWorse = ll.n && ((ll.z != null && ll.z >= GATE_WORSE_Z) || ll.meanDiff >= GATE_WORSE_ABS);
  let softWorse = false, softNote = 'n/a';
  if (cand.n >= 30 && dep.n >= 30) {
    const tol = 2 * Math.sqrt(cand.sePp ** 2 + dep.sePp ** 2);
    softWorse = (dep.beyondMarketPp - cand.beyondMarketPp) > tol;
    softNote = `deployed ${dep.beyondMarketPp}pp (n=${dep.n}) vs candidate ${cand.beyondMarketPp}pp (n=${cand.n}); tolerance ${tol.toFixed(1)}pp`;
  } else softNote = `cell too thin to gate (candidate n=${cand.n}, deployed n=${dep.n})`;
  return { ...gate, records: recs.length, logLoss: { n: ll.n, candidate: ll.candidateLogLoss, deployed: ll.deployedLogLoss, meanDiff: ll.meanDiff, se: ll.se, z: ll.z }, pocket: { candidate: cand, deployed: dep, note: softNote }, hardWorse, softWorse, pass: !(hardWorse || softWorse) };
}

function safeVersionName(v) { return String(v).replace(/[^0-9A-Za-z._-]/g, '_'); }

function readArchiveIndex() {
  try { return JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, 'index.json'), 'utf8')); } catch { return []; }
}

function writeArchiveIndex(index) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARCHIVE_DIR, 'index.json'), JSON.stringify(index, null, 2));
}

// Idempotent: archive a weights object under its trainedAt if not already there,
// and (re)mark its status. Returns the index entry.
function archiveVersion(weights, status, extra = {}) {
  if (!weights?.trainedAt) return null;
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const file = `gbdt-weights-${safeVersionName(weights.trainedAt)}.json`;
  const full = path.join(ARCHIVE_DIR, file);
  if (!fs.existsSync(full)) fs.writeFileSync(full, JSON.stringify(weights));
  const index = readArchiveIndex();
  let entry = index.find(e => e.version === weights.trainedAt);
  if (!entry) {
    entry = {
      version:      weights.trainedAt,
      file,
      archivedAt:   new Date().toISOString(),
      trainN:       weights.trainN ?? null,
      testN:        weights.testN ?? null,
      treeBoundary: weights.treeBoundary ?? null,
      validation:   weights.validation ?? weights.metrics ?? null,
      hyperparams:  weights.hyperparams ?? null,
    };
    index.push(entry);
  }
  Object.assign(entry, extra, { status, statusAt: new Date().toISOString() });
  index.sort((a, b) => a.version < b.version ? -1 : 1);
  writeArchiveIndex(index);
  return entry;
}

function writeGateResult(result) {
  const suffix = (STANDALONE ? `-${LEAGUE_ID}` : '') + (RUN_TAG ? `-${RUN_TAG}` : '');
  const file = GATE_DRY_RUN ? `retrain-gate-dryrun${suffix}.json` : `retrain-gate-result${suffix}.json`;
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify({ ...result, dryRun: GATE_DRY_RUN }, null, 2));
}

// Prediction function for an arbitrary weights object (deployed or archived),
// identical arithmetic to models/gbdt.js predict() and to gbdtProb() below.
function probFnFromWeights(w) {
  return (r) => {
    const pHome = sigmoid(w.platt.home.A * ensembleRaw(w.classifiers.home, r.x) + w.platt.home.B);
    const pDraw = sigmoid(w.platt.draw.A * ensembleRaw(w.classifiers.draw, r.x) + w.platt.draw.B);
    const pAway = sigmoid(w.platt.away.A * ensembleRaw(w.classifiers.away, r.x) + w.platt.away.B);
    const s = pHome + pDraw + pAway;
    return { home: pHome / s, draw: pDraw / s, away: pAway / s };
  };
}

// Paired per-fixture log-loss comparison of two probability functions on the
// same records. diff = candidate − deployed, so negative means candidate better.
function _summariseDiffs(rows) {
  const n = rows.length;
  if (!n) return { n: 0 };
  let llC = 0, llD = 0;
  for (const r of rows) { llC += r.lc; llD += r.ld; }
  const meanDiff = rows.reduce((a, r) => a + r.d, 0) / n;
  const varDiff  = n > 1 ? rows.reduce((a, r) => a + (r.d - meanDiff) ** 2, 0) / (n - 1) : 0;
  const se       = n > 1 ? Math.sqrt(varDiff / n) : null;
  const z        = se ? meanDiff / se : null;
  return { n, candidateLogLoss: llC / n, deployedLogLoss: llD / n, meanDiff, se, z };
}

// 2026-09-14 (Addendum 50 follow-through): the first live run rejected the
// candidate at z 3.55 without saying WHERE the regression sat. The paired
// result now carries a breakdown by league, by the deployed model's top-pick
// probability band (a fixed reference the candidate cannot move), by context
// and by fixture year, each with n / mean diff / SE / z and the cell's share of
// the total difference (n × meanDiff over the window total), so a rejection
// or adoption names its shape. Diagnosis of causes is a separate decision.
function _breakdown(rows, keyFn, totalDiffSum) {
  const groups = new Map();
  for (const r of rows) { const k = keyFn(r); if (k == null) continue; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const out = [];
  for (const [key, list] of groups) {
    const sm = _summariseDiffs(list);
    out.push({ key, n: sm.n, meanDiff: sm.meanDiff, se: sm.se, z: sm.z, candidateLogLoss: sm.candidateLogLoss, deployedLogLoss: sm.deployedLogLoss,
               shareOfTotalDiff: totalDiffSum ? (sm.meanDiff * sm.n) / totalDiffSum : null });
  }
  out.sort((a, b) => Math.abs((b.meanDiff || 0) * b.n) - Math.abs((a.meanDiff || 0) * a.n));
  return out;
}

function pairedLogLoss(records, candFn, depFn) {
  const rows = [];
  for (const r of records) {
    const pc = candFn(r), pd = depFn(r);
    const yc = r.y === 'home' ? pc.home : r.y === 'draw' ? pc.draw : pc.away;
    const yd = r.y === 'home' ? pd.home : r.y === 'draw' ? pd.draw : pd.away;
    const lc = -Math.log(Math.max(EPS, yc)), ld = -Math.log(Math.max(EPS, yd));
    const depTop = Math.max(pd.home, pd.draw, pd.away);
    rows.push({ lc, ld, d: lc - ld, leagueId: r.leagueId, context: r.context, year: String(r.date || '').slice(0, 4) || null,
                depBand: depTop < 0.40 ? '<40%' : depTop < 0.50 ? '40-50%' : depTop < 0.60 ? '50-60%' : depTop < 0.70 ? '60-70%' : '70%+' });
  }
  const total = _summariseDiffs(rows);
  if (!total.n) return { n: 0 };
  // Shares are only meaningful when the window-level difference is material;
  // below 1e-4 mean log-loss they would be ratios of noise to noise.
  const totalDiffSum = Math.abs(total.meanDiff) >= 1e-4 ? total.meanDiff * total.n : 0;
  return {
    ...total,
    breakdown: {
      byLeague:  _breakdown(rows, r => String(r.leagueId), totalDiffSum),
      byBand:    _breakdown(rows, r => r.depBand, totalDiffSum),
      byContext: _breakdown(rows, r => r.context, totalDiffSum),
      byYear:    _breakdown(rows, r => r.year, totalDiffSum),
    },
  };
}

// 2026-08-24 (calibration-rules.md rule 15): no rule-10 holdout stays fully/
// permanently excluded any more -- it exists only long enough to bank one
// genuine backtest, then converts immediately to a date-split cutoff (rule
// 12's mechanism), same end-state League One/Two reached. Championship (40)
// and Carabao Cup (48) have both converted below -- Carabao Cup once its
// corrected rescore (the domestic-blend over-broad-filter fix) produced its
// own clean, banked read (CALIBRATION_AUDIT[48]: posEdgeN=192, ROI +8.04%).
// Serie B (136), Segunda División (141), 2. Bundesliga (79) were rule-10 holdouts
// for the evening of 2026-09-04 only; converted to the date-splits below the same
// evening once their single backtests were banked (rule 15, Addendum 43).
const FULLY_EXCLUDED_LEAGUE_IDS = new Set([]);

// Per-league date-split cutoff (calibration-rules.md rules 12/15). Real money
// is staked on League One/Two and new fixtures resolve weekly with no way to
// improve the model on them, but each league's own banked backtest was
// computed against its own pre-cutoff population and must never be
// contaminated. Anything with a kickoff strictly before a league's own
// cutoff stays excluded from training forever, preserving exactly the
// population that league's read was computed against. Anything at or after
// is training-eligible once it resolves, same as every other league on the
// weekly retrain cycle. This is a training-pool-only decision — it does NOT
// authorize touching avgHomeWinRate/homeAdvBaseWeight/etc. (rule 10) for any
// of these leagues, and it must never be inferred from
// UNSEEN_POPULATION_LEAGUES/historicalSource in server.js, which stay
// decoupled and permanently 'real-backtest' regardless of what this filter
// does (rule 12).
const DATE_SPLIT_CUTOFFS = new Map([
  [136, '2026-09-04T21:00:00Z'], // Serie B — Addendum 43 Part 2 backtest compute time, rounded up
  [141, '2026-09-04T21:00:00Z'], // Segunda División
  [79,  '2026-09-04T21:00:00Z'], // 2. Bundesliga
  // League One / League Two — commit timestamp of the temp diagnostic that
  // produced Addendum 19's matched-population read (2c0ed15,
  // 2026-08-11T08:13:41+01:00 = 07:13:41 UTC), rounded up to a clean margin
  // past the latest plausible query time that same morning.
  [41, '2026-08-11T09:00:00Z'],
  [42, '2026-08-11T09:00:00Z'],
  // Championship — commit timestamp of the endpoint that produced its
  // banked backtest read (387adb3, 2026-08-19T21:42:33+01:00 =
  // 20:42:33 UTC), rounded up past the later display-wiring commit
  // (66e2870, 20:50:18 UTC) the same evening.
  [40, '2026-08-19T22:00:00Z'],
  // Carabao Cup — converted 2026-08-24 per rule 15, immediately after its
  // corrected backtest (Addendum 27, CALIBRATION_AUDIT[48]). Cutoff =
  // commit timestamp of the last diagnostic used to verify that read
  // (dcefd7d, 2026-08-24T16:47:37+01:00 = 15:47:37 UTC), rounded up past it
  // the same evening.
  [48, '2026-08-24T16:00:00Z'],
]);

function isTrainingExcluded(leagueId, date) {
  const lid = parseInt(leagueId, 10);
  if (FULLY_EXCLUDED_LEAGUE_IDS.has(lid)) return true;
  const cutoff = DATE_SPLIT_CUTOFFS.get(lid);
  if (cutoff !== undefined) {
    // No date on record → fail safe toward exclusion rather than risk folding
    // in a fixture that can't be verified as post-cutoff.
    if (!date) return true;
    return new Date(date).getTime() < new Date(cutoff).getTime();
  }
  return false;
}

const FORWARD_FREEZE = (STANDALONE && !STANDALONE_TRAIN_ALL) ? (DATE_SPLIT_CUTOFFS.get(LEAGUE_ID) || null) : null;
function loadData() {
  if (FORWARD_FREEZE) console.log(`  [Standalone] forward window frozen: rows on/after ${FORWARD_FREEZE} excluded from trees and Platt (STANDALONE_TRAIN_ALL unset)`);
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'backfill-historical.json'), 'utf8'));
  const records = raw.scoredRecords || [];
  const attached = attachRegime(records, buildLeagueHomeRateIndex(raw.fixtures || [])); // FD-2: pre-2026-09-20 records
  if (attached) console.log(`  [Regime] attached regime features to ${attached} records lacking them (features=${REGIME_FEATURES})`);
  return records
    .filter(r => r.homeFactors && r.awayFactors && r.actualOutcome && r.context)
    // 2026-09-15 (Addendum 51): domestic club football only. Tournament and
    // international rows never train, never sit in the gate window.
    .filter(r => r.context === 'club_domestic' && !RETIRED_LEAGUE_IDS.has(parseInt(r.leagueId, 10)))
    // Standalone: this league's rows only, all seasons (cutoffs do not apply —
    // the model IS the league's own). Pooled: the usual date-split exclusions.
    .filter(r => STANDALONE ? parseInt(r.leagueId, 10) === LEAGUE_ID : !isTrainingExcluded(r.leagueId, r.date))
    .filter(r => !TRAIN_BEFORE || r.date < TRAIN_BEFORE)
    .filter(r => !FORWARD_FREEZE || r.date < FORWARD_FREEZE) // standalone in shadow: forward window never trains (trees or Platt)
    .map(r => ({
      x:        maskRegime(buildFeatures(r.homeFactors, r.awayFactors, r.context)),
      y:        r.actualOutcome,   // 'home' | 'draw' | 'away'
      date:     r.date,
      context:  r.context,
      leagueId: r.leagueId,
      homeFactors: r.homeFactors,
      awayFactors: r.awayFactors,
    }));
}

// ─── TIME-STRATIFIED SPLIT ────────────────────────────────────────────────────
function splitData(records) {
  const sorted = records.slice().sort((a, b) => a.date < b.date ? -1 : 1);
  const cutoff = Math.floor(sorted.length * 0.8);
  return { train: sorted.slice(0, cutoff), test: sorted.slice(cutoff) };
}

// ─── MATH HELPERS ─────────────────────────────────────────────────────────────
const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));
const mean = arr => arr.reduce((s, v) => s + v, 0) / arr.length;

// ─── DECISION TREE ────────────────────────────────────────────────────────────
// Builds a tree on (X, residuals, hessians) using XGBoost-style split gain
// with L2 regularisation. Leaf value = sum(g) / (sum(h) + lambda).
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

      // XGBoost gain formula with L2 regularisation
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

// ─── GBDT TRAINER ─────────────────────────────────────────────────────────────
// One-vs-rest binary log-loss GBDT with stochastic subsampling + Newton steps.
// Async, not for this function's own math (still plain synchronous tree-building)
// but so the training run yields periodically — same pattern used to fix this
// week's scoring-loop/optimiser/profile-rebuild crashes on the same 512MB
// instance. This runs in a spawned child process, not the main server, so it was
// never blocking live traffic — but the child is still a single Node process on
// the same memory-constrained container, and 200 synchronous tree-builds over a
// growing weekly population with zero yields is exactly the same risk shape as
// those earlier bugs, just in a different process. Yielding here also means a
// SIGKILL from hitting the memory ceiling lands between trees rather than mid-
// tree, and gives the OS a chance to reclaim per-iteration garbage (subX/subG/
// subH/allIdx are all rebuilt fresh every tree) before the next allocation.
async function trainClassifier(samples, classLabel, sampleW = null) {
  const X = samples.map(s => s.x);
  const y = samples.map(s => s.y === classLabel ? 1 : 0);
  const n = X.length;
  const W = sampleW || new Float64Array(n).fill(1);
  const wSum = W.reduce((s, v) => s + v, 0);
  const prior = y.reduce((s, v, i) => s + v * W[i], 0) / wSum;
  const initValue = Math.log((prior + 1e-6) / (1 - prior + 1e-6));

  const F = new Float64Array(n).fill(initValue);
  const trees = [];
  const subN = Math.floor(n * SUBSAMPLE);

  process.stdout.write(`  Training ${classLabel.padEnd(5)}: `);
  for (let t = 0; t < N_TREES; t++) {
    const probs = F.map(f => sigmoid(f));
    // Newton gradients (residuals) and hessians for log-loss
    const gradients = y.map((yi, i) => (yi - probs[i]) * W[i]);   // first derivative × sample weight
    const hessians  = probs.map((p, i) => p * (1 - p) * W[i]);     // second derivative × sample weight

    // Stochastic subsampling: random subset of indices
    const allIdx = Array.from({length: n}, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {             // Fisher-Yates shuffle
      const j = Math.floor(rng() * (i + 1));
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

// ─── PLATT SCALING ────────────────────────────────────────────────────────────
// Fits P_cal = sigmoid(A * logOdds + B) by gradient descent on binary log-loss.
// Init A=1 (identity for log-odds input), B=0.
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

// ─── ENSEMBLE PREDICT ─────────────────────────────────────────────────────────
function ensembleRaw(classifier, x) {
  let F = classifier.initValue;
  for (const tree of classifier.trees) F += classifier.lr * treePredict(tree, x);
  return F;
}

// ─── LINEAR BASELINE ─────────────────────────────────────────────────────────
function linearPredict(record) {
  const lid     = parseInt(record.leagueId, 10);
  const weights = WEIGHTS_BY_CONTEXT[record.context] || WEIGHTS_BY_CONTEXT.club_domestic;
  const lc      = LEAGUE_CONFIG[lid] || null;
  return computeModelProb(record.homeFactors, record.awayFactors, weights, record.context, lc);
}

// ─── METRICS ─────────────────────────────────────────────────────────────────
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

function bandAccuracy(records, probFn) {
  const bands = [
    { label: '<40%',   lo: 0,    hi: 0.40 },
    { label: '40–50%', lo: 0.40, hi: 0.50 },
    { label: '50–60%', lo: 0.50, hi: 0.60 },
    { label: '60–70%', lo: 0.60, hi: 0.70 },
    { label: '70%+',   lo: 0.70, hi: 1.01 },
  ];

  return bands.map(band => {
    const inBand = records.filter(r => {
      const p = probFn(r);
      const topP = Math.max(p.home, p.draw, p.away);
      return topP >= band.lo && topP < band.hi;
    });
    if (!inBand.length) return { ...band, n: 0, avgPred: null, actual: null, bias: null };
    const avgPred = mean(inBand.map(r => {
      const p = probFn(r);
      return Math.max(p.home, p.draw, p.away);
    }));
    const correct = inBand.filter(r => {
      const p = probFn(r);
      const topLabel = p.home >= p.draw && p.home >= p.away ? 'home'
                     : p.draw >= p.away ? 'draw' : 'away';
      return topLabel === r.y;
    }).length;
    const actual = correct / inBand.length;
    return { ...band, n: inBand.length, avgPred: avgPred * 100, actual: actual * 100, bias: (actual - avgPred) * 100 };
  });
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  GBDT + Platt Scaling — Training & Validation   ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  console.log(`Loading data... (DATA_DIR=${DATA_DIR}, env DATA_DIR=${process.env.DATA_DIR ?? '(unset)'}${STANDALONE ? `, STANDALONE league ${LEAGUE_ID} -> ${WEIGHTS_FILE}` : ', pooled domestic'})`);
  const all    = loadData();
  const { train, test } = splitData(all);
  console.log(`  Total: ${all.length}  |  Train: ${train.length}  |  Test (held-out): ${test.length}`);
  // Tree boundary (2026-09-04, docs/model-versioning.md "Tree boundary"): the
  // chronological split above means every fixture dated before test[0].date was
  // used to BUILD these trees. Logged here and persisted into the weights file
  // below so any "held-out"/"validated" backtest scored with these weights can
  // exclude those fixtures mechanically (server.js getModelTreeBoundary()),
  // instead of someone having to reproduce this split after the fact against a
  // pool that has since grown (Addendum 14 had to do exactly that).
  const treeBoundary = {
    lastTrainFixtureDate:  train[train.length - 1]?.date ?? null,
    firstTestFixtureDate:  test[0]?.date ?? null,
    trainPoolN:            all.length,
  };
  console.log(`  Tree boundary — trees trained on fixtures up to ${treeBoundary.lastTrainFixtureDate}; first test fixture ${treeBoundary.firstTestFixtureDate}`);

  const ctxCount = (arr, ctx) => arr.filter(r => r.context === ctx).length;
  console.log(`  Train — domestic:${ctxCount(train,'club_domestic')} european:${ctxCount(train,'club_european')} intl:${ctxCount(train,'international')}`);
  console.log(`  Test  — domestic:${ctxCount(test, 'club_domestic')} european:${ctxCount(test, 'club_european')} intl:${ctxCount(test, 'international')}\n`);

  // ── Train classifiers ──
  console.log(`Training (${N_TREES} trees, depth ${DEPTH}, lr ${LR})...`);
  // Recency weights (Addendum 62): anchored at the newest training row.
  let sampleW = null, effectiveN = train.length;
  if (RECENCY_HALF_LIFE) {
    const anchorMs = Math.max(...train.map(r => new Date(r.date).getTime()));
    sampleW = new Float64Array(train.length);
    for (let i = 0; i < train.length; i++) { const age = (anchorMs - new Date(train[i].date).getTime()) / (365.25 * 86400000); sampleW[i] = Math.pow(0.5, age / RECENCY_HALF_LIFE); }
    const sw = sampleW.reduce((a, b) => a + b, 0), sw2 = sampleW.reduce((a, b) => a + b * b, 0);
    effectiveN = Math.round(sw * sw / sw2);
    console.log(`  Recency weighting: half-life ${RECENCY_HALF_LIFE} seasons, anchor ${new Date(anchorMs).toISOString().slice(0, 10)}, effective n ${effectiveN} of ${train.length}`);
  }
  const classifiers = {
    home: await trainClassifier(train, 'home', sampleW),
    draw: await trainClassifier(train, 'draw', sampleW),
    away: await trainClassifier(train, 'away', sampleW),
  };

  // ── Fit Platt scaling on validation set ──
  console.log('\nFitting Platt scaling on validation set...');
  const platt = {};
  for (const cls of ['home', 'draw', 'away']) {
    const logOdds = test.map(r => ensembleRaw(classifiers[cls], r.x));
    const yBin    = test.map(r => r.y === cls ? 1 : 0);
    platt[cls]    = fitPlatt(logOdds, yBin);
    console.log(`  ${cls.padEnd(5)}: A=${platt[cls].A.toFixed(4)}  B=${platt[cls].B.toFixed(4)}`);
  }

  // ── Build prediction functions ──
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

  function linearProbWrapped(r) {
    return linearPredict(r);
  }

  // ── Compute metrics ──
  console.log('\nComputing validation metrics...');
  const llGBDT   = logLoss(test, gbdtProb);
  const llLinear = logLoss(test, linearProbWrapped);
  const bsGBDT   = brierScore(test, gbdtProb);
  const bsLinear = brierScore(test, linearProbWrapped);
  const bandsGBDT   = bandAccuracy(test, gbdtProb);
  const bandsLinear = bandAccuracy(test, linearProbWrapped);

  // ── Report ──
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║                    VALIDATION RESULTS (held-out 20%)               ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  Metric          Linear      GBDT+Platt    Δ');
  console.log('  ─────────────────────────────────────────────');
  const llDelta = llGBDT - llLinear;
  const bsDelta = bsGBDT - bsLinear;
  console.log(`  Log-loss        ${llLinear.toFixed(4)}      ${llGBDT.toFixed(4)}        ${llDelta > 0 ? '+' : ''}${llDelta.toFixed(4)}`);
  console.log(`  Brier score     ${bsLinear.toFixed(4)}      ${bsGBDT.toFixed(4)}        ${bsDelta > 0 ? '+' : ''}${bsDelta.toFixed(4)}`);

  console.log('\n  Probability band accuracy (top-pick band):');
  console.log('  Band        n      AvgPred   Actual    Bias (Linear)  Bias (GBDT)');
  console.log('  ─────────────────────────────────────────────────────────────────');
  for (let i = 0; i < bandsGBDT.length; i++) {
    const g = bandsGBDT[i];
    const l = bandsLinear[i];
    if (!g.n) continue;
    const biasL = l.bias != null ? (l.bias > 0 ? '+' : '') + l.bias.toFixed(1) + 'pp' : 'n/a';
    const biasG = g.bias != null ? (g.bias > 0 ? '+' : '') + g.bias.toFixed(1) + 'pp' : 'n/a';
    console.log(`  ${g.label.padEnd(10)}  ${String(g.n).padStart(4)}   ${l.avgPred?.toFixed(1).padStart(5)}%     ${l.actual?.toFixed(1).padStart(5)}%    ${biasL.padStart(8)}     ${biasG.padStart(8)}`);
  }

  // ── Quality gates ──
  console.log('\n  Quality gates:');
  const gate1 = llGBDT < llLinear;
  const band5060Linear = bandsLinear.find(b => b.label === '50–60%');
  const band5060GBDT   = bandsGBDT.find(b   => b.label === '50–60%');
  const gate2 = band5060GBDT && band5060Linear
    && Math.abs(band5060GBDT.bias) < Math.abs(band5060Linear.bias)
    && Math.abs(band5060GBDT.bias) <= 5.0;

  // Regression check: <40% and 60-70% bias must not worsen by more than 3pp.
  // 3pp tolerance approved (2026-07-25): <40% band increase is within 1 SE (n=188)
  // caused by model reclassifying 222 fixtures upward, not miscalibration.
  const checkBand = (label) => {
    const g = bandsGBDT.find(b => b.label === label);
    const l = bandsLinear.find(b => b.label === label);
    if (!g || !l || !g.bias || !l.bias) return true;
    return Math.abs(g.bias) <= Math.abs(l.bias) + 3.0;
  };
  const gate3 = checkBand('<40%') && checkBand('60–70%');

  console.log(`  [${gate1 ? '✓' : '✗'}] Gate 1: Lower log-loss (${llGBDT.toFixed(4)} < ${llLinear.toFixed(4)})`);
  console.log(`  [${gate2 ? '✓' : '✗'}] Gate 2: 50–60% band bias reduced to ≤±5pp (GBDT: ${band5060GBDT?.bias?.toFixed(1) ?? 'n/a'}pp, Linear: ${band5060Linear?.bias?.toFixed(1) ?? 'n/a'}pp)`);
  console.log(`  [${gate3 ? '✓' : '✗'}] Gate 3: No regression on <40% or 60–70% bands`);

  const allGatesMet = gate1 && gate2 && gate3;
  console.log(`\n  Verdict: ${allGatesMet ? `✅ ALL GATES MET — writing ${WEIGHTS_FILE}` : `❌ GATES NOT MET — ${STANDALONE ? 'no standalone model for this league (predictLeague stays null)' : 'keeping linear model'}`}`);

  if (!allGatesMet) {
    // Dry runs archive the candidate anyway (status 'dry-run-gates-failed') so a
    // recipe comparison is still possible — the quality gates guard DEPLOYMENT, not
    // measurement (Addendum 62).
    if (GATE_DRY_RUN) archiveVersion({ trainedAt: new Date().toISOString(), standaloneLeagueId: STANDALONE ? LEAGUE_ID : null, recipe: { halfLifeSeasons: RECENCY_HALF_LIFE, trainBefore: TRAIN_BEFORE, tag: RUN_TAG || null, regimeFeatures: REGIME_FEATURES, trainSeed: TRAIN_SEED, forwardFreeze: FORWARD_FREEZE, effectiveN }, trainN: train.length, testN: test.length, treeBoundary, hyperparams: { nTrees: N_TREES, depth: DEPTH, lr: LR, minLeaf: MIN_LEAF }, validation: { logLoss: llGBDT, brier: bsGBDT, logLossLinear: llLinear, brierLinear: bsLinear }, metrics: { logLossLinear: llLinear, logLossGBDT: llGBDT, brierLinear: bsLinear, brierGBDT: bsGBDT }, classifiers, platt }, 'dry-run-gates-failed', { tag: RUN_TAG || null, halfLifeSeasons: RECENCY_HALF_LIFE, trainBefore: TRAIN_BEFORE, gates: { gate1, gate2, gate3 } });
    // Leave a record (Addendum 62): batch/dry runs need to know WHY a candidate produced no model.
    writeGateResult({ at: new Date().toISOString(), standaloneLeagueId: STANDALONE ? LEAGUE_ID : null, recipe: { halfLifeSeasons: RECENCY_HALF_LIFE, trainBefore: TRAIN_BEFORE, tag: RUN_TAG || null, regimeFeatures: REGIME_FEATURES, trainSeed: TRAIN_SEED, forwardFreeze: FORWARD_FREEZE }, decision: 'rejected', reason: 'quality gates not met', qualityGates: { gate1, gate2, gate3 }, candidateOwnSlice: { n: test.length, logLoss: llGBDT, logLossLinear: llLinear, brier: bsGBDT, band5060: { gbdt: band5060GBDT?.bias ?? null, linear: band5060Linear?.bias ?? null } } });
    console.log(`\n  ${WEIGHTS_FILE} NOT written.`);
    process.exit(0);
  }

  // ── Improvement gate: paired, like-for-like comparison against the deployed weights ──
  // (see the RETRAIN GATE + VERSION ARCHIVE block at the top of this file)
  const outPath   = path.join(DATA_DIR, WEIGHTS_FILE);
  const trainedAt = new Date().toISOString();
  let deployed = null;
  if (fs.existsSync(outPath)) {
    try { deployed = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (e) { console.warn(`  [Gate] Could not read deployed weights: ${e.message}`); }
  }

  // Candidate weights object, built before the decision so a rejected or
  // dry-run candidate can be archived for diagnosis (2026-09-14: the first
  // live rejection could not be broken down afterwards because the candidate
  // was gone).
  const candidateOut = {
    trainedAt,
    standaloneLeagueId: STANDALONE ? LEAGUE_ID : null,
    recipe: { halfLifeSeasons: RECENCY_HALF_LIFE, trainBefore: TRAIN_BEFORE, tag: RUN_TAG || null, regimeFeatures: REGIME_FEATURES, trainSeed: TRAIN_SEED, forwardFreeze: FORWARD_FREEZE, effectiveN },
    trainN:      train.length,
    testN:       test.length,
    treeBoundary,
    hyperparams: { nTrees: N_TREES, depth: DEPTH, lr: LR, minLeaf: MIN_LEAF },
    validation:  { logLoss: llGBDT, brier: bsGBDT, logLossLinear: llLinear, brierLinear: bsLinear },
    metrics:     { logLossLinear: llLinear, logLossGBDT: llGBDT, brierLinear: bsLinear, brierGBDT: bsGBDT },
    classifiers,
    platt,
  };

  const gateResult = {
    at: trainedAt,
    standaloneLeagueId: STANDALONE ? LEAGUE_ID : null,
    weightsFile: WEIGHTS_FILE,
    recipe: { halfLifeSeasons: RECENCY_HALF_LIFE, trainBefore: TRAIN_BEFORE, tag: RUN_TAG || null, regimeFeatures: REGIME_FEATURES, trainSeed: TRAIN_SEED, forwardFreeze: FORWARD_FREEZE },
    dryRun: GATE_DRY_RUN,
    candidateVersion: trainedAt,
    deployedVersion: deployed?.trainedAt ?? null,
    policy: GATE_POLICY,
    thresholds: { worseZ: GATE_WORSE_Z, worseAbs: GATE_WORSE_ABS, betterMargin: GATE_BETTER_MARGIN },
    qualityGates: { gate1, gate2, gate3 },
    candidateOwnSlice: { n: test.length, logLoss: llGBDT, brier: bsGBDT, from: test[0]?.date ?? null, to: test[test.length - 1]?.date ?? null },
    deployedStoredLogLoss: deployed ? (deployed.validation?.logLoss ?? deployed.metrics?.logLossGBDT ?? null) : null,
    pairedWindow: null,
    decision: null,
    reason: null,
  };

  if (deployed?.classifiers && deployed?.platt) {
    // Make sure the deployed version is in the archive before anything can replace it.
    archiveVersion(deployed, 'deployed');

    // Paired window: the candidate's held-out slice, restricted to fixtures on
    // or after the deployed model's own tree boundary so the window is
    // out-of-sample for BOTH models. (Both Platt fits saw some of it — 2
    // parameters per class, negligible, and symmetric between the two.)
    let deployedBoundary = deployed.treeBoundary?.firstTestFixtureDate ?? KNOWN_TREE_BOUNDARIES[deployed.trainedAt] ?? null;
    const boundarySource = deployed.treeBoundary?.firstTestFixtureDate ? 'weights-file'
                         : KNOWN_TREE_BOUNDARIES[deployed.trainedAt] ? 'pinned-addendum-14' : 'unknown';
    const window = deployedBoundary ? test.filter(r => r.date >= deployedBoundary) : test;
    const paired = pairedLogLoss(window, gbdtProb, probFnFromWeights(deployed));
    gateResult.pairedWindow = {
      n: paired.n,
      from: window[0]?.date ?? null,
      to: window[window.length - 1]?.date ?? null,
      deployedBoundary,
      boundarySource,
      excludedAsInSampleForDeployed: test.length - window.length,
      candidateLogLoss: paired.candidateLogLoss ?? null,
      deployedLogLoss:  paired.deployedLogLoss ?? null,
      meanDiff: paired.meanDiff ?? null,   // candidate − deployed; negative = candidate better
      se: paired.se ?? null,
      z:  paired.z ?? null,
      breakdown: paired.breakdown ?? null, // by league / deployed top-pick band / context / fixture year
    };

    console.log('\n  Paired gate (same window, both models):');
    console.log(`    window n=${paired.n} (${gateResult.pairedWindow.from} → ${gateResult.pairedWindow.to}; deployed boundary ${deployedBoundary ?? 'unknown'} [${boundarySource}]; ${gateResult.pairedWindow.excludedAsInSampleForDeployed} excluded as in-sample for deployed)`);
    console.log(`    candidate ${paired.candidateLogLoss?.toFixed(4)} vs deployed ${paired.deployedLogLoss?.toFixed(4)} on this window (deployed's stored own-slice figure: ${gateResult.deployedStoredLogLoss?.toFixed?.(4) ?? 'n/a'})`);
    console.log(`    mean paired diff ${paired.meanDiff?.toFixed(5)} ± ${paired.se?.toFixed(5)} (z ${paired.z?.toFixed(2)}), policy ${GATE_POLICY}`);
    const fmtCell = c => `${String(c.key).padEnd(14)} n=${String(c.n).padStart(5)}  diff ${(c.meanDiff >= 0 ? '+' : '') + c.meanDiff.toFixed(4)} ± ${c.se ? c.se.toFixed(4) : 'n/a'}  z ${c.z != null ? c.z.toFixed(2) : 'n/a'}  share ${c.shareOfTotalDiff != null ? (c.shareOfTotalDiff * 100).toFixed(0) + '%' : 'n/a'}`;
    for (const [label, cells] of Object.entries(paired.breakdown || {})) {
      console.log(`    ${label} (largest contribution first):`);
      for (const c of cells.slice(0, 8)) console.log(`      ${fmtCell(c)}`);
    }

    let adopt, reason;
    if (!paired.n) {
      adopt = false; reason = 'empty paired window';
    } else if (GATE_POLICY === 'superiority') {
      adopt = paired.meanDiff <= -GATE_BETTER_MARGIN;
      reason = adopt ? `candidate better by ${(-paired.meanDiff).toFixed(4)} ≥ ${GATE_BETTER_MARGIN}` : `candidate not better by ${GATE_BETTER_MARGIN} on the paired window`;
    } else {
      const sigWorse = paired.z != null && paired.z >= GATE_WORSE_Z;
      const absWorse = paired.meanDiff >= GATE_WORSE_ABS;
      adopt = !(sigWorse || absWorse);
      reason = adopt
        ? `candidate not inferior on the paired window (diff ${paired.meanDiff.toFixed(5)}, z ${paired.z?.toFixed(2)})`
        : `candidate worse: ${sigWorse ? `z ${paired.z.toFixed(2)} ≥ ${GATE_WORSE_Z}` : ''}${sigWorse && absWorse ? '; ' : ''}${absWorse ? `diff ${paired.meanDiff.toFixed(4)} ≥ ${GATE_WORSE_ABS}` : ''}`;
    }
    // Pocket-aware gates (Addendum 53): each must pass as well.
    gateResult.pocketGates = [];
    for (const g of (STANDALONE ? [] : POCKET_GATES)) { // standalone models have no pocket gates: the whole gate is the league
      try {
        const pg = pocketGate(g, gbdtProb, probFnFromWeights(deployed));
        gateResult.pocketGates.push(pg);
        console.log(`  Pocket gate — ${pg.label}: ${pg.skipped ? pg.skipped : `log-loss diff ${pg.logLoss.meanDiff?.toFixed(5)} ± ${pg.logLoss.se?.toFixed(5)} (z ${pg.logLoss.z?.toFixed(2)}, n=${pg.logLoss.n}); pocket ${pg.pocket.note} → ${pg.pass ? 'PASS' : 'FAIL'}`}`);
        if (adopt && pg.pass === false) { adopt = false; reason = `pocket gate failed (${pg.label}): ${pg.hardWorse ? 'worse log-loss on the league' : 'pocket residual materially worse'}`; }
      } catch (e) { gateResult.pocketGates.push({ ...g, error: e.message }); console.warn(`  Pocket gate — ${g.label}: error ${e.message}`); }
    }
    gateResult.decision = adopt ? 'adopted' : 'rejected';
    gateResult.reason = reason;
    if (GATE_DRY_RUN) {
      archiveVersion(candidateOut, 'dry-run', { gateDecisionWouldBe: gateResult.decision, gateReason: reason, comparedTo: deployed.trainedAt, tag: RUN_TAG || null, halfLifeSeasons: RECENCY_HALF_LIFE, trainBefore: TRAIN_BEFORE });
      writeGateResult(gateResult);
      console.log(`\n  [GBDT] DRY RUN — gate would have ${gateResult.decision.toUpperCase()} (${reason}). gbdt-weights.json untouched; candidate archived as dry-run; result in retrain-gate-dryrun.json.`);
      process.exit(0);
    }
    if (!adopt) {
      archiveVersion(candidateOut, 'rejected', { gateReason: reason, comparedTo: deployed.trainedAt });
      console.log(`\n  [GBDT] Gate: REJECTED — ${reason}. Keeping deployed version ${deployed.trainedAt}; candidate archived as rejected.`);
      writeGateResult(gateResult);
      process.exit(0);
    }
    console.log(`\n  [GBDT] Gate: ADOPTED — ${reason}. Replacing ${deployed.trainedAt}.`);
  } else {
    gateResult.decision = 'adopted';
    gateResult.reason = deployed ? 'deployed weights unreadable/incomplete — nothing to compare against' : 'no deployed weights — first version';
    if (GATE_DRY_RUN) { archiveVersion(candidateOut, 'dry-run', { tag: RUN_TAG || null, halfLifeSeasons: RECENCY_HALF_LIFE, trainBefore: TRAIN_BEFORE, comparedTo: null }); writeGateResult(gateResult); console.log(`\n  [GBDT] DRY RUN — ${gateResult.reason}; candidate archived as dry-run, nothing written.`); process.exit(0); }
    console.log(`\n  [GBDT] Gate: ${gateResult.reason}; writing weights.`);
  }

  // ── Write weights ──
  const weightsOut = {
    ...candidateOut, // treeBoundary is read by server.js getModelTreeBoundary()
    gate:        { policy: GATE_POLICY, decision: gateResult.decision, reason: gateResult.reason, pairedWindow: gateResult.pairedWindow, replaced: deployed?.trainedAt ?? null },
  };
  fs.writeFileSync(outPath, JSON.stringify(weightsOut));
  console.log(`\n  Written: ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
  if (deployed?.trainedAt) archiveVersion(deployed, 'superseded', { supersededBy: trainedAt, supersededAt: trainedAt });
  archiveVersion(weightsOut, 'deployed');
  writeGateResult(gateResult);
  console.log(`  Archived: ${ARCHIVE_DIR} (${readArchiveIndex().length} versions indexed)`);
})().catch(e => {
  // Explicit catch rather than relying on Node's default unhandledRejection
  // behaviour — this must fail loudly with a clear, attributable message (the
  // parent process's child.on('close', code) handler in server.js treats any
  // non-zero exit as a failed run and logs it), not hang or exit silently/
  // ambiguously if something throws after an await (e.g. an OOM-adjacent
  // allocation failure surfacing as a thrown error rather than a signal).
  console.error(`\n[GBDT] FATAL — training run failed: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
