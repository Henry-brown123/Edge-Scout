'use strict';

const fs   = require('fs');
const path = require('path');

// ─── XG STORE (StatsBomb + future sources) ───────────────────────────────────
// Keyed as "{homeTeam}|{awayTeam}|{YYYY-MM-DD}". Loaded once at startup;
// reloaded on demand via reloadXgStore() after an import run.
const XG_STORE_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'xg-data.json');
let _xgStore = null;

function getXgStore() {
  if (_xgStore) return _xgStore;
  try { _xgStore = JSON.parse(fs.readFileSync(XG_STORE_PATH, 'utf8')); }
  catch { _xgStore = {}; }
  return _xgStore;
}

function reloadXgStore() { _xgStore = null; }

// Look up StatsBomb xG for a fixture. Tries exact date then ±1 day for timezone drift.
function lookupXg(homeName, awayName, dateStr) {
  const store = getXgStore();
  if (!homeName || !awayName || !dateStr) return null;
  const d = new Date(dateStr);
  for (let offset = 0; offset <= 1; offset++) {
    const candidate = new Date(d);
    candidate.setUTCDate(d.getUTCDate() + offset);
    const ds = candidate.toISOString().slice(0, 10);
    const entry = store[`${homeName}|${awayName}|${ds}`];
    if (entry) return entry;
    // Also try previous day
    const prev = new Date(d);
    prev.setUTCDate(d.getUTCDate() - offset);
    const ps = prev.toISOString().slice(0, 10);
    const prev_entry = store[`${homeName}|${awayName}|${ps}`];
    if (prev_entry) return prev_entry;
  }
  return null;
}

// ─── FIXTURE CONTEXT ─────────────────────────────────────────────────────────

function classifyFixture(leagueId) {
  const id = parseInt(leagueId, 10);
  // Includes WC/continental qualifying leagues (26-35) so team profiles built
  // from qualifying data are correctly classified as international, not club_domestic.
  const INTERNATIONAL = [1, 4, 5, 6, 7, 8, 9, 10, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 960];
  const CLUB_EUROPEAN = [2, 3, 848];
  if (INTERNATIONAL.includes(id)) return 'international';
  if (CLUB_EUROPEAN.includes(id))  return 'club_european';
  return 'club_domestic';
}

// ─── DOMESTIC BLEND CLASSIFICATION (shared: server.js live path + weightOptimiser.js
// historical path, Addendum 24 Part C) ─────────────────────────────────────────
// Competitions whose own recent history is too thin/structurally unsuitable for
// form/xg/defense/momentum/standings to mean anything on their own (knockout format
// — a handful of matches per season at most — or, for Carabao Cup, no backfilled
// history at all) — these pull each team's real current domestic-league data
// instead. Single source of truth so the live and historical paths can never
// silently drift out of sync with each other.
const CUP_LEAGUE_IDS_FOR_DOMESTIC_BLEND = new Set([48, 2, 3, 848]); // Carabao Cup, Champions League, Europa League, Conference League
// Domestic leagues eligible as a source of "real current form" for the blend above —
// every currently-tracked top-flight-or-below domestic league. Deliberately excludes
// other cup competitions (keeps the blend one-directional) and anything outside
// LEAGUES (an untracked league contributes nothing, same limit the international
// blend already has for non-backfilled competitions).
const DOMESTIC_LEAGUE_IDS_FOR_BLEND = new Set([39, 140, 135, 78, 61, 179, 88, 94, 41, 42, 40]);
// Betting-tier classification (three-tier redesign, 2026-08-31) — distinct from
// CUP_LEAGUE_IDS_FOR_DOMESTIC_BLEND above: that set is about SCORING methodology
// (which fixtures borrow domestic form data) and deliberately excludes the World
// Cup (WC has its own international-pool blend, not the domestic one). This set
// is about BETTING-TIER assignment (which leagues are "always no-stake/observation
// if priced, never real paper money until individually promoted") and deliberately
// DOES include the World Cup. The two sets overlap but are not the same thing —
// do not merge them.
const TOURNAMENT_LEAGUE_IDS = new Set([1, 2, 3, 48, 848]); // FIFA World Cup, Champions League, Europa League, Carabao Cup, Conference League
// UEFA's competition reform (Champions League, Europa League, Conference League all
// moved from group-of-4 stages to a single 36-team league-phase table) took effect
// the 2024-25 season — API-Sports' own `season` field uses the year a season starts,
// so season>=2024 is the single-phase era. Football-justified cutoff, not arbitrary:
// before this, "rank across the whole competition" mixed teams from different
// 4-team groups that never played each other — no more meaningful as a single
// ranking than Carabao Cup's own cross-round table was (Addendum 24 Part A/C's
// finding). From 2024-25 on, every team in the competition plays the same 8-fixture
// league phase, so a single table position is genuinely comparable, confirmed live
// (Addendum 24 Part 1 investigation: /standings returns a real, current, populated
// 36-team single table for the 2025-26 season).
const UEFA_SINGLE_PHASE_SEASON_FLOOR = 2024;
// Games-played floor for trusting a Champions/Europa/Conference League team's OWN
// competition-phase table position, per the brief's own prior finding (Phase 1 Part C
// point 10: "competition-phase standing is real and meaningful once gamesPlayed>=3 in
// that competition"). Deliberately NOT the same as the domestic gamesPlayed>=1 floor
// (Part D) — that threshold was evidenced specifically for full-season domestic
// tables; the Euro league phase is only 8 fixtures total, self-selects to two
// unevenly-strong halves by matchday 1-2 (seeded pots), and single-phase play only
// started 2024-25, so there is no separate evidence base yet to justify a lower
// floor here. Applying Part D's domestic threshold to this competition type without
// its own evidence would just be a subtler version of the exact mistake Part A fixed
// (trusting a table position without confirming it is actually meaningful yet).
const EURO_COMPETITION_PHASE_GAMES_FLOOR = 3;

// ─── CONTEXT-AWARE WEIGHTS ────────────────────────────────────────────────────

const WEIGHTS_BY_CONTEXT = {
  club_domestic: {
    form: 22, homeAdv: 14, xg: 16, h2h: 10,
    defense: 14, momentum: 10, injuries: 8, standings: 6,
  },
  club_european: {
    form: 18, homeAdv: 10, xg: 14, h2h: 12,
    defense: 14, momentum: 12, injuries: 12, standings: 8,
  },
  international: {
    form: 14, homeAdv: 6, xg: 10, h2h: 14,
    defense: 12, momentum: 10, injuries: 18, standings: 16,
  },
};

// Keep DEFAULT_WEIGHTS as a named export for any callers that reference it directly
const DEFAULT_WEIGHTS = WEIGHTS_BY_CONTEXT.club_domestic;

// ─── CONTEXT-SPECIFIC CONFIG ─────────────────────────────────────────────────

