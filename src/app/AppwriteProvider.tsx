import { useMemo, type ReactNode } from 'react';
import type { EnvResult, PublicConfig } from '@shared/env.ts';
import { createBrowserAppwrite } from '../lib/appwrite/client.ts';
import { createBrowserDb } from '../lib/appwrite/db.ts';
import { AppwriteContext, type AppwriteContextValue } from './AppwriteContext.ts';

export function AppwriteProvider({ env, children }: { env: EnvResult<PublicConfig>; children: ReactNode }) {
  const value = useMemo<AppwriteContextValue>(
    () => {
      const appwrite = env.ok ? createBrowserAppwrite(env.config, env.config.logRequests || import.meta.env.DEV) : null;
      return { env, appwrite, db: appwrite ? createBrowserDb(appwrite) : null };
    },
    [env],
  );
  return <AppwriteContext value={value}>{children}</AppwriteContext>;
}
