'use strict';
// ─── Research: line-up-aware 1X2 model (Addendum 70 Part 1.5) ─────────────────────────
// Question: does information Pinnacle prices and our model does not see — who actually
// starts — narrow the model-vs-market gap? Trained on the line-up era only (the post-match
// XI in lineups.json is the confirmed pre-match XI in all but rare warm-up changes; the
// lock's pre-match sheets are the forward continuation). Four builds on identical rows and
// windows so the line-up effect is isolated from everything else:
//   A  base-26 features, standalone (the league's own rows)      C  base-26, pooled line-up era
//   B  base-26 + line-up features, standalone                    D  base-26 + line-up, pooled line-up era
// Each is read once on the league's holdout (>= holdoutFrom) against the deployed pooled
// chain and against Pinnacle. Research only.
const fs = require('fs');
const path = require('path');
const { buildFeatures } = require('../models/gbdt');

const DEPTH = 3, N_TREES = 200, LR = 0.05, MIN_LEAF = 20, L2_LAMBDA = 1.0, SUBSAMPLE = 0.7;
function mulberry32(a) { return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));
function buildTree(X, G, H, depth) {
  const n = X.length; const sumG = G.reduce((s, v) => s + v, 0), sumH = H.reduce((s, v) => s + v, 0);
  if (depth >= DEPTH || n < MIN_LEAF * 2) return { leaf: true, value: sumG / (sumH + L2_LAMBDA) };
  const nF = X[0].length; let best = { gain: 0, f: -1, t: 0, L: null, R: null };
  for (let fi = 0; fi < nF; fi++) {
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => X[a][fi] - X[b][fi]);
    let gL = 0, hL = 0, gR = sumG, hR = sumH;
    for (let i = 0; i < n - 1; i++) { const idx = order[i]; gL += G[idx]; gR -= G[idx]; hL += H[idx]; hR -= H[idx]; if (X[order[i]][fi] === X[order[i + 1]][fi]) continue; const nL = i + 1, nR = n - nL; if (nL < MIN_LEAF || nR < MIN_LEAF) continue; const gain = gL ** 2 / (hL + L2_LAMBDA) + gR ** 2 / (hR + L2_LAMBDA) - sumG ** 2 / (sumH + L2_LAMBDA); if (gain > best.gain) best = { gain, f: fi, t: (X[order[i]][fi] + X[order[i + 1]][fi]) / 2, L: order.slice(0, i + 1), R: order.slice(i + 1) }; }
  }
  if (best.f === -1) return { leaf: true, value: sumG / (sumH + L2_LAMBDA) };
  return { leaf: false, feature: best.f, threshold: best.t, left: buildTree(best.L.map(i => X[i]), best.L.map(i => G[i]), best.L.map(i => H[i]), depth + 1), right: buildTree(best.R.map(i => X[i]), best.R.map(i => G[i]), best.R.map(i => H[i]), depth + 1) };
}
function treePredict(node, x) { return node.leaf ? node.value : (x[node.feature] <= node.threshold ? treePredict(node.left, x) : treePredict(node.right, x)); }
async function trainBinary(X, y, seed) {
  const n = X.length; const rng = mulberry32(seed); const base = Math.max(1e-3, Math.min(1 - 1e-3, y.reduce((s, v) => s + v, 0) / n)); const initValue = Math.log(base / (1 - base));
  const F = new Array(n).fill(initValue); const trees = []; const subN = Math.floor(n * SUBSAMPLE);
  for (let t = 0; t < N_TREES; t++) { const p = F.map(sigmoid); const G = y.map((yi, i) => yi - p[i]), H = p.map(q => q * (1 - q)); const idx = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } const sub = idx.slice(0, subN); const tree = buildTree(sub.map(i => X[i]), sub.map(i => G[i]), sub.map(i => H[i]), 0); trees.push(tree); for (let i = 0; i < n; i++) F[i] += LR * treePredict(tree, X[i]); if ((t + 1) % 20 === 0) await new Promise(r => setImmediate(r)); }
  const importance = {}; const walk = (nd) => { if (nd.leaf) return; importance[nd.feature] = (importance[nd.feature] || 0) + 1; walk(nd.left); walk(nd.right); }; trees.forEach(walk);
  return { raw: x => { let f = initValue; for (const tr of trees) f += LR * treePredict(tr, x); return f; }, importance };
}
function fitPlatt(z, y) { const ll = (A, B) => { let s = 0; for (let i = 0; i < z.length; i++) { const q = sigmoid(A * z[i] + B); s += -(y[i] ? Math.log(Math.max(1e-12, q)) : Math.log(Math.max(1e-12, 1 - q))); } return s / z.length; }; let best = { A: 1, B: 0, ll: ll(1, 0) }; for (let A = 0.2; A <= 2.0 + 1e-9; A += 0.1) for (let B = -1.5; B <= 1.5 + 1e-9; B += 0.1) { const v = ll(A, B); if (v < best.ll) best = { A, B, ll: v }; } const c = { ...best }; for (let A = c.A - 0.15; A <= c.A + 0.15 + 1e-9; A += 0.01) for (let B = c.B - 0.15; B <= c.B + 0.15 + 1e-9; B += 0.01) { const v = ll(A, B); if (v < best.ll) best = { A, B, ll: v }; } const { A, B } = best; return { A: +A.toFixed(3), B: +B.toFixed(3), apply: zz => sigmoid(A * zz + B) }; }
async function train3(rowsTrain, rowsPlatt, featOf, seed) {
  const X = rowsTrain.map(featOf), XP = rowsPlatt.map(featOf); const out = { cls: {}, importance: {} };
  for (const c of ['home', 'draw', 'away']) { const m = await trainBinary(X, rowsTrain.map(r => r.y === c ? 1 : 0), seed); const pl = fitPlatt(XP.map(x => m.raw(x)), rowsPlatt.map(r => r.y === c ? 1 : 0)); out.cls[c] = { m, pl }; for (const [k, v] of Object.entries(m.importance)) out.importance[k] = (out.importance[k] || 0) + v; }
  out.predict = (r) => { const x = featOf(r); const p = {}; for (const c of ['home', 'draw', 'away']) p[c] = out.cls[c].pl.apply(out.cls[c].m.raw(x)); const s = p.home + p.draw + p.away; return { home: p.home / s, draw: p.draw / s, away: p.away / s }; };
  return out;
}

