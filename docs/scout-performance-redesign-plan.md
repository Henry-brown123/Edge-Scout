# Scout tab and Performance tab redesign — implementation plan (2026-09-17)

Status: plan, awaiting the user's go-ahead to build. Written after Part 1
(pocket registry) landed, because the registry is what the UI keys on.

## What the UI keys on (already in place after commit for Addendum 58)

- `POCKETS` in server.js: id, label, league, rule, priority, from-date. Every
  bet and watching entry carries `pocketId` (null = not a pocket bet).
- `standaloneShadow` on every League Two lock: the standalone model's pick,
  probability, edge and whether it clears its pre-registered candidate cell.
  This is the "League Two V2 (paper)" bucket — confirmed understanding: it is
  the standalone League Two model's shadow scoring, tracked on its own terms,
  separate from the live pooled-chain pocket, so progress toward the cutover
  criterion (`diag-standalone-forward`) is visible. It never stakes.
- Existing real-money edit flow: `placementStatus`, `placementConfirmed`,
  `bookmakerUsed`, `actualOdds`, `actualStake`, `placedAt`.

## 1. Colour system (three states, two persistent, one transient)

State is derived, never stored as a colour:

| State | Derivation | Colour |
|---|---|---|
| Real, confirmed | `pocketId != null && placementConfirmed` | green |
| Awaiting confirmation (transient) | `pocketId != null && !placementConfirmed && !result && kickoff > now − 2h` | orange |
| Paper | everything else, including a pocket lock whose confirmation window passed | blue |

An orange card that is never confirmed reverts to blue on its own when the
window closes (resolution or 2 hours after kickoff). No stored "not placed"
state; the bet stays in the paper log exactly as today.

Server: one helper `betDisplayState(bet)` exposed on `/api/state` and
`/api/bets` rows as `displayState`; the client renders from it. Removes the
current ad-hoc `real-money` / `paper-trade` / `paper-money-hit` class logic.

## 2. Buckets

A `BUCKETS` list derived from `POCKETS` plus one shadow bucket:

- `l2-9-40` League Two 9%/40% (real)
- `l1-12-50` League One 12%/50% year-round (real)
- `l1-jan-may-5-45` League One Jan–May 5%/45% (real)
- `l2-v2-paper` **League Two V2 (paper)** — membership: League Two locks whose
  `standaloneShadow.clearsCell` is true; result and PnL computed from the
  standalone's own pick at the closing/soft price, stored beside the live
  bet's; never staked; progress line = the cutover criterion's current
  reading (matched forward fixtures, paired residual vs pooled).

Server route `GET /api/buckets`: per bucket n, resolved, wins, PnL at real
stake (green only), paper PnL (all members), beyond-market residual with SE,
closing ROI, last 10, and the bucket's rule text and start date.

## 3. Visibility filter

- Scout tab: cards grouped under the four buckets; every other league's
  watching/lock cards go under one collapsed "Other (paper, background)"
  group. Nothing is removed from the data.
- Performance tab: the real-money results tables show only the four
  buckets. The existing cohort tables, H/L/X grid rows and source markers
  move behind a "Research" toggle (off by default) rather than being
  deleted, since the calibration and reserved-set work still reads them.
- Overall paper bet log and paper bankroll are unchanged and still include
  every league.

Verification that hiding has zero effect on data: the filter is applied in
the client and in the two new read-only routes only; scanning
(`getActiveLeagues`), locking, resolution, closing-odds capture, nightly
scoring, training pools and reserved-set counters are untouched. The proof
after build: counts on `/api/bets`, `/api/backfill/historical/status`,
`/api/admin/calibration-factors` reservedTestSets and the weekly-retrain
snapshot before and after, identical.

## 4. Confirmation action

A "Confirm placed" button on orange cards (Scout tab) and orange rows
(Performance bet log) opening the existing real-money edit modal
(stake / odds / bookmaker), which already sets `placementConfirmed`.
No "not placed" action. The button does not appear on blue or green.

## 5. Order of work and size

1. Server: `betDisplayState`, `/api/buckets`, L2 V2 paper PnL on resolution
   (half a day).
2. Client: colour derivation and confirmation button (half a day).
3. Client: bucket grouping on Scout; bucket tables + Research toggle on
   Performance (one day).
4. Verification pass per section 3.

Nothing in this plan changes scoring, staking rules or data collection.
