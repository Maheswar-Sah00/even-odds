import type { Models } from 'appwrite';
import { createContext, useContext } from 'react';

export type AuthState =
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'signed_out' }
  | { status: 'signed_in'; user: Models.User; isOrganiser: boolean }
  | { status: 'error'; message: string };

export interface AuthContextValue {
  state: AuthState;
  /** Re-read the session from Appwrite (after sign-in, sign-out, or team changes). */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
