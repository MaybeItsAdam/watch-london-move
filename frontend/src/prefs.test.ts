import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS, loadPrefs, savePrefs } from './prefs';

const KEY = 'wlm.prefs.v1';

describe('prefs', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('returns the defaults when nothing is stored', () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('round-trips', () => {
    const prefs = { sidebarOpen: false, showRoutes: false, legendDismissed: true };
    savePrefs(prefs);
    expect(loadPrefs()).toEqual(prefs);
  });

  // sidebarOpen is tri-state: null means "decide from the viewport".
  it('keeps a null sidebar preference distinct from false', () => {
    savePrefs({ ...DEFAULT_PREFS, sidebarOpen: null });
    expect(loadPrefs().sidebarOpen).toBeNull();
    savePrefs({ ...DEFAULT_PREFS, sidebarOpen: false });
    expect(loadPrefs().sidebarOpen).toBe(false);
  });

  it.each([
    ['not json at all', 'malformed'],
    ['null', 'a stored null'],
    ['[1,2,3]', 'the wrong shape'],
    ['{"showRoutes":"yes"}', 'a value of the wrong type'],
  ])('falls back to defaults for %s (%s)', (stored) => {
    window.localStorage.setItem(KEY, stored);
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('keeps the fields it does understand from a partial record', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ legendDismissed: true }));
    const prefs = loadPrefs();
    expect(prefs.legendDismissed).toBe(true);
    expect(prefs.showRoutes).toBe(DEFAULT_PREFS.showRoutes);
  });

  // Safari private mode and a WebView with site data disabled both throw here.
  it('survives storage that throws on read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('survives storage that throws on write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => savePrefs(DEFAULT_PREFS)).not.toThrow();
  });
});
