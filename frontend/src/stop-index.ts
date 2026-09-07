import type { Bounds } from './types';

/**
 * The 33,082-stop index, as a binary blob with its spatial grid already built.
 *
 * `stops.json` was 2.57MB of JSON parsed on the main thread into 33,082 objects
 * and then re-bucketed into a grid — well over 100ms of blocking on a phone,
 * landing during the first zoom to street level, which is exactly when the user
 * is panning. None of that work was necessary: the data changes a few times a
 * year, so the grid can be built once at build time and shipped.
 *
 * What ships instead is two `Float32Array`s of coordinates, the grid as a sorted
 * cell table, and one UTF-8 blob each for ids and names. Loading it is a `fetch`
 * plus an `ArrayBuffer` — no parse, no per-stop object. Objects are materialised
 * only for the stops a query actually returns, which above zoom 15 is a couple
 * of hundred rather than thirty-three thousand.
 *
 * Float32 holds a latitude near 51.5 to about 0.4m, comfortably below the ~1.1m
 * the source data claims and far below the size of the dot drawn for it. These
 * coordinates are only ever drawn; nothing matches on them. (The stop matching
 * in InfoPanel works on the socket feed's own coordinates, not on these.)
 *
 * The encoder lives in `scripts/encode-stop-index.mjs` — build-time only, so it
 * stays out of the bundle — and `stop-index.test.ts` round-trips the two against
 * each other, which is what keeps the layout below honest.
 */

/** 'WLMS', little-endian. */
export const STOP_INDEX_MAGIC = 0x534d4c57;
export const STOP_INDEX_VERSION = 1;

/**
 * ~1.1km of latitude. The stops layer only draws above zoom 15, where a viewport
 * spans a couple of hundredths of a degree, so a query touches a handful of
 * cells holding ~25 stops each.
 */
export const STOP_CELL_DEG = 0.01;

/**
 * Cell ids are packed into one unsigned integer so the table can be sorted and
 * binary-searched. The offset keeps both axes non-negative; 16 bits each spans
 * ±327 degrees at this cell size, which is the whole planet several times over.
 */
export const CELL_ORIGIN = 32768;

export function cellIdFor(lat: number, lon: number, cellDeg: number): number {
  const y = Math.floor(lat / cellDeg) + CELL_ORIGIN;
  const x = Math.floor(lon / cellDeg) + CELL_ORIGIN;
  return y * 65536 + x;
}

/** Byte offset of the first typed-array section. Everything before it is scalar. */
export const STOP_INDEX_HEADER_BYTES = 24;

export type StopRecord = {
  id: string;
  lat: number;
  lon: number;
  name: string;
};

export type StopIndex = {
  count: number;
  cellDeg: number;
  lat: Float32Array;
  lon: Float32Array;
  /** Sorted ascending, one entry per occupied cell. */
  cellId: Uint32Array;
  /** `cellCount + 1` entries; cell k spans stops [cellStart[k], cellStart[k + 1]). */
  cellStart: Uint32Array;
  idOffset: Uint32Array;
  nameOffset: Uint32Array;
  idBlob: Uint8Array;
  nameBlob: Uint8Array;
};

export class StopIndexFormatError extends Error {}

/**
 * Read the header and hand back views onto the same buffer.
 *
 * Nothing is copied and nothing is decoded here — this is deliberately O(1) in
 * the number of stops, which is the entire point of the format.
 */
export function decodeStopIndex(buffer: ArrayBuffer): StopIndex {
  if (buffer.byteLength < STOP_INDEX_HEADER_BYTES) {
    throw new StopIndexFormatError('stop index is shorter than its header');
  }
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== STOP_INDEX_MAGIC) {
    throw new StopIndexFormatError(`stop index magic is 0x${magic.toString(16)}`);
  }
  const version = view.getUint32(4, true);
  if (version !== STOP_INDEX_VERSION) {
    throw new StopIndexFormatError(`stop index version ${version} is not supported`);
  }
  const count = view.getUint32(8, true);
  const cellCount = view.getUint32(12, true);
  const cellDeg = view.getUint32(16, true) / 1e6;
  if (cellDeg <= 0) {
    throw new StopIndexFormatError('stop index cell size is not positive');
  }

  // Laid out so every typed-array section is 4-byte aligned: the two blobs,
  // whose lengths are arbitrary, come last and are only ever read as bytes.
  const latAt = STOP_INDEX_HEADER_BYTES;
  const lonAt = latAt + count * 4;
  const cellIdAt = lonAt + count * 4;
  const cellStartAt = cellIdAt + cellCount * 4;
  const idOffsetAt = cellStartAt + (cellCount + 1) * 4;
  const nameOffsetAt = idOffsetAt + (count + 1) * 4;
  const idBlobAt = nameOffsetAt + (count + 1) * 4;

  if (buffer.byteLength < idBlobAt) {
    throw new StopIndexFormatError('stop index is truncated');
  }

  const idOffset = new Uint32Array(buffer, idOffsetAt, count + 1);
  const nameOffset = new Uint32Array(buffer, nameOffsetAt, count + 1);
  const idBlobLength = idOffset[count];
  const nameBlobAt = idBlobAt + idBlobLength;
  const nameBlobLength = nameOffset[count];

  if (buffer.byteLength < nameBlobAt + nameBlobLength) {
    throw new StopIndexFormatError('stop index string blobs are truncated');
  }

  return {
    count,
    cellDeg,
    lat: new Float32Array(buffer, latAt, count),
    lon: new Float32Array(buffer, lonAt, count),
    cellId: new Uint32Array(buffer, cellIdAt, cellCount),
    cellStart: new Uint32Array(buffer, cellStartAt, cellCount + 1),
    idOffset,
    nameOffset,
    idBlob: new Uint8Array(buffer, idBlobAt, idBlobLength),
    nameBlob: new Uint8Array(buffer, nameBlobAt, nameBlobLength),
  };
}

