/**
 * Encoder for the binary stop index read by `src/stop-index.ts`.
 *
 * Build-time only, and in `scripts/` rather than `src/` so it never reaches the
 * bundle: the app only ever decodes. The layout constants are duplicated across
 * the two files, which is a real hazard — `src/stop-index.test.ts` round-trips
 * this encoder against that decoder precisely so a drift between them is a red
 * test rather than a map with no stops on it.
 *
 * See the header comment on `src/stop-index.ts` for why the format is what it is.
 */

/** 'WLMS', little-endian. Must match STOP_INDEX_MAGIC. */
export const STOP_INDEX_MAGIC = 0x534d4c57;
export const STOP_INDEX_VERSION = 1;
export const STOP_CELL_DEG = 0.01;
export const CELL_ORIGIN = 32768;
export const STOP_INDEX_HEADER_BYTES = 24;

export function cellIdFor(lat, lon, cellDeg) {
  const y = Math.floor(lat / cellDeg) + CELL_ORIGIN;
  const x = Math.floor(lon / cellDeg) + CELL_ORIGIN;
  return y * 65536 + x;
}

/**
 * `stops` is the array from `public/data/stops.json`. Returns a `Uint8Array`.
 *
 * Stops are sorted by cell id so that a cell's members are contiguous, which is
 * what lets the grid be two flat arrays — the ids and a start offset — instead
 * of a Map of arrays that would have to be rebuilt on every load.
 */
export function encodeStopIndex(stops, cellDeg = STOP_CELL_DEG) {
  const usable = stops.filter(
    (stop) => Number.isFinite(stop?.lat) && Number.isFinite(stop?.lon),
  );
  // Cells are computed from the Float32 values that will actually be stored,
  // not from the float64 input. The two disagree on cell boundaries — 51.51 is
  // 51.50999999999999 in float64, which floors into the cell below, but is
  // exactly 51.51 in float32, which floors into the cell above — and a stop
  // filed under one cell but read back into another is invisible to every query
  // that does not happen to cover both. Rounding first makes filing and lookup
  // agree by construction.
  const sorted = usable
    .map((stop) => {
      const lat = Math.fround(stop.lat);
      const lon = Math.fround(stop.lon);
      return { stop, lat, lon, cell: cellIdFor(lat, lon, cellDeg) };
    })
    .sort((a, b) => a.cell - b.cell);

  const count = sorted.length;
  const encoder = new TextEncoder();
  const idBytes = sorted.map((entry) => encoder.encode(entry.stop.id ?? ''));
  const nameBytes = sorted.map((entry) => encoder.encode(entry.stop.name ?? ''));

  const cellIds = [];
  const cellStarts = [];
  for (let i = 0; i < count; i += 1) {
    if (cellIds.length === 0 || cellIds[cellIds.length - 1] !== sorted[i].cell) {
      cellIds.push(sorted[i].cell);
      cellStarts.push(i);
    }
  }
  // Sentinel, so the last cell's end needs no special case at read time.
  cellStarts.push(count);
  const cellCount = cellIds.length;

  let idBlobLength = 0;
  for (const bytes of idBytes) {
    idBlobLength += bytes.length;
  }
  let nameBlobLength = 0;
  for (const bytes of nameBytes) {
    nameBlobLength += bytes.length;
  }

  const latAt = STOP_INDEX_HEADER_BYTES;
  const lonAt = latAt + count * 4;
  const cellIdAt = lonAt + count * 4;
  const cellStartAt = cellIdAt + cellCount * 4;
  const idOffsetAt = cellStartAt + (cellCount + 1) * 4;
  const nameOffsetAt = idOffsetAt + (count + 1) * 4;
  const idBlobAt = nameOffsetAt + (count + 1) * 4;
  const nameBlobAt = idBlobAt + idBlobLength;
  const total = nameBlobAt + nameBlobLength;

  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  view.setUint32(0, STOP_INDEX_MAGIC, true);
  view.setUint32(4, STOP_INDEX_VERSION, true);
  view.setUint32(8, count, true);
  view.setUint32(12, cellCount, true);
  view.setUint32(16, Math.round(cellDeg * 1e6), true);
  view.setUint32(20, 0, true);

  const lat = new Float32Array(buffer, latAt, count);
  const lon = new Float32Array(buffer, lonAt, count);
  const cellId = new Uint32Array(buffer, cellIdAt, cellCount);
  const cellStart = new Uint32Array(buffer, cellStartAt, cellCount + 1);
  const idOffset = new Uint32Array(buffer, idOffsetAt, count + 1);
  const nameOffset = new Uint32Array(buffer, nameOffsetAt, count + 1);
  const bytes = new Uint8Array(buffer);

  let idCursor = 0;
  let nameCursor = 0;
  for (let i = 0; i < count; i += 1) {
    lat[i] = sorted[i].lat;
    lon[i] = sorted[i].lon;
    idOffset[i] = idCursor;
    nameOffset[i] = nameCursor;
    bytes.set(idBytes[i], idBlobAt + idCursor);
    bytes.set(nameBytes[i], nameBlobAt + nameCursor);
    idCursor += idBytes[i].length;
    nameCursor += nameBytes[i].length;
  }
  idOffset[count] = idCursor;
  nameOffset[count] = nameCursor;
  cellId.set(cellIds);
  cellStart.set(cellStarts);

  return new Uint8Array(buffer);
}
