# Real-Money Strategy Proposal — Pillar 2

Written overnight, autonomously, as the primary output of the CLV/tournament-football/strategy
review task (see [`tier-calibration-analysis.md`](tier-calibration-analysis.md) Addendum 30 for
the CLV clarification and the diagnosis of tonight's Carabao Cup result that this proposal builds
on). This document is a **proposal, not an implementation** — nothing here has been deployed;
every code change it recommends is called out explicitly and none has been made.

Status: no `LEAGUE_CONFIG` values, no real-money gating, no settings defaults, and no live scoring
logic were changed by this document. Auto-retrain gate: last live-confirmed `false` this same
session; nothing here touches the training path.

## 1. The honest starting point

No league, tier, or competition in this entire project has ever produced a real-money ROI reading
whose 95% confidence interval fully excludes zero on the positive side, at a decision-grade sample
size. That is the honest baseline this proposal starts from — there is no hidden slam-dunk being
overlooked. The question this document actually answers is narrower and more useful: **of
everything tested, what comes closest, by how much, and is it close enough to bet modest real money
on while continuing to gather evidence?**

## 2. What actually has decision-grade evidence (full inventory in Addendum 30's companion research)

**Closest to confirmed, ranked:**

1. **League Two's home+away 50%+ correction layer, walk-forward-validated (Addendum 26).** The
   single strongest evidence this project has ever produced, in its own words: *"the strongest
   read this project's correction-layer work has produced."* Calibration moves from −8.6pp to
   +0.5pp across **every one of 4 independent walk-forward blocks** (never regresses in any
   block); ROI improves in every block; pooled posEdgeN=355 clears the rule-6 decision floor;
   corrected ROI **+14.8%, CI (−0.2%, +29.8%)** — nearly, not fully, excludes zero. **Built,
   committed, currently not called from any live path** (`applyVariableCorrectionLayer()` in
   `scoring.js` exists but nothing invokes it in `scoreOneFixture`).

2. **The 40-45% tier avoid signal, 9 leagues, test-only (Addendum 5/6/12).** The other
   decision-grade, statistically confirmed finding in the whole project — n=430, ROI **−21.5%**,
   95% CI **[−34.4%, −8.6%]**, confirmed negative after shrinkage across all 9 leagues
   independently, reconfirmed on a separate held-out population (Addendum 12). This is an
   *exclusion* rule, not a source of profit, but it is exactly as strong evidence as finding #1 —
   and any strategy that doesn't encode it is knowingly betting into a proven loser.

3. **League Two's home-only subset within its own overall null (Addendum 26/27).** ROI **+8.0%,
   CI (−0.1%, +16.1%)** — the single tightest near-significant positive reading outside the
   correction layer itself. Overlaps substantially with #1's own population.

4. **League One's home+away 50%+ correction layer, walk-forward (Addendum 26).** A real, weaker
   sibling to #1 — "improved but not fully confirmed," pooled posEdgeN=425, corrected ROI **+4.6%,
   CI (−5.5%, +14.6%)** — clears the volume floor, direction is right, but the CI is wider and the
   result is less consistent block-to-block (one block genuinely regressed) than League Two's.

5. **The two currently-cleanest green-flagged cells (Addendum 19/22).** League One 45-50% (n=259,
   ROI +5.7%, CI spans zero but "isn't badly skewed," calibration error negligible) and League Two
   45-50% (n=335, ROI +15.4%, CI nearly clears zero, calibration negligible). Both below the
   decision floor individually, but genuinely the cleanest of the six cells a prior, rigorous
   evidence-reconciliation exercise (Addendum 22) actually ranked.

