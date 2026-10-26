import { useRef, type KeyboardEvent } from 'react';

/** The item at index i of a non-empty constant list (indexes come from the list itself). */
export function pick<T>(list: readonly T[], i: number): T {
  const item = list[i] ?? list[0];
  if (item === undefined) throw new Error('pick: empty list');
  return item;
}

/** Arrow-key navigation for a WAI-ARIA tab list (roving tabindex). */
export function useTabKeys(count: number, active: number, select: (i: number) => void) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent) => {
    const keys: Record<string, number> = { ArrowRight: active + 1, ArrowLeft: active - 1, Home: 0, End: count - 1 };
    const next = keys[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const i = (next + count) % count;
    select(i);
    refs.current[i]?.focus();
  };
  return { refs, onKeyDown };
}
