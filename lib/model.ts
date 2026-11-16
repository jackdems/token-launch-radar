// The token radar's value model.
//
// WHAT THIS FILE DOES
// The snapshot carries ten fields per protocol and nothing else. This module turns four of them
// (tvl_usd, change_7d, listed_at, and the absence of a token) into one number per protocol: an
// implied value, in dollars, for a token that does not exist yet.
//
// WHERE THE NUMBER COMES FROM
// It is calibrated, not invented. 128 protocols in the same snapshot already trade, so each one
// gives a realised multiple: market cap / TVL. Regressing those realised multiples is how this
// model learns what the market has actually paid per dollar of TVL, then applies that to the
// protocols that do not trade yet. The figures below are the fitted result and they are reported
// with the fit's own out-of-sample error, because a model quoted without its error is a claim,
// not a measurement.
//
// WHAT THE FIT ACTUALLY FOUND (honest limits)
//   - log(TVL) is the only robust signal: bigger protocols in this snapshot trade at LOWER
//     multiples (fitted elasticity -0.478), so implied value grows roughly as TVL^0.52.
//   - 5-fold cross-validated R^2 on log(multiple) is 0.148. A negative control (a random feature)
//     scores 0.005 and an intercept-only model -0.015, so 0.148 is a real edge but a small one:
//     most of the variation in market cap / TVL is not explained by anything in this snapshot.
//     Anyone promising a tight valuation here is fitting noise.
//   - 7-day growth does not predict a higher multiple in this snapshot; its raw correlation with
//     the multiple is negative (-0.34). It is therefore used as a small momentum adjustment
//     around zero, NOT as a value driver, and it can reduce a score.
//   - Category priors are shrunk towards the global multiple rather than trusted outright, since
//     most categories hold only a handful of live examples.
//
// So the deterministic part: implied = TVL * multiple(TVL) * growthAdjustment * categoryTilt,
// every term a function of the snapshot's own figures, no protocol name ever special-cased.

/** One protocol as the sealed snapshot carries it. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

const DAY_MS = 86_400_000;

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either date is unusable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether the snapshot records no token for this protocol at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether the board may rank it as a candidate radar find.
 *
 * The watchlist's own exclusion rule, restated so a protocol the house's rule would have dropped is
 * never ranked as a discovery: a pre-token protocol that is a wrapped, staked or bridged product of
 * a token that already trades is not a future launch, it is a receipt for something that trades
 * today. Ranking WBTC or "Binance staked ETH" as an unminted gem is exactly the mistake this filter
 * exists to prevent, so the same tests the snapshot's watchlist used are applied here.
 *
 * The exclusion categories and name marks are the rule RULES.txt states for the watchlist; they are
 * a fixed part of the bounty's definition of a subject, not a hand-picked list of protocols.
 */
const PRODUCT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** A name carrying a whole word wrapped, staked or staking, in any case, is a derivative. */
const DERIVATIVE_NAME = /\b(wrapped|staked|staking)\b/i;

/** A leading exchange name marks an exchange's own product, never a protocol's launch. */
const EXCHANGE_PREFIX = /^(binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)\b/i;

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol is a wrapped, staked or bridged product rather than a subject of its own. */
export function isDerivativeProduct(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  if (DERIVATIVE_NAME.test(p.name)) return true;
  if (EXCHANGE_PREFIX.test(p.name)) return true;
  return false;
}

export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (isDerivativeProduct(p)) return false;
  if (VERSIONED.test(p.name)) return false;
  return true;
}

/**
 * The fitted calibration, recomputed from the snapshot on every run by `fitCalibration`.
 *
 * These constants are the fallback used only when the snapshot holds too few live protocols to
 * fit: they are the same numbers the fit returns on the sealed snapshot, so a run that cannot fit
 * still ranks rather than crashing.
 */
export interface Calibration {
  /** Elasticity of the multiple with respect to TVL: multiple ~ TVL^elasticity. */
  elasticity: number;
  /** Multiple at the geometric-mean TVL of the live set. */
  base_multiple: number;
  /** Per-category multiplier on the multiple, shrunk towards 1. */
  category_tilt: Record<string, number>;
  /** How many live protocols carried a usable market cap. */
  live_count: number;
  /** 5-fold cross-validated R^2 of the multiple model on log scale; negative means worse than a mean. */
  cv_r2: number;
  /** Median absolute percentage error of the fitted multiple. */
  median_abs_pct_error: number;
  /** Correlation between 7-day growth and the realised multiple (negative = growth did not pay). */
  growth_correlation: number;
  /** The negative control's R^2: a random feature. The baseline a real signal must beat. */
  control_r2: number;
}

