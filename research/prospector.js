'use strict';
// ─── Prospector (Part 7, 2026-09-22): model-free market-vs-outcome pocket discovery ──────
// Pattern-first: where does Pinnacle's margin-stripped closing probability diverge from
// actual outcome rates, consistently, in a way a bet at the closing price would capture?
// No model anywhere in this file. Research only; nothing here touches live scoring.
//
// Cells: league (and pooled groups) × side (home/draw/away) × implied-probability band ×
// season phase (Aug–Oct / Nov–Jan / Feb–May / all). Per cell, on TRAIN rows (< split):
// n, residual = mean(outcome − implied), SE, z, flat ROI at the close. Multiple
// comparisons: Benjamini–Hochberg over every train cell. Cells passing (q ≤ qMax and
// n ≥ minN and |residual| ≥ minPp) are the pre-registered candidates and are read ONCE
// on TEST rows (≥ split) — plus rule-19 checks: closed doors, four recency blocks,
// decomposition by finer band, and season-by-season consistency.

const fs = require('fs');
const path = require('path');

function summarise(list) {
  const n = list.length; if (!n) return { n: 0 };
  const res = list.map(r => r.bm); const m = res.reduce((a, b) => a + b, 0) / n; const sd = n > 1 ? Math.sqrt(res.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1)) : 0; const se = sd ? sd / Math.sqrt(n) : null;
  const pnl = list.reduce((a, r) => a + r.pnl, 0);
  return { n, wins: list.filter(r => r.won).length, residualPp: +(m * 100).toFixed(2), sePp: se != null ? +(se * 100).toFixed(2) : null, z: se ? +(m / se).toFixed(2) : null, roiClosePct: +((pnl / n) * 100).toFixed(1), impliedMean: +(list.reduce((a, r) => a + r.implied, 0) / n).toFixed(3), actualRate: +(list.reduce((a, r) => a + (r.won ? 1 : 0), 0) / n).toFixed(3) };
}
function normCdf(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
function bhAdjust(items) { // items: [{ p }] → adds q (BH-adjusted p)
  const sorted = items.map((it, i) => ({ i, p: it.p })).sort((a, b) => a.p - b.p); const m = sorted.length; let prev = 1;
  for (let k = m - 1; k >= 0; k--) { const q = Math.min(prev, sorted[k].p * m / (k + 1)); items[sorted[k].i].q = +q.toFixed(4); prev = q; }
  return items;
}

function run({ dataDir, split = '2024-09-16', minN = 100, qMax = 0.10, minPp = 2.0, bandWidth = 0.05, leagueIds = null, groups = null, retired = new Set() }) {
  const t0 = Date.now();
  const hist = JSON.parse(fs.readFileSync(path.join(dataDir, 'backfill-historical.json'), 'utf8'));
  const closing = JSON.parse(fs.readFileSync(path.join(dataDir, 'closing-odds.json'), 'utf8'));
  const rows = [];
  for (const f of (hist.fixtures || [])) {
    const lid = parseInt(f.league?.id, 10); if (!Number.isFinite(lid) || retired.has(lid)) continue; if (leagueIds && !leagueIds.includes(lid)) continue;
    if (!['FT', 'AET', 'PEN'].includes(f.fixture?.status?.short)) continue;
    const hg = Number(f.goals?.home ?? f.score?.fulltime?.home), ag = Number(f.goals?.away ?? f.score?.fulltime?.away); if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const co = closing[f.fixture.id] || closing[String(f.fixture.id)]; if (!co || co.bookmaker !== 'pinnacle' || !(co.homeOdds > 1 && co.drawOdds > 1 && co.awayOdds > 1)) continue;
    const ih = 1 / co.homeOdds, id = 1 / co.drawOdds, ia = 1 / co.awayOdds, s = ih + id + ia; const implied = { home: ih / s, draw: id / s, away: ia / s };
    const y = hg > ag ? 'home' : hg < ag ? 'away' : 'draw'; const d = f.fixture.date; const month = new Date(d).getUTCMonth() + 1; const season = f.league?.season ?? (month >= 7 ? new Date(d).getUTCFullYear() : new Date(d).getUTCFullYear() - 1);
    const phase = [8, 9, 10].includes(month) ? 'augOct' : [11, 12, 1].includes(month) ? 'novJan' : [2, 3, 4, 5].includes(month) ? 'febMay' : 'other';
    for (const side of ['home', 'draw', 'away']) rows.push({ lid, date: d, day: d.slice(0, 10), season, phase, side, implied: implied[side], won: y === side, bm: (y === side ? 1 : 0) - implied[side], pnl: y === side ? co[`${side}Odds`] - 1 : -1 });
  }
  rows.sort((a, b) => a.date < b.date ? -1 : 1);
  const band = (p) => Math.floor(p / bandWidth) * bandWidth; const bandKey = (p) => `${band(p).toFixed(2)}-${(band(p) + bandWidth).toFixed(2)}`;
  const grp = groups || { lower: [41, 42, 40, 136, 141, 79], top: [39, 140, 135, 78, 61], all: null };
  const scopes = [...new Set(rows.map(r => r.lid))].map(l => ({ key: `L${l}`, ids: [l] })).concat(Object.entries(grp).map(([k, ids]) => ({ key: k, ids })));
  const train = rows.filter(r => r.day < split), test = rows.filter(r => r.day >= split);
  const cells = [];
  for (const sc of scopes) {
    const tr = sc.ids ? train.filter(r => sc.ids.includes(r.lid)) : train;
    const by = {}; for (const r of tr) { for (const ph of [r.phase, 'all']) { if (ph === 'other') continue; const k = `${sc.key}|${r.side}|${bandKey(r.implied)}|${ph}`; (by[k] = by[k] || []).push(r); } }
    for (const [k, l] of Object.entries(by)) { if (l.length < minN) continue; const s = summarise(l); const p = s.z != null ? 2 * (1 - normCdf(Math.abs(s.z))) : 1; cells.push({ key: k, scope: sc.key, side: k.split('|')[1], band: k.split('|')[2], phase: k.split('|')[3], train: s, p }); }
  }
  bhAdjust(cells);
  const candidates = cells.filter(c => c.q <= qMax && Math.abs(c.train.residualPp) >= minPp).sort((a, b) => a.q - b.q);
  const closedDoors = (d) => d >= '2020-06-17' && d < '2021-05-17';
  const sub = (l) => { const s = summarise(l); return { n: s.n, residualPp: s.residualPp, roiClosePct: s.roiClosePct }; };
  const read = candidates.map(c => {
    const sc = scopes.find(x => x.key === c.scope); const sel = (list) => list.filter(r => (!sc.ids || sc.ids.includes(r.lid)) && r.side === c.side && bandKey(r.implied) === c.band && (c.phase === 'all' || r.phase === c.phase));
    const tr = sel(train), te = sel(test); const q = Math.max(1, Math.ceil(tr.length / 4));
    const blocks = [0, 1, 2, 3].map(i => ({ block: i + 1, ...sub(tr.slice(i * q, (i + 1) * q)) }));
    const bySeason = {}; for (const r of [...tr, ...te]) (bySeason[r.season] = bySeason[r.season] || []).push(r);
    const fine = {}; for (const r of tr) { const k = `${(Math.floor(r.implied / 0.025) * 0.025).toFixed(3)}`; (fine[k] = fine[k] || []).push(r); }
    const bet = c.train.residualPp > 0 ? c.side : null; // a negative residual means the side is over-priced: the "bet" would be against it (no direct market for that beyond laying), so only positive-residual cells are directly actionable
    return { ...c, actionable: !!bet, testLook: summarise(te), consistent: te.length ? (Math.sign(summarise(te).residualPp) === Math.sign(c.train.residualPp) && Math.abs(summarise(te).residualPp) >= Math.abs(c.train.residualPp) / 2) : null,
      rule19: { closedDoors: { inside: sub(tr.filter(r => closedDoors(r.day))), outside: sub(tr.filter(r => !closedDoors(r.day))) }, recencyBlocks: blocks, bySeason: Object.fromEntries(Object.entries(bySeason).sort().map(([k, l]) => [k, sub(l)])), fineBands: Object.fromEntries(Object.entries(fine).sort().map(([k, l]) => [k, sub(l)])), betsPerSeason: +(tr.length / Math.max(1, new Set(tr.map(r => r.season)).size)).toFixed(1) } };
  });
  return { ranAt: new Date().toISOString(), seconds: +((Date.now() - t0) / 1000).toFixed(1), params: { split, minN, qMax, minPp, bandWidth }, data: { fixtureRows: rows.length / 3, trainRows: train.length / 3, testRows: test.length / 3, leagues: [...new Set(rows.map(r => r.lid))].length, from: rows[0]?.day, to: rows[rows.length - 1]?.day }, cellsTested: cells.length, candidates: read.length, actionable: read.filter(r => r.actionable).length, results: read, topByZ: cells.sort((a, b) => Math.abs(b.train.z) - Math.abs(a.train.z)).slice(0, 15).map(c => ({ key: c.key, n: c.train.n, residualPp: c.train.residualPp, z: c.train.z, q: c.q, roi: c.train.roiClosePct })) };
}
module.exports = { run };
