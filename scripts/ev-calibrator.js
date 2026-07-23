'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const { computeModelProb, classifyFixture, LEAGUE_CONFIG } = require('../scoring');

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { return null; }
}

// ─── LOAD DATA ────────────────────────────────────────────────────────────────

const historical = readJSON('backfill-historical.json') || {};
const scoredRecords = historical.scoredRecords || [];
const optimisedWeights = historical.optimisedWeights || {};
const closingOdds = readJSON('closing-odds.json') || {};   // keyed by fixtureId

// ─── JOIN BY FIXTURE ID ───────────────────────────────────────────────────────

const matched = [];
for (const rec of scoredRecords) {
  const co = closingOdds[rec.fixtureId];
  if (!co) continue;
  if (!rec.actualOutcome) continue;
  if (!rec.homeFactors || !rec.awayFactors) continue;

  // Determine which outcome to evaluate (the top model pick)
  const context = rec.context || classifyFixture(rec.leagueId);
  const weights = optimisedWeights[context] || optimisedWeights.club_domestic;
  if (!weights) continue;

  const leagueConfig = LEAGUE_CONFIG[parseInt(rec.leagueId, 10)] || null;
  const probs = computeModelProb(rec.homeFactors, rec.awayFactors, weights, context, leagueConfig);

  // Top pick: whichever outcome the model favours most
  let topOutcome, modelProb, pinnacleOdds;
  if (probs.home >= probs.draw && probs.home >= probs.away) {
    topOutcome  = 'home';
    modelProb   = probs.home;
    pinnacleOdds = co.homeOdds;
  } else if (probs.away >= probs.draw) {
    topOutcome  = 'away';
    modelProb   = probs.away;
    pinnacleOdds = co.awayOdds;
  } else {
    topOutcome  = 'draw';
    modelProb   = probs.draw;
    pinnacleOdds = co.drawOdds;
  }

  if (!pinnacleOdds || pinnacleOdds <= 1) continue;

  const pinnacleImplied = 1 / pinnacleOdds;
  const edge = (modelProb - pinnacleImplied) / pinnacleImplied;

  const won = rec.actualOutcome === topOutcome;

  matched.push({
    fixtureId:    rec.fixtureId,
    leagueId:     rec.leagueId,
    context,
    topOutcome,
    modelProb,
    pinnacleOdds,
    pinnacleImplied,
    edge,
    won,
    date:         rec.date,
  });
}

// ─── BAND DEFINITIONS ────────────────────────────────────────────────────────

const BANDS = [
  { label: '< 0%',   min: -Infinity, max: 0    },
  { label: '0–5%',   min: 0,         max: 0.05 },
  { label: '5–10%',  min: 0.05,      max: 0.10 },
  { label: '10–15%', min: 0.10,      max: 0.15 },
  { label: '15–20%', min: 0.15,      max: 0.20 },
  { label: '20%+',   min: 0.20,      max: Infinity },
];

function calcBandStats(fixtures) {
  return BANDS.map(b => {
    const inBand = fixtures.filter(f => f.edge >= b.min && f.edge < b.max);
    const n = inBand.length;
    let roi = null;
    if (n > 0) {
      let totalReturn = 0;
      for (const f of inBand) {
        totalReturn += f.won ? (f.pinnacleOdds - 1) : -1;
      }
      roi = totalReturn / n;
    }
    return { band: b.label, n, roi };
  });
}

function kellyRecommendation(roi) {
  if (roi === null || roi < 0) return 'flag_for_review';
  if (roi < 0.02) return 'quarter_kelly';
  if (roi < 0.05) return 'third_kelly';
  return 'half_kelly';
}

// ─── OVERALL STATS ────────────────────────────────────────────────────────────

const overallBands = calcBandStats(matched);

// Only bets with positive edge (5%+) for Kelly recommendation
const posEdge = matched.filter(f => f.edge >= 0.05);
let posRoi = null;
if (posEdge.length > 0) {
  posRoi = posEdge.reduce((sum, f) => sum + (f.won ? (f.pinnacleOdds - 1) : -1), 0) / posEdge.length;
}

// ─── PER-LEAGUE BREAKDOWN ─────────────────────────────────────────────────────

const leagueMap = {};
for (const f of matched) {
  const lid = parseInt(f.leagueId, 10);
  const name = LEAGUE_CONFIG[lid]?.name || `League ${f.leagueId}`;
  if (!leagueMap[name]) leagueMap[name] = [];
  leagueMap[name].push(f);
}

const byLeague = Object.entries(leagueMap).map(([league, fixtures]) => {
  const n = fixtures.length;
  const posE = fixtures.filter(f => f.edge >= 0.05);
  let roi = null;
  if (posE.length > 0) {
    roi = posE.reduce((sum, f) => sum + (f.won ? (f.pinnacleOdds - 1) : -1), 0) / posE.length;
  }
  const kelly = kellyRecommendation(roi);
  return { league, n, posEdgeN: posE.length, roi, kelly };
}).sort((a, b) => b.n - a.n);

// ─── RESULT ───────────────────────────────────────────────────────────────────

const result = {
  summary: {
    totalMatched:   matched.length,
    positiveEdge:   posEdge.length,
    positiveEdgeRoi: posRoi !== null ? parseFloat(posRoi.toFixed(4)) : null,
    kellyRecommendation: kellyRecommendation(posRoi),
  },
  bands: overallBands.map(b => ({
    ...b,
    roi:     b.roi !== null ? parseFloat(b.roi.toFixed(4)) : null,
    warning: b.n < 30 ? 'small_sample' : null,
  })),
  byLeague: byLeague.map(l => ({
    ...l,
    roi: l.roi !== null ? parseFloat(l.roi.toFixed(4)) : null,
  })),
};

console.log(JSON.stringify(result, null, 2));
