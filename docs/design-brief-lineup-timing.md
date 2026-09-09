# Design brief J — Lineup-timing redesign for a single, lineup-aware lock (2026-09-09)

Status: **design only**. The build waits on item L, which is the only way to
price the central trade-off (what a later lock costs against Pinnacle's line).
No live timing changes from this document.

## 1. Facts this is built on

- API-Sports publishes confirmed lineups at about T-28 minutes, consistently
  across all 13 competitions we score (Addendum 44). The lock runs at
  T-45..T-75, so 0 of 287 club locks checked had a lineup. WOWY, the only
  lineup-consuming modifier, has been a no-op on every club bet.
- Item K is complete: the post-match lineups pool now covers Championship,
  League One and League Two (15,115 fixtures on disk, every sampled EFL team
  with WOWY player records), so WOWY has deltas to apply in the one staked
  league once lineups reach it.
- The two-stage patch (lock early, adjust later) was rejected: it produced two
  probabilities per bet with no single validated quantity. The requirement is
  one lock that already incorporates lineups.
- The 0.93 calibration factor and the 13%/45% rule were validated on
  pre-lineup probabilities. A lineup-adjusted probability is a different
  quantity and needs its own validation (calibration-rules.md rule 13), not a
  re-use of the existing factor.

## 2. The trade-off L has to price

Moving the single lock from ~T-60 to ~T-25 changes the market we face. Two
opposite effects, both measurable from L's per-bet `pinnacleOddsAtLock` vs
Pinnacle closing:

- If our edge lives in *pre-lineup* information, Pinnacle's T-25 line has
  already absorbed the lineup news and part of our edge with it; the later
  lock loses closing-line value.
- If our edge is *created* by lineups, locking before them is guessing; the
  later lock gains.

L answers this directly: for locked bets, the drift between lock price and
closing price, split by lock time and by whether the bet cleared the staked
rule. If the average drift from T-60 to close is small in the staked pocket,
the later lock is cheap. If it is large and against us, lineups have to earn
more than that drift to justify the move. Until L reports, the number is
unknown and this brief does not assume it.

A third cost is operational: the user places every bet by hand, and a T-25
lock leaves roughly twenty minutes to do so. That is the user's call; the
design below keeps the pre-lineup lock as a fallback so nothing is missed if
the window is too short on a given day.

## 3. Proposed design (to be validated, not assumed)

**Single lock, lineup-aware, per competition type.**
- Club fixtures: the T-60 pass becomes a *watch* pass that scores and stores
  the pre-lineup probability (already the "watching stage" record) but does
  not lock. The lock pass runs at T-25, tries the lineups endpoint (one call;
  retried at T-22 if absent), and scores once with whatever it has. The bet
  record carries `lineupsAtLock: true|false`, the WOWY adjustment applied
  (`lineupAdjustment`, signed), and both the pre-lineup watching probability
  and the locked probability, so the paired effect of lineups is measurable
  on every bet without a second lock.
- International fixtures: unchanged (no WOWY data by design).
- Fallback: if the T-25 pass cannot run (rate limit, outage), the T-60
  watching score becomes the lock at T-25 with `lineupsAtLock:false`, so the
  timing is single either way.

**Observation before stakes.** For the first pre-registered window, the
lineup adjustment is *recorded but not applied* to the probability that
drives the staked rule: the rule fires on the pre-lineup probability exactly
as today, and the adjusted probability is stored beside it. That gives a
paired test on identical bets: adjusted vs unadjusted log-loss and beyond-
market residual, with the sample size stated up front (target n = 300 club
locks, about six weeks at current volume). Only if the adjusted probability
is better on that paired test does it take over the rule, and then with its
own calibration factor fitted train-only under rule 13.

**Modifier equivalence.** Any change to how WOWY enters the probability
touches the modifier stage of `scoreProbabilities`. It must land after the
shared scorer's cutover (H), so there is one place to change and the shadow
diff is not disturbed while it runs.

## 4. Measurement plan and rollback

- Pre-registered before the first T-25 lock: the paired test above, the
  closing-line drift comparison (T-60 vs T-25 lock, from L), and the share of
  club locks that actually had lineups (expect > 90% given T-28 publication).
- Rollback: a settings flag `lockPass: 'T-60' | 'T-25'` with the T-60 pass as
  default until the paired test reports; flipping it back restores today's
  behaviour with no data loss because the watching-stage record is kept in
  both modes.

## 5. Dependencies

1. **L** — prices the trade-off; without it the decision is a guess.
2. **H cutover** — modifier change lands in one place.
3. **K** — done.
4. User decision on the operational window once L's number is in.

Tagging: the timing itself is a **pipeline** item (data arrives after we
lock). Whether lineups carry signal beyond the market is a **model** question
the paired test answers; it is untested today and this brief does not assume
the answer.