const CONTEXT_CONFIG = {
  club_domestic: {
    awayMult:      0.88,   // strong home advantage
    rankScale:     0,      // rankings irrelevant — use real form data
    homeBase:      0.40,   // ranking base probs (not used when scale=0)
    awayBase:      0.35,
    dataConfMin:   0.4,    // minimum dataConf before pre-match lock
    gapThresholdBase: 0.25,
  },
  club_european: {
    awayMult:      0.92,
    rankScale:     0.003,
    homeBase:      0.35,
    awayBase:      0.40,
    dataConfMin:   0.3,
    gapThresholdBase: 0.20,
  },
  international: {
    awayMult:      0.97,   // near-neutral venues, minimal home advantage
    rankScale:     0.018,  // raised from 0.010 — anchor guaranteed 30% weight so needs more differentiation
    homeBase:      0.30,
    awayBase:      0.45,
    dataConfMin:   0.0,    // no min data requirement — use stricter gap threshold
    gapThresholdBase: 0.25, // raised — tiered fixture-count gate is now the binding constraint for international
  },
};

// ─── SCORING HELPERS ─────────────────────────────────────────────────────────

function recencyAvg(arr, decay = 0.05) {
  if (!arr.length) return 0;
  let sum = 0, wSum = 0;
  arr.forEach((v, i) => {
    const w = Math.exp(-decay * i);
    sum += v * w;
    wSum += w;
  });
  return wSum > 0 ? sum / wSum : 0;
}

function outcomePoints(fix, isHome) {
  const hg = fix.goals?.home ?? fix.score?.fulltime?.home;
  const ag = fix.goals?.away ?? fix.score?.fulltime?.away;
  if (hg == null || ag == null) return null;
  if (isHome) return hg > ag ? 3 : hg === ag ? 1 : 0;
  return ag > hg ? 3 : hg === ag ? 1 : 0;
}

function formScore(fixtures, teamId, window = 6, decay = 0.05) {
  const rel = fixtures
    .filter(f => (f.teams?.home?.id === teamId || f.teams?.away?.id === teamId) && f.fixture?.status?.short === 'FT')
    .slice(0, window);
  if (!rel.length) return 50;
  const pts = rel.map(f => outcomePoints(f, f.teams?.home?.id === teamId) ?? 1);
  return Math.round((recencyAvg(pts, decay) / 3) * 100);
}

function homeAdvScore(fixtures, teamId, decay = 0.05) {
  const home = fixtures
    .filter(f => f.teams?.home?.id === teamId && f.fixture?.status?.short === 'FT')
    .slice(0, 10);
  if (!home.length) return 50;
  return Math.round((recencyAvg(home.map(f => outcomePoints(f, true) ?? 1), decay) / 3) * 100);
}

function xgScore(fixtures, teamId, statsCache = {}, decay = 0.05) {
  const rel = fixtures
    .filter(f => (f.teams?.home?.id === teamId || f.teams?.away?.id === teamId) && f.fixture?.status?.short === 'FT')
    .slice(0, 8);
  if (!rel.length) return 50;
  const vals = rel.map(f => {
    const isHome   = f.teams?.home?.id === teamId;
    // Tier 1: StatsBomb / imported xG store (keyed by team name + date)
    const sbEntry = lookupXg(f.teams?.home?.name, f.teams?.away?.name, f.fixture?.date);
    if (sbEntry) return isHome ? sbEntry.home : sbEntry.away;
    // Tier 2: API-Sports fixture stats (real xG or shots proxy)
    const c = statsCache[f.fixture?.id];
    if (c) {
      const s = isHome ? c.home : c.away;
      if (s?.xg != null) return s.xg;
      if (s?.shotsOn != null) return s.shotsOn * 0.33;
    }
    // Tier 3: goals as last-resort proxy
    return isHome ? (f.goals?.home ?? 0) : (f.goals?.away ?? 0);
  });
  return Math.min(100, Math.round((recencyAvg(vals, decay) / 3) * 100));
}

function defenseScore(fixtures, teamId, decay = 0.05) {
  const rel = fixtures
    .filter(f => (f.teams?.home?.id === teamId || f.teams?.away?.id === teamId) && f.fixture?.status?.short === 'FT')
    .slice(0, 8);
  if (!rel.length) return 50;
  const conceded = rel.map(f => {
    const isHome = f.teams?.home?.id === teamId;
    return isHome ? (f.goals?.away ?? 0) : (f.goals?.home ?? 0);
  });
  return Math.max(0, Math.round(100 - (recencyAvg(conceded, decay) / 3) * 100));
}

function momentumScore(fixtures, teamId) {
  const finished = fixtures
    .filter(f => (f.teams?.home?.id === teamId || f.teams?.away?.id === teamId) && f.fixture?.status?.short === 'FT');

  const recent = finished.slice(0, 3);
  if (!recent.length) return 50;

  const season = finished.slice(0, 15);
  if (season.length < 5) return 50;

  const recentPts = recent.map(f => outcomePoints(f, f.teams?.home?.id === teamId) ?? 1);
  const recentRate = recentPts.reduce((a, b) => a + b, 0) / (recent.length * 3);

  const seasonPts = season.map(f => outcomePoints(f, f.teams?.home?.id === teamId) ?? 1);
  const seasonRate = seasonPts.reduce((a, b) => a + b, 0) / (season.length * 3);

  // Positive diff = hot streak above season average; negative = slump
  const diff = recentRate - seasonRate;
  return Math.max(0, Math.min(100, Math.round(50 + diff * 150)));
}

function h2hScore(h2hFixtures, homeTeamId, window = 5, decay = 0.05) {
  const recent = h2hFixtures.slice(0, window);
  if (!recent.length) return 50;
  const pts = recent.map(f => outcomePoints(f, f.teams?.home?.id === homeTeamId) ?? 1);
  return Math.round((recencyAvg(pts, decay) / 3) * 100);
}

// Shared rank->0-100 conversion, extracted so the live path (below), the historical
// scorer (weightOptimiser.js, post Addendum-24 fix), and the last-season proxy all
// use the exact same formula rather than three near-identical inline copies drifting
// apart over time.
function rankToProxyScore(rank, leagueSize) {
  if (!leagueSize) return 50;
  return Math.round(((leagueSize - rank + 1) / leagueSize) * 100);
}

// Looks up a team's rank in a (possibly already-flattened) standings array and
// converts it via rankToProxyScore — shared by both the current-season lookup below
// and the last-season proxy, so "how do we read a standings array" only exists once.
function lookupStandingScore(standings, teamId) {
  if (!standings?.length) return null;
  const flat = Array.isArray(standings[0]) ? standings.flat() : standings;
  const entry = flat.find(s => s.team?.id === teamId);
  if (!entry) return null;
  return { score: rankToProxyScore(entry.rank, flat.length), gamesPlayed: entry.all?.played || 0 };
}

// Addendum 24 Part D — last-season final standing as the early-season proxy. Tested
// train-only against real outcomes (docs/tier-calibration-analysis.md, the standings-
// proxy candidate test): r=0.36 vs. the in-season rolling signal's r=0.14 at the exact
// population where neutral is used today, ~2.6x stronger. Returns null (not 50) when
// unavailable — the caller decides the final fallback — so a promoted/newly-tracked
// team (no prior-season rank in this league) is distinguishable from "found last
// season's table and this team was mid-table," which do carry different information.
function lastSeasonStandingScore(lastSeasonStandings, teamId) {
  const looked = lookupStandingScore(lastSeasonStandings, teamId);
  return looked ? looked.score : null;
}

