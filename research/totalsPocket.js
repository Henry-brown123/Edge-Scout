'use strict';
// ─── Research: league-specific totals (over/under 2.5) pocket, reserve-first ─────────
// Addendum 69. Research only — nothing here is read by live scoring.
// Rule 21: every feature comes from the league's own fixtures (and the fixture-stats
// pooled for those fixtures); no other league, no pooled model.
//
// Pipeline per league:
//   features (strictly prior days) → GBDT (binary: total goals >= 3) on TREES window
//   → Platt on PLATT window → cell selection on SELECT window (trees never saw it)
//   → shortlist by the pre-registered rule → ONE read on the HOLDOUT window.
// Market: Pinnacle 2.5 line at kickoff (alternate-totals store first, else the main
// line where it was 2.5). Every outcome is decided (no pushes, no split stakes).

const fs = require('fs');
const path = require('path');

const DEPTH = 3, N_TREES = 200, LR = 0.05, MIN_LEAF = 20, L2_LAMBDA = 1.0, SUBSAMPLE = 0.7;
const FINAL = new Set(['FT', 'AET', 'PEN']);
const SENT = -1;

function mulberry32(a) { return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));

function buildTree(X, G, H, depth) {
  const n = X.length; const sumG = G.reduce((s, v) => s + v, 0), sumH = H.reduce((s, v) => s + v, 0);
  if (depth >= DEPTH || n < MIN_LEAF * 2) return { leaf: true, value: sumG / (sumH + L2_LAMBDA) };
  const nF = X[0].length; let best = { gain: 0, f: -1, t: 0, L: null, R: null };
  for (let fi = 0; fi < nF; fi++) {
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => X[a][fi] - X[b][fi]);
    let gL = 0, hL = 0, gR = sumG, hR = sumH;
    for (let i = 0; i < n - 1; i++) {
      const idx = order[i]; gL += G[idx]; gR -= G[idx]; hL += H[idx]; hR -= H[idx];
      if (X[order[i]][fi] === X[order[i + 1]][fi]) continue;
      const nL = i + 1, nR = n - nL; if (nL < MIN_LEAF || nR < MIN_LEAF) continue;
      const gain = gL ** 2 / (hL + L2_LAMBDA) + gR ** 2 / (hR + L2_LAMBDA) - sumG ** 2 / (sumH + L2_LAMBDA);
      if (gain > best.gain) best = { gain, f: fi, t: (X[order[i]][fi] + X[order[i + 1]][fi]) / 2, L: order.slice(0, i + 1), R: order.slice(i + 1) };
    }
  }
  if (best.f === -1) return { leaf: true, value: sumG / (sumH + L2_LAMBDA) };
  return { leaf: false, feature: best.f, threshold: best.t, left: buildTree(best.L.map(i => X[i]), best.L.map(i => G[i]), best.L.map(i => H[i]), depth + 1), right: buildTree(best.R.map(i => X[i]), best.R.map(i => G[i]), best.R.map(i => H[i]), depth + 1) };
}
function treePredict(node, x) { return node.leaf ? node.value : (x[node.feature] <= node.threshold ? treePredict(node.left, x) : treePredict(node.right, x)); }
async function trainBinary(X, y, seed) {
  const n = X.length; const rng = mulberry32(seed); const base = y.reduce((s, v) => s + v, 0) / n; const initValue = Math.log(base / (1 - base));
  const F = new Array(n).fill(initValue); const trees = []; const subN = Math.floor(n * SUBSAMPLE);
  for (let t = 0; t < N_TREES; t++) {
    const p = F.map(sigmoid); const G = y.map((yi, i) => yi - p[i]), H = p.map(q => q * (1 - q));
    const idx = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    const sub = idx.slice(0, subN); const tree = buildTree(sub.map(i => X[i]), sub.map(i => G[i]), sub.map(i => H[i]), 0); trees.push(tree);
    for (let i = 0; i < n; i++) F[i] += LR * treePredict(tree, X[i]);
    if ((t + 1) % 20 === 0) await new Promise(r => setImmediate(r));
  }
  const raw = x => { let f = initValue; for (const tr of trees) f += LR * treePredict(tr, x); return f; };
  const importance = {}; const walk = (nd) => { if (nd.leaf) return; importance[nd.feature] = (importance[nd.feature] || 0) + 1; walk(nd.left); walk(nd.right); }; trees.forEach(walk);
  return { raw, importance, initValue, nTrees: trees.length };
}
function fitPlatt(z, y) { // logistic on raw log-odds: coarse then fine grid on (A,B)
  const ll = (A, B) => { let s = 0; for (let i = 0; i < z.length; i++) { const q = sigmoid(A * z[i] + B); s += -(y[i] ? Math.log(Math.max(1e-12, q)) : Math.log(Math.max(1e-12, 1 - q))); } return s / z.length; };
  let best = { A: 1, B: 0, ll: ll(1, 0) };
  for (let A = 0.2; A <= 2.0 + 1e-9; A += 0.1) for (let B = -1.0; B <= 1.0 + 1e-9; B += 0.1) { const v = ll(A, B); if (v < best.ll) best = { A, B, ll: v }; }
  const c = { ...best }; for (let A = c.A - 0.15; A <= c.A + 0.15 + 1e-9; A += 0.01) for (let B = c.B - 0.15; B <= c.B + 0.15 + 1e-9; B += 0.01) { const v = ll(A, B); if (v < best.ll) best = { A, B, ll: v }; }
  const { A, B } = best; return { A: +A.toFixed(3), B: +B.toFixed(3), apply: zz => sigmoid(A * zz + B) };
}

