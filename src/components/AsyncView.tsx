import type { ReactNode } from 'react';
import type { AsyncState } from '../lib/useAsync.ts';
import { Banner, Button, LoadingState } from './ui/index.ts';

interface AsyncViewProps<T> {
  state: AsyncState<T> & { reload: () => void };
  loadingLabel?: string;
  /** Called for 404s so pages can show a specific not-found state. */
  notFound?: ReactNode;
  children: (data: T) => ReactNode;
}

/** Renders loading, error (with retry), not-found and success states consistently. */
export function AsyncView<T>({ state, loadingLabel, notFound, children }: AsyncViewProps<T>) {
  if (state.status === 'loading') return <LoadingState label={loadingLabel ?? 'Loading…'} />;
  if (state.status === 'error') {
    if (notFound && state.error.mapped.kind === 'not_found') return <>{notFound}</>;
    return (
      <Banner
        tone="error"
        title="Could not load this information"
        actions={
          state.error.mapped.retryable ? (
            <Button variant="secondary" size="sm" onClick={state.reload}>
              Try again
            </Button>
          ) : null
        }
      >
        {state.error.mapped.message}
      </Banner>
    );
  }
  return <>{children(state.data)}</>;
}

/** Shown by data pages when the browser configuration is invalid (see /status). */
export function NotConfiguredBanner({ what }: { what: string }) {
  return (
    <Banner tone="error" title="App not configured">
      {what} is unavailable until the Appwrite configuration is fixed. See the <a href="/status">status page</a>.
    </Banner>
  );
}