// gamesPlayed threshold tightened from <3 to <1 (Addendum 24 Part D) — tested
// train-only: at exactly 0 games played the in-season rolling rank is genuine noise
// (r=-0.01, justifying neutral/proxy there), but by 1 game played it already carries
// real signal (r=0.23) that a hardcoded neutral was needlessly throwing away.
// lastSeasonStandings (optional, 4th arg) — Addendum 24 Part D's proxy, tried before
// falling back to neutral. Backward compatible: omitting it just means the proxy step
// is skipped, same behaviour as before this addendum except for the tightened
// threshold.
function standingsScore(standings, teamId, fixtureContext, lastSeasonStandings) {
  // Group standings within a 4-team WC/tournament group are meaningless for quality
  // differentiation — all qualifiers are elite and a "rank 2 of 4" score of 75
  // tells us nothing about relative team strength. Return neutral for international.
  if (fixtureContext === 'international') return 50;
  const current = lookupStandingScore(standings, teamId);
  // No current-season entry at all (very first fixtures of a season, before this
  // team has been added to any live table snapshot) or fewer than 1 game played —
  // early-season table positions below that are arbitrary or carried over from last
  // season's finish, not meaningful yet. Try the evidenced proxy before neutral.
  if (!current || current.gamesPlayed < 1) {
    const proxy = lastSeasonStandingScore(lastSeasonStandings, teamId);
    return proxy ?? 50;
  }
  return current.score;
}

// Discounts factor confidence based on how long ago a team's most recent fixture
// in its form pool was played. Ordinal recency decay (recencyAvg) already weights
// game-to-game, but has no notion of calendar time — a 76-day-old game at index 0
// (e.g. the only data available at season start) gets full weight otherwise, same
// class of problem the standings games-played guard addresses.
function stalenessMultiplier(mostRecentDate) {
  if (!mostRecentDate) return 0.5; // no data — pull to neutral
  const daysSince = (Date.now() - new Date(mostRecentDate)) / 86400000;
  if (daysSince < 14) return 1.0;  // fresh — full confidence
  if (daysSince < 30) return 0.85; // slightly stale
  if (daysSince < 60) return 0.65; // moderately stale
  if (daysSince < 90) return 0.45; // summer break — significant discount
  return 0.30;                      // very stale — minimal contribution
}

// Pulls a factor score toward neutral (50) by the staleness multiplier.
// multiplier 1.0 = no change; 0.0 = fully neutral.
function applyStalenessPull(rawScore, multiplier) {
  return Math.round(50 + (rawScore - 50) * multiplier);
}

function injuryScore(injuries, teamId) {
  if (!injuries?.length) return 50;
  const team = injuries.filter(i => i.team?.id === teamId);
  if (!team.length) return 100;
  const posWeight = (pos = '') => {
    const p = pos.toLowerCase();
    if (p.includes('forward') || p.includes('attacker')) return 12;
    if (p.includes('midfielder')) return 9;
    if (p.includes('defender')) return 6;
    return 4;
  };
  const impact = team.reduce((s, i) => s + posWeight(i.player?.type || i.player?.position || ''), 0);
  return Math.max(0, Math.round(100 - impact));
}

// ─── LEAGUE CONFIG ────────────────────────────────────────────────────────────
// Per-league baseline rates and market efficiency used to tune draw probability
// and home advantage in computeModelProb, and to weight success scores.
// PL avgDrawRate (0.243) is the baseline — other leagues are expressed relative.

const LEAGUE_CONFIG = {
  39:  { name: 'Premier League',   avgHomeWinRate: 0.435, avgDrawRate: 0.221, avgAwayWinRate: 0.344, avgGoalsPerGame: 2.68, marketEfficiency: 0.95, drawBaseWeight: 1.00, homeAdvBaseWeight: 1.00 },
  140: { name: 'La Liga',          avgHomeWinRate: 0.461, avgDrawRate: 0.271, avgAwayWinRate: 0.268, avgGoalsPerGame: 2.58, marketEfficiency: 0.93, drawBaseWeight: 1.12, homeAdvBaseWeight: 1.25 },
  135: { name: 'Serie A',          avgHomeWinRate: 0.419, avgDrawRate: 0.287, avgAwayWinRate: 0.295, avgGoalsPerGame: 2.52, marketEfficiency: 0.91, drawBaseWeight: 1.12, homeAdvBaseWeight: 0.98 },
  78:  { name: 'Bundesliga',       avgHomeWinRate: 0.454, avgDrawRate: 0.234, avgAwayWinRate: 0.312, avgGoalsPerGame: 3.02, marketEfficiency: 0.92, drawBaseWeight: 0.96, homeAdvBaseWeight: 1.00 },
  61:  { name: 'Ligue 1',          avgHomeWinRate: 0.409, avgDrawRate: 0.258, avgAwayWinRate: 0.333, avgGoalsPerGame: 2.52, marketEfficiency: 0.88, drawBaseWeight: 1.06, homeAdvBaseWeight: 0.96 },
  2:   { name: 'Champions League',      avgHomeWinRate: 0.451, avgDrawRate: 0.205, avgAwayWinRate: 0.345, avgGoalsPerGame: 2.87, marketEfficiency: 0.96, drawBaseWeight: 1.01, homeAdvBaseWeight: 0.94 },
  // 2026-09-01 audit flag: fit 2026-06-17 (pre-GBDT), the one league row never
  // re-tuned post-switch — every other row here got touched between 2026-08-01
  // and 2026-08-24. No forward action today: WC 2026 has concluded (per
  // CALIBRATION_AUDIT[1], no further data will accumulate), so nothing currently
  // live reads this row. BUT: API-Sports reuses leagueId=1 across WC editions
  // (differentiated only by `season`), so this exact stale row will silently
  // apply again to WC 2030 fixtures unless someone re-validates it first —
  // re-check this before that tournament, not after.
  1:   { name: 'World Cup',             avgHomeWinRate: 0.390, avgDrawRate: 0.224, avgAwayWinRate: 0.386, avgGoalsPerGame: 2.64, marketEfficiency: 0.94, drawBaseWeight: 0.92, homeAdvBaseWeight: 0.80 },
  179: { name: 'Scottish Premiership',  avgHomeWinRate: 0.4449, avgDrawRate: 0.2396, avgAwayWinRate: 0.3154, avgGoalsPerGame: 2.71, marketEfficiency: 0.78, drawBaseWeight: 1.07, homeAdvBaseWeight: 1.35 },
  88:  { name: 'Eredivisie',            avgHomeWinRate: 0.4344, avgDrawRate: 0.2382, avgAwayWinRate: 0.3274, avgGoalsPerGame: 3.12, marketEfficiency: 0.80, drawBaseWeight: 1.00, homeAdvBaseWeight: 1.00 },
  94:  { name: 'Primeira Liga',         avgHomeWinRate: 0.4486, avgDrawRate: 0.2258, avgAwayWinRate: 0.3255, avgGoalsPerGame: 2.68, marketEfficiency: 0.79, drawBaseWeight: 0.93, homeAdvBaseWeight: 0.97 },
  // Base rates corrected 2026-08-11 against train-only observed frequencies
  // (docs/calibration-rules.md train/test split; see VALIDATED_SPLITS in
  // server.js for the exact boundary). Both are UEFA continental competitions
  // where every match bar a neutral-venue final sends the away side across a
  // border into an unfamiliar stadium — European away form is a well-documented
  // step down from a club's normal domestic away form, which is a coherent
  // football story for why the train-observed home rate runs hotter than the
  // untuned defaults assumed. marketEfficiency/drawBaseWeight/homeAdvBaseWeight
  // left untouched, same reasoning as every prior split this cycle: no
  // independent train evidence to move them separately from the base-rate fix.
  3:   { name: 'Europa League',         avgHomeWinRate: 0.500, avgDrawRate: 0.210, avgAwayWinRate: 0.290, avgGoalsPerGame: 2.78, marketEfficiency: 0.88, drawBaseWeight: 1.02, homeAdvBaseWeight: 0.96 },
  848: { name: 'Conference League',     avgHomeWinRate: 0.466, avgDrawRate: 0.206, avgAwayWinRate: 0.328, avgGoalsPerGame: 2.65, marketEfficiency: 0.82, drawBaseWeight: 1.03, homeAdvBaseWeight: 0.98 },
  // Added 2026-08-10, paper-only, zero calibration history — deliberately no
  // avgHomeWinRate/avgDrawRate/avgAwayWinRate/avgGoalsPerGame. Those four feed a
  // real 30%-live-blend in applyLeagueBiasCorrection() and a goals-market baseline
  // in scoreGoalsMarkets() — inventing plausible-looking cup numbers for either
  // would silently bias live predictions toward an unverified guess, exactly what
  // "no tuned base rates" rules out. marketEfficiency/drawBaseWeight/homeAdvBaseWeight
  // are pure multipliers where 1.0 is a genuine no-op, not a guess, so those are
  // safe to set neutral. applyLeagueBiasCorrection() now skips the blend entirely
  // when avgHomeWinRate is absent (see scoring.js) — this entry exists for name
  // lookups and as a ready slot for real calibration once enough live data exists.
  48:  { name: 'Carabao Cup', marketEfficiency: 1.0, drawBaseWeight: 1.0, homeAdvBaseWeight: 1.0 },
  // Added 2026-08-10, paper-only, zero calibration history — same guard as league 48
  // above (no avgHomeWinRate/avgDrawRate/avgAwayWinRate/avgGoalsPerGame; neutral
  // marketEfficiency/drawBaseWeight/homeAdvBaseWeight only).
  41:  { name: 'League One', marketEfficiency: 1.0, drawBaseWeight: 1.0, homeAdvBaseWeight: 1.0 },
  42:  { name: 'League Two', marketEfficiency: 1.0, drawBaseWeight: 1.0, homeAdvBaseWeight: 1.0 },
  // Added 2026-08-19, paper-only, zero calibration history — same guard as 48/41/42
  // above (no avgHomeWinRate/avgDrawRate/avgAwayWinRate/avgGoalsPerGame; neutral
  // marketEfficiency/drawBaseWeight/homeAdvBaseWeight only). Rule-10 protected
  // from day one through its one banked backtest; converted to a rule-12/15
  // date-split (cutoff 2026-08-19T22:00:00Z) once that read was banked — see
  // DATE_SPLIT_HOLDOUT_CUTOFFS in server.js and CALIBRATION_AUDIT[40].
  40:  { name: 'Championship', marketEfficiency: 1.0, drawBaseWeight: 1.0, homeAdvBaseWeight: 1.0 },
};

