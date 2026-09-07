import { Geolocation } from '@capacitor/geolocation';
import { IS_NATIVE } from './lifecycle';

/**
 * Where the user is, once, as `[lon, lat]` — or null if they declined, the fix
 * timed out, or the platform cannot answer.
 *
 * Goes through Capacitor's plugin rather than `navigator.geolocation` directly
 * on native platforms, because the browser API is not actually available on
 * either of the two this app also ships as:
 *
 * - **iOS.** WKWebView does not implement the W3C Geolocation API for
 *   third-party apps, and Capacitor's bridge does not proxy it. A direct
 *   `getCurrentPosition` never calls back at all — the control would simply
 *   spin until its own timeout and then give up, on every attempt, forever.
 * - **Android below 12.** Capacitor's `BridgeWebChromeClient` requests *both*
 *   coarse and fine location for a WebView geolocation prompt, and only falls
 *   back to accepting coarse alone on SDK 31+. This app declares coarse only
 *   (see AndroidManifest.xml), so on SDK 24–30 — which is our floor — the
 *   prompt resolves to denied.
 *
 * In a browser tab, `navigator.geolocation` is used directly so the web build
 * avoids a dynamic import of Capacitor's web implementation.
 *
 * Coarse and one-shot on purpose: the camera is centred at city zoom, so
 * street-level precision buys nothing and costs a larger permission prompt, a
 * slower fix and more battery. A `watchPosition` would keep the GPS open for a
 * session nobody asked to be tracked in.
 */
export async function currentPosition(): Promise<[number, number] | null> {
  if (!IS_NATIVE) {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return null;
    }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve([position.coords.longitude, position.coords.latitude]),
        () => resolve(null),
        {
          enableHighAccuracy: false,
          timeout: 8000,
          maximumAge: 30000,
        },
      );
    });
  }

  try {
    const position = await Geolocation.getCurrentPosition({
      enableHighAccuracy: false,
      timeout: 8000,
      maximumAge: 30000,
    });
    return [position.coords.longitude, position.coords.latitude];
  } catch {
    // Declined, unavailable, or timed out. There is nothing useful to say that
    // the permission prompt has not already said, so the caller just stops
    // looking busy.
    return null;
  }
}
