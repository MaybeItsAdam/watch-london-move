/**
 * Fail the build when the things a cold start has to download grow.
 *
 *   npm run budget          # after `npm run build`
 *
 * CI already runs lint, typecheck, tests and a build, and none of them notice a
 * chunk gaining 300KB. That is the failure mode this exists for: every
 * regression in the bundle split or the static data is otherwise invisible
 * until someone opens the app on a slow phone, which is nobody on the team.
 *
 * Budgets are set a little above what the build currently emits — enough that
 * ordinary churn does not trip them, tight enough that a new dependency does.
 * Raising one is a normal thing to do; doing it without noticing is not, which
 * is the entire point.
 *
 * JS and CSS are measured **gzipped**, because that is what crosses the wire.
 * `public/data` is measured **raw**, because on iOS and Android those files are
 * copied into the app binary uncompressed and their size is download size in
 * the store listing.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(root, 'dist');

/**
 * Chunks are content-hashed, so they are matched by the stable prefix Vite
 * derives from the `manualChunks` name — `index-D6fOW2TG.js` matches `index`.
 */
const CHUNK_BUDGETS_GZIP = {
  // React, the app, socket.io, and everything not split out below.
  index: 115_000,
  // deck.gl core + layers. Split out in its own right; see vite.config.ts.
  deckgl: 200_000,
  // The renderer. Large, but every session needs it and it cannot be deferred.
  maplibre: 290_000,
  // Lazy: only fetched once the camera reaches the 3D zoom band.
  'model-layers': 75_000,
};

/** Raw bytes, and the whole of what ships inside the native app binaries. */
const DATA_BUDGETS_RAW = {
  'routes.json': 2_600_000,
  'stops.bin': 1_600_000,
};

/** Stylesheets, gzipped. Small, but they block the first paint. */
const CSS_BUDGET_GZIP = 20_000;

/** Everything a first paint needs, gzipped, across all eager chunks and CSS. */
const EAGER_TOTAL_GZIP = 620_000;

const kb = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;

function gzipSize(path) {
  return gzipSync(readFileSync(path), { level: 9 }).length;
}

/**
 * Which budget a built file belongs to, or null.
 *
 * Matched by the `<name>-` prefix rather than by stripping the hash off the
 * end. Two attempts at the latter both failed on real filenames: a hash class
 * including `-` is greedy and turns `model-layers-D4gcMDeu` into `model`, and
 * one excluding `-` fails outright on `maplibre-D-iNNwj3`, because rolldown's
 * base64 hashes contain hyphens themselves. The prefix is the part we choose,
 * in vite.config.ts, so it is the part worth matching on.
 */
function budgetKeyFor(name) {
  for (const key of Object.keys(CHUNK_BUDGETS_GZIP)) {
    if (name.startsWith(`${key}-`)) {
      return key;
    }
  }
  return null;
}

const failures = [];
const rows = [];

function check(label, actual, budget) {
  const over = actual > budget;
  rows.push({ label, actual, budget, over });
  if (over) {
    failures.push(`${label} is ${kb(actual)}, over its ${kb(budget)} budget`);
  }
}

// --- chunks ----------------------------------------------------------------
let assets;
try {
  assets = readdirSync(join(DIST, 'assets'));
} catch {
  console.error('No dist/assets — run `npm run build` first.');
  process.exit(1);
}

const seen = new Set();
let eagerTotal = 0;
for (const name of assets) {
  if (!name.endsWith('.js') && !name.endsWith('.css')) {
    continue;
  }
  const size = gzipSize(join(DIST, 'assets', name));
  const key = budgetKeyFor(name);
  // Lazy by construction — excluded from the eager total for the same reason
  // it is split out at all.
  if (key !== 'model-layers') {
    eagerTotal += size;
  }
  // Budgets are per-chunk and JS-only; a stylesheet sharing a chunk's name
  // must not be measured against a JavaScript allowance a hundred times its size.
  if (name.endsWith('.css')) {
    check(`${name} (gzip)`, size, CSS_BUDGET_GZIP);
  } else if (key) {
    seen.add(key);
    check(`${name} (gzip)`, size, CHUNK_BUDGETS_GZIP[key]);
  }
}

// A renamed or dropped chunk must be loud: silently ceasing to check something
// is exactly how a budget rots into decoration.
for (const prefix of Object.keys(CHUNK_BUDGETS_GZIP)) {
  if (!seen.has(prefix)) {
    failures.push(`no chunk matched the "${prefix}" budget — was it renamed or removed?`);
  }
}

check('eager JS + CSS (gzip)', eagerTotal, EAGER_TOTAL_GZIP);

// --- bundled static data ---------------------------------------------------
for (const [name, budget] of Object.entries(DATA_BUDGETS_RAW)) {
  let size;
  try {
    size = statSync(join(DIST, 'data', name)).size;
  } catch {
    failures.push(`dist/data/${name} is missing`);
    continue;
  }
  check(`data/${name} (raw)`, size, budget);
}

// --- report ----------------------------------------------------------------
const width = Math.max(...rows.map((r) => r.label.length));
for (const { label, actual, budget, over } of rows) {
  const share = ((actual / budget) * 100).toFixed(0);
  console.log(
    `${over ? 'FAIL' : ' ok '}  ${label.padEnd(width)}  ${kb(actual).padStart(10)} / ${kb(budget).padStart(10)}  ${share.padStart(3)}%`,
  );
}

if (failures.length > 0) {
  console.error(`\n${failures.length} over budget:`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error(
    '\nIf the growth is intended, raise the budget in scripts/check-budget.mjs' +
      ' in the same commit — so the increase is reviewed rather than absorbed.',
  );
  process.exit(1);
}

console.log('\nAll within budget.');
