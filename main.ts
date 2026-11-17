// token-radar-01 entry: the ranked board and the page's data.
//
// Reads the sealed snapshot from /input/snapshot.json, fits the comps calibration on the same
// snapshot's live-token protocols, scores every pre-token protocol, writes /output/board.json,
// writes the page's data beside the page, copies dashboard/ and screenshots/, and writes
// /output/dossier.json last with the vendored make.fun library the scorer uses byte for byte.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EARLY_ROWS,
  LIVE_ROWS,
  MODEL_VERSION,
  fitCalibration,
  isPreToken,
  isRankable,
  scoreProtocol,
  tvlReference,
  type BoardRow,
  type LiveRow,
  type RadarData,
  type Snapshot,
  type SnapshotProtocol,
} from './lib/model.ts';
import { AIRDROP_SUPPLY_SHARE, ASSUMED_QUALIFYING_WALLETS, LAUNCH_PROBABILITY, farmEconomics, farmSteps } from './lib/farm.ts';
import { buildDossier } from './lib/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap shapes the dossier, the rest refuse the entry. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> from the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory>\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

/** Parse and validate the snapshot: the gate refuses an entry built on a shape it does not know. */
function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Partial<Snapshot>;
  if (typeof raw.as_of !== 'string') throw new Error('snapshot: as_of is not a string');
  if (!Array.isArray(raw.protocols)) throw new Error('snapshot: protocols is not an array');
  if (!Array.isArray(raw.watchlist)) throw new Error('snapshot: watchlist is not an array');
  const protocols: SnapshotProtocol[] = raw.protocols.map((p, i) => {
    if (typeof p?.slug !== 'string' || typeof p?.name !== 'string') throw new Error(`snapshot: protocol ${i} has no slug or name`);
    if (typeof p.tvl_usd !== 'number') throw new Error(`snapshot: protocol ${p.slug} has no tvl_usd`);
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: raw.as_of,
    source: typeof raw.source === 'string' ? raw.source : '',
    floor_usd: typeof raw.floor_usd === 'number' ? raw.floor_usd : 0,
    protocols,
    watchlist: raw.watchlist.filter((s): s is string => typeof s === 'string'),
  };
}

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));

// The calibration is fitted on this snapshot's own live protocols, never on a hardcoded table.
const calibration = fitCalibration(snapshot);
const tvlRef = tvlReference(snapshot, calibration);

/** Every protocol the board ranks: the whole watchlist, then every other pre-token protocol. */
function buildBoard(): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  const onWatchlist = new Set(snapshot.watchlist);
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, the strongest by TVL first. The
  // watchlist is the floor, never the ceiling, so this is where the board earns its width.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of, calibration, tvlRef) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((row, i) => {
    const base = {
      rank: i + 1,
      slug: row.p.slug,
      name: row.p.name,
      category: row.p.category,
      chains: row.p.chains,
      tvl_usd: row.p.tvl_usd,
      change_7d: row.p.change_7d,
      mcap_usd: row.p.mcap_usd,
      listed_at: row.p.listed_at,
      age_days: row.s.age_days,
      implied_value_usd: row.s.implied,
      token_status: 'pre-token' as const,
      on_watchlist: onWatchlist.has(row.p.slug),
      multiple: Math.round(row.s.multiple * 1e4) / 1e4,
      growth_multiplier: Math.round(row.s.growth_multiplier * 1e4) / 1e4,
      category_tilt: Math.round(row.s.category_tilt * 1e4) / 1e4,
    };
    // The economics are computed once and reused: the steps quote the same verdict the row carries.
    const econ = farmEconomics(row.p, base);
    return {
      ...base,
      farm: {
        value_per_tvl: econ.value_per_tvl,
        capital_usd: econ.capital_usd,
        cost_usd: econ.cost_usd,
        expected_value_usd: econ.expected_value_usd,
        edge: econ.edge,
        verdict: econ.verdict,
        reason: econ.reason,
      },
      farm_steps: farmSteps(row.p, base),
    };
  });
}

const board = buildBoard();

/** The market's own values for protocols that already trade: never mixed into the ranking. */
const live: LiveRow[] = snapshot.protocols
  .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0)
  .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  .slice(0, LIVE_ROWS)
  .map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd!,
    multiple: Math.round((p.mcap_usd! / p.tvl_usd) * 1e4) / 1e4,
    change_7d: p.change_7d,
  }));

/** Refuse locally what the gate would refuse remotely, so a broken board never ships. */
function boardIssue(rows: BoardRow[]): string | null {
  if (rows.length < 100) return `only ${rows.length} rows, the gate needs at least 100`;
  if (rows.length > 4000) return `${rows.length} rows, the gate takes at most 4000`;
  const seen = new Set<string>();
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of rows) {
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
    if (!known.has(r.slug)) return `slug ${r.slug} is not a snapshot protocol`;
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `row ${r.slug} has no positive whole implied value`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `row ${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `row ${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  for (const slug of snapshot.watchlist) if (!seen.has(slug)) return `the watchlist slug ${slug} is missing from the board`;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.implied_value_usd > rows[i - 1]!.implied_value_usd) return `implied value rises at rank ${rows[i]!.rank}`;
  }
  if (new Set(rows.map((r) => r.implied_value_usd)).size === 1) return 'every implied value is the same: that ranks nothing';
  return null;
}

const issue = boardIssue(board);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

const radar: RadarData = {
  as_of: snapshot.as_of,
  source: snapshot.source,
  floor_usd: snapshot.floor_usd,
  farm_model: {
    airdrop_share: AIRDROP_SUPPLY_SHARE,
    assumed_wallets: ASSUMED_QUALIFYING_WALLETS,
    launch_probability: LAUNCH_PROBABILITY,
  },
  calibration,
  model_version: MODEL_VERSION,
  board_size: board.length,
  watchlist_size: snapshot.watchlist.length,
  early_size: board.filter((r) => !r.on_watchlist).length,
  live_size: live.length,
  rows: board,
  live,
};

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashboardOut = join(out, 'dashboard');
copyFiles(join(here, 'dashboard'), dashboardOut);

// The page's data lives inside the page's own directory: the dashboard is served from
// /output/dashboard and the data file has to sit beside index.html, or the page renders empty.
writeFileSync(join(dashboardOut, 'data.js'), `window.RADAR = ${JSON.stringify(radar)};\n`);
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length}: hand in the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from /output and compares bytes.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }),
);

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows ranked ` +
    `(${radar.early_size} early, ${live.length} live set aside)\n` +
    `token radar: calibration on ${calibration.live_count} live protocols, elasticity ${calibration.elasticity.toFixed(3)}, ` +
    `cv r2 ${calibration.cv_r2.toFixed(3)} (control ${calibration.control_r2.toFixed(3)})\n` +
    `token radar: wrote board.json, data.js, dashboard/, ${shots.length} screenshots and dossier.json to ${out}\n`,
);