export const FALLBACK_CALIBRATION: Calibration = {
  elasticity: -0.4777,
  base_multiple: 0.2241,
  category_tilt: {},
  live_count: 128,
  cv_r2: 0.1477,
  median_abs_pct_error: 0.86,
  growth_correlation: -0.3448,
  control_r2: 0.0053,
};

/** Deterministic pseudo-random numbers, so a run's shuffle is identical every time. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smallest-squares solve for a small dense system, by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= n; c++) m[r]![c] = m[r]![c]! - f * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** Ordinary least squares on a design matrix; returns null when the system is singular. */
function ols(x: number[][], y: number[]): number[] | null {
  const k = x[0]!.length;
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty = new Array<number>(k).fill(0);
  for (let i = 0; i < x.length; i++) {
    for (let j = 0; j < k; j++) {
      xty[j] = xty[j]! + x[i]![j]! * y[i]!;
      for (let l = 0; l < k; l++) xtx[j]![l] = xtx[j]![l]! + x[i]![j]! * x[i]![l]!;
    }
  }
  return solve(xtx, xty);
}

/** Pearson correlation, or 0 when either series has no spread. */
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** Median of a non-empty list. */
function median(values: number[]): number {
  const s = [...values].sort((p, q) => p - q);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Fit the calibration from the snapshot's own live-token protocols.
 *
 * The design is deliberately small: an intercept and log(TVL). Adding sixteen category dummies to
 * 128 observations was tried and cross-validated at R^2 0.018, which is overfitting; category
 * enters instead as a shrunken tilt over the intercept, so a category with four live examples
 * moves the multiple only slightly from the global one.
 */
export function fitCalibration(snapshot: Snapshot): Calibration {
  const live = snapshot.protocols.filter(
    (p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 1000 && p.tvl_usd > 0,
  );
  if (live.length < 12) return FALLBACK_CALIBRATION;

  const y = live.map((p) => Math.log(p.mcap_usd! / p.tvl_usd));
  const lt = live.map((p) => Math.log(p.tvl_usd));
  const meanLt = lt.reduce((s, v) => s + v, 0) / lt.length;
  const centered = lt.map((v) => v - meanLt);
  const design = centered.map((v) => [1, v]);
  const coef = ols(design, y);
  if (coef === null) return FALLBACK_CALIBRATION;
  const elasticity = coef[1]!;
  const intercept = coef[0]!;

  // 5-fold cross-validation, the fold assignment drawn from a fixed seed so the reported figure
  // is the same on every run.
  const rand = mulberry32(0x5eed1234);
  const order = live.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const folds = 5;
  const predicted = new Array<number>(y.length).fill(0);
  for (let k = 0; k < folds; k++) {
    const test: number[] = [];
    const train: number[] = [];
    for (let i = 0; i < order.length; i++) (i % folds === k ? test : train).push(order[i]!);
    if (train.length < 3 || test.length === 0) continue;
    const c = ols(
      train.map((i) => design[i]!),
      train.map((i) => y[i]!),
    );
    if (c === null) continue;
    for (const i of test) predicted[i] = c[0]! + c[1]! * centered[i]!;
  }
  const meanY = y.reduce((s, v) => s + v, 0) / y.length;
  let ssRes = 0;
  let ssTot = 0;
  const absPct: number[] = [];
  for (let i = 0; i < y.length; i++) {
    ssRes += (y[i]! - predicted[i]!) ** 2;
    ssTot += (y[i]! - meanY) ** 2;
    absPct.push(Math.abs(Math.exp(y[i]! - predicted[i]!) - 1));
  }
  const cv_r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // The negative control: the same fit on a random feature. A real signal must beat it.
  const noise = live.map(() => rand() * 2 - 1);
  const noiseDesign = noise.map((v) => [1, v]);
  const noiseCoef = ols(noiseDesign, y);
  let control_r2 = -1;
  if (noiseCoef !== null) {
    let res = 0;
    for (let i = 0; i < y.length; i++) res += (y[i]! - (noiseCoef[0]! + noiseCoef[1]! * noise[i]!)) ** 2;
    control_r2 = ssTot > 0 ? 1 - res / ssTot : 0;
  }

  // Category tilt: each category's median residual against the TVL-only fit, shrunk by its own
  // sample size towards 1 (no tilt). Four examples move the multiple a little; one barely at all.
  const residuals = new Map<string, number[]>();
  for (let i = 0; i < live.length; i++) {
    const cat = live[i]!.category;
    if (cat === null) continue;
    const fit = intercept + elasticity * centered[i]!;
    const bucket = residuals.get(cat);
    if (bucket === undefined) residuals.set(cat, [y[i]! - fit]);
    else bucket.push(y[i]! - fit);
  }
  const category_tilt: Record<string, number> = {};
  for (const [cat, list] of residuals) {
    if (list.length < 3) continue;
    const shrink = list.length / (list.length + 6);
    const tilt = Math.exp(median(list) * shrink);
    category_tilt[cat] = Math.min(4, Math.max(0.25, tilt));
  }

  const growthPairs = live
    .map((p, i) => ({ growth: p.change_7d, multiple: y[i]! }))
    .filter((pair) => pair.growth !== null);

  return {
    elasticity,
    base_multiple: Math.exp(intercept),
    category_tilt,
    live_count: live.length,
    cv_r2,
    median_abs_pct_error: median(absPct),
    growth_correlation: pearson(
      growthPairs.map((p) => p.growth!),
      growthPairs.map((p) => p.multiple),
    ),
    control_r2,
  };
}

/** How strongly 7-day growth moves the score. Small on purpose: the fit found no positive edge. */
export const GROWTH_WEIGHT = 0.35;

/** Growth is clamped so one wild week cannot dominate a protocol's whole valuation. */
export const GROWTH_CAP = 75;
export const GROWTH_FLOOR = -50;

/** The result of scoring one protocol. */
export interface Score {
  implied: number;
  multiple: number;
  tvlMultiple: number;
  growth_multiplier: number;
  category_tilt: number;
  growth_pct: number;
  age_days: number | null;
}

/**
 * The implied value of one protocol's hypothetical token.
 *
 *   multiple   = base_multiple * (tvl / tvl_ref)^elasticity        the fitted comps curve
 *   multiple  *= category_tilt[category]                            shrunk category prior
 *   growthAdj  = 1 + clamp(change_7d, -50, 75) / 100 * 0.35         small momentum tilt
 *   implied    = max(1, round(tvl * multiple * growthAdj))
 *
 * `tvlRef` is the geometric mean TVL of the live set the curve was fitted on. It has to travel
 * with the calibration or the elasticity would be applied around the wrong point.
 */
export function scoreProtocol(
  p: SnapshotProtocol,
  asOf: string,
  cal: Calibration,
  tvlRef: number,
): Score {
  const age = ageDays(asOf, p.listed_at);
  const rawGrowth = p.change_7d === null ? 0 : p.change_7d;
  const growth_pct = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, rawGrowth));
  const growth_multiplier = 1 + (growth_pct / 100) * GROWTH_WEIGHT;
  const ratio = p.tvl_usd > 0 && tvlRef > 0 ? p.tvl_usd / tvlRef : 1;
  const tvlMultiple = cal.base_multiple * Math.pow(ratio, cal.elasticity);
  const tilt = p.category !== null ? (cal.category_tilt[p.category] ?? 1) : 1;
  const multiple = Math.min(6, Math.max(0.005, tvlMultiple * tilt));
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growth_multiplier));
  return { implied, multiple, tvlMultiple, growth_multiplier, category_tilt: tilt, growth_pct, age_days: age };
}

