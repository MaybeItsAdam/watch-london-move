import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import manifest from './static-data-manifest.json';
// The encoder is a build script with no types of its own; this test is the
// contract between it and the decoder, so the shape is asserted here rather
// than declared there.
// @ts-expect-error -- untyped .mjs build script, imported deliberately
import { encodeStopIndex } from '../scripts/encode-stop-index.mjs';
import {
  STOP_CELL_DEG,
  StopIndexFormatError,
  cellIdFor,
  decodeStopIndex,
  queryStopIndex,
  stopAt,
  type StopRecord,
} from './stop-index';

/**
 * The encoder (a build script) and the decoder (shipped) duplicate the byte
 * layout between them. That duplication is the whole risk of this format: an
 * offset that disagrees by four bytes produces a map with no stops on it and no
 * error anywhere. These tests are the thing that makes that a red build.
 */

function encode(stops: StopRecord[], cellDeg = STOP_CELL_DEG): ArrayBuffer {
  const bytes = encodeStopIndex(stops, cellDeg) as Uint8Array;
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

const stop = (id: string, lat: number, lon: number, name = id): StopRecord => ({
  id,
  lat,
  lon,
  name,
});

// Spread across several 0.01° cells around central London.
const LONDON: StopRecord[] = [
  stop('490000001', 51.5072, -0.1276, 'Trafalgar Square'),
  stop('490000002', 51.5074, -0.1278, 'Charing Cross'),
  stop('490000003', 51.5194, -0.127, 'Russell Square'),
  stop('490000004', 51.4952, -0.1441, 'Victoria'),
  stop('490000005', 51.5033, -0.1195, 'Waterloo'),
];

const boundsAround = (lat: number, lon: number, pad: number) => ({
  south: lat - pad,
  north: lat + pad,
  west: lon - pad,
  east: lon + pad,
});

const byId = (stops: StopRecord[]) => stops.map((s) => s.id).sort();

describe('stop index round-trip', () => {
  it('preserves every stop', () => {
    const index = decodeStopIndex(encode(LONDON));
    expect(index.count).toBe(LONDON.length);

    const all: StopRecord[] = [];
    for (let i = 0; i < index.count; i += 1) {
      all.push(stopAt(index, i));
    }
    expect(byId(all)).toEqual(byId(LONDON));

    for (const decoded of all) {
      const original = LONDON.find((s) => s.id === decoded.id);
      expect(original).toBeDefined();
      expect(decoded.name).toBe(original?.name);
      // Float32, so ~0.4m at this latitude — well inside what the source claims.
      expect(decoded.lat).toBeCloseTo(original!.lat, 4);
      expect(decoded.lon).toBeCloseTo(original!.lon, 4);
    }
  });

  it('keeps a cell table that is sorted and covers every stop', () => {
    const index = decodeStopIndex(encode(LONDON));
    for (let k = 1; k < index.cellId.length; k += 1) {
      expect(index.cellId[k]).toBeGreaterThan(index.cellId[k - 1]);
    }
    expect(index.cellStart[0]).toBe(0);
    expect(index.cellStart[index.cellId.length]).toBe(index.count);
  });

  it('files every stop under the cell its coordinates imply', () => {
    const index = decodeStopIndex(encode(LONDON));
    for (let k = 0; k < index.cellId.length; k += 1) {
      for (let i = index.cellStart[k]; i < index.cellStart[k + 1]; i += 1) {
        expect(cellIdFor(index.lat[i], index.lon[i], index.cellDeg)).toBe(index.cellId[k]);
      }
    }
  });

  it('handles non-ASCII names', () => {
    const stops = [stop('1', 51.5, -0.1, "King's Cross — St. Pancras"), stop('2', 51.51, -0.11, 'Euston 🚇')];
    const index = decodeStopIndex(encode(stops));
    const names = [stopAt(index, 0).name, stopAt(index, 1).name].sort();
    expect(names).toEqual(["King's Cross — St. Pancras", 'Euston 🚇'].sort());
  });

  it('handles an empty index', () => {
    const index = decodeStopIndex(encode([]));
    expect(index.count).toBe(0);
    expect(queryStopIndex(index, boundsAround(51.5, -0.1, 1))).toEqual([]);
  });

  it('drops stops with no usable coordinates rather than emitting NaN', () => {
    const stops = [stop('good', 51.5, -0.1), { id: 'bad', name: 'bad' } as unknown as StopRecord];
    const index = decodeStopIndex(encode(stops));
    expect(index.count).toBe(1);
    expect(stopAt(index, 0).id).toBe('good');
  });
});

describe('queryStopIndex', () => {
  it('finds a stop in a tight box', () => {
    const index = decodeStopIndex(encode(LONDON));
    const found = queryStopIndex(index, boundsAround(51.5072, -0.1276, 0.0005));
    expect(byId(found)).toEqual(['490000001', '490000002']);
  });

  it('returns nothing for an empty part of the map', () => {
    const index = decodeStopIndex(encode(LONDON));
    expect(queryStopIndex(index, boundsAround(52.5, -1.9, 0.01))).toEqual([]);
  });

  it('returns every stop for a box covering the network', () => {
    const index = decodeStopIndex(encode(LONDON));
    expect(byId(queryStopIndex(index, boundsAround(51.5, -0.13, 0.5)))).toEqual(byId(LONDON));
  });

  // The whole-world case takes the linear-scan branch rather than 600M lookups.
  it('agrees with a brute-force scan over a range of boxes', () => {
    const stops: StopRecord[] = [];
    for (let i = 0; i < 400; i += 1) {
      stops.push(stop(`s${i}`, 51.4 + (i % 20) * 0.011, -0.2 + Math.floor(i / 20) * 0.013));
    }
    const index = decodeStopIndex(encode(stops));

    for (const pad of [0.002, 0.02, 0.09, 5]) {
      for (const [lat, lon] of [
        [51.5, -0.15],
        [51.42, -0.19],
        [51.6, -0.05],
      ]) {
        const bounds = boundsAround(lat, lon, pad);
        // Compared against the Float32 values the format actually stores, which
        // is what a query can see. Using the float64 inputs here would make the
        // oracle stricter than the data and fail on rounding rather than on a
        // real defect.
        const expected = stops.filter(
          (s) =>
            Math.fround(s.lat) >= bounds.south &&
            Math.fround(s.lat) <= bounds.north &&
            Math.fround(s.lon) >= bounds.west &&
            Math.fround(s.lon) <= bounds.east,
        );
        expect(byId(queryStopIndex(index, bounds))).toEqual(byId(expected));
      }
    }
  });

  /**
   * Regression. The encoder originally computed a stop's cell from its float64
   * coordinate while the query read back a Float32 one, so a stop sitting on a
   * cell boundary was filed in one cell and looked for in its neighbour — and
   * simply never returned. 51.51 is the canonical case: float64 holds it as
   * 51.50999999999999, which floors one cell lower than the float32 value does.
   */
  it('finds stops sitting exactly on a cell boundary', () => {
    const boundary = [51.51, 51.52, 51.53, 51.49, 51.5];
    const stops = boundary.map((lat, i) => stop(`b${i}`, lat, -0.12));
    const index = decodeStopIndex(encode(stops));
    for (const [i, lat] of boundary.entries()) {
      const found = queryStopIndex(index, boundsAround(Math.fround(lat), -0.12, 0.0001));
      expect(byId(found)).toContain(`b${i}`);
    }
  });

  it('handles negative longitudes either side of the meridian', () => {
    const stops = [stop('west', 51.5, -0.05), stop('east', 51.5, 0.05)];
    const index = decodeStopIndex(encode(stops));
    expect(byId(queryStopIndex(index, boundsAround(51.5, -0.05, 0.001)))).toEqual(['west']);
    expect(byId(queryStopIndex(index, boundsAround(51.5, 0.05, 0.001)))).toEqual(['east']);
  });
});

describe('decodeStopIndex rejects a bad buffer', () => {
  it('rejects one too short to hold a header', () => {
    expect(() => decodeStopIndex(new ArrayBuffer(8))).toThrow(StopIndexFormatError);
  });

  it('rejects a wrong magic', () => {
    const buffer = new ArrayBuffer(64);
    new DataView(buffer).setUint32(0, 0xdeadbeef, true);
    expect(() => decodeStopIndex(buffer)).toThrow(/magic/);
  });

  it('rejects a future version', () => {
    const buffer = encode(LONDON);
    new DataView(buffer).setUint32(4, 99, true);
    expect(() => decodeStopIndex(buffer)).toThrow(/version/);
  });

  // A half-written file is the realistic corruption, not a random one.
  it('rejects a truncated body', () => {
    const buffer = encode(LONDON);
    expect(() => decodeStopIndex(buffer.slice(0, buffer.byteLength - 8))).toThrow(
      StopIndexFormatError,
    );
  });
});

/**
 * Against the real committed artefact, not a fixture.
 *
 * The round-trip tests above prove the encoder and decoder agree with each
 * other; they would still both pass if `npm run stop-index` had never been run,
 * or had been run against a stale `data-src/stops.json`. This is the one that
 * fails if what actually ships is wrong.
 */
describe('the shipped stops.bin', () => {
  // From the project root rather than import.meta.url: vitest runs these under
  // happy-dom, where import.meta.url is an http URL and not a file path.
  const buffer = (() => {
    const bytes = readFileSync(resolve(process.cwd(), 'public/data/stops.bin'));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  })();

  it('decodes, and holds the number of stops the manifest claims', () => {
    const index = decodeStopIndex(buffer);
    expect(index.count).toBe(manifest.stops.count);
    expect(index.count).toBeGreaterThan(30000);
    expect(index.cellDeg).toBeCloseTo(STOP_CELL_DEG, 6);
  });

  it('answers a central London box with real, named stops', () => {
    const index = decodeStopIndex(buffer);
    // ~1km around Trafalgar Square. Dense enough that an empty answer means
    // something is broken rather than that the box was unlucky.
    const found = queryStopIndex(index, boundsAround(51.5072, -0.1276, 0.006));
    expect(found.length).toBeGreaterThan(20);
    for (const stop of found) {
      expect(stop.id).not.toBe('');
      expect(stop.name).not.toBe('');
      expect(stop.lat).toBeGreaterThan(51.49);
      expect(stop.lat).toBeLessThan(51.52);
    }
  });

  it('files every stop in the cell its stored coordinates imply', () => {
    const index = decodeStopIndex(buffer);
    for (let k = 0; k < index.cellId.length; k += 1) {
      for (let i = index.cellStart[k]; i < index.cellStart[k + 1]; i += 1) {
        expect(cellIdFor(index.lat[i], index.lon[i], index.cellDeg)).toBe(index.cellId[k]);
      }
    }
  });
});
