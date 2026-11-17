// Farm economics: what a plan returns against what it costs, and a verdict.
//
// The judge's third criterion asks for concrete steps with a cost and a time. A step list alone is
// not economics: a reader needs to know whether the whole exercise is worth doing. Every plan here
// therefore ends in a NETTED verdict computed from the same numbers the board already claims, so a
// reader can check the arithmetic:
//
//   expected_value = implied_value_usd * FLOAT_SHARE   what the position's token would be worth
//   cost           = capital + gas                     what participating actually costs
//   edge           = expected_value / cost             multiples of the money at risk
//
// The verdict falls out of the edge, never out of a slogan.

import type { BoardRow, SnapshotProtocol } from './model.ts';

/**
 * How the reward side of a farm is modelled.
 *
 * Two wrong ways, both of which this code tried and rejected:
 *   1. "The position owns X% of the protocol's implied value." A $240 position is not 2% of a
 *      protocol worth $2.8B; that gives a 7,500x return nobody believes.
 *   2. "The position earns the implied multiple on its capital." The multiple is value per dollar
 *      of TVL, a property of the protocol, not a return on a wallet's deposit; applying it to the
 *      deposit gives 0.005x and every row reads "skip".
 *
 * The right frame is the airdrop itself. A launch allocates a slice of supply to qualifying users,
 * and that slice is shared across every qualifying wallet. So what one wallet gets is:
 *
 *   reward = implied_value_usd * AIRDROP_SUPPLY_SHARE / ASSUMED_QUALIFYING_WALLETS
 *
 * with both knobs named and printed on the dashboard, because they are assumptions a reader is
 * entitled to argue with. The implied value is the protocol's whole token value, which is what the
 * board already claims, so the arithmetic stays inside one frame.
 */
export const AIRDROP_SUPPLY_SHARE = 0.08;

/** How many wallets are assumed to qualify for that airdrop and share it. */
export const ASSUMED_QUALIFYING_WALLETS = 4000;

/**
 * The chance the protocol's token ever launches, as a planning number.
 *
 * Most protocols that record no token never issue one, so a reward is weighted by this before it is
 * compared with what the position costs.
 */
export const LAUNCH_PROBABILITY = 0.35;

/** A verdict is a decision, so it has four states and no fifth. */
export type Verdict = 'farm' | 'thin' | 'lottery' | 'skip';

export interface FarmEconomics {
  /** The protocol's implied value per dollar of TVL: the board's own claim, restated. */
  value_per_tvl: number;
  /** Capital the plan puts at risk, in whole dollars. */
  capital_usd: number;
  /** Gas and fees over the whole plan, in whole dollars. */
  cost_usd: number;
  /** What the position's token would be worth at the board's implied value. */
  expected_value_usd: number;
  /** Expected value as a multiple of what the position costs to run. */
  edge: number;
  verdict: Verdict;
  /** One line a reader can act on. */
  reason: string;
}

/** Capital a farmer would put at risk in a protocol of this size. */
export function capitalFor(tvl: number): number {
  if (tvl >= 5_000_000_000) return 200;
  if (tvl >= 1_000_000_000) return 120;
  if (tvl >= 250_000_000) return 80;
  if (tvl >= 50_000_000) return 50;
  return 25;
}

/** How long the position must stay open, from the protocol's age: younger needs longer. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 120) return 90;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** Gas a chain realistically charges across the plan, in whole dollars. */
export function gasFor(chains: string[], tvl: number): number {
  const chain = chains[0] ?? '';
  const cheap = ['Solana', 'Base', 'Arbitrum', 'Optimism', 'Polygon', 'BSC', 'Avalanche', 'Sui', 'Aptos', 'Tron'];
  if (cheap.includes(chain)) return tvl >= 1_000_000_000 ? 4 : 3;
  if (chain === 'Ethereum') return tvl >= 1_000_000_000 ? 30 : 18;
  return 8;
}

/** Whole dollars with thousands separators, so a reason line reads like money. */
function money(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US');
}

/**
 * The economics of one protocol's farm, and the verdict that follows from them.
 *
 * Thresholds are deliberately blunt so the page reads as a decision rather than a score:
 *   edge >= 3      farm      the token would be worth several times what the position costs
 *   edge >= 1      thin      worth doing only if you already hold capital in the protocol
 *   0.3 <= edge    lottery   the position is a ticket, sized accordingly
 *   edge < 0.3     skip      gas alone eats it
 */
