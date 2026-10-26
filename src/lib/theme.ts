import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

// Light (white) / dark (black) theme. The first visit follows the system preference;
// a choice made with the toggle is remembered per browser. index.html applies the
// stored value before first paint, so there is no flash.

export type Theme = 'dark' | 'light';
export const THEME_KEY = 'even-odds-theme';
const listeners = new Set<() => void>();

function read(): Theme {
  const t = typeof document !== 'undefined' ? document.documentElement.dataset.theme : undefined;
  return t === 'dark' ? 'dark' : 'light';
}

export function setTheme(t: Theme) {
  const root = document.documentElement;
  root.dataset.theme = t;
  root.style.colorScheme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#121014' : '#faf9fb');
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* storage blocked: the choice lasts for this page view */
  }
  listeners.forEach((l) => {
    l();
  });
}

/**
 * Switch theme with a circular reveal growing from (x, y), e.g. the toggle button.
 * Uses the View Transitions API; falls back to an instant switch.
 */
export function switchTheme(t: Theme, x: number, y: number) {
  if (!('startViewTransition' in document) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setTheme(t);
    return;
  }
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const vt = document.startViewTransition(() => {
    flushSync(() => {
      setTheme(t);
    });
  });
  void vt.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${String(x)}px ${String(y)}px)`, `circle(${String(r)}px at ${String(x)}px ${String(y)}px)`] },
      { duration: 700, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', pseudoElement: '::view-transition-new(root)' },
    );
  });
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    (): Theme => 'light',
  );
}
