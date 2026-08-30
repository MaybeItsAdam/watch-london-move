import { describe, expect, it } from 'vitest';
import { buildUrlSearch, parseUrlState, type UrlState } from './url-state';

const base: UrlState = {
  camera: null,
  selectedId: null,
  selectedLines: [],
  filters: null,
  basemap: null,
};

const allModes = {
  bus: true,
  tube: true,
  overground: true,
  dlr: true,
  tram: true,
  elizabeth: true,
};

describe('parseUrlState', () => {
  it('reads a full camera', () => {
    const state = parseUrlState('?at=51.5072,-0.1276,14.5,30,55');
    expect(state.camera).toEqual({
      lat: 51.5072,
      lon: -0.1276,
      zoom: 14.5,
      bearing: 30,
      pitch: 55,
    });
  });

  it('defaults a camera missing its bearing and pitch', () => {
    expect(parseUrlState('?at=51.5,-0.12,12')?.camera).toEqual({
      lat: 51.5,
      lon: -0.12,
      zoom: 12,
      bearing: 0,
      pitch: 0,
    });
  });

  // A link is the one input a stranger controls, and MapLibre throws on a
  // latitude outside the Mercator range rather than clamping it.
  it.each([
    ['?at=', 'empty'],
    ['?at=not,a,camera', 'non-numeric'],
    ['?at=91,0,12', 'latitude past the projection limit'],
    ['?at=51.5,-0.12,99', 'impossible zoom'],
    ['?at=51.5', 'truncated'],
  ])('rejects %s (%s)', (search) => {
    expect(parseUrlState(search).camera).toBeNull();
  });

  it('clamps pitch rather than rejecting the whole camera', () => {
    expect(parseUrlState('?at=51.5,-0.12,12,0,120').camera?.pitch).toBe(85);
  });

  it('reads a selection and a line filter', () => {
    const state = parseUrlState('?v=bus%2F1234&lines=24,n29');
    expect(state.selectedId).toBe('bus/1234');
    expect(state.selectedLines).toEqual(['24', 'n29']);
  });

  it('reads a mode filter, leaving unnamed modes off', () => {
    expect(parseUrlState('?modes=bus,tram').filters).toEqual({
      bus: true,
      tube: false,
      overground: false,
      dlr: false,
      tram: true,
      elizabeth: false,
    });
  });

  // Forward compatibility: a link made by a newer build must still open.
  it('ignores unknown mode names', () => {
    expect(parseUrlState('?modes=bus,monorail').filters?.bus).toBe(true);
  });

  it('treats a filter naming nothing known as no filter at all', () => {
    expect(parseUrlState('?modes=monorail').filters).toBeNull();
  });

  it('rejects an unknown basemap', () => {
    expect(parseUrlState('?map=sepia').basemap).toBeNull();
    expect(parseUrlState('?map=night').basemap).toBe('night');
  });

  it('survives a URL with nothing in it', () => {
    expect(parseUrlState('')).toEqual(base);
  });
});

describe('buildUrlSearch', () => {
  it('omits everything that is at its default', () => {
    expect(buildUrlSearch(base, '')).toBe('');
    expect(buildUrlSearch({ ...base, filters: allModes, basemap: 'auto' }, '')).toBe('');
  });

  it('round-trips a full state', () => {
    const state: UrlState = {
      camera: { lat: 51.5072, lon: -0.1276, zoom: 14.5, bearing: 30, pitch: 55 },
      selectedId: 'bus/1234',
      selectedLines: ['24'],
      filters: { ...allModes, tube: false },
      basemap: 'night',
    };
    expect(parseUrlState(buildUrlSearch(state, ''))).toEqual(state);
  });

  it('rounds coordinates to the precision the wire format uses', () => {
    const search = buildUrlSearch(
      { ...base, camera: { lat: 51.50723456, lon: -0.12764321, zoom: 14.5678, bearing: 0, pitch: 0 } },
      '',
    );
    expect(search).toContain('at=51.50723,-0.12764,14.57,0,0');
  });

  // A shared link is read and pasted by people; %2C everywhere is noise.
  it('leaves commas literal, and still round-trips', () => {
    const state: UrlState = {
      ...base,
      camera: { lat: 51.5072, lon: -0.1276, zoom: 14.5, bearing: 30, pitch: 55 },
      selectedLines: ['24', 'n29', 'sl8'],
      filters: { ...allModes, tube: false },
    };
    const search = buildUrlSearch(state, '');
    expect(search).not.toContain('%2C');
    expect(parseUrlState(search)).toEqual(state);
  });

  // Anything that genuinely needs escaping still is.
  it('still encodes characters that are not comma', () => {
    const search = buildUrlSearch({ ...base, selectedId: 'bus/12 34&x' }, '');
    expect(search).toContain('v=bus%2F12+34%26x');
    expect(parseUrlState(search).selectedId).toBe('bus/12 34&x');
  });

  // The service worker's ?sw=off escape hatch lives in the same query string.
  it('preserves unrelated parameters already present', () => {
    expect(buildUrlSearch(base, '?sw=off')).toBe('?sw=off');
  });

  it('clears a parameter when its state goes back to the default', () => {
    expect(buildUrlSearch(base, '?v=bus%2F1234&lines=24')).toBe('');
  });
});
