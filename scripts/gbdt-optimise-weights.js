'use strict';
// Isolated weight-optimisation runner — Track A memory-safety fix.
//
// Runs weightOptimiser.js's optimiseWeights() (full-population gradient descent,
// 200 iterations x ~17 loss evaluations x 3 contexts) as its OWN OS process,
// same spawn()-isolated pattern as scripts/gbdt-train.js / gbdt-train-proxy.js.
//
// Why this exists: runHistoricalBackfill's Phase 3 used to call this inline in
// the main server process, sharing its heap. On a full rescore=true run
// (population rebuilt from scratch), this is genuinely large full-population
// gradient descent run repeatedly at every 500-record checkpoint against an
// ever-growing array — confirmed (2026-08-14 incident) to exceed this
// instance's 512MB heap partway through a full pass, OOM-crashing the entire
// live app, not just the optimisation work. Running it here means a crash
// here only kills this short-lived child — the main server, and the already-
// scored/persisted population, are unaffected.
//
// Reads backfill-historical.json (already fully scored by the time this is
// invoked), writes ONLY optimised-weights.json (small — just weights/accuracy)
// rather than read-modify-writing the large combined file itself, so there's
// no risk of racing a concurrent write from the main process. server.js merges
// this file's contents into backfill-historical.json after this process exits
// cleanly.

const path = require('path');
const fs   = require('fs');
const { optimiseWeights } = require('../weightOptimiser');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { return null; }
}

function writeJSON(file, data) {
  const dest = path.join(DATA_DIR, file);
  const tmp  = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, dest);
}

async function main() {
  const historical = readJSON('backfill-historical.json');
  const records = historical?.scoredRecords || [];
  if (records.length === 0) {
    console.error('[OptimiseWeights] No scoredRecords found — nothing to optimise.');
    process.exit(1);
  }
  console.log(`[OptimiseWeights] Starting — ${records.length} scored records`);

  const optimisedWeights = {};
  const accuracy = {};
  for (const ctx of ['club_domestic', 'club_european', 'international']) {
    const ctxRecords = records.filter(r => r.context === ctx);
    if (ctxRecords.length < 50) {
      console.log(`[OptimiseWeights] ${ctx}: only ${ctxRecords.length} records — skipped (need >= 50)`);
      continue;
    }
    const result = await optimiseWeights(records, ctx);
    optimisedWeights[ctx] = result.weights;
    accuracy[ctx] = {
      accuracy:    result.accuracy,
      baseline:    result.baselineAccuracy,
      loss:        result.finalLoss,
      improvement: result.improvement,
      count:       result.recordCount,
      optimisedAt: new Date().toISOString(),
    };
    console.log(`[OptimiseWeights] ${ctx}: ${result.recordCount} records · accuracy ${(result.accuracy * 100).toFixed(1)}% (baseline ${(result.baselineAccuracy * 100).toFixed(1)}%, Δ${result.improvement >= 0 ? '+' : ''}${result.improvement}pp)`);
  }

  writeJSON('optimised-weights.json', {
    optimisedWeights,
    accuracy,
    lastOptimisedAt: new Date().toISOString(),
    sourceScoredCount: records.length,
  });
  console.log('[OptimiseWeights] Done — wrote optimised-weights.json');
  process.exit(0);
}

main().catch(e => {
  console.error('[OptimiseWeights] Fatal:', e.message);
  process.exit(1);
});