// ─── XG PROXY ─────────────────────────────────────────────────────────────────
// Estimates expected goals from shot statistics when official xG isn't available.
// Produces a value in the 0–5 range consistent with the xgScore() input scale.
//
// 2026-09-01: original coefficients (shotsOn*0.35 + totalShots*0.08 +
// possession*0.5, no intercept) were never checked against real xG — this feeds
// xgScore()'s live "xg" factor whenever official xG isn't available, which is one
// of the raw features the GBDT model actually splits on, so a biased proxy
// silently reshapes GBDT's own input distribution. Checked against 4,173
// proxy/real pairs (Understat/StatsBomb ground truth via lookupXg, matched
// domestic-league fixtures 2023-08 to 2025-05): the old formula overestimated
// real xG by a mean of +1.27 on a held-out chronological test set (last 20% by
// date) — MAE 1.29, e.g. Arsenal 4.04 vs actual 0.84, nearly 5x high in
// individual cases. Refit via OLS on the first 80% chronologically, evaluated on
// the untouched last 20% (calibration-rules.md-style train/test discipline):
// held-out MAE 0.455 (vs 1.29), mean bias 0.018 (vs +1.27) — essentially
// unbiased out-of-sample. Clamped to zero: xG can't be negative, and the
// negative possession coefficient can produce a small negative value at the
// low-shots/high-possession extreme (e.g. 0 shots on target, 90% possession).
function computeXGProxy({ shotsOn = 0, totalShots = 0, possession = 0.5 }) {
  const raw = 0.0491 + (shotsOn * 0.1654) + (totalShots * 0.0656) + (possession * -0.2032);
  return parseFloat(Math.max(0, raw).toFixed(3));
}

// ─── COMPETITION PHASE ────────────────────────────────────────────────────────
// Returns the phase of competition for a fixture. Used to tag calibration records
// and (future) to adjust model behaviour per phase (knockout vs league mid-season).

function classifyCompetitionPhase(fix, leagueId) {
  const id    = parseInt(leagueId, 10);
  const round = (fix.league?.round || '').toLowerCase();

  // International tournaments — WC, Euros, Copa America, Nations League, AFCON, etc.
  const TOURNAMENT = [1, 4, 5, 6, 7, 8, 9, 10, 960];
  if (TOURNAMENT.includes(id)) {
    if (round.includes('group')) return 'group_stage';
    return 'knockout';
  }

  // European club competitions (CL, EL, Conference)
  if ([2, 3, 848].includes(id)) {
    if (round.includes('group') || round.includes('league phase')) return 'group_stage';
    return 'knockout';
  }

  // Domestic leagues — classify by gameweek number (assumes 38-game season)
  const gw = parseInt((round.match(/\d+/) || [])[0] || '0', 10);
  if (!gw) return 'league_mid';
  if (gw <= 8)  return 'league_early';
  if (gw >= 31) return 'league_late';
  return 'league_mid';
}

// ─── MODEL PROBABILITY ────────────────────────────────────────────────────────

