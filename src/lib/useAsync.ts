import { useCallback, useEffect, useState } from 'react';
import { toServiceError, type ServiceError } from '@shared/errors.ts';

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: ServiceError };

/**
 * Runs `load` whenever `key` changes. Stale responses are ignored, errors are
 * mapped to ServiceError, and `reload` re-runs the request on demand.
 * `load` must be stable for a given key (wrap it in useCallback).
 */
export function useAsync<T>(load: (() => Promise<T>) | null, key: unknown): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!load) return;
    let current = true;
    load().then(
      (data) => {
        if (current) setState({ status: 'success', data });
      },
      (err: unknown) => {
        if (current) setState({ status: 'error', error: toServiceError('load', err) });
      },
    );
    return () => {
      current = false;
    };
    // `key` intentionally drives re-runs; `load` is expected to change with it.
  }, [load, key, nonce]);

  // After a successful load, reloading keeps the current data on screen (no
  // flash of the loading state, and child components keep their local state);
  // after an error it shows the loading state again.
  const reload = useCallback(() => {
    setState((s) => (s.status === 'success' ? s : { status: 'loading' }));
    setNonce((n) => n + 1);
  }, []);

  return { ...state, reload };
}
