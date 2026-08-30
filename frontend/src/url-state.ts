import { FILTER_ORDER } from './config';
import type { BasemapMode } from './config';
import type { FilterKey } from './types';

/**
 * The app's state, in the address bar.
 *
 * Nothing used to survive a reload: the camera, the filters, the basemap choice
 * and the selection were all discarded and the intro fly-in replayed, and there
 * was no way to send anyone a link to a vehicle or a place. For a live map of a
 * city that is the difference between a toy and something you can point at.
 *
 * Query parameters rather than a hash fragment. The hash is the convention for
 * a bare camera (`#12/51.5/-0.12`), but this carries a selection and a filter
 * set as well, and `URLSearchParams` is a parser that already exists and is
 * already correct about escaping. Everything is written with `replaceState`, so
 * a pan never adds a history entry — the back button stays the app's, not the
 * camera's.
 *
 * Every field is optional in both directions. A hand-edited or truncated URL
 * degrades to a default rather than throwing: this runs before the map exists,
 * and a parse error here would be a white screen.
 */

export type CameraState = {
  lon: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
};

export type UrlState = {
  camera: CameraState | null;
  selectedId: string | null;
  selectedLines: string[];
  /** Null means "the default, everything on" — absent from the URL. */
  filters: Record<FilterKey, boolean> | null;
  basemap: BasemapMode | null;
};

export const EMPTY_URL_STATE: UrlState = {
  camera: null,
  selectedId: null,
  selectedLines: [],
  filters: null,
  basemap: null,
};

const CAMERA_PARAM = 'at';
const SELECTED_PARAM = 'v';
const LINES_PARAM = 'lines';
const MODES_PARAM = 'modes';
const BASEMAP_PARAM = 'map';

const BASEMAP_MODES = ['auto', 'day', 'night'] as const;

/** ~1.1m, the same precision the vehicle feed is rounded to on the wire. */
const COORD_DP = 5;
const ZOOM_DP = 2;
const ANGLE_DP = 1;

const round = (value: number, dp: number) => Number(value.toFixed(dp));

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

/** `lat,lon,zoom,bearing,pitch` — one parameter, because they only mean anything together. */
function encodeCamera(camera: CameraState): string {
  return [
    round(camera.lat, COORD_DP),
    round(camera.lon, COORD_DP),
    round(camera.zoom, ZOOM_DP),
    round(camera.bearing, ANGLE_DP),
    round(camera.pitch, ANGLE_DP),
  ].join(',');
}

function decodeCamera(raw: string | null): CameraState | null {
  if (!raw) {
    return null;
  }
  const parts = raw.split(',').map(Number);
  const [lat, lon, zoom, bearing = 0, pitch = 0] = parts;
  if (![lat, lon, zoom, bearing, pitch].every(isFiniteNumber)) {
    return null;
  }
  // Bounds-checked rather than trusted: MapLibre throws on a latitude outside
  // the Mercator range, and a link is the one input a stranger controls.
  if (lat < -85 || lat > 85 || lon < -180 || lon > 180 || zoom < 0 || zoom > 24) {
    return null;
  }
  return {
    lat,
    lon,
    zoom,
    bearing: bearing % 360,
    pitch: Math.max(0, Math.min(85, pitch)),
  };
}

function decodeFilters(raw: string | null): Record<FilterKey, boolean> | null {
  if (raw === null) {
    return null;
  }
  const enabled = new Set(raw.split(',').filter(Boolean));
  // An unrecognised mode name is ignored rather than rejected, so a link made
  // by a newer build still opens on an older one with the modes it understands.
  const known = FILTER_ORDER.filter((key) => enabled.has(key));
  if (known.length === 0) {
    return null;
  }
  const filters = {} as Record<FilterKey, boolean>;
  for (const key of FILTER_ORDER) {
    filters[key] = enabled.has(key);
  }
  return filters;
}

function decodeBasemap(raw: string | null): BasemapMode | null {
  return BASEMAP_MODES.includes(raw as BasemapMode) ? (raw as BasemapMode) : null;
}

export function parseUrlState(search: string): UrlState {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return EMPTY_URL_STATE;
  }
  return {
    camera: decodeCamera(params.get(CAMERA_PARAM)),
    selectedId: params.get(SELECTED_PARAM) || null,
    selectedLines: (params.get(LINES_PARAM) || '').split(',').filter(Boolean),
    filters: decodeFilters(params.get(MODES_PARAM)),
    basemap: decodeBasemap(params.get(BASEMAP_PARAM)),
  };
}

/**
 * The state as a query string, with anything at its default left out — a link
 * to "central London right now" should not carry six parameters saying so.
 */
export function buildUrlSearch(state: UrlState, base: string): string {
  const params = new URLSearchParams(base);
  const set = (key: string, value: string | null) => {
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
  };

  set(CAMERA_PARAM, state.camera ? encodeCamera(state.camera) : null);
  set(SELECTED_PARAM, state.selectedId);
  set(LINES_PARAM, state.selectedLines.length > 0 ? state.selectedLines.join(',') : null);
  const allModesOn = state.filters === null || FILTER_ORDER.every((key) => state.filters?.[key]);
  set(
    MODES_PARAM,
    allModesOn ? null : FILTER_ORDER.filter((key) => state.filters?.[key]).join(','),
  );
  set(BASEMAP_PARAM, state.basemap && state.basemap !== 'auto' ? state.basemap : null);

  // Commas back to literal commas. `URLSearchParams` percent-encodes them, but
  // they are sub-delims under RFC 3986 and perfectly legal unencoded in a query
  // — and this is a link a person is meant to look at and paste. It saves ~20
  // characters on a typical link and round-trips identically, which
  // `url-state.test.ts` asserts rather than assumes.
  const query = params.toString().replace(/%2C/g, ',');
  return query ? `?${query}` : '';
}

/**
 * Write the state into the address bar without touching history.
 *
 * `replaceState` throws on some origins a WebView can be served from, and a
 * failure here must never take the map down with it — the URL is a convenience,
 * the map is the app.
 */
export function writeUrlState(state: UrlState): void {
  try {
    const url = new URL(window.location.href);
    const search = buildUrlSearch(state, url.search);
    if (search === url.search || (search === '' && url.search === '')) {
      return;
    }
    window.history.replaceState(null, '', `${url.pathname}${search}${url.hash}`);
  } catch {
    // Ignored on purpose: see above.
  }
}

/** The current shareable link, for `navigator.share` and copy-to-clipboard. */
export function shareableUrl(state: UrlState): string {
  try {
    const url = new URL(window.location.href);
    // A Capacitor WebView is served from capacitor://localhost, which is not a
    // link anyone else can open. Share the real site instead.
    const base =
      url.protocol === 'http:' || url.protocol === 'https:'
        ? `${url.origin}${url.pathname}`
        : 'https://watchlondonmove.maybeitssoftware.co.uk/';
    return `${base}${buildUrlSearch(state, '')}`;
  } catch {
    return 'https://watchlondonmove.maybeitssoftware.co.uk/';
  }
}