function computeModelProb(homeFactors, awayFactors, weights, context = 'club_domestic', leagueConfig = null) {
  const cfg   = CONTEXT_CONFIG[context] || CONTEXT_CONFIG.club_domestic;
  const total = Object.values(weights).reduce((a, b) => a + b, 0) || 100;

  // League-specific home advantage weight (default 1.0 = no adjustment)
  const homeAdvMult = leagueConfig?.homeAdvBaseWeight ?? 1.0;

  const score = (f, isHome) => (
    f.form * weights.form +
    (isHome ? f.homeAdv * weights.homeAdv * homeAdvMult : f.homeAdv * weights.homeAdv) +
    f.xg * weights.xg + f.h2h * weights.h2h + f.defense * weights.defense +
    f.momentum * weights.momentum + f.injuries * weights.injuries + f.standings * weights.standings
  ) / total;

  const homeScore = score(homeFactors, true);
  const awayAdj   = score(awayFactors, false) * cfg.awayMult;

  // Draw base scaled by league's historical draw rate relative to PL baseline (0.243)
  const drawRateRatio = (leagueConfig?.avgDrawRate ?? 0.243) / 0.243;
  const qualityGap    = Math.abs(homeScore - awayAdj);
  const drawBase      = 35 * drawRateRatio;
  const drawScore     = Math.max(20 * drawRateRatio, drawBase - qualityGap * 0.3);

  const raw = homeScore + awayAdj + drawScore;
  return { home: homeScore / raw, draw: drawScore / raw, away: awayAdj / raw };
}

// ─── LEAGUE BIAS CORRECTION ───────────────────────────────────────────────────
// Live scoring runs on the GBDT model (models/gbdt.js), which accepts leagueConfig
// for interface compatibility but ignores it entirely — none of LEAGUE_CONFIG's
// avgHomeWinRate/avgDrawRate/avgAwayWinRate calibration reaches live predictions
// through the model itself. This blends the model's raw output toward each league's
// observed base rates as a post-prediction correction, applied in scoreOneFixture
// immediately after model.predict(). homeAdvBaseWeight is applied here too, scaling
// the home target before blending — this is its only live-pipeline effect (it also
// separately feeds computeModelProb, the diagnostic/backtest-only linear model).
function applyLeagueBiasCorrection(probs, leagueId, leagueConfig) {
  const config = leagueConfig[leagueId];
  // A LEAGUE_CONFIG entry can exist (for name lookups, market efficiency, etc.)
  // without carrying real base-rate calibration yet — e.g. a brand-new paper-only
  // league with no live/backtest history. Skip the blend rather than pull toward
  // an absent/undefined target (avgDrawRate/avgAwayWinRate would be equally
  // missing whenever avgHomeWinRate is, since they're always added together).
  if (!config || config.avgHomeWinRate == null) return probs; // no correction available

  // Target rates from LEAGUE_CONFIG (observed actual rates), with homeAdvBaseWeight
  // scaling the home target before the three are renormalised to sum to 1.
  const rawHomeTarget = config.avgHomeWinRate * (config.homeAdvBaseWeight || 1.0);
  const drawTarget = config.avgDrawRate;
  const awayTarget = config.avgAwayWinRate;

  const targetSum = rawHomeTarget + drawTarget + awayTarget;
  const targetHome = rawHomeTarget / targetSum;
  const targetDraw = drawTarget / targetSum;
  const targetAway = awayTarget / targetSum;

  // Current GBDT output
  const { home, draw, away } = probs;

  // Blend GBDT output toward league targets
  // blendFactor 0 = pure GBDT, 1 = pure league average
  // Use 0.3 — meaningful correction without overriding the model entirely
  const blendFactor = 0.3;

  const correctedHome = home * (1 - blendFactor) + targetHome * blendFactor;
  const correctedDraw = draw * (1 - blendFactor) + targetDraw * blendFactor;
  const correctedAway = away * (1 - blendFactor) + targetAway * blendFactor;

  // Renormalise to sum to 1
  const total = correctedHome + correctedDraw + correctedAway;

  return {
    home: correctedHome / total,
    draw: correctedDraw / total,
    away: correctedAway / total,
  };
}

// ─── VARIABLE-STRENGTH CORRECTION LAYER (calibration-rules.md rules 13/14) ───
// Replaces applyLeagueBiasCorrection()'s single fixed 30% blend with a scoped
// correction table: each rule applies only within its own (league, pick-type,
// probability-band) scope, with its own direction/strength — "not a fixed 30%
// blend everywhere" per the correction-layer redesign brief. Each rule was fit
// as a Platt-style rescale (sigmoid(A*logit(p)+B)) on a genuine, chronologically
// -anchored TRAIN split.
//
// Superseded 2026-08-19 (Addendum 26 — walk-forward validation): Addendum 25's
// single-holdout original9-away-45-70 rule is REMOVED here, not just flagged —
// 4-block walk-forward testing confirmed it is genuinely unstable (calibration
// overshoots in the same direction every single block, not noise) and its
// pooled ROI stays negative-leaning even after correction. League One/Two are
// UPDATED to their most-recent-block (train-to-2025-08) fit — walk-forward
// confirmed League Two specifically as stable across all 4 blocks and clearing
// rule 6's floor on the pooled read; League One improved but stayed mixed (one
// of four blocks showed a real ROI regression). See
// docs/tier-calibration-analysis.md Addendum 26 for the full per-block writeup.
//
// DORMANT: not called from scoreOneFixture() (live) or scoreFixtureFromPool()/
// computeMatchedEdgeFixtures() (historical) — calibration-rules.md rule 3 (no
// re-peeking) plus the correction-layer brief's own instruction ("do not
// deploy the new correction live yet") means this exists for review and future
// wiring, not active use. Deploying it is its own separate, deliberate
// decision once the result is judged trustworthy enough to act on — true even
// for League Two, whose walk-forward read is the strongest evidence produced
// so far but still hasn't been deployed.
const CORRECTION_LAYER_RULES = [
  {
    id: 'league-one-50plus',
    leagues: [41],
    pickTypes: ['home', 'away'],
    bandMin: 0.50, bandMax: 1.0,
    A: 0.9567, B: -0.2086,
    fitTrainN: 1121,
    historicalSource: 'correction-layer-backtest-walkforward',
  },
  {
    id: 'league-two-50plus',
    leagues: [42],
    pickTypes: ['home', 'away'],
    bandMin: 0.50, bandMax: 1.0,
    A: 0.5508, B: -0.2488,
    fitTrainN: 954,
    historicalSource: 'correction-layer-backtest-walkforward',
  },
];

function plattTransform(p, A, B) {
  const clamped = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  const logit = Math.log(clamped / (1 - clamped));
  const z = A * logit + B;
  if (z < -35) return 1e-15;
  if (z > 35) return 1 - 1e-15;
  return 1 / (1 + Math.exp(-z));
}

// Applies the scoped correction table to a model's raw (pre-blend) probs.
// Picks the top outcome first (same order live scoring already uses), then
// rescales only that outcome's probability if a rule matches its (league,
// pick-type, band) scope, renormalising the other two to keep the sum at 1.
// Falls through unchanged when no rule matches — most (league, pick, band)
// combinations have zero evidenced correction, by design (rule 4: no
// correction without a football-justified, measured reason).
function applyVariableCorrectionLayer(rawProbs, leagueId, rules = CORRECTION_LAYER_RULES) {
  const lid = parseInt(leagueId, 10);
  const topOutcome = rawProbs.home >= rawProbs.draw && rawProbs.home >= rawProbs.away
    ? 'home' : (rawProbs.away >= rawProbs.draw ? 'away' : 'draw');
  const p = rawProbs[topOutcome];

  const rule = rules.find(r =>
    r.leagues.includes(lid) && r.pickTypes.includes(topOutcome) && p >= r.bandMin && p < r.bandMax
  );
  if (!rule) return { ...rawProbs };

  const newP = plattTransform(p, rule.A, rule.B);
  const others = ['home', 'draw', 'away'].filter(o => o !== topOutcome);
  const otherSum = rawProbs[others[0]] + rawProbs[others[1]];
  const remaining = Math.max(0, 1 - newP);
  const out = { [topOutcome]: newP };
  for (const o of others) {
    out[o] = otherSum > 0 ? remaining * (rawProbs[o] / otherSum) : remaining / 2;
  }
  return out;
}