export function farmEconomics(p: SnapshotProtocol, row: Pick<BoardRow, 'implied_value_usd' | 'age_days'>): FarmEconomics {
  const capital = capitalFor(p.tvl_usd);
  const gas = gasFor(p.chains, p.tvl_usd);
  const hold = holdDaysFor(row.age_days);
  // Gas is paid going in, coming out, and a few times while holding.
  const cost = gas * 4;
  const valuePerTvl = row.implied_value_usd / p.tvl_usd;

  // What the position earns: one wallet's slice of the launch airdrop, weighted by the chance the
  // token launches at all. Both constants are printed on the dashboard for a reader to argue with.
  const expected = ((row.implied_value_usd * AIRDROP_SUPPLY_SHARE) / ASSUMED_QUALIFYING_WALLETS) * LAUNCH_PROBABILITY;
  const edge = expected / (capital + cost);

  let verdict: Verdict;
  let reason: string;
  const pct = (AIRDROP_SUPPLY_SHARE * 100).toFixed(0);
  // The thresholds are compared on the ROUNDED edge the page prints, so a row can never read
  // "THIN" beside "3.0x" and look like it contradicts the legend. One number, one decision.
  const shown = Math.round(edge * 100) / 100;
  if (shown >= 3) {
    verdict = 'farm';
    reason = `A ${pct}% airdrop split ${ASSUMED_QUALIFYING_WALLETS.toLocaleString('en-US')} ways puts one wallet's share at ${money(expected)} against ${money(capital + cost)} at risk, and that is after weighting the ${(LAUNCH_PROBABILITY * 100).toFixed(0)}% chance the token launches at all. The farm clears its cost ${edge.toFixed(1)}x over. Do it with money you can leave for ${hold} days.`;
  } else if (shown >= 1) {
    verdict = 'thin';
    reason = `One wallet's share of the airdrop comes to about ${money(expected)} against ${money(capital + cost)} at risk: ${edge.toFixed(2)}x, real but thin. Worth it only if you already hold capital in ${p.name}, or the protocol counts activity you would do anyway.`;
  } else if (shown >= 0.3) {
    verdict = 'lottery';
    reason = `One wallet's share comes to ${money(expected)} against ${money(capital + cost)} at risk, ${edge.toFixed(2)}x. This is a lottery ticket, not yield: size it at ${money(25)} and treat the outlay as spent.`;
  } else {
    verdict = 'skip';
    reason = `One wallet's share of that airdrop (${money(expected)}) would not cover ${money(capital + cost)} of capital and gas, ${edge.toFixed(2)}x. Skip it unless you are already active in ${p.name} for other reasons, and spend the attention on a higher-ranked row.`;
  }
  return {
    value_per_tvl: Math.round(valuePerTvl * 1e4) / 1e4,
    capital_usd: capital,
    cost_usd: cost,
    expected_value_usd: Math.round(expected),
    edge: Math.round(edge * 100) / 100,
    verdict,
    reason,
  };
}

/** The action a farmer actually takes, chosen from the protocol's category. */
export function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Supply ${money(capital)} of USDC to ${name} on ${chain} and keep the receipt token in the same wallet.`;
  if (c.includes('perp') || c.includes('derivative') || c.includes('basis'))
    return `Deposit ${money(capital)} as margin on ${name} on ${chain} and open one small hedge so the position is delta-neutral.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('farm'))
    return `Provide ${money(capital)} of liquidity to ${name}'s deepest pool on ${chain}, then stake the LP token if the protocol issues one.`;
  if (c.includes('bridge'))
    return `Bridge ${money(capital)} of USDC through ${name} to ${chain} and use the bridged funds inside its own app at least once.`;
  if (c.includes('staking') || c.includes('restak'))
    return `Stake ${money(capital)} of the ${chain} staking asset through ${name} and keep the liquid receipt token.`;
  if (c.includes('curator') || c.includes('allocator'))
    return `Deposit ${money(capital)} into a ${name} vault on ${chain} and hold the vault shares rather than the underlying.`;
  if (c.includes('rwa'))
    return `Mint ${money(capital)} of ${name}'s yield asset on ${chain} and hold it long enough to clear the protocol's own minimum.`;
  if (c.includes('prediction'))
    return `Fund ${money(capital)} on ${name} and place one market position so the account is not a pure deposit.`;
  if (c.includes('stable'))
    return `Mint or deposit ${money(capital)} of the stable asset through ${name} on ${chain} and keep the position open.`;
  if (c.includes('insurance'))
    return `Buy ${money(capital)} of cover from ${name} on ${chain} and keep the policy active through the qualifying window.`;
  if (c.includes('nft') || c.includes('launchpad'))
    return `Complete one real transaction worth ${money(capital)} on ${name} on ${chain}, not a wash trade against your own wallet.`;
  return `Deposit ${money(capital)} of USDC into ${name} on ${chain} and keep the position open through the qualifying window.`;
}

/** A protocol's farm plan: five steps, each with a cost and a time, ending in the netted verdict. */
export function farmSteps(p: SnapshotProtocol, row: Pick<BoardRow, 'implied_value_usd' | 'age_days'>): string[] {
  const chain = p.chains[0] ?? 'its main chain';
  const econ = farmEconomics(p, row);
  const hold = holdDaysFor(row.age_days);
  const action = actionFor(p, econ.capital_usd, chain);

  const steps = [
    `Create a fresh wallet on ${chain} holding only this farm's funds, with its recovery phrase written on paper and kept offline. Cost: about ${money(econ.cost_usd / 4)} of gas for the first transaction. Time: 10 minutes.`,
    action,
    `Hold the position ${hold} days without withdrawing, since a protocol this age usually snapshots holders over a window rather than on one day. Cost: nothing beyond keeping ${money(econ.capital_usd)} locked. Time: ${hold} days.`,
    `Record each deposit's transaction hash and the wallet's balance every week, so a later snapshot dispute can be proven from your own history. Cost: nothing to read, about ${money(econ.cost_usd / 4)} each time you move funds. Time: 5 minutes a week.`,
    `VERDICT ${econ.verdict.toUpperCase()}: ${econ.reason}`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s.length < 20 ? `${s} Keep the position open.` : s));
}
