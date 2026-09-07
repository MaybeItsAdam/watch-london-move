import { useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';

export const IS_NATIVE = Capacitor.isNativePlatform();

/**
 * Whether the app is in the foreground.
 *
 * Two sources because neither is sufficient alone: `visibilitychange` is the
 * only signal in a browser tab, but iOS does not reliably fire it when a
 * WKWebView is suspended, so the native lifecycle event is authoritative there.
 * Both resolve to the same boolean, so overlapping events are harmless.
 */
export function useAppActive(): boolean {
  const [active, setActive] = useState(() => document.visibilityState !== 'hidden');

  useEffect(() => {
    const onVisibility = () => setActive(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);

    if (!IS_NATIVE) {
      return () => {
        document.removeEventListener('visibilitychange', onVisibility);
      };
    }

    const listener = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      setActive(isActive);
    }).catch(() => null);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      listener.then((handle) => handle?.remove()).catch(() => {});
    };
  }, []);

  return active;
}

/**
 * Native chrome. No-ops in a browser.
 *
 * `ready` gates the splash screen: `launchAutoHide` is off in
 * capacitor.config.ts because a timer would uncover an empty canvas while
 * MapLibre is still fetching its style, so the app dismisses it once there is
 * something to look at.
 */
export function useNativeShell(ready: boolean) {
  useEffect(() => {
    if (!IS_NATIVE) {
      return;
    }
    // Light content — the bar sits over the app's near-black background.
    StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
    // Android only; iOS rejects it. Draws the map full-bleed behind the bar,
    // which App.css then keeps the panels clear of.
    StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!IS_NATIVE || !ready) {
      return;
    }
    SplashScreen.hide().catch(() => {});
  }, [ready]);
}

/**
 * Android's hardware/gesture back button.
 *
 * A single-page app gets no back behaviour for free: with no listener, back
 * exits the app outright from wherever you are — including with a vehicle panel
 * open, which on Android reads as a crash rather than a navigation. Android
 * users expect back to unwind the visible layers first and only then leave.
 *
 * `steps` are tried in order, most-recently-opened first; each returns true if
 * it had something to close. When none does, the app exits, which is the
 * correct terminal behaviour rather than trapping the user inside it.
 *
 * A ref holds the steps so a changing closure never re-registers the native
 * listener: `addListener` is asynchronous, and re-running this effect on every
 * render that changes a handler races its own removal.
 */
export function useAndroidBack(steps: (() => boolean)[]) {
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  useEffect(() => {
    if (!IS_NATIVE) {
      return;
    }
    const listener = CapacitorApp.addListener('backButton', () => {
      for (const step of stepsRef.current) {
        if (step()) {
          return;
        }
      }
      CapacitorApp.exitApp();
    });
    return () => {
      listener.then((handle) => handle.remove());
    };
  }, []);
}
