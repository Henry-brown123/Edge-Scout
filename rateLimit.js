'use strict';

let _limited = false;
let _clearsAt = null;
let _clearTimer = null;

function setRateLimited() {
  if (_limited) return;
  _limited = true;
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  _clearsAt = midnight;
  const msUntilMidnight = midnight - now;
  console.warn(`[RateLimit] Daily quota reached — resuming at ${midnight.toISOString()}`);
  if (_clearTimer) clearTimeout(_clearTimer);
  _clearTimer = setTimeout(() => {
    _limited = false;
    _clearsAt = null;
    console.log('[RateLimit] Quota reset — API calls resuming');
  }, msUntilMidnight);
}

function isRateLimited() { return _limited; }

function getRateLimitState() {
  return { limited: _limited, clearsAt: _clearsAt ? _clearsAt.toISOString() : null };
}

// Returns true at/after 05:00 UTC — hard stop reserving quota for live operations (scan, T-60, resolution)
function backfillCutoffReached() {
  return new Date().getUTCHours() >= 5;
}

module.exports = { setRateLimited, isRateLimited, getRateLimitState, backfillCutoffReached };