const LINEUP_FEATURE_NAMES = ['h_missingRegulars', 'h_familiarity', 'h_newcomers', 'h_coreRetained', 'h_xiN', 'a_missingRegulars', 'a_familiarity', 'a_newcomers', 'a_coreRetained', 'a_xiN'];
function lineupFeaturesFor(teamId, todayXI, priorXIs) { // priorXIs: array of Set (most recent last), up to 10
  const last = priorXIs.slice(-10); if (last.length < 5 || !todayXI || todayXI.size < 9) return null;
  const starts = {}; for (const xi of last) for (const p of xi) starts[p] = (starts[p] || 0) + 1;
  const regulars = Object.entries(starts).sort((a, b) => b[1] - a[1]).slice(0, 11).map(([p]) => +p);
  const missing = regulars.filter(p => !todayXI.has(p)).length;
  const fam = [...todayXI].reduce((s, p) => s + (starts[p] || 0) / last.length, 0) / todayXI.size;
  const newcomers = [...todayXI].filter(p => !starts[p]).length;
  const core = regulars.filter(p => todayXI.has(p)).length / 11;
  return [missing, +fam.toFixed(3), newcomers, +core.toFixed(3), last.length];
}

async function run({ dataDir, leagueId, windows, chainProbs, closing, seed = 20260922 }) {
  const t0 = Date.now();
  const hist = JSON.parse(fs.readFileSync(path.join(dataDir, 'backfill-historical.json'), 'utf8'));
  const lineups = JSON.parse(fs.readFileSync(path.join(dataDir, 'lineups.json'), 'utf8'));
  const fixById = new Map((hist.fixtures || []).map(f => [String(f.fixture?.id), f]));
  // XI history per team (from every fixture with a lineup, any league in the pool), sorted by date
  const xiByTeam = {}; const xiOf = (side) => new Set((side?.starters || []).map(p => +p.id).filter(Boolean));
  for (const [fid, e] of Object.entries(lineups)) { const f = fixById.get(String(fid)); if (!f) continue; const d = f.fixture.date; if (e.home?.teamId) (xiByTeam[e.home.teamId] = xiByTeam[e.home.teamId] || []).push({ d, xi: xiOf(e.home) }); if (e.away?.teamId) (xiByTeam[e.away.teamId] = xiByTeam[e.away.teamId] || []).push({ d, xi: xiOf(e.away) }); }
  for (const arr of Object.values(xiByTeam)) arr.sort((a, b) => a.d < b.d ? -1 : 1);
  const priorXIs = (tid, d) => (xiByTeam[tid] || []).filter(x => x.d < d).map(x => x.xi);
  const W = windows;
  const recs = (hist.scoredRecords || []).filter(r => r.homeFactors && r.awayFactors && r.actualOutcome && r.context === 'club_domestic' && r.date >= W.treesFrom);
  const rows = [];
  for (const r of recs) {
    const e = lineups[String(r.fixtureId)]; const f = fixById.get(String(r.fixtureId)); if (!e || !f) continue;
    const lh = lineupFeaturesFor(r.homeTeamId, xiOf(e.home), priorXIs(r.homeTeamId, r.date)), la = lineupFeaturesFor(r.awayTeamId, xiOf(e.away), priorXIs(r.awayTeamId, r.date));
    if (!lh || !la) continue;
    const base = buildFeatures(r.homeFactors, r.awayFactors, r.context);
    rows.push({ fid: r.fixtureId, lid: parseInt(r.leagueId, 10), date: r.date, day: r.date.slice(0, 10), y: r.actualOutcome, base, lineup: [...lh, ...la], rec: r });
  }
  rows.sort((a, b) => a.date < b.date ? -1 : 1);
  const inW = (r, a, b) => r.day >= a && (b ? r.day < b : true);
  const own = rows.filter(r => r.lid === leagueId);
  const sets = { standalone: own, pooled: rows };
  const featBase = r => r.base, featLine = r => [...r.base, ...r.lineup];
  const builds = [['A', 'standalone', featBase, 'base-26, standalone'], ['B', 'standalone', featLine, 'base-26 + line-up, standalone'], ['C', 'pooled', featBase, 'base-26, pooled line-up era'], ['D', 'pooled', featLine, 'base-26 + line-up, pooled line-up era']];
  const hold = own.filter(r => r.day >= W.holdoutFrom).map(r => { const co = closing[r.fid] || closing[String(r.fid)]; if (!co || co.bookmaker !== 'pinnacle' || !(co.homeOdds > 1 && co.drawOdds > 1 && co.awayOdds > 1)) return null; const ih = 1 / co.homeOdds, id = 1 / co.drawOdds, ia = 1 / co.awayOdds, s = ih + id + ia; return { ...r, mk: { home: ih / s, draw: id / s, away: ia / s }, odds: co, chain: chainProbs(r.rec) }; }).filter(r => r && r.chain);
  const ll = (p, y) => -Math.log(Math.max(1e-12, p[y]));
  const paired = (a, b) => { const d = hold.map(r => ll(a(r), r.y) - ll(b(r), r.y)); const n = d.length; if (!n) return { n: 0 }; const m = d.reduce((x, y) => x + y, 0) / n, sd = n > 1 ? Math.sqrt(d.reduce((x, v) => x + (v - m) ** 2, 0) / (n - 1)) : 0; return { n, meanDiff: +m.toFixed(5), z: sd ? +(m / (sd / Math.sqrt(n))).toFixed(2) : null }; };
  const topPick = (pf) => { const bets = hold.map(r => { const p = pf(r); const pick = p.home >= p.draw && p.home >= p.away ? 'home' : p.away >= p.draw ? 'away' : 'draw'; const won = r.y === pick; return { bm: (won ? 1 : 0) - r.mk[pick], pnl: won ? r.odds[`${pick}Odds`] - 1 : -1, homeP: p.home }; }); const n = bets.length; if (!n) return { n: 0 }; const bm = bets.reduce((a, b) => a + b.bm, 0) / n, sd = n > 1 ? Math.sqrt(bets.reduce((a, b) => a + (b.bm - bm) ** 2, 0) / (n - 1)) : 0; return { n, beyondMarketPp: +(bm * 100).toFixed(2), sePp: sd ? +((sd / Math.sqrt(n)) * 100).toFixed(2) : null, roiClosePct: +((bets.reduce((a, b) => a + b.pnl, 0) / n) * 100).toFixed(1), homeExpected: +(bets.reduce((a, b) => a + b.homeP, 0) / n).toFixed(3) }; };
  const results = {};
  for (const [key, set, featOf, label] of builds) {
    const pool = sets[set]; const tr = pool.filter(r => inW(r, W.treesFrom, W.treesTo)), pl = pool.filter(r => inW(r, W.treesTo, W.plattTo));
    if (tr.length < 300 || pl.length < 100) { results[key] = { label, skipped: `too few rows (trees ${tr.length}, platt ${pl.length})` }; continue; }
    const m = await train3(tr, pl, featOf, seed);
    const pf = r => m.predict(r);
    const imp = Object.entries(m.importance).map(([i, c]) => [+i >= 26 ? LINEUP_FEATURE_NAMES[+i - 26] : `base${i}`, c]).sort((a, b) => b[1] - a[1]);
    results[key] = { label, treeRows: tr.length, plattRows: pl.length, vsDeployedPooled: paired(pf, r => r.chain), vsMarket: paired(pf, r => r.mk), topPick: topPick(pf), lineupImportanceShare: featOf === featLine ? +(imp.filter(([k]) => !k.startsWith('base')).reduce((a, b) => a + b[1], 0) / Math.max(1, imp.reduce((a, b) => a + b[1], 0))).toFixed(3) : 0, topFeatures: imp.slice(0, 10) };
  }
  const homeActual = hold.length ? +(hold.filter(r => r.y === 'home').length / hold.length).toFixed(3) : null;
  return { leagueId, windows: W, ranAt: new Date().toISOString(), seconds: +((Date.now() - t0) / 1000).toFixed(1),
    data: { lineupEraRowsAllLeagues: rows.length, ownLeagueRows: own.length, holdoutRows: hold.length, holdoutFrom: hold[0]?.day, holdoutTo: hold[hold.length - 1]?.day, leaguesInPool: [...new Set(rows.map(r => r.lid))], lineupsEntries: Object.keys(lineups).length },
    reference: { deployedPooledVsMarket: paired(r => r.chain, r => r.mk), deployedPooledTopPick: topPick(r => r.chain), marketTopPick: topPick(r => r.mk), homeActual },
    results, lineupFeatures: LINEUP_FEATURE_NAMES, note: 'meanDiff = model − reference log-loss per fixture on the holdout; negative = model better. Line-up features from the post-match XI (confirmed pre-match XI in all but rare warm-up changes); history strictly prior.' };
}
module.exports = { run, LINEUP_FEATURE_NAMES };
