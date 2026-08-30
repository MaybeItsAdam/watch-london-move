import { AmbientLight, DirectionalLight, LightingEffect } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { routeLineId, vehicleLabel, vehicleLivery } from './config';
import type { Bounds, VehicleModels, VehicleRow } from './types';

// ---------------------------------------------------------------------------
// Level of detail
// ---------------------------------------------------------------------------
//
// Vehicles used to be drawn as glTF models at every zoom, scaled up by 2^(16-z)
// to hold a constant on-screen size. That only holds for an unpitched camera:
// at pitch 55 the ground scale varies several-fold between the horizon and the
// foreground, so a size chosen to read at the horizon becomes a kilometre-long
// slab in front of it, and central London fills with overlapping boxes.
//
// So the map now has three bands. Zoomed out it is a field of dots — the whole
// fleet, legible, showing where London is moving. Zoomed in it is vehicles.
// Between them the two cross-fade. The dot band is also far cheaper: one
// instanced layer instead of three PBR scenegraphs, which is what lets every
// vehicle be drawn rather than density-thinned away.
//
// The band is set by density, not by when a model becomes legible. A pitched
// camera magnifies the foreground several-fold over the centre scale the size
// is computed from, so a bus that measures 11px at the middle of the screen is
// nearer 40px at the bottom of it — fine on a street, a wall of overlapping
// boxes anywhere central London is still full-frame.
export const LOD_MIN_ZOOM = 13.5;
const LOD_MAX_ZOOM = 14.5;
/** Route blinds appear once models are most of the way in — before that the
 *  labels are bigger than the vehicles they name. */
const LABEL_MIN_ZOOM = 14;

const DOT_RADIUS_BUS = 2.6;
const DOT_RADIUS_RAIL = 4.2;
const DOT_RADIUS_SELECTED = 8;
const DOT_CASING: [number, number, number, number] = [11, 15, 26, 150];

/** Alpha applied to vehicles that are not on the focused line. */
const DIMMED_ALPHA = 45;

const MAX_LABELS = 220;
/** Label bin size in degrees at zoom 0, halving each level to hold ~44px —
 *  about one route blind, so at most one label lands per blind-sized cell. */
const LABEL_CELL_DEG_AT_ZOOM_0 = 30.9;

/**
 * deck's default lights are tuned for extruded polygons, and under them the
 * vehicle bodies come out muddy — a TfL red arrives on screen as brown. Lifting
 * the ambient term is what recovers the livery colour; the two directionals,
 * one high and one low from the opposite side, are there to keep the roof, the
 * sides and the window bands distinguishable rather than flattening the model
 * back into a coloured blob.
 *
 * A module-level singleton, not a per-frame value: deck rebuilds its lighting
 * uniforms whenever the effect identity changes.
 */
export const vehicleLighting = new LightingEffect({
  ambient: new AmbientLight({ color: [255, 255, 255], intensity: 2.1 }),
  key: new DirectionalLight({
    color: [255, 251, 240],
    intensity: 1.35,
    direction: [-1.2, -3, -1.6],
  }),
  fill: new DirectionalLight({ color: [206, 220, 255], intensity: 0.55, direction: [1.6, -1, 1] }),
});

/** One bucket per model shape: ScenegraphLayer takes a single scenegraph, not a
 *  per-row accessor, so each shape needs its own layer and so its own data. */
export type FleetBuckets = {
  all: VehicleRow[];
  bus: VehicleRow[];
  tram: VehicleRow[];
  dlr: VehicleRow[];
  elizabeth: VehicleRow[];
  /** Deep-tube and Overground stock — everything without a shape of its own. */
  rail: VehicleRow[];
};

const BUCKET_KEYS = ['all', 'bus', 'tram', 'dlr', 'elizabeth', 'rail'] as const;
type BucketKey = (typeof BUCKET_KEYS)[number];

/**
 * Scratch space for the bucketing pass, reused across frames. Rows are written
 * in here first and only copied out when membership actually changed, so a
 * steady fleet costs no allocation at all.
 */
const scratch: Record<BucketKey, VehicleRow[]> = {
  all: [],
  bus: [],
  tram: [],
  dlr: [],
  elizabeth: [],
  rail: [],
};
const scratchLength: Record<BucketKey, number> = {
  all: 0,
  bus: 0,
  tram: 0,
  dlr: 0,
  elizabeth: 0,
  rail: 0,
};

