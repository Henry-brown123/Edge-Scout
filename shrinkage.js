// ─── EMPIRICAL-BAYES SHRINKAGE ────────────────────────────────────────────────
//
// Plain-language explanation of what this does and why:
//
// When you slice data into small cells (e.g. "Ligue 1 fixtures in the 65-70%
// confidence tier", n=41), the cell's own observed value (its hit rate, its
// ROI) is a noisy estimate of the truth. A cell with only 41 fixtures can
// easily show a hit rate 10-15pp away from where it would settle with 1,000
// fixtures, purely by chance. A cell with 1,800 fixtures is much more
// trustworthy on its own.
//
// Shrinkage handles this by pulling every cell's estimate part-way toward the
// pooled average across all cells, with "part-way" controlled by how much
// that specific cell's own data can be trusted:
//
//   shrunk_i = pooledMean + weight_i * (value_i - pooledMean)
//   weight_i = n_i / (n_i + k)
//
// - weight_i -> 1 as n_i grows large: big cells keep ~all of their own signal.
// - weight_i -> 0 as n_i shrinks toward zero: small cells collapse to the
//   pooled mean, since there's essentially no information to trust.
// - k is the "how noisy is a single observation, relative to how much cells
//   genuinely differ from each other" constant. It is estimated from the data
//   itself (that's the "empirical" part of empirical Bayes) as:
//
//       k = withinCellVariance / betweenCellVariance
//
//   withinCellVariance:  the average per-observation variance inside a cell
//                         (e.g. p*(1-p) for a hit rate, or the sample
//                         variance of individual bet returns for ROI).
//   betweenCellVariance: how much the cells' TRUE underlying values actually
//                         differ from each other, net of the noise you'd see
//                         even if they were all identical. Estimated via
//                         method-of-moments: take the observed spread of cell
//                         values around the pooled mean, and subtract out the
//                         average sampling noise each cell would show on its
//                         own even with no real difference. Floored just
//                         above zero so k never divides by zero when cells
//                         look statistically indistinguishable.
//
// If cells are mostly noise (k large relative to n) shrinkage pulls hard
// toward the pooled mean — correctly refusing to treat sampling luck as a
// real league-level (or tier-level) effect. If cells show real, sizeable
// differences relative to their noise (k small), shrinkage barely moves them
// — real signal survives.
//
// This is a standard James-Stein / empirical-Bayes estimator, not a novel or
// tuned-per-dataset method — no free parameters here are hand-picked, all are
// derived from the cells passed in.

/**
 * @param {Array<{id: string, n: number, value: number}>} cells
 *   One row per cell (e.g. one league within one tier). `value` is the cell's
 *   own observed mean (hit rate, ROI, whatever is being shrunk).
 * @param {(cell) => number} varianceOf
 *   Returns the per-observation variance for a cell's outcome type — e.g.
 *   `c.value * (1 - c.value)` for a 0/1 hit-rate, or a precomputed sample
 *   variance of individual returns for ROI.
 * @returns {Array} each input cell plus { pooledMean, k, weight, shrunk, delta }
 */
function empiricalBayesShrink(cells, varianceOf) {
  const usable = cells.filter(c => c.n > 0);
  if (usable.length === 0) return cells.map(c => ({ ...c, pooledMean: null, k: null, weight: null, shrunk: null, delta: null }));

  const totalN = usable.reduce((s, c) => s + c.n, 0);
  const pooledMean = usable.reduce((s, c) => s + c.value * c.n, 0) / totalN;

  // Average per-observation variance across cells (the "within" component).
  const withinVar = usable.reduce((s, c) => s + varianceOf(c), 0) / usable.length;

  // Average sampling variance OF THE MEAN each cell would show (variance/n) —
  // this is the noise floor we subtract out below.
  const avgSamplingVarOfMean = usable.reduce((s, c) => s + varianceOf(c) / c.n, 0) / usable.length;

  // Observed variance of the cells' own means around the pooled mean.
  const observedVar = usable.reduce((s, c) => s + (c.value - pooledMean) ** 2, 0) / usable.length;

  // Method-of-moments between-cell variance: real spread minus noise floor,
  // floored so k stays finite even when cells look identical.
  const MIN_BETWEEN_VAR = 1e-6;
  const betweenVar = Math.max(observedVar - avgSamplingVarOfMean, MIN_BETWEEN_VAR);

  const k = withinVar / betweenVar;

  return cells.map(c => {
    if (c.n <= 0) return { ...c, pooledMean: +pooledMean.toFixed(4), k: +k.toFixed(2), weight: 0, shrunk: +pooledMean.toFixed(4), delta: +(pooledMean - (c.value || 0)).toFixed(4) };
    const weight = c.n / (c.n + k);
    const shrunk = pooledMean + weight * (c.value - pooledMean);
    return {
      ...c,
      pooledMean: +pooledMean.toFixed(4),
      k: +k.toFixed(2),
      weight: +weight.toFixed(3),
      shrunk: +shrunk.toFixed(4),
      delta: +(shrunk - c.value).toFixed(4),
    };
  });
}

// Convenience variance functions for the two outcome types this task uses.
const varianceForHitRate = c => Math.max(c.value * (1 - c.value), 1e-6); // p(1-p), floored so a 0%/100% cell doesn't zero out k
const varianceForRoi = c => (typeof c.sampleVariance === 'number' ? c.sampleVariance : varianceForHitRate(c));

module.exports = { empiricalBayesShrink, varianceForHitRate, varianceForRoi };
