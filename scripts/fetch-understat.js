'use strict';

/**
 * fetch-understat.js
 *
 * Fetches historical xG data from understat.com for PL, La Liga, Serie A,
 * Bundesliga, and Ligue 1 for seasons 2019–2024.
 *
 * Uses understat's internal AJAX API: GET /getLeagueData/{league}/{season}
 * Requires a valid PHPSESSID cookie (obtained automatically from main page).
 *
 * Usage:
 *   node scripts/fetch-understat.js            # all leagues, all seasons
 *   node scripts/fetch-understat.js --dry-run  # print counts only, no write
 *   DATA_DIR=/data node scripts/fetch-understat.js
 *
 * Output: data/xg-data.json (merged — existing entries are never overwritten)
 *         data/team-name-map.json (created on first run if absent)
 */

const https    = require('https');
const zlib     = require('zlib');
const fs       = require('fs');
const path     = require('path');

const DATA_DIR     = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const XG_PATH      = path.join(DATA_DIR, 'xg-data.json');
const NAMEMAP_PATH = path.join(DATA_DIR, 'team-name-map.json');
const DRY_RUN      = process.argv.includes('--dry-run');
const DELAY_MS     = 700;

const LEAGUES = [
  { slug: 'EPL',        name: 'Premier League' },
  { slug: 'La_liga',    name: 'La Liga'        },
  { slug: 'Serie_A',    name: 'Serie A'        },
  { slug: 'Bundesliga', name: 'Bundesliga'     },
  { slug: 'Ligue_1',    name: 'Ligue 1'        },
];

const SEASONS = [2019, 2020, 2021, 2022, 2023, 2024];

const BUILTIN_NAME_MAP = {
  // Premier League
  'Wolverhampton Wanderers': 'Wolves',
  'Wolverhampton':           'Wolves',
  'Leeds':                   'Leeds United',
  'Sheffield United':        'Sheffield Utd',
  'West Bromwich Albion':    'West Brom',
  'Newcastle United':        'Newcastle',
  // Serie A
  'Milan':                   'AC Milan',
  // Bundesliga
  'Borussia M.Gladbach':     "Borussia M'gladbach",
  // Ligue 1
  'Paris Saint-Germain':     'PSG',
};

function loadNameMap() {
  let extra = {};
  try { extra = JSON.parse(fs.readFileSync(NAMEMAP_PATH, 'utf8')); } catch {}
  return { ...BUILTIN_NAME_MAP, ...extra };
}

function normaliseName(raw, nameMap) {
  return nameMap[raw] || raw;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
const BASE_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Encoding': 'gzip, deflate',
  'Accept-Language': 'en-GB,en;q=0.9',
};

function fetchRaw(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { ...BASE_HEADERS, ...extraHeaders } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchRaw(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip')   stream = res.pipe(zlib.createGunzip());
      if (res.headers['content-encoding'] === 'deflate') stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data',  c => chunks.push(c));
      stream.on('end',   () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getSessionCookie() {
  const r = await fetchRaw('https://understat.com/', { Accept: 'text/html' });
  const cookies = (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  if (!cookies) throw new Error('No session cookie returned from understat.com');
  return cookies;
}

async function fetchLeagueData(league, season, cookie) {
  const url = `https://understat.com/getLeagueData/${league}/${season}`;
  const r = await fetchRaw(url, {
    Accept:            'application/json, text/javascript, */*; q=0.01',
    Referer:           `https://understat.com/league/${league}/${season}`,
    Cookie:            cookie,
    'X-Requested-With': 'XMLHttpRequest',
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return JSON.parse(r.body);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let store = {};
  try { store = JSON.parse(fs.readFileSync(XG_PATH, 'utf8')); } catch {}
  const before = Object.keys(store).length;
  console.log(`Existing xg-data.json: ${before} entries`);

  const nameMap = loadNameMap();

  process.stdout.write('Obtaining understat session cookie... ');
  const cookie = await getSessionCookie();
  console.log('OK');

  let added = 0, skipped = 0, errors = 0;

  for (const { slug, name } of LEAGUES) {
    for (const season of SEASONS) {
      process.stdout.write(`  ${name} ${season}/${season + 1}... `);

      let data;
      try {
        data = await fetchLeagueData(slug, season, cookie);
      } catch (e) {
        console.log(`ERROR: ${e.message}`);
        errors++;
        await sleep(DELAY_MS * 3);
        continue;
      }

      const allFixtures = Object.values(data.dates || {}).flat();
      let seasonAdded = 0;

      for (const fix of allFixtures) {
        if (!fix.isResult) continue;
        if (!fix.xG?.h || !fix.xG?.a) continue;

        const homeXg = parseFloat(fix.xG.h);
        const awayXg = parseFloat(fix.xG.a);
        if (isNaN(homeXg) || isNaN(awayXg)) continue;

        const home    = normaliseName(fix.h?.title || '', nameMap);
        const away    = normaliseName(fix.a?.title || '', nameMap);
        const dateStr = (fix.datetime || '').slice(0, 10);
        if (!home || !away || !dateStr) continue;

        const key = `${home}|${away}|${dateStr}`;
        if (store[key]) { skipped++; continue; }

        store[key] = { home: homeXg, away: awayXg, source: 'understat', fixtureId: fix.id };
        seasonAdded++;
        added++;
      }

      console.log(`${allFixtures.length} fixtures → +${seasonAdded} new`);
      await sleep(DELAY_MS);
    }
  }

  console.log(`\nSummary: ${added} added, ${skipped} already present, ${errors} errors`);
  console.log(`Total: ${Object.keys(store).length} entries (was ${before})`);

  const bySrc = {};
  for (const v of Object.values(store)) bySrc[v.source || 'unknown'] = (bySrc[v.source || 'unknown'] || 0) + 1;
  console.log('By source:', bySrc);

  if (!DRY_RUN) {
    fs.writeFileSync(XG_PATH, JSON.stringify(store, null, 2));
    console.log(`Written → ${XG_PATH}`);

    if (!fs.existsSync(NAMEMAP_PATH)) {
      fs.writeFileSync(NAMEMAP_PATH, JSON.stringify(BUILTIN_NAME_MAP, null, 2));
      console.log(`Written → ${NAMEMAP_PATH}`);
    }
  } else {
    console.log('[dry-run] No files written');
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