function collect(key: BucketKey, row: VehicleRow) {
  scratch[key][scratchLength[key]] = row;
  scratchLength[key] += 1;
}

/**
 * Hand back the previous array when the membership is identical, and a fresh
 * one when it is not.
 *
 * The identity of this array is load-bearing. deck.gl compares `props.data`
 * by reference (`diffDataProps` in @deck.gl/core), and on any change it calls
 * `attributeManager.invalidateAll()` — which re-runs *every* accessor over
 * *every* row, `updateTriggers` notwithstanding. Returning a new array each
 * frame, as this used to, therefore made the `updateTriggers` below dead code
 * and re-derived colour, radius and text sixty times a second for a fleet
 * whose colours had not changed. Reusing the array when nothing joined or left
 * is what lets the triggers finally do their job; positions still reach the
 * GPU because `getPosition` carries its own per-frame trigger.
 *
 * The comparison is a reference check per row, not a deep one: `updateRow`
 * mutates the row objects in place, so a row that is still in the fleet is
 * still the same object.
 */
function reconcile(previous: VehicleRow[] | undefined, key: BucketKey): VehicleRow[] {
  const buffer = scratch[key];
  const length = scratchLength[key];
  if (previous && previous.length === length) {
    let same = true;
    for (let i = 0; i < length; i += 1) {
      if (previous[i] !== buffer[i]) {
        same = false;
        break;
      }
    }
    if (same) {
      return previous;
    }
  }
  const next = new Array<VehicleRow>(length);
  for (let i = 0; i < length; i += 1) {
    next[i] = buffer[i];
  }
  return next;
}

/**
 * Apply the sidebar filters and split the fleet by model shape in one pass.
 * This runs on every animation frame — positions interpolate, so the rows are
 * rebuilt regardless — which is why it is one pass and not the filter plus
 * three `Array.filter` scans it replaces.
 *
 * `previous` is last frame's result. Each bucket that still holds exactly the
 * same rows is handed back unchanged, so the common case — a fleet that is
 * moving but whose membership only turns over on a server payload — produces
 * no new arrays and no deck.gl attribute invalidation.
 */
export function bucketFleet(
  rows: VehicleRow[],
  include: (row: VehicleRow) => boolean,
  previous?: FleetBuckets | null,
): FleetBuckets {
  for (const key of BUCKET_KEYS) {
    scratchLength[key] = 0;
  }

  for (const row of rows) {
    if (!include(row)) {
      continue;
    }
    collect('all', row);
    // `all` is not a vehicle type, so a type colliding with it would be a bug
    // rather than a bucket; every other key is one of the model shapes.
    const type = row.type as BucketKey;
    if (type !== 'all' && type in scratch) {
      collect(type, row);
    } else {
      collect('rail', row);
    }
  }

  const buckets = {} as FleetBuckets;
  let reusedEverything = previous != null;
  for (const key of BUCKET_KEYS) {
    const next = reconcile(previous?.[key], key);
    buckets[key] = next;
    if (previous?.[key] !== next) {
      reusedEverything = false;
    }
  }
  // Nothing joined or left any bucket: hand back the very same object, so
  // callers holding it as a memo dependency see no change either.
  return reusedEverything && previous ? previous : buckets;
}