const textDecoder = new TextDecoder();

function readString(blob: Uint8Array, offsets: Uint32Array, i: number): string {
  return textDecoder.decode(blob.subarray(offsets[i], offsets[i + 1]));
}

export function stopAt(index: StopIndex, i: number): StopRecord {
  return {
    id: readString(index.idBlob, index.idOffset, i),
    name: readString(index.nameBlob, index.nameOffset, i),
    lat: index.lat[i],
    lon: index.lon[i],
  };
}

/** Position of `id` in the sorted cell table, or -1. */
function findCell(cellId: Uint32Array, id: number): number {
  let low = 0;
  let high = cellId.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const value = cellId[mid];
    if (value === id) {
      return mid;
    }
    if (value < id) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return -1;
}

/**
 * Every stop inside `bounds`.
 *
 * The cell table is sorted, so a cell is found by binary search rather than by
 * building a Map at load — which would have put back a share of the per-stop
 * work this format exists to remove.
 */
export function queryStopIndex(index: StopIndex, bounds: Bounds): StopRecord[] {
  const { cellDeg } = index;
  const minY = Math.floor(bounds.south / cellDeg);
  const maxY = Math.floor(bounds.north / cellDeg);
  const minX = Math.floor(bounds.west / cellDeg);
  const maxX = Math.floor(bounds.east / cellDeg);

  const within = (i: number) =>
    index.lat[i] >= bounds.south &&
    index.lat[i] <= bounds.north &&
    index.lon[i] >= bounds.west &&
    index.lon[i] <= bounds.east;

  const found: StopRecord[] = [];

  // A box wider than the network is cheaper to answer by scanning every stop
  // than by walking its cells: a whole-world bounds would be 600M empty lookups.
  const cells = (maxY - minY + 1) * (maxX - minX + 1);
  if (cells > index.cellId.length) {
    for (let i = 0; i < index.count; i += 1) {
      if (within(i)) {
        found.push(stopAt(index, i));
      }
    }
    return found;
  }

  for (let y = minY; y <= maxY; y += 1) {
    const rowBase = (y + CELL_ORIGIN) * 65536;
    for (let x = minX; x <= maxX; x += 1) {
      const cell = findCell(index.cellId, rowBase + (x + CELL_ORIGIN));
      if (cell < 0) {
        continue;
      }
      const end = index.cellStart[cell + 1];
      for (let i = index.cellStart[cell]; i < end; i += 1) {
        if (within(i)) {
          found.push(stopAt(index, i));
        }
      }
    }
  }
  return found;
}

let cachedIndexForNames: StopIndex | null = null;
let cachedNames: string[] | null = null;

function getCachedNames(index: StopIndex): string[] {
  if (cachedIndexForNames === index && cachedNames) {
    return cachedNames;
  }
  const names = new Array<string>(index.count);
  for (let i = 0; i < index.count; i += 1) {
    names[i] = readString(index.nameBlob, index.nameOffset, i);
  }
  cachedIndexForNames = index;
  cachedNames = names;
  return names;
}

/**
 * Search stops by name.
 * Returns up to `limit` unique stop records matching the query string.
 */
export function searchStopIndex(index: StopIndex, query: string, limit = 8): StopRecord[] {
  const needle = query.trim().toLowerCase();
  if (!needle || needle.length < 2) {
    return [];
  }

  const names = getCachedNames(index);
  const found: StopRecord[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < index.count; i += 1) {
    const name = names[i];
    if (name.toLowerCase().includes(needle)) {
      const key = name.toLowerCase().replace(/\s+(stop\s+[a-z0-9]+|\bstand\b)/i, '').trim();
      if (!seen.has(key)) {
        seen.add(key);
        found.push(stopAt(index, i));
        if (found.length >= limit) {
          break;
        }
      }
    }
  }

  return found;
}