/** The geometric mean TVL of the live set the calibration was fitted on. */
export function tvlReference(snapshot: Snapshot, cal: Calibration): number {
  const live = snapshot.protocols.filter(
    (p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 1000 && p.tvl_usd > 0,
  );
  if (live.length < 12) {
    // The fallback calibration was fitted around this point; reproduce it from the snapshot.
    return live.length > 0
      ? Math.exp(live.reduce((s, p) => s + Math.log(p.tvl_usd), 0) / live.length)
      : 100_000_000;
  }
  return Math.exp(live.reduce((s, p) => s + Math.log(p.tvl_usd), 0) / live.length);
}

/** One row of the board, as the gate reads it plus the fields the page shows. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  token_status: 'pre-token';
  on_watchlist: boolean;
  multiple: number;
  growth_multiplier: number;
  category_tilt: number;
  farm_steps: string[];
}

/** A protocol that already trades: shown as the market's own value, never ranked against the rest. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
  change_7d: number | null;
}

/** Everything the page needs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  /** The TVL the fitted curve pivots on: the geometric mean of the live set it was fitted on. */
  tvl_ref: number;
  calibration: Calibration;
  model_version: string;
  board_size: number;
  watchlist_size: number;
  early_size: number;
  live_size: number;
  rows: BoardRow[];
  live: LiveRow[];
}

export const MODEL_VERSION = 'comps-tvl-v1';

/** How many pre-token protocols below the watchlist floor the early radar carries. */
export const EARLY_ROWS = 180;

/** How many live-token protocols the market view carries. */
export const LIVE_ROWS = 30;