function hash01(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

/**
 * `hash01` walks the whole id string, and a vehicle's id never changes, so the
 * label ranking memoises it. Bounded because ids leave the fleet and never come
 * back: past the cap the table is dropped whole rather than evicted one at a
 * time, which is cheap and correct — the values are pure functions of the key.
 */
const RANK_CACHE_MAX = 20000;
const rankCache = new Map<string, number>();

function labelRank(row: VehicleRow): number {
  let rank = rankCache.get(row.id);
  if (rank === undefined) {
    if (rankCache.size >= RANK_CACHE_MAX) {
      rankCache.clear();
    }
    rank = hash01(row.id);
    rankCache.set(row.id, rank);
  }
  // Rail is rarer and more informative than a bus, so it wins a contested cell
  // regardless of hash.
  return row.type === 'bus' ? rank : rank - 1;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

// Reused across calls; `chooseLabels` clears them on entry and nothing outlives
// the call. At street zoom this used to be a fresh Map plus an object per
// occupied cell, every frame.
const bestRank = new Map<number, number>();
const bestRow = new Map<number, VehicleRow>();
const railSurvivors: VehicleRow[] = [];
const busSurvivors: VehicleRow[] = [];
const byLabelRank = (a: VehicleRow, b: VehicleRow) => labelRank(a) - labelRank(b);

/**
 * Pick which vehicles get a route blind. Labels over-plot far faster than
 * vehicles do, so at most one lands per blind-sized screen cell, chosen by a
 * hash of the vehicle id — stable, so a label does not hop between neighbours
 * frame to frame — and the survivors are capped. The selection always keeps its
 * label.
 */
function chooseLabels(
  rows: VehicleRow[],
  zoom: number,
  selectedId: string | null,
  bounds: Bounds | null,
): VehicleRow[] {
  const cellDeg = LABEL_CELL_DEG_AT_ZOOM_0 / Math.pow(2, zoom);
  bestRank.clear();
  bestRow.clear();
  let selected: VehicleRow | null = null;

  for (const row of rows) {
    if (row.id === selectedId) {
      selected = row;
      continue;
    }
    // The socket subscription is padded well beyond the viewport, and at street
    // zoom most of the fleet it carries is off screen. Spending the label budget
    // on vehicles nobody can see is how Trafalgar Square ended up with one
    // labelled bus.
    if (
      bounds &&
      (row.position[0] < bounds.west ||
        row.position[0] > bounds.east ||
        row.position[1] < bounds.south ||
        row.position[1] > bounds.north)
    ) {
      continue;
    }
    // Numeric cell keys: string keys would allocate twice per vehicle per frame.
    const cell =
      (Math.floor(row.position[0] / cellDeg) + 32768) * 65536 +
      Math.floor(row.position[1] / cellDeg) +
      32768;
    const rank = labelRank(row);
    const existing = bestRank.get(cell);
    // Two parallel maps rather than one map of {row, rank}: the object was an
    // allocation per occupied cell per call, and neither half outlives the call.
    if (existing === undefined || rank < existing) {
      bestRank.set(cell, rank);
      bestRow.set(cell, row);
    }
  }

  const labels: VehicleRow[] = [];
  if (selected) {
    labels.push(selected);
  }

  if (bestRow.size <= MAX_LABELS) {
    for (const row of bestRow.values()) {
      labels.push(row);
    }
    return labels;
  }

  // Central London holds several hundred rail vehicles, so ranking the whole
  // set and taking the top slice would spend the entire budget on rail and
  // never label a bus. The budget is split instead, and either side's unclaimed
  // share falls to the other.
  railSurvivors.length = 0;
  busSurvivors.length = 0;
  for (const row of bestRow.values()) {
    (row.type === 'bus' ? busSurvivors : railSurvivors).push(row);
  }
  railSurvivors.sort(byLabelRank);
  busSurvivors.sort(byLabelRank);
  const railBudget = Math.min(railSurvivors.length, Math.round(MAX_LABELS * 0.55));
  const busBudget = Math.min(busSurvivors.length, MAX_LABELS - railBudget);
  const railTake = Math.min(railSurvivors.length, MAX_LABELS - busBudget);

  for (let i = 0; i < railTake; i += 1) {
    labels.push(railSurvivors[i]);
  }
  for (let i = 0; i < busBudget; i += 1) {
    labels.push(busSurvivors[i]);
  }
  return labels;
}

/**
 * Label placement, throttled.
 *
 * Which vehicles carry a blind is deliberately hash-stable so labels do not hop
 * between neighbours — which also means the answer barely changes between one
 * frame and the next, and recomputing it at 60Hz bought nothing. Their
 * *positions* are not throttled: the rows in the returned array are the live
 * vehicle objects, and the TextLayer's `getPosition` carries the per-frame
 * epoch, so a label tracks its vehicle smoothly regardless of this interval.
 *
 * Returning the same array between recomputes matters as much as skipping the
 * work: it is what keeps deck.gl from re-rasterising the label atlas — see
 * `reconcile`.
 */
const LABEL_REFRESH_MS = 250;
let labelsAt = 0;
let labelsResult: VehicleRow[] = [];
let labelsRows: VehicleRow[] | null = null;
let labelsSelectedId: string | null = null;

function labelsFor(
  rows: VehicleRow[],
  zoom: number,
  selectedId: string | null,
  bounds: Bounds | null,
): VehicleRow[] {
  const now = performance.now();
  // `rows` changes identity exactly when the fleet's membership does, so a
  // vehicle that has left never lingers in a stale label set.
  if (
    labelsRows === rows &&
    labelsSelectedId === selectedId &&
    now - labelsAt < LABEL_REFRESH_MS
  ) {
    return labelsResult;
  }
  labelsAt = now;
  labelsRows = rows;
  labelsSelectedId = selectedId;
  labelsResult = chooseLabels(rows, zoom, selectedId, bounds);
  return labelsResult;
}

/** White or near-black, whichever the livery can carry. */
function labelInk(livery: [number, number, number]): [number, number, number] {
  const luminance = (0.2126 * livery[0] + 0.7152 * livery[1] + 0.0722 * livery[2]) / 255;
  return luminance > 0.6 ? [16, 20, 32] : [255, 255, 255];
}

type StateAccessors = {
  isDimmed: (row: VehicleRow) => boolean;
  vehicleColor: (row: VehicleRow) => [number, number, number, number];
  emphasis: (row: VehicleRow) => boolean;
  labelInkFor: (row: VehicleRow) => [number, number, number];
  labelBackgroundFor: (row: VehicleRow) => [number, number, number, number];
};

/**
 * The selection/focus-dependent accessors, rebuilt only when the state they
 * close over changes.
 *
 * deck.gl invokes these when an `updateTriggers` entry fires, which is exactly
 * when this cache misses — so building them per frame only ever produced
 * garbage for the frames on which nothing called them.
 */
let accessorCacheKey: string | null = null;
let accessorCache: StateAccessors | null = null;

function accessorsFor(
  key: string,
  selectedId: string | null,
  hoveredId: string | null,
  focusLine: string | null,
): StateAccessors {
  if (accessorCache && accessorCacheKey === key) {
    return accessorCache;
  }
  const isDimmed = (row: VehicleRow) => focusLine !== null && routeLineId(row) !== focusLine;
  const vehicleColor = (row: VehicleRow): [number, number, number, number] => {
    const [r, g, b] = vehicleLivery(row);
    return [r, g, b, isDimmed(row) ? DIMMED_ALPHA : 255];
  };
  const emphasis = (row: VehicleRow) => row.id === selectedId || row.id === hoveredId;
  const labelInkFor = (row: VehicleRow) => labelInk(vehicleLivery(row));
  const labelBackgroundFor = (row: VehicleRow): [number, number, number, number] => {
    const [r, g, b] = vehicleLivery(row);
    return [r, g, b, isDimmed(row) ? 60 : 235];
  };
  accessorCache = { isDimmed, vehicleColor, emphasis, labelInkFor, labelBackgroundFor };
  accessorCacheKey = key;
  return accessorCache;
}

export type VehicleLayerOptions = {
  models: VehicleModels | null;
  fleet: FleetBuckets;
  zoom: number;
  onSelect: (row: VehicleRow) => void;
  onHover: (row: VehicleRow | null) => void;
  selectedId: string | null;
  hoveredId: string | null;
  /** When set, everything not on this route id is dimmed back. */
  focusLine: string | null;
  /** Current viewport, used to keep the label budget on screen. */
  bounds: Bounds | null;
  /**
   * Bumped once per animation frame. It is the only `updateTriggers` entry that
   * fires every frame, and it is deliberately wired to the position accessors
   * alone: poses change continuously, liveries do not. Without it a stable
   * `data` array would leave the fleet frozen on screen; with it applied to
   * everything, the stable array would buy nothing.
   */
  positionEpoch: number;
  /** Injected once `./model-layers` has been dynamically imported; until then
   *  the map stays in its dot band regardless of zoom. */
  buildModels: ModelLayerBuilder | null;
};

export type ModelLayerBuilder = (params: {
  models: VehicleModels;
  fleet: FleetBuckets;
  zoom: number;
  opacity: number;
  getColor: (row: VehicleRow) => [number, number, number, number];
  onClick: (info: { object?: VehicleRow }) => void;
  onHover: (info: { object?: VehicleRow }) => void;
  colorTrigger: string;
  positionEpoch: number;
}) => Layer[];

export function buildVehicleLayers({
  models,
  fleet,
  zoom,
  onSelect,
  onHover,
  selectedId,
  hoveredId,
  focusLine,
  bounds,
  positionEpoch,
  buildModels,
}: VehicleLayerOptions) {
  const modelOpacity = clamp01((zoom - LOD_MIN_ZOOM) / (LOD_MAX_ZOOM - LOD_MIN_ZOOM));
  const dotOpacity = 1 - modelOpacity;
  const showDots = dotOpacity > 0.01;

  // Dots grow towards the hand-off: a 2.6px dot is right over a whole city, but
  // by the time the camera is at street level it has to hold its own against a
  // basemap full of orange roads, and against the models it is fading into.
  const dotScale = 1 + clamp01((zoom - 10) / (LOD_MAX_ZOOM - 10)) * 0.6;

  // Accessors that read selection or focus have to be re-evaluated when those
  // change, but not otherwise. That is only true as long as `data` keeps its
  // identity between frames — see `reconcile` above for why. With that holding,
  // this is what keeps a 6,500-row colour upload off every frame.
  const stateTrigger = `${selectedId}|${hoveredId}|${focusLine}`;
  // The accessors themselves are cached on the same key rather than rebuilt per
  // frame: deck.gl only calls them when a trigger fires, so a fresh closure per
  // frame was six function objects a frame that nothing invoked.
  const state = accessorsFor(stateTrigger, selectedId, hoveredId, focusLine);
  const { vehicleColor, emphasis } = state;

  const handleClick = ({ object }: { object?: VehicleRow }) => {
    if (object) {
      onSelect(object);
    }
  };
  const handleHover = ({ object }: { object?: VehicleRow }) => {
    onHover(object ?? null);
  };

  const layers: Layer[] = [];

  if (showDots) {
    layers.push(
      new ScatterplotLayer<VehicleRow>({
        id: 'vehicles-dots',
        data: fleet.all,
        opacity: dotOpacity,
        radiusUnits: 'pixels',
        radiusMinPixels: 1.5,
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 0.9,
        getLineColor: DOT_CASING,
        getPosition: (d) => d.position,
        getRadius: (d) =>
          emphasis(d)
            ? DOT_RADIUS_SELECTED
            : dotScale * (d.type === 'bus' ? DOT_RADIUS_BUS : DOT_RADIUS_RAIL),
        getFillColor: vehicleColor,
        pickable: true,
        onClick: handleClick,
        onHover: handleHover,
        updateTriggers: {
          getPosition: positionEpoch,
          // Radius reads `dotScale`, which tracks the camera, so the zoom band
          // has to be part of its trigger or the dots stop growing as you zoom.
          getRadius: `${stateTrigger}|${dotScale.toFixed(3)}`,
          getFillColor: stateTrigger,
        },
      }),
    );
  }

  if (buildModels && models && modelOpacity > 0.01) {
    layers.push(
      ...buildModels({
        models,
        fleet,
        zoom,
        opacity: modelOpacity,
        getColor: vehicleColor,
        onClick: handleClick,
        onHover: handleHover,
        colorTrigger: stateTrigger,
        positionEpoch,
      }),
    );
  }

  if (zoom >= LABEL_MIN_ZOOM) {
    const labelled = labelsFor(fleet.all, zoom, selectedId, bounds);
    layers.push(
      new TextLayer<VehicleRow>({
        id: 'vehicle-labels',
        data: labelled,
        // The blind is a fixed-size UI element, not part of the scene.
        billboard: true,
        sizeUnits: 'pixels',
        getSize: 11,
        getPixelOffset: [0, -30],
        fontWeight: 700,
        // A bus route is digits and at most two letters; keeping the atlas to
        // that avoids rasterising a font the map never draws.
        characterSet: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ&',
        background: true,
        backgroundPadding: [5, 2, 5, 2],
        getBorderWidth: 1,
        getBorderColor: [255, 255, 255, 190],
        getPosition: (d) => d.position,
        getText: (d) => vehicleLabel(d),
        getColor: state.labelInkFor,
        getBackgroundColor: state.labelBackgroundFor,
        // Labels are decoration for the vehicle beneath them; picking one would
        // shadow the model it names.
        pickable: false,
        updateTriggers: {
          getPosition: positionEpoch,
          getColor: stateTrigger,
          getBackgroundColor: stateTrigger,
        },
      }),
    );
  }

  return layers;
}
