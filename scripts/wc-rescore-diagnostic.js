/**
 * WC rescore diagnostic — validates four international model adjustments.
 *
 * Usage:  node scripts/wc-rescore-diagnostic.js
 *
 * Adjustments validated:
 *   1 — international dataConf capped at 0.70 (anchor always ≥30% weight)
 *   2 — rankScale raised to 0.018 (in scoring.js CONTEXT_CONFIG)
 *   3 — neutral venue base probs 0.34/0.34 (was 0.38/0.38)
 *   4 — host nation +8pp boost (USA/Canada/Mexico at WC 2026)
 *
 * Reads local data files only. No external API calls.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch { return null; }
}

const {
  formScore, homeAdvScore, xgScore, defenseScore, momentumScore,
  classifyFixture, classifyCompetitionPhase,
  WEIGHTS_BY_CONTEXT, CONTEXT_CONFIG,
  computeModelProb,
} = require('../scoring.js');

// ── Baseline captured 2026-06-22 (pre-rebuild, pre-fix) ──────────────────────
const BEFORE = {
  1489383: { home: 'France',   away: 'Senegal',
             model: { home: 0.5570, draw: 0.1943, away: 0.2487 },
             implied: { home: 0.7143, draw: 0.2222, away: 0.1429 } },
  1489384: { home: 'England',  away: 'Croatia',
             model: { home: 0.5094, draw: 0.1947, away: 0.2959 },
             implied: { home: 0.6061, draw: 0.2778, away: 0.2000 } },
  1489385: { home: 'Ghana',    away: 'Panama',
             model: { home: 0.3400, draw: 0.2500, away: 0.4100 },
             implied: { home: 0.4348, draw: 0.3226, away: 0.3125 } },
  1489391: { home: 'USA',      away: 'Australia',
             model: { home: 0.3955, draw: 0.2439, away: 0.3607 },
             implied: { home: 0.6369, draw: 0.2222, away: 0.2105 } },
  1489390: { home: 'Scotland', away: 'Morocco',
             model: { home: 0.0771, draw: 0.2270, away: 0.6959 },
             implied: { home: 0.1852, draw: 0.2667, away: 0.5952 } },
};

// ── FIFA ranks and quality (mirrors server.js) ────────────────────────────────
const FIFA_RANKS = {
  'Argentina':1,'France':2,'England':3,'Brazil':4,'Belgium':5,
  'Portugal':6,'Spain':7,'Netherlands':8,'Colombia':8,'Italy':9,
  'Germany':10,'Croatia':12,'Morocco':13,'Switzerland':14,'Denmark':14,
  'United States':15,'USA':15,'Mexico':16,'Uruguay':17,'Japan':19,
  'Senegal':18,'Austria':25,'Sweden':28,'Turkey':31,'Algeria':36,
  'Chile':35,'Norway':37,'Czechia':38,'Scotland':40,'Slovenia':42,
  'Slovakia':43,'Romania':46,'Nigeria':47,'South Korea':23,'Australia':24,
  'Ecuador':45,'Ghana':60,'Jamaica':62,'Panama':64,'Saudi Arabia':56,
  'Iran':22,'Ukraine':22,'Poland':26,'Wales':29,'Hungary':27,'Serbia':33,
};
function lookupFIFARank(name) {
  if (!name) return 55;
  const key = Object.keys(FIFA_RANKS).find(k =>
    name.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(name.toLowerCase())
  );
  return key ? FIFA_RANKS[key] : 55;
}
function rankToQuality(r) { return Math.max(5, Math.min(100, Math.round(105 - r))); }

const INTERNATIONAL_LEAGUE_IDS = new Set([1, 4, 5, 6, 7, 8, 9, 10, 32, 33, 34, 31, 960]);
// Adjustment 4: WC 2026 host nation team IDs
const HOST_NATIONS_2026 = new Set([2384, 5529, 16]); // USA, Canada, Mexico

function main() {
  console.log('\n=== WC Rescore Diagnostic (Adjustments 1-4) ===');
  console.log('DATA_DIR:', DATA_DIR);

  const hist     = readJSON('backfill-historical.json');
  const stats    = readJSON('fixture-stats.json') || {};
  const settings = readJSON('settings.json') || {};

  if (!hist?.fixtures?.length) {
    console.error('\nERROR: backfill-historical.json is empty — run historical backfill first.');
    process.exit(1);
  }

  const intlPool = hist.fixtures.filter(f =>
    INTERNATIONAL_LEAGUE_IDS.has(f.league?.id) && f.fixture?.status?.short === 'FT'
  );
  console.log(`Historical pool: ${hist.fixtures.length}  International pool: ${intlPool.length}`);

  // Build team-name → id index from all historical data
  const teamIndex = {};
  for (const f of hist.fixtures) {
    if (f.teams?.home?.id) teamIndex[f.teams.home.name?.toLowerCase()] = { id: f.teams.home.id, name: f.teams.home.name };
    if (f.teams?.away?.id) teamIndex[f.teams.away.name?.toLowerCase()] = { id: f.teams.away.id, name: f.teams.away.name };
  }

  const d  = settings.decay      || 0.05;
  const fw = settings.formWindow  || 6;
  const calibration = settings.calibrationFactor || 1.11;
  const cfg = CONTEXT_CONFIG.international;
  const weights = settings.optimisedWeights?.international || WEIGHTS_BY_CONTEXT.international;

  console.log(`\nSettings: rankScale=${cfg.rankScale} calibration=${calibration}`);
  console.log('─'.repeat(72));

  const summary = [];

  for (const [fidStr, b] of Object.entries(BEFORE)) {
    // Resolve team IDs
    const homeEntry = teamIndex[b.home.toLowerCase()] ||
      Object.values(teamIndex).find(e => e.name?.toLowerCase().includes(b.home.toLowerCase()));
    const awayEntry = teamIndex[b.away.toLowerCase()] ||
      Object.values(teamIndex).find(e => e.name?.toLowerCase().includes(b.away.toLowerCase()));

    const homeId = homeEntry?.id ?? null;
    const awayId = awayEntry?.id ?? null;

    // Synthetic fixture for competitionPhase detection
    const fix = {
      fixture: { id: Number(fidStr) },
      league:  { id: 1, round: 'Group Stage - 1' },
      teams:   { home: { id: homeId, name: b.home }, away: { id: awayId, name: b.away } },
    };
    const competitionPhase = classifyCompetitionPhase(fix, 1);

    if (!homeId || !awayId) {
      console.log(`\n${b.home} vs ${b.away}: team IDs not resolved — skipping`);
      continue;
    }

    const homeFormCount = intlPool.filter(f => f.teams?.home?.id === homeId || f.teams?.away?.id === homeId).length;
    const awayFormCount = intlPool.filter(f => f.teams?.home?.id === awayId || f.teams?.away?.id === awayId).length;

    // Adjustment 1: cap at 0.70
    const homeDataConf = Math.min(homeFormCount / 15, 0.70);
    const awayDataConf = Math.min(awayFormCount / 15, 0.70);
    const dataConf     = Math.min(homeDataConf, awayDataConf);

    const homeF = {
      form:      formScore(intlPool, homeId, fw, d),
      homeAdv:   homeAdvScore(intlPool, homeId, d),
      xg:        xgScore(intlPool, homeId, stats, d),
      h2h:       50,
      defense:   defenseScore(intlPool, homeId, d),
      momentum:  momentumScore(intlPool, homeId),
      injuries:  50,
      standings: 50,
    };
    const awayF = {
      form:      formScore(intlPool, awayId, fw, d),
      homeAdv:   50,
      xg:        xgScore(intlPool, awayId, stats, d),
      h2h:       50,
      defense:   defenseScore(intlPool, awayId, d),
      momentum:  momentumScore(intlPool, awayId),
      injuries:  50,
      standings: 50,
    };

    let probs = computeModelProb(homeF, awayF, weights, 'international');

    // Ranking anchor (Adjustments 2 + 3)
    if (cfg.rankScale > 0 && dataConf < 1) {
      const rankDiff = rankToQuality(lookupFIFARank(b.home)) - rankToQuality(lookupFIFARank(b.away));
      const neutralVenue = competitionPhase === 'group_stage' || competitionPhase === 'knockout';
      // Adjustment 3: 0.34/0.34 neutral base
      const anchorH = neutralVenue ? 0.34 : cfg.homeBase;
      const anchorA = neutralVenue ? 0.34 : cfg.awayBase;
      const rH = Math.max(0.05, Math.min(0.85, anchorH + rankDiff * cfg.rankScale));
      const rA = Math.max(0.05, Math.min(0.85, anchorA - rankDiff * cfg.rankScale));
      const rD = Math.max(0.05, 1 - rH - rA);
      const sum = rH + rD + rA;
      const rankAdj = { home: rH/sum, draw: rD/sum, away: rA/sum };
      probs = {
        home: dataConf * probs.home + (1 - dataConf) * rankAdj.home,
        draw: dataConf * probs.draw + (1 - dataConf) * rankAdj.draw,
        away: dataConf * probs.away + (1 - dataConf) * rankAdj.away,
      };
    }

    // Adjustment 4: host nation boost
    const homeIsHost = HOST_NATIONS_2026.has(homeId);
    const awayIsHost = HOST_NATIONS_2026.has(awayId);
    const hostApplied = (homeIsHost || awayIsHost) &&
      (competitionPhase === 'group_stage' || competitionPhase === 'knockout');
    if (hostApplied) {
      const BOOST = 0.08;
      if (homeIsHost) {
        const take = BOOST * 0.6;
        probs = { home: Math.min(0.90, probs.home + BOOST), draw: Math.max(0.03, probs.draw - take), away: Math.max(0.03, probs.away - (BOOST - take)) };
      } else {
        const take = BOOST * 0.6;
        probs = { home: Math.max(0.03, probs.home - (BOOST - take)), draw: Math.max(0.03, probs.draw - take), away: Math.min(0.90, probs.away + BOOST) };
      }
      const bSum = probs.home + probs.draw + probs.away;
      probs = { home: probs.home/bSum, draw: probs.draw/bSum, away: probs.away/bSum };
    }

    // Calibration
    const calH = Math.min(0.90, probs.home * calibration);
    const calD = probs.draw;
    const calA = Math.min(0.90, probs.away * calibration);
    const calSum = calH + calD + calA;
    const cal = { home: calH/calSum, draw: calD/calSum, away: calA/calSum };

    const gapBefore = b.implied.home - b.model.home;
    const gapAfter  = b.implied.home - cal.home;

    console.log(`\n${b.home} vs ${b.away}  [${competitionPhase}${hostApplied ? ' +host' : ''}]`);
    console.log(`  dataConf: home=${homeDataConf.toFixed(2)} (${homeFormCount} intl fixtures)  away=${awayDataConf.toFixed(2)} (${awayFormCount} intl fixtures)  combined=${dataConf.toFixed(2)}`);
    console.log(`  Form  home: form=${homeF.form} xg=${homeF.xg} def=${homeF.defense} mom=${homeF.momentum}`);
    console.log(`        away: form=${awayF.form} xg=${awayF.xg} def=${awayF.defense} mom=${awayF.momentum}`);
    console.log(`  ┌──────────────┬──────────┬──────────┬──────────┐`);
    console.log(`  │              │   Home   │   Draw   │   Away   │`);
    console.log(`  ├──────────────┼──────────┼──────────┼──────────┤`);
    console.log(`  │ Implied      │  ${pct(b.implied.home)}  │  ${pct(b.implied.draw)}  │  ${pct(b.implied.away)}  │`);
    console.log(`  │ Before fixes │  ${pct(b.model.home)}  │  ${pct(b.model.draw)}  │  ${pct(b.model.away)}  │`);
    console.log(`  │ After fixes  │  ${pct(cal.home)}  │  ${pct(cal.draw)}  │  ${pct(cal.away)}  │`);
    console.log(`  ├──────────────┼──────────┼──────────┼──────────┤`);
    console.log(`  │ Home gap Δ   │  ${pp(gapBefore)} → ${pp(gapAfter)}  │          │          │`);
    console.log(`  └──────────────┴──────────┴──────────┴──────────┘`);

    summary.push({ label: `${b.home} vs ${b.away}`, gapBefore, gapAfter, dataConf, hostApplied });
  }

  const avgBefore = summary.reduce((s, r) => s + Math.abs(r.gapBefore), 0) / summary.length;
  const avgAfter  = summary.reduce((s, r) => s + Math.abs(r.gapAfter),  0) / summary.length;

  console.log('\n' + '═'.repeat(72));
  console.log('SUMMARY');
  console.log('─'.repeat(72));
  for (const r of summary) {
    const dir = Math.abs(r.gapAfter) < Math.abs(r.gapBefore) ? '✓' : '✗';
    console.log(`  ${dir}  ${r.label.padEnd(26)} ${pp(r.gapBefore)} → ${pp(r.gapAfter)}${r.hostApplied ? ' (host boost)' : ''}`);
  }
  console.log('─'.repeat(72));
  console.log(`  Average |gap| BEFORE: ${(avgBefore*100).toFixed(1)}pp`);
  console.log(`  Average |gap| AFTER:  ${(avgAfter*100).toFixed(1)}pp`);
  console.log(`  Improvement:          ${((avgBefore-avgAfter)*100).toFixed(1)}pp`);
  if (avgAfter <= 0.10) {
    console.log('\n  ✓ TARGET MET — average gap ≤10pp. Ready for review.');
  } else {
    console.log(`\n  ✗ Average gap still ${(avgAfter*100).toFixed(1)}pp — further tuning needed.`);
  }
  console.log('');
}

function pct(v) { return v == null ? ' n/a' : (v * 100).toFixed(1).padStart(4) + '%'; }
function pp(v)  { return (v >= 0 ? '+' : '') + (v * 100).toFixed(1).padStart(5) + 'pp'; }

main();