// ─── KELLY CRITERION ─────────────────────────────────────────────────────────

function kelly(prob, odds, fraction = 0.5, bankroll = 1000) {
  const b = odds - 1;
  const k = (b * prob - (1 - prob)) / b;
  const fracK = Math.max(0, k * fraction);
  return { fullKelly: k, fracKelly: fracK, stake: parseFloat((fracK * bankroll).toFixed(2)) };
}

// ─── UNIFIED MARKET EDGE (Track A — historical/live edge unification) ─────────
// The live path (scoreOneFixture) and every historical-evidence read
// (runEvCalibration, tier-performance's League One/Two snapshot, the walk-forward
// proxy) used to compute "edge" three different ways: different probability inputs
// (raw modelProb vs a calFactor-boosted one), different market benchmarks (raw
// Pinnacle closing price vs margin-stripped true probability), and different edge
// units (relative %, (p-q)/q, vs absolute probability-point gap, p-q). This is the
// single source of truth both paths now share, so "edge" means the same thing
// wherever it's computed. applyCalFactor is a genuine parameter, not always true —
// the walk-forward proxy model fits its own fresh Platt calibration per block,
// which already serves the same corrective purpose as calFactor; applying both
// would double-correct a model calFactor was never fit against.

// Data confidence — capped at 1 once a team has >=15 fixtures in its own pool
// (0.70 cap for international, thinner cross-competition comparability). Shared
// so historical reads use the exact same definition scoreOneFixture does, instead
// of a separate approximation.
function computeDataConf(homeFormCount, awayFormCount, context) {
  const confCap = context === 'international' ? 0.70 : 1;
  const homeDataConf = Math.min(homeFormCount / 15, confCap);
  const awayDataConf = Math.min(awayFormCount / 15, confCap);
  return Math.min(homeDataConf, awayDataConf);
}

// Margin-stripped ("true") implied probabilities from raw 3-way Pinnacle odds —
// normalizes so the three implied probabilities sum to 1, removing the
// bookmaker's built-in margin. Same market benchmark scoreOneFixture uses
// (pinnStripped) when a full 3-way Pinnacle price is available.
//
// Bug fixed 2026-08-18: this read rawOdds.home/.away/.draw, but computeUnifiedEdge's
// only two callers (computeMatchedEdgeFixtures in server.js) both pass a closing-odds
// record shaped {homeOdds, drawOdds, awayOdds} — the convention used everywhere else
// in this codebase (co.homeOdds etc.). The mismatch meant every field read undefined,
// so stripped came back {home:NaN, away:NaN, draw:NaN} and edge was NaN for every
// single fixture, silently (JSON serializes NaN as null) since Track A shipped
// 2026-08-14: computeMatchedEdgeFixtures()'s consumers all filter on `edge >= 0.05`,
// so every "positive edge" population was empty app-wide the whole time — confirmed
// via /api/ev-calibration showing positiveEdge:0/roi:null for all 14 leagues, and
// buildUnseenPopulationMatrix() silently falling back to the frozen pre-Track-A
// LEAGUE_TIER_MATRIX snapshot for Carabao Cup/League One/League Two (why those cells
// looked fine — they were never actually the "live-computed replacement" the Track A
// comment describes, just the old numbers hiding an empty live computation behind
// them). settings.paperTradeOnly/paperKellyFraction were NOT affected — the
// auto-management loop in runEvCalibration() already skips `roi === null` leagues, so
// no real-money gating was mutated by this. marginStrippedImplied has no other
// callers, so widening its accepted shape here is safe everywhere it's used.
function marginStrippedImplied(rawOdds) {
  const home = rawOdds.home ?? rawOdds.homeOdds;
  const away = rawOdds.away ?? rawOdds.awayOdds;
  const draw = rawOdds.draw ?? rawOdds.drawOdds;
  const rawImplied = { home: 1 / home, away: 1 / away, draw: 1 / draw };
  const sum = rawImplied.home + rawImplied.away + rawImplied.draw;
  return { home: rawImplied.home / sum, away: rawImplied.away / sum, draw: rawImplied.draw / sum };
}

// The unified edge: calFactor-boosted modelProb (when applicable) minus the
// margin-stripped market probability for the picked outcome — an absolute
// probability-point gap, matching entry.edge in scoreOneFixture exactly (the
// edge value actually stored on every live bet/watching record and shown in the
// UI), not computeSuccessScore's separate internal edge sub-term.
function computeUnifiedEdge(modelProb, rawOdds, topOutcome, { applyCalFactor = true, calFactor = 1.08 } = {}) {
  const calProb = applyCalFactor ? Math.min(0.97, modelProb * calFactor) : modelProb;
  const stripped = marginStrippedImplied(rawOdds);
  const edge = calProb - stripped[topOutcome];
  return { calProb, stripped, edge };
}

// Picks the model's actual favourite by raw probability — the exact selection
// method computeMatchedEdgeFixtures() (server.js) uses to build the backtest
// population the domestic paper-money rule (edge>=18%, modelProb>=45%) was
// validated against. Deliberately NOT successScore (a different, largely
// uncorrelated composite used for display/legacy gating) and deliberately raw
// modelProb, not calibratedProb — using calibratedProb here would silently
// diverge live tier selection from what was actually backtested. `results` is
// scoreOneFixture's 3-candidate array, each with `bet` in {'Home Win','Draw',
// 'Away Win'} and a `modelProb` field.
function pickTopCandidateByProbability(results) {
  const home = results.find(r => r.bet === 'Home Win');
  const draw = results.find(r => r.bet === 'Draw');
  const away = results.find(r => r.bet === 'Away Win');
  if (home.modelProb >= draw.modelProb && home.modelProb >= away.modelProb) return home;
  if (away.modelProb >= draw.modelProb) return away;
  return draw;
}

// ─── SUCCESS SCORE ────────────────────────────────────────────────────────────
// 0-99: win probability (0-35) + value/edge (0-45) + confidence/data (0-19)
// dataConf multiplier suppresses scores when historical data is thin.
// At dataConf=0: multiplier = 0.4, so max raw 59 becomes ~24 (below 40 threshold).

// League-specific edge cap: PL 20%+ edge is real (+18% ROI confirmed).
// All other leagues at 20%+ edge: 0% ROI confirmed — halve the score.
function applyEdgeCap(score, edge, leagueId) {
  if (edge < 0.20) return score;
  if (parseInt(leagueId, 10) === 39) return score; // Premier League: genuine edge
  return Math.round(score * 0.5);
}

