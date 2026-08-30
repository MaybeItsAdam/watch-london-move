/**
 * Convert `data-src/stops.json` into the binary index the app reads.
 *
 *   npm run stop-index
 *
 * Separate from `generate-static-data.mjs` — which harvests stops from a live
 * backend — because this needs no backend at all: it is a pure transform of a
 * file already in the repo. That means CI, a fresh clone, and anyone who has
 * only ever run `npm install` can all regenerate it.
 *
 * Note where the two files live. The JSON is the *source* and sits in
 * `data-src/`, outside `public/`, so it is never copied into `dist/` and never
 * lands in the iOS and Android binaries: shipping both formats would have made
 * this change add 2.5 MB to the app rather than remove work from it. Only
 * `stops.bin` ships. The JSON stays in the repo so the binary can be rebuilt
 * offline — a format bump should not require a live backend and a multi-minute
 * harvest.
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeStopIndex } from './encode-stop-index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const STOPS_JSON = join(root, 'data-src', 'stops.json');
const STOPS_BIN = join(root, 'public', 'data', 'stops.bin');
const MANIFEST = join(root, 'src', 'static-data-manifest.json');

export async function buildStopIndex() {
  const raw = JSON.parse(await readFile(STOPS_JSON, 'utf8'));
  const stops = Array.isArray(raw) ? raw : (raw.stops ?? []);
  if (stops.length === 0) {
    throw new Error(`${STOPS_JSON} holds no stops`);
  }

  const encoded = encodeStopIndex(stops);
  await writeFile(STOPS_BIN, encoded);

  // The manifest is what the app reads to decide whether a bundled index exists
  // at all, so it is written last: a manifest naming a file that is not there
  // yet would send a mid-build dev server down a 404.
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  manifest.stops = {
    path: 'data/stops.bin',
    bytes: encoded.byteLength,
    count: stops.length,
    format: 'binary',
  };
  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  const jsonBytes = (await stat(STOPS_JSON)).size;
  return { count: stops.length, jsonBytes, binBytes: encoded.byteLength };
}

// Only when run directly, so `generate-static-data.mjs` can import it.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  buildStopIndex()
    .then(({ count, jsonBytes, binBytes }) => {
      const mb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;
      console.log(
        `stops.bin: ${count} stops, ${mb(jsonBytes)} JSON -> ${mb(binBytes)} binary ` +
          `(${(binBytes / jsonBytes * 100).toFixed(0)}%)`,
      );
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