// ── Features from the league's own fixtures only ──
const FEATURE_NAMES = [];
function buildFeatureTable(fixtures, stats) {
  // fixtures: [{ id, date, day, season, h, a, hg, ag }] sorted asc
  const byTeam = {}; const h2h = {}; const leagueSeq = [];
  const dec = (k, half) => Math.pow(0.5, k / half);
  const wmean = (arr, key, half = 8) => { if (!arr.length) return null; let s = 0, w = 0; for (let i = 0; i < arr.length; i++) { const ww = dec(arr.length - 1 - i, half); s += ww * arr[i][key]; w += ww; } return s / w; };
  const mean = (arr, key) => arr.length ? arr.reduce((s, x) => s + x[key], 0) / arr.length : null;
  const rows = [];
  for (const f of fixtures) {
    const st = stats[String(f.id)] || stats[f.id] || null;
    const prior = (tid) => (byTeam[tid] || []);
    const feat = {};
    for (const [side, tid, opp, isHome] of [['h', f.h, f.a, true], ['a', f.a, f.h, false]]) {
      const all = prior(tid); const l10 = all.slice(-10), l25 = all.slice(-25);
      const venue = all.filter(x => x.home === isHome).slice(-10);
      const withStats = all.filter(x => x.sf != null).slice(-10);
      feat[`${side}_gf10`] = wmean(l10, 'gf'); feat[`${side}_ga10`] = wmean(l10, 'ga'); feat[`${side}_gf25`] = wmean(l25, 'gf', 15); feat[`${side}_ga25`] = wmean(l25, 'ga', 15);
      feat[`${side}_o25_10`] = mean(l10, 'o25'); feat[`${side}_o25_25`] = mean(l25, 'o25'); feat[`${side}_tot10`] = wmean(l10, 'tot');
      feat[`${side}_vgf10`] = wmean(venue, 'gf'); feat[`${side}_vga10`] = wmean(venue, 'ga'); feat[`${side}_vo25`] = mean(venue, 'o25');
      feat[`${side}_sof10`] = mean(withStats, 'sf'); feat[`${side}_soa10`] = mean(withStats, 'sa'); feat[`${side}_tsf10`] = mean(withStats, 'tsf'); feat[`${side}_tsa10`] = mean(withStats, 'tsa');
      const withXg = all.filter(x => x.xf != null).slice(-10); feat[`${side}_xgf10`] = mean(withXg, 'xf'); feat[`${side}_xga10`] = mean(withXg, 'xa'); feat[`${side}_xgN`] = withXg.length; feat[`${side}_statsN`] = withStats.length;
      feat[`${side}_ppg25`] = mean(l25, 'pts'); feat[`${side}_n`] = all.length;
      const last = all[all.length - 1]; feat[`${side}_rest`] = last ? Math.min(30, (new Date(f.day) - new Date(last.day)) / 86400000) : null;
      feat[`${side}_played`] = all.filter(x => x.season === f.season).length;
    }
    const hk = [f.h, f.a].sort().join('-'); const meetings = (h2h[hk] || []).slice(-5); feat.h2h_tot = mean(meetings, 'tot'); feat.h2h_n = meetings.length;
    const lg = leagueSeq.slice(-300); feat.lg_o25 = mean(lg, 'o25'); feat.lg_tot = mean(lg, 'tot');
    feat.month = new Date(f.day).getUTCMonth() + 1;
    const nPrior = Math.min(feat.h_n, feat.a_n);
    rows.push({ id: f.id, date: f.date, day: f.day, season: f.season, h: f.h, a: f.a, hg: f.hg, ag: f.ag, over: f.hg + f.ag >= 3 ? 1 : 0, feat, ok: nPrior >= 8 && feat.lg_o25 != null });
    // update state AFTER computing features (strictly prior)
    const tot = f.hg + f.ag, o25 = tot >= 3 ? 1 : 0;
    const sH = st?.home, sA = st?.away;
    (byTeam[f.h] = byTeam[f.h] || []).push({ day: f.day, season: f.season, home: true, gf: f.hg, ga: f.ag, tot, o25, pts: f.hg > f.ag ? 3 : f.hg === f.ag ? 1 : 0, sf: sH?.shotsOn ?? null, sa: sA?.shotsOn ?? null, tsf: sH?.totalShots ?? null, tsa: sA?.totalShots ?? null, xf: sH?.xg ?? null, xa: sA?.xg ?? null });
    (byTeam[f.a] = byTeam[f.a] || []).push({ day: f.day, season: f.season, home: false, gf: f.ag, ga: f.hg, tot, o25, pts: f.ag > f.hg ? 3 : f.hg === f.ag ? 1 : 0, sf: sA?.shotsOn ?? null, sa: sH?.shotsOn ?? null, tsf: sA?.totalShots ?? null, tsa: sH?.totalShots ?? null, xf: sA?.xg ?? null, xa: sH?.xg ?? null });
    (h2h[hk] = h2h[hk] || []).push({ day: f.day, tot }); leagueSeq.push({ day: f.day, tot, o25 });
  }
  const names = Object.keys(rows.find(r => r.ok)?.feat || {}); FEATURE_NAMES.splice(0, FEATURE_NAMES.length, ...names);
  for (const r of rows) r.x = names.map(k => (r.feat[k] == null || Number.isNaN(r.feat[k])) ? SENT : r.feat[k]);
  return { rows, names };
}

