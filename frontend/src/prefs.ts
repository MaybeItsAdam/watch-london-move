/**
 * The handful of choices worth remembering between visits but not worth putting
 * in a link.
 *
 * The split against url-state.ts is deliberate. A URL describes *what you are
 * looking at* — where, which lines, which vehicle — and is meant to be sent to
 * someone else. This describes *how you like the app*, which is personal and
 * would be noise, or an imposition, in a shared link.
 *
 * Every read is defensive. `localStorage` throws rather than returning null in
 * Safari's private mode and in a WebView with site data disabled, and a stored
 * value is whatever an older build happened to write.
 */

const KEY = 'wlm.prefs.v1';

export type Prefs = {
  sidebarOpen: boolean | null;
  showRoutes: boolean;
  legendDismissed: boolean;
};

export const DEFAULT_PREFS: Prefs = {
  // Null means "decide from the viewport", which is what the app did before
  // anything was remembered: open beside a desktop map, closed over a phone one.
  sidebarOpen: null,
  showRoutes: true,
  legendDismissed: false,
};

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

export function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) {
      return DEFAULT_PREFS;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return DEFAULT_PREFS;
    }
    const record = parsed as Record<string, unknown>;
    return {
      sidebarOpen:
        typeof record.sidebarOpen === 'boolean' ? record.sidebarOpen : DEFAULT_PREFS.sidebarOpen,
      showRoutes: asBoolean(record.showRoutes, DEFAULT_PREFS.showRoutes),
      legendDismissed: asBoolean(record.legendDismissed, DEFAULT_PREFS.legendDismissed),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage full, disabled, or a private window. Preferences are a
    // convenience; losing them must not break the session that set them.
  }
}