**Everything else** — the original 9 leagues individually, Champions League/Europa
League/Conference League, every other green-flagged cell (League One 60-65%, League Two 50-55%/
55-60%/65-70%) — is either statistically indistinguishable from zero after shrinkage, too thin to
say anything, or (per Addendum 22's own risk ranking) carries a real, measured overconfidence flag
alongside a flattering point estimate. None of these are proposed for inclusion below.

**Already deployed, working as intended:** the home/away strength multiplier (Addendum 28) —
calibration error moved from +2.5pp to −0.1pp, ROI's CI moved from confidently-negative to
inconclusive. This is a real, evidenced improvement to the *scoring* layer, not itself a
bet-selection rule — it makes every number above slightly more trustworthy than it would otherwise
be, but doesn't change which leagues/tiers clear the bar.

## 3. Broad model-led rule vs. narrow targeted rule — direct comparison, clear recommendation

**The brief asks for a direct recommendation, not a survey of both as equally valid. Recommendation: the narrow, targeted rule (b), not the broad model-led rule (a). This is not a close call.**

A broad rule ("bet wherever the model shows ≥X% confidence and ≥Y% edge, mirroring where paper
trading already bets") would, by construction, include:

- The original 9 leagues individually, **none of which** show a confirmed edge after shrinkage —
  most are "statistically indistinguishable from zero," several (La Liga, Bundesliga, Eredivisie)
  show meaningfully *negative* raw test-set ROI in specific tiers.
- The 40-45% tier, **confirmed negative** at decision-grade volume across all 9 leagues — a broad
  rule that doesn't specifically carve this out is knowingly betting into the single most
  statistically confident *loss* signal this project has ever produced.
- Cup/tournament competitions, which Addendum 30 just found have both weaker statistical evidence
  *and* two independently-confirmed structural scoring gaps (standings fabrication, no
  rotation-awareness) that a broad rule has no way to account for.

Once a broad rule is patched to explicitly carve out the 40-45% tier and cup competitions, it is no
longer meaningfully "broad, mirroring paper trading" — it already requires the same curation the
narrow rule proposes, just arrived at reluctantly rather than by design. The narrow rule starts from
that curation deliberately and adds one further discipline: it only stakes real money where the
*specific* evidence (not "the model generally seems fine") has actually been walk-forward tested,
not just single-look backtested. Given real money is on the table, that's the correct bar, and it's
the same bar rule 6/8 already set for this project everywhere else — this proposal doesn't invent a
new standard, it just applies the existing one consistently to a go-live decision instead of only to
diagnostic write-ups.

## 4. The concrete proposal

**Include, real money, immediately on Phase 1 (see rollout below):**

- **League Two, 50%+ probability band (home and away picks), with `applyVariableCorrectionLayer()`
  deployed and active.** This is evidence item #1 above — the strongest, most rigorously tested
  finding this project has produced. Deploying the correction is not optional here: betting the
  *raw*, pre-correction probabilities in a tier this project already knows is measurably
  miscalibrated (that finding is *why* the correction exists) would leave known, already-quantified
  value on the table, or worse, bet against it.
- **League Two 45-50% (uncorrected)**, the cleanest of the six existing green-flagged cells,
  kept exactly as-is (n=335, ROI +15.4%). Sits just below the correction layer's own tested
  boundary, so it stays a separate, raw-probability bucket rather than being folded into the
  corrected population it wasn't evaluated as part of.
- **League One 45-50% (uncorrected)**, the second existing green-flagged cell worth keeping
  (n=259, ROI +5.7%, cleanest of the six per Addendum 22's own ranking).

**Explicitly exclude, real money, until further dedicated evidence exists:**

- **All cup/tournament competitions** — Carabao Cup, Champions League, Europa League, Conference
  League. Not a reaction to tonight specifically; the evidence for this predates tonight (thinner
  samples across the board, two independently confirmed structural scoring bugs) and tonight's own
  experience only reinforces it. This should be a hard `paperTradeOnly` block, not left to
  individual green-flag discretion — Addendum 30 found tonight's specific cells were flagged
  outside the evidence-reconciliation process Addendum 22 established, at sample sizes (n=16-45)
  thinner than even the weakest cell that process accepted (n=77). The tool worked as designed; the
  standard applied to it tonight didn't match this project's own bar.
- **The 40-45% probability tier, every league, no exceptions.** Confirmed negative at n=430,
  decision-grade. This should be a structural exclusion in the betting logic, not a matter of not
  green-flagging it — a future paper-trading run or an unreviewed model update could otherwise
  silently start recommending into it again.
- **League One's remaining four green-flagged cells beyond 45-50%** (60-65%) and **League Two's
  three beyond 45-50%/50-55%+corrected** (55-60%, 65-70%) — Addendum 22's own ranking already
  flagged these with real, measured overconfidence and thin samples ("weakest-evidenced," "treat
  with real caution"). Recommend un-flagging these specifically (a green-flags.json edit, not a
  code change) pending a fresh look, rather than leaving them live alongside the stronger cells
  above with no visible distinction in risk.
- **The original 9 leagues**, individually, for now. None shows a confirmed edge; several show
  clearly negative results in specific tiers. Nothing in this task's evidence review found a reason
  to add any of them to real-money scope.

**Edge threshold**: keep the existing 5%+ edge filter (rule 11). Nothing in this task's evidence
review examined the threshold itself (that's Continuous ROI's job, last refreshed against a
different, older model per calibration-rules.md rule 11 — due its own refresh, but out of scope
here) and no reason surfaced to move it.

**Kelly fraction**: recommend fixing `realKellyFraction` to **0.125 (1/8 Kelly)**, correcting the
discovered 0.25 (Quarter-Kelly) misconfiguration flagged in Addendum 30. Given the strongest
evidence backing this proposal is *"nearly, not fully"* significant (League Two's correction layer,
CI −0.2% to +29.8%), staking at double that conservative fraction was never a deliberate,
evidence-led choice — it was a stale default nobody had re-examined against the actual strength of
evidence behind it. 1/8 is the right fraction for evidence at exactly this stage: real, walk-forward
tested, directionally consistent, but not yet fully proven.

## 5. Phased rollout

**Phase 0 — before any stake changes (mechanical, do first):**
1. Fix `realKellyFraction` default to `0.125`.
2. Wire `applyVariableCorrectionLayer()` into the live scoring path for League Two, gated behind a
   new settings flag (e.g. `leagueTwoCorrectionActive`), **default `false`** — same governed
   pattern as every other modifier this project has shipped this year. Flip it to `true` only once
   Phase 1's own live validation (below) actually starts.
3. Hard-block real-money betting for Carabao Cup, Champions League, Europa League, and Conference
   League in `LEAGUE_CONFIG` (`paperTradeOnly: true`, not a green-flag matter).
4. Structurally exclude the 40-45% tier from real-money eligibility across all leagues (a check in
   the same place `paperTradeOnly`/edge-threshold gating already lives), not just an
   absence-of-green-flag.
5. Un-flag the four weaker green-flagged cells identified in Section 4.
6. Add the "Execution CLV" dashboard metric from the Add-on section (cheap, already-available data,
   directly prevents next time's CLV misreading).

**Phase 1 — League Two only, corrected 50%+ band + the two cleanest 45-50% cells:**
Go live with real money at 1/8 Kelly on exactly the scope in Section 4's "include" list. Set an
explicit minimum-live-sample trigger before evaluating — recommend the same order of magnitude this
project has used elsewhere for a first real look (~40-50 real-money bets), not a fixed calendar
date, since volume is what actually matters for the next decision.

**Phase 2 — trigger: Phase 1's live results don't contradict the backtest** (calibration stays
broadly in line with what was expected, ROI's live CI doesn't turn confidently negative):
add League One's 50%+ corrected band (evidence item #4) — the real but weaker sibling, held back
specifically so its own live performance isn't confounded with League Two's in the same batch.

**Phase 3 — trigger: League One and Two both hold up live over a further live sample:**
revisit whether any of the un-flagged cells (Section 4) or any original-9 league/tier deserves a
fresh, dedicated walk-forward test of its own — not a default expansion, a new evidence-generating
exercise per calibration-rules.md rules 1-3, same as everything else in this project.

## 6. Open questions and design work still needed before this can actually go live

- **Correction-layer deployment mechanics**: `applyVariableCorrectionLayer()` needs an actual call
  site added to `scoreOneFixture` (or wherever the live pick is finalized), a settings flag, and a
  live-verification pass against a real current League Two fixture — same discipline as the
  home/away multiplier's own rollout (Addendum 28). Not designed in this document, only proposed.
- **Structural tier/competition exclusions**: Section 4's exclusions are currently enforced only by
  human discipline (not green-flagging certain things) plus `LEAGUE_CONFIG.paperTradeOnly` for
  whole competitions. The 40-45%-tier exclusion specifically has no code enforcement point
  identified yet — needs one before Phase 0 is genuinely complete, or it remains only as reliable as
  remembering not to green-flag it.
- **Lineup-freshness verification for cup competitions generally** (Addendum 30, item 5) is still
  an open, unverified question — worth a dedicated check once back online, independent of the
  hard exclusion above (useful for understanding *how* wrong the model can get on a rotated night,
  even though it's no longer taking real bets there).
- **Green-flags.json's actual current live state** was not directly re-confirmed this session (no
  live access) — Section 4's un-flagging recommendation should be verified against the live file
  before assuming it matches what Addendum 22 last documented.
- **This proposal itself has not been through calibration-rules.md rules 1-3 as a "new tuning
  cycle"** — it's a synthesis of existing, already-disciplined evidence, not a new fit. Nothing
  here should be read as exempting Phase 0's mechanical changes from the project's own review;
  they're code changes like any other and should be checked in normally before deploying.

## 7. Closing note — Betfair Exchange automation (scoping only, no code)

Tonight's real bets consistently beat Edge Scout's own quoted odds on the exchange (e.g. Watford
2.32 taken vs. a 2.00 quote) — real, demonstrated execution value that manual placement is
currently capturing. Automating that placement would eventually need: Betfair's API (Sports/Exchange
API, requiring an application key and a funded, API-enabled account — a paid product tier, not the
free retail login), live market-depth reads to size an order against actual available liquidity
rather than a theoretical stake, and explicit handling for **partial fills** — this project has
already hit real multi-fill situations placing manually (a single intended stake matched across
several separate bet fragments at slightly different prices), which an automated flow must reconcile
into one logical position rather than recording fragments as unrelated bets.

The risk specific to automation, not present in today's manual flow, is the loss of **the one human
moment that currently catches a wrong stake, a flipped selection, or a stale price** before money
moves — exactly the kind of mistake this project's own bet-log editing tools exist to *correct after
the fact* today, which isn't available once an order has already matched unattended. A sensible,
safe starting point: build an **auto-prepared, human-confirmed** flow first — the system computes
and stages the exact order (selection, price, stake) the moment a bet locks, and a single tap
confirms and sends it, with the human still the last check before anything executes — rather than
skipping straight to fully unattended placement. No Betfair integration code has been written as
part of this document, per the brief's explicit instruction.
