import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Banner, ButtonLink, EmptyState, LoadingState, PageHeader } from '../../components/ui/index.ts';
import { useAuth } from './auth-context.ts';

/**
 * Route guards. They give a good experience, NOT security: every protected
 * record is also protected by Appwrite row permissions, and every write by a
 * server Function that re-checks the caller.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  switch (state.status) {
    case 'loading':
      return <LoadingState label="Checking your session…" />;
    case 'unconfigured':
      return (
        <>
          <PageHeader title="Sign-in unavailable" />
          <Banner tone="error" title="App not configured">
            Sign-in is unavailable until the Appwrite configuration is fixed. See the <a href="/status">status page</a>.
          </Banner>
        </>
      );
    case 'error':
      return (
        <>
          <PageHeader title="Could not check your session" />
          <Banner tone="error">{state.message}</Banner>
        </>
      );
    case 'signed_out':
      return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
    case 'signed_in':
      return <>{children}</>;
  }
}

export function RequireOrganiser({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  return (
    <RequireAuth>
      {state.status === 'signed_in' && !state.isOrganiser ? (
        <>
        <PageHeader title="Organisers only" />
        <EmptyState icon={Lock} title="Organiser access required" actions={<ButtonLink to="/" variant="secondary">Go to the home page</ButtonLink>}>
          This area is for program organisers. Your account is not a member of the organiser team. If you think this is
          wrong, ask the program administrator to add you.
        </EmptyState>
        </>
      ) : (
        children
      )}
    </RequireAuth>
  );
}
