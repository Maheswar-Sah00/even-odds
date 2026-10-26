import { useCallback } from 'react';
import { useAppwriteContext } from '../../app/AppwriteContext.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { householdApi } from './household-api.ts';

/** The caller's household summary from the household Function (null = none yet). */
export function useHousehold() {
  const { appwrite } = useAppwriteContext();
  const load = useCallback(() => (appwrite ? householdApi(appwrite).get() : Promise.reject(new Error('not configured'))), [appwrite]);
  return useAsync(appwrite ? load : null, appwrite);
}