// International divergence penalty: large model–market gaps on international fixtures
// are systematically wrong (7/7 WC 2026 large-divergence picks lost). Penalty scales
// with divergence magnitude; below 10pp the model tracks the market reliably.
function applyDivergencePenalty(score, divergence, context) {
  if (context !== 'international') return score;
  if (divergence < 0.10) return score;
  if (divergence < 0.15) return Math.round(score * 0.75); // 10–15pp: −25%
  if (divergence < 0.20) return Math.round(score * 0.50); // 15–20pp: −50%
  return Math.round(score * 0.25);                         // 20pp+:   −75%
}

function computeSuccessScore(modelProb, bookOdds, formFixtureCount = 20, dataConf = 1, pinnacleEdge = null, leagueId = null, context = null) {
  const impliedProb = 1 / bookOdds;
  const edge = modelProb - impliedProb;
  if (edge <= 0) return 0;
  const winComp        = modelProb * 35;
  const valueComp      = Math.min(edge / 0.20, 1) * 45;
  const confidenceComp = Math.min(formFixtureCount / 50, 1) * 19;
  const raw            = Math.min(99, Math.round(winComp + valueComp + confidenceComp));
  const dataMultiplier = 0.4 + (dataConf * 0.6);
  const base           = Math.round(raw * dataMultiplier);
  const edgeVsPinnacle = pinnacleEdge !== null ? pinnacleEdge : edge;
  const capped         = applyEdgeCap(base, edgeVsPinnacle, leagueId);
  return applyDivergencePenalty(capped, edge, context);
}

// ─── FIFA RANKINGS ────────────────────────────────────────────────────────────

const FIFA_RANK_FALLBACK = {
  'Argentina':1,'France':2,'England':3,'Brazil':4,'Belgium':5,
  'Portugal':6,'Spain':7,'Netherlands':8,'Colombia':8,'Italy':9,
  'Germany':10,'Croatia':12,'Morocco':13,'Switzerland':14,'Denmark':14,
  'United States':15,'USA':15,'Mexico':16,'Uruguay':17,'Japan':19,
  'Senegal':18,'Austria':25,'Sweden':28,'Turkey':31,'Algeria':36,
  'Chile':35,'Norway':37,'Czechia':38,'Scotland':40,'Slovenia':42,
  'Slovakia':43,'Romania':46,'Nigeria':47,"Côte d'Ivoire":50,'Ireland':50,
  'Costa Rica':51,'Canada':51,'Finland':52,'Cameroon':53,'Bosnia & Herzegovina':62,
  'Bosnia':62,'Venezuela':58,'Democratic Republic of Congo':59,'Iraq':59,
  'Qatar':66,'Iceland':67,'Honduras':73,'El Salvador':73,'Jordan':87,
  'China PR':91,'China':91,'Peru':93,'Indonesia':130,'Kuwait':145,
  'South Korea':23,'Australia':24,'Ecuador':45,'Ghana':60,'Jamaica':62,
  'Panama':64,'Saudi Arabia':56,'Iran':22,'Ukraine':22,'Poland':26,
  'Wales':29,'Hungary':27,'Serbia':33,'Egypt':36,'Tunisia':30,
  'Bolivia':82,'Paraguay':63,'New Zealand':90,'Palestine':95,'Georgia':74,
  'Tajikistan':105,'Thailand':115,'Vietnam':119,'India':127,'Uzbekistan':70,
};

// Optional extraRankings object checked first, falls back to FIFA_RANK_FALLBACK.
function lookupFIFARank(teamName, extraRankings) {
  if (!teamName) return 55;
  if (extraRankings) {
    const v = extraRankings[teamName];
    if (v) return v;
  }
  const lower = teamName.toLowerCase();
  const key = Object.keys(FIFA_RANK_FALLBACK).find(k =>
    lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower)
  );
  return key ? FIFA_RANK_FALLBACK[key] : 55;
}

// ─── INTERNATIONAL SCORING IMPROVEMENTS ───────────────────────────────────────

// Replaces formScore() for international fixtures.
// Weights results by opponent FIFA ranking so wins vs rank-1 count far more
// than wins vs rank-100; prevents teams with good records vs weak opposition
// from being over-rated.
function internationalFormScore(teamId, historicalPool, extraRankings) {
  const INTL_IDS = new Set([1, 4, 5, 6, 7, 8, 9, 10, 31, 32, 33, 34, 35, 960]);
  const intlFixtures = historicalPool
    .filter(f =>
      INTL_IDS.has(f.league?.id) &&
      (f.teams?.home?.id === teamId || f.teams?.away?.id === teamId) &&
      f.fixture?.status?.short === 'FT'
    )
    .sort((a, b) => new Date(b.fixture?.date) - new Date(a.fixture?.date))
    .slice(0, 10);

  if (intlFixtures.length < 3) return 50;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const fixture of intlFixtures) {
    const isHome = fixture.teams?.home?.id === teamId;
    const opponent = isHome ? fixture.teams?.away : fixture.teams?.home;
    const opponentRank = lookupFIFARank(opponent?.name, extraRankings);
    const opponentQuality = Math.max(0.05, (101 - opponentRank) / 100);

    const homeGoals = fixture.goals?.home ?? 0;
    const awayGoals = fixture.goals?.away ?? 0;
    const won  = isHome ? homeGoals > awayGoals : awayGoals > homeGoals;
    const drew = homeGoals === awayGoals;
    const points = won ? 1 : drew ? 0.4 : 0;

    const recencyW = historicalWeight(fixture.fixture?.date);
    const w = opponentQuality * recencyW;
    weightedSum += points * w;
    totalWeight += w;
  }

  const rate = totalWeight > 0 ? weightedSum / totalWeight : 0.5;
  return Math.round(rate * 100);
}

// Replaces standingsScore() for international fixtures.
// Three-component composite: FIFA ranking (40%), tournament seeding (25%),
// opponent-quality-adjusted standing (35% — proxied by FIFA score until live
// tournament data accumulates).
function internationalQualityScore(teamName, tournamentSeedings, extraRankings) {
  const rank      = lookupFIFARank(teamName, extraRankings);
  const fifaScore = Math.max(5, Math.round((101 - rank) * 1.0));

  const seed      = tournamentSeedings?.[teamName] ?? 24;
  const seedScore = Math.max(5, Math.round(105 - seed * 2));

  const adjustedStandings = fifaScore; // proxy until live standings accumulate

  return Math.min(100, Math.max(0,
    Math.round(fifaScore * 0.40 + seedScore * 0.25 + adjustedStandings * 0.35)
  ));
}

// ─── GOALS MARKET SCORING (POISSON) ──────────────────────────────────────────

