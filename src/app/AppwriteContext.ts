import { createContext, useContext } from 'react';
import type { EnvResult, PublicConfig } from '@shared/env.ts';
import type { BrowserAppwrite } from '../lib/appwrite/client.ts';
import type { BrowserDb } from '../lib/appwrite/db.ts';

export interface AppwriteContextValue {
  env: EnvResult<PublicConfig>;
  /** null when configuration is invalid; the UI must show the config error instead. */
  appwrite: BrowserAppwrite | null;
  db: BrowserDb | null;
}

export const AppwriteContext = createContext<AppwriteContextValue | null>(null);

export function useAppwriteContext(): AppwriteContextValue {
  const value = useContext(AppwriteContext);
  if (!value) throw new Error('useAppwriteContext must be used inside <AppwriteProvider>');
  return value;
}

/** Read-only typed DB for the browser, or null when configuration is invalid. */
export function useBrowserDb(): BrowserDb | null {
  return useAppwriteContext().db;
}
