import { Teams } from 'appwrite';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toServiceError } from '@shared/errors.ts';
import { useAppwriteContext } from '../../app/AppwriteContext.ts';
import { AuthContext, type AuthState } from './auth-context.ts';

/**
 * Session state from Appwrite. The organiser flag only controls navigation
 * and route guards; actual access is enforced by Appwrite permissions and
 * server-side Functions, which check team membership themselves.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { appwrite } = useAppwriteContext();
  const [state, setState] = useState<AuthState>(appwrite ? { status: 'loading' } : { status: 'unconfigured' });

  const load = useCallback(async (): Promise<AuthState> => {
    if (!appwrite) return { status: 'unconfigured' };
    try {
      const user = await appwrite.log.run('account.get', () => appwrite.account.get());
      let isOrganiser = false;
      const teamId = appwrite.config.organiserTeamId;
      if (teamId) {
        const teams = await appwrite.log.run('teams.list', () => new Teams(appwrite.client).list({}));
        isOrganiser = teams.teams.some((t) => t.$id === teamId);
      }
      return { status: 'signed_in', user, isOrganiser };
    } catch (err) {
      const mapped = toServiceError('account.get', err).mapped;
      if (mapped.status === 401) return { status: 'signed_out' };
      return { status: 'error', message: mapped.message };
    }
  }, [appwrite]);

  useEffect(() => {
    let current = true;
    void load().then((s) => {
      if (current) setState(s);
    });
    return () => {
      current = false;
    };
  }, [load]);

  const refresh = useCallback(async () => {
    setState(await load());
  }, [load]);

  const signOut = useCallback(async () => {
    if (!appwrite) return;
    await appwrite.log.run('account.deleteSession', () => appwrite.account.deleteSession({ sessionId: 'current' })).catch(() => undefined);
    setState({ status: 'signed_out' });
  }, [appwrite]);

  const value = useMemo(() => ({ state, refresh, signOut }), [state, refresh, signOut]);
  return <AuthContext value={value}>{children}</AuthContext>;
}