function _factorial(n) {
  if (n <= 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function _poissonProb(lambda, k) {
  return Math.exp(-lambda) * Math.pow(lambda, k) / _factorial(k);
}

// P(total goals > threshold) — threshold is the line, e.g. 2.5
function _overProb(homeXg, awayXg, threshold) {
  const lambda = homeXg + awayXg;
  let cumulative = 0;
  for (let k = 0; k <= Math.floor(threshold); k++) {
    cumulative += _poissonProb(lambda, k);
  }
  return Math.min(0.99, Math.max(0.01, 1 - cumulative));
}

// P(home scores ≥1) * P(away scores ≥1)
function _bttsProb(homeXg, awayXg) {
  return Math.min(0.99, Math.max(0.01, (1 - Math.exp(-homeXg)) * (1 - Math.exp(-awayXg))));
}

// Score goals markets from xG data.
// totalsOddsMap: "HomeTeam|AwayTeam" → { "2.5": { over, under }, "1.5": {...}, "3.5": {...} }
// Returns array of goals candidates (market: "goals") or [] if no xG data.
function scoreGoalsMarkets(homeName, awayName, date, totalsOddsMap, bankroll = 1000, kellyFraction = 0.5, homeF = null, awayF = null, leagueConfig = null) {
  const xgEntry = lookupXg(homeName, awayName, date);

  let homeXg, awayXg, xgSource;
  if (xgEntry && xgEntry.home != null && xgEntry.away != null) {
    homeXg = xgEntry.home;
    awayXg = xgEntry.away;
    xgSource = 'statsbomb';
  } else if (homeF && awayF) {
    // Pre-match xG estimate from factor scores when no StatsBomb data available.
    // Uses league avgGoalsPerGame as base, adjusted by each team's xg attack quality
    // and opponent's defensive quality. Clamped to plausible xG ranges.
    const avgGoals  = leagueConfig?.avgGoalsPerGame ?? 2.6;
    const attackAdj = (xg)  => 1 + 0.5 * (xg  - 50) / 50;   // xg=50 → 1.0, xg=100 → 1.5, xg=0 → 0.5
    const defenseAdj = (def) => 1 - 0.35 * (def - 50) / 50;  // def=50 → 1.0, def=100 → 0.65, def=0 → 1.35
    homeXg = Math.max(0.3, Math.min(3.5, avgGoals * 0.54 * attackAdj(homeF.xg ?? 50) * defenseAdj(awayF.defense ?? 50)));
    awayXg = Math.max(0.3, Math.min(3.5, avgGoals * 0.46 * attackAdj(awayF.xg ?? 50) * defenseAdj(homeF.defense ?? 50)));
    xgSource = 'estimated';
  } else {
    return [];
  }
  const key    = `${homeName}|${awayName}`;
  const totals = totalsOddsMap?.[key] || {};

  const overBtts  = _bttsProb(homeXg, awayXg);
  const over25    = _overProb(homeXg, awayXg, 2.5);
  const over15    = _overProb(homeXg, awayXg, 1.5);
  const over35    = _overProb(homeXg, awayXg, 3.5);

  const markets = [
    { bet: 'Over 2.5',  prob: over25,       bookOdds: totals['2.5']?.over   ?? null },
    { bet: 'Under 2.5', prob: 1 - over25,   bookOdds: totals['2.5']?.under  ?? null },
    { bet: 'Over 1.5',  prob: over15,       bookOdds: totals['1.5']?.over   ?? null },
    { bet: 'Under 1.5', prob: 1 - over15,   bookOdds: totals['1.5']?.under  ?? null },
    { bet: 'Over 3.5',  prob: over35,       bookOdds: totals['3.5']?.over   ?? null },
    { bet: 'Under 3.5', prob: 1 - over35,   bookOdds: totals['3.5']?.under  ?? null },
    { bet: 'BTTS Yes',  prob: overBtts,     bookOdds: totals['btts']?.yes   ?? null },
    { bet: 'BTTS No',   prob: 1 - overBtts, bookOdds: totals['btts']?.no    ?? null },
  ];

  const candidates = [];
  for (const m of markets) {
    const impliedProb = m.bookOdds ? 1 / m.bookOdds : null;
    const edge        = impliedProb != null ? m.prob - impliedProb : null;
    const ev          = m.bookOdds  != null ? m.prob * (m.bookOdds - 1) - (1 - m.prob) : null;

    let successScore = null;
    if (m.bookOdds && edge > 0) {
      const winComp   = m.prob * 35;
      const valueComp = Math.min(edge / 0.15, 1) * 45;
      successScore    = Math.min(99, Math.round(winComp + valueComp));
    }

    const k = m.bookOdds ? kelly(m.prob, m.bookOdds, kellyFraction, bankroll) : null;

    candidates.push({
      market:      'goals',
      bet:         m.bet,
      modelProb:   parseFloat(m.prob.toFixed(4)),
      bookOdds:    m.bookOdds,
      impliedProb: impliedProb != null ? parseFloat(impliedProb.toFixed(4)) : null,
      edge:        edge != null ? parseFloat(edge.toFixed(4)) : null,
      ev:          ev   != null ? parseFloat(ev.toFixed(4))   : null,
      successScore,
      kelly:       k,
      homeXg:      parseFloat(homeXg.toFixed(3)),
      awayXg:      parseFloat(awayXg.toFixed(3)),
      totalXg:     parseFloat((homeXg + awayXg).toFixed(3)),
      xgSource,
    });
  }

  return candidates;
}

// ─── SUPPORTING UTILITIES ─────────────────────────────────────────────────────

// Recency decay brackets for historical weight training
function historicalWeight(fixtureDate) {
  const ageMs     = Date.now() - new Date(fixtureDate).getTime();
  const ageMonths = ageMs / (1000 * 60 * 60 * 24 * 30.5);
  if (ageMonths <= 6)  return 1.0;
  if (ageMonths <= 18) return 0.7;
  if (ageMonths <= 36) return 0.4;
  return 0.15;
}

function weatherModifier(w) {
  if (!w) return 100;
  let score = 100;
  if ((w.precipProb ?? 0) > 70) score -= 15;
  else if ((w.precipProb ?? 0) > 40) score -= 8;
  if ((w.windSpeed ?? 0) > 40) score -= 12;
  else if ((w.windSpeed ?? 0) > 25) score -= 6;
  return Math.max(60, score);
}

module.exports = {
  classifyFixture,
  WEIGHTS_BY_CONTEXT,
  CONTEXT_CONFIG,
  LEAGUE_CONFIG,
  DEFAULT_WEIGHTS,
  CUP_LEAGUE_IDS_FOR_DOMESTIC_BLEND, DOMESTIC_LEAGUE_IDS_FOR_BLEND, UEFA_SINGLE_PHASE_SEASON_FLOOR,
  TOURNAMENT_LEAGUE_IDS,
  EURO_COMPETITION_PHASE_GAMES_FLOOR,
  recencyAvg, outcomePoints,
  formScore, homeAdvScore, xgScore, defenseScore,
  momentumScore, h2hScore, standingsScore, injuryScore,
  rankToProxyScore, lookupStandingScore, lastSeasonStandingScore,
  stalenessMultiplier, applyStalenessPull,
  internationalFormScore, internationalQualityScore,
  lookupFIFARank, FIFA_RANK_FALLBACK,
  computeModelProb, applyLeagueBiasCorrection, computeXGProxy, classifyCompetitionPhase,
  CORRECTION_LAYER_RULES, applyVariableCorrectionLayer,
  kelly, computeSuccessScore,
  computeDataConf, marginStrippedImplied, computeUnifiedEdge, pickTopCandidateByProbability,
  historicalWeight, weatherModifier,
  reloadXgStore, getXgStore, lookupXg,
  scoreGoalsMarkets,
};