function summarise(bets, seasons) {
  const n = bets.length; if (!n) return { n: 0 };
  const bm = bets.reduce((a, b) => a + b.bm, 0) / n, sd = n > 1 ? Math.sqrt(bets.reduce((a, b) => a + (b.bm - bm) ** 2, 0) / (n - 1)) : 0, pnl = bets.reduce((a, b) => a + b.pnl, 0);
  return { n, wins: bets.filter(b => b.won).length, beyondMarketPp: +(bm * 100).toFixed(2), sePp: sd ? +((sd / Math.sqrt(n)) * 100).toFixed(2) : null, z: sd ? +(bm / (sd / Math.sqrt(n))).toFixed(2) : null, roiClosePct: +((pnl / n) * 100).toFixed(1), unitsPerSeason: +(pnl / seasons).toFixed(1), betsPerSeason: +(n / seasons).toFixed(1) };
}

async function run({ dataDir, leagueId, windows, inRealPocket = null, seed = 20260922 }) {
  const t0 = Date.now();
  const hist = JSON.parse(fs.readFileSync(path.join(dataDir, 'backfill-historical.json'), 'utf8'));
  let stats = {}; try { stats = JSON.parse(fs.readFileSync(path.join(dataDir, 'fixture-stats.json'), 'utf8')); } catch {}
  let alt = { entries: {} }; try { alt = JSON.parse(fs.readFileSync(path.join(dataDir, 'research-alt-totals.json'), 'utf8')); } catch {}
  let main = { entries: {} }; try { main = JSON.parse(fs.readFileSync(path.join(dataDir, 'research-totals-closing.json'), 'utf8')); } catch {}
  const fixtures = (hist.fixtures || []).filter(f => parseInt(f.league?.id, 10) === leagueId && FINAL.has(f.fixture?.status?.short) && Number.isFinite(Number(f.goals?.home ?? f.score?.fulltime?.home)))
    .map(f => ({ id: f.fixture.id, date: f.fixture.date, day: f.fixture.date.slice(0, 10), season: f.league?.season, h: f.teams.home.id, a: f.teams.away.id, hg: Number(f.goals?.home ?? f.score?.fulltime?.home), ag: Number(f.goals?.away ?? f.score?.fulltime?.away) })).sort((x, y) => x.date < y.date ? -1 : 1);
  const { rows, names } = buildFeatureTable(fixtures, stats);
  const W = windows; const inWin = (r, a, b) => r.day >= a && (b ? r.day < b : true);
  const treeRows = rows.filter(r => r.ok && inWin(r, W.treesFrom, W.treesTo)), plattRows = rows.filter(r => r.ok && inWin(r, W.treesTo, W.plattTo));
  // market rows: Pinnacle 2.5 line — alternate store first, else main-line store where the main line was 2.5
  const line25 = (id) => { const a = alt.entries[id]; if (a?.line25 && a.line25.over > 1 && a.line25.under > 1) return { over: a.line25.over, under: a.line25.under, src: 'alt' }; const m = main.entries[id]; if (m?.main && m.main.point === 2.5 && m.main.over > 1 && m.main.under > 1) return { over: m.main.over, under: m.main.under, src: 'main' }; return null; };
  const model = await trainBinary(treeRows.map(r => r.x), treeRows.map(r => r.over), seed);
  const platt = fitPlatt(plattRows.map(r => model.raw(r.x)), plattRows.map(r => r.over));
  const scored = rows.filter(r => r.ok && r.day >= W.plattTo).map(r => { const l = line25(r.id); if (!l) return null; const io = 1 / l.over, iu = 1 / l.under; const mOver = io / (io + iu); const p = platt.apply(model.raw(r.x)); return { ...r, p, mOver, over25: l, edgeOver: p - mOver, edgeUnder: (1 - p) - (1 - mOver), src: l.src }; }).filter(Boolean);
  const sel = scored.filter(r => inWin(r, W.plattTo, W.holdoutFrom)), hold = scored.filter(r => r.day >= W.holdoutFrom);
  const seasonsOf = (list) => { if (list.length < 2) return 1; return Math.max(0.5, (new Date(list[list.length - 1].date) - new Date(list[0].date)) / (365.25 * 86400000)); };
  const ll = (p, y) => -(y ? Math.log(Math.max(1e-12, p)) : Math.log(Math.max(1e-12, 1 - p)));
  const paired = (list) => { const n = list.length; if (!n) return { n: 0 }; const d = list.map(r => ll(r.p, r.over) - ll(r.mOver, r.over)); const m = d.reduce((a, b) => a + b, 0) / n, sd = n > 1 ? Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1)) : 0; const base = list.reduce((a, r) => a + r.over, 0) / n; return { n, modelLL: +(list.reduce((a, r) => a + ll(r.p, r.over), 0) / n).toFixed(4), marketLL: +(list.reduce((a, r) => a + ll(r.mOver, r.over), 0) / n).toFixed(4), constantLL: +(list.reduce((a, r) => a + ll(base, r.over), 0) / n).toFixed(4), meanDiffVsMarket: +m.toFixed(5), z: sd ? +(m / (sd / Math.sqrt(n))).toFixed(2) : null, overRate: +base.toFixed(3), modelMeanP: +(list.reduce((a, r) => a + r.p, 0) / n).toFixed(3), marketMeanP: +(list.reduce((a, r) => a + r.mOver, 0) / n).toFixed(3) }; };
  const cellBets = (list, side, eMin, pMin) => list.filter(r => side === 'over' ? (r.edgeOver >= eMin - 1e-9 && r.p >= pMin - 1e-9) : (r.edgeUnder >= eMin - 1e-9 && (1 - r.p) >= pMin - 1e-9)).map(r => { const won = side === 'over' ? r.over === 1 : r.over === 0; const mk = side === 'over' ? r.mOver : 1 - r.mOver; const odds = side === 'over' ? r.over25.over : r.over25.under; return { r, date: r.date, day: r.day, won, mk, odds, bm: (won ? 1 : 0) - mk, pnl: won ? odds - 1 : -1 }; });
  const selSeasons = seasonsOf(sel), holdSeasons = seasonsOf(hold);
  const grid = [];
  for (const side of ['over', 'under']) for (let e = 0; e <= 0.15 + 1e-9; e += 0.01) for (let p = 0.35; p <= 0.70 + 1e-9; p += 0.05) { const s = summarise(cellBets(sel, side, e, p), selSeasons); if (s.n >= 30) grid.push({ side, edgeMin: +e.toFixed(2), probMin: +p.toFixed(2), sel: s }); }
  const eligible = grid.filter(g => g.sel.n >= 60 && g.sel.z != null && g.sel.z >= 1.5).sort((a, b) => b.sel.unitsPerSeason - a.sel.unitsPerSeason);
  const volume = grid.filter(g => g.sel.n >= 100 && g.sel.z != null && g.sel.z >= 1.0 && g.sel.roiClosePct > 0).sort((a, b) => b.sel.betsPerSeason - a.sel.betsPerSeason)[0] || null;
  const key = g => `${g.side}|${g.edgeMin}|${g.probMin}`; const shortlist = []; for (const g of [...eligible.slice(0, 3), ...(volume ? [volume] : [])]) if (!shortlist.some(x => key(x) === key(g))) shortlist.push(g);
  const closedDoors = d => d >= '2020-06-17' && d < '2021-05-17';
  const sub = (bets, f) => { const l = bets.filter(f); const n = l.length; if (!n) return { n: 0 }; const bm = l.reduce((a, b) => a + b.bm, 0) / n; return { n, beyondMarketPp: +(bm * 100).toFixed(1), roiClosePct: +((l.reduce((a, b) => a + b.pnl, 0) / n) * 100).toFixed(1) }; };
  const months = b => new Date(b.date).getUTCMonth() + 1;
  const checks = shortlist.map(c => {
    const sb = cellBets(sel, c.side, c.edgeMin, c.probMin), hb = cellBets(hold, c.side, c.edgeMin, c.probMin);
    const q = Math.max(1, Math.ceil(sb.length / 4)); const blocks = [0, 1, 2, 3].map(i => ({ block: i + 1, ...sub(sb, (b, idx) => idx >= i * q && idx < (i + 1) * q) }));
    const teamCounts = {}; for (const b of sb) { for (const t of [b.r.h, b.r.a]) teamCounts[t] = (teamCounts[t] || 0) + 1; } const top3 = Object.values(teamCounts).sort((x, y) => y - x).slice(0, 3).reduce((a, b) => a + b, 0);
    const overlap = inRealPocket ? sb.filter(b => inRealPocket(b.r.id) === true).length : null;
    const bySeason = {}; for (const b of [...sb, ...hb]) { const k = b.r.season; (bySeason[k] = bySeason[k] || []).push(b); }
    return { cell: { side: c.side, edgeMin: c.edgeMin, probMin: c.probMin }, selection: c.sel, holdoutRead: summarise(hb, holdSeasons), holdoutBySeason: Object.fromEntries(Object.entries(bySeason).filter(([k]) => hb.some(b => String(b.r.season) === String(k))).map(([k, l]) => [k, sub(l, () => true)])),
      rule19: { seasonality: { augOct: sub(sb, b => [8, 9, 10].includes(months(b))), novJan: sub(sb, b => [11, 12, 1].includes(months(b))), febMay: sub(sb, b => [2, 3, 4, 5].includes(months(b))) }, side: c.side, teamConcentration: { top3Share: sb.length ? +(top3 / (2 * sb.length)).toFixed(2) : null, teams: Object.keys(teamCounts).length }, recencyBlocks: blocks, decompositionByMarketPrice: { under45: sub(sb, b => b.mk < 0.45), mid: sub(sb, b => b.mk >= 0.45 && b.mk < 0.55), over55: sub(sb, b => b.mk >= 0.55) }, decompositionBySource: { alt: sub(sb, b => b.r.src === 'alt'), main: sub(sb, b => b.r.src === 'main') }, overlapWithReal1x2Pocket: overlap != null ? { betsAlsoInRealPocket: overlap, share: sb.length ? +(overlap / sb.length).toFixed(2) : null } : 'n/a', closedDoorsNote: 'selection and holdout windows post-date closed doors; see trainPeriodClosedDoors' } };
  });
  // closed doors: descriptive on the tree-training period (in-sample for the trees — reported as such)
  const trainCd = treeRows.filter(r => closedDoors(r.day)), trainOpen = treeRows.filter(r => !closedDoors(r.day) && r.day >= '2019-08-01');
  const rate = l => l.length ? +(l.reduce((a, r) => a + r.over, 0) / l.length).toFixed(3) : null;
  const importance = Object.entries(model.importance).map(([i, c]) => [names[+i], c]).sort((x, y) => y[1] - x[1]).slice(0, 15);
  return { leagueId, windows: W, ranAt: new Date().toISOString(), seconds: +((Date.now() - t0) / 1000).toFixed(1),
    data: { leagueFixtures: fixtures.length, featureRows: rows.filter(r => r.ok).length, treeRows: treeRows.length, plattRows: plattRows.length, selectionRows: sel.length, holdoutRows: hold.length, selectionFrom: sel[0]?.day, selectionTo: sel[sel.length - 1]?.day, holdoutFrom: hold[0]?.day, holdoutTo: hold[hold.length - 1]?.day, lineSource: { selection: { alt: sel.filter(r => r.src === 'alt').length, main: sel.filter(r => r.src === 'main').length }, holdout: { alt: hold.filter(r => r.src === 'alt').length, main: hold.filter(r => r.src === 'main').length } }, statsCoverage: { treeRowsWithShots: treeRows.filter(r => r.feat.h_statsN >= 5).length, selRowsWithShots: sel.filter(r => r.feat.h_statsN >= 5).length, selRowsWithXg: sel.filter(r => r.feat.h_xgN >= 5).length } },
    model: { features: names.length, trees: model.nTrees, depth: DEPTH, lr: LR, minLeaf: MIN_LEAF, seed, platt: { A: platt.A, B: platt.B }, topFeatures: importance },
    modelVsMarket: { selection: paired(sel), holdout: paired(hold) },
    allTopPicks: { selectionOver: summarise(cellBets(sel, 'over', 0, 0), selSeasons), selectionUnder: summarise(cellBets(sel, 'under', 0, 0), selSeasons) },
    trainPeriodClosedDoors: { insideN: trainCd.length, insideOverRate: rate(trainCd), outsideN: trainOpen.length, outsideOverRate: rate(trainOpen), note: 'in-sample for the trees; descriptive only' },
    grid: { cells: grid.length, eligible: eligible.length, volumeCandidate: volume ? { side: volume.side, edgeMin: volume.edgeMin, probMin: volume.probMin, sel: volume.sel } : null, top10: eligible.slice(0, 10).map(g => ({ side: g.side, edgeMin: g.edgeMin, probMin: g.probMin, ...g.sel })) },
    shortlistRule: 'top 3 by units/season among selection cells with n>=60 & z>=1.5, plus the top bets/season cell with n>=100, z>=1.0, ROI>0; ONE holdout read for these',
    shortlist: checks };
}

module.exports = { run, FEATURE_NAMES };
