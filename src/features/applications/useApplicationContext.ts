import { Query } from 'appwrite';
import { useCallback } from 'react';
import { useAppwriteContext } from '../../app/AppwriteContext.ts';
import type { BrowserRow } from '../../lib/appwrite/db.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { householdApi, type HouseholdSummary } from '../family/household-api.ts';

export interface ApplicationContext {
  household: HouseholdSummary | null;
  program: BrowserRow<'programs'>;
  sessions: BrowserRow<'seat_ledger'>[];
  zones: BrowserRow<'zones'>[];
  children: BrowserRow<'children'>[];
  application: BrowserRow<'applications'> | null;
  preferences: BrowserRow<'preferences'>[];
  home: BrowserRow<'family_locations'> | null;
}

/**
 * Everything the wizard and receipt need. Program data is public; household,
 * children, application and preferences are read through row permissions
 * (only this household's guardians can read them).
 */
export function useApplicationContext(programId: string | null) {
  const { appwrite, db } = useAppwriteContext();
  const load = useCallback(async (): Promise<ApplicationContext> => {
    if (!appwrite || !db || !programId) throw new Error('not ready');
    const [household, program, sessions, zones] = await Promise.all([
      householdApi(appwrite).get(),
      db.getRow('programs', programId),
      db.listRows('seat_ledger', [Query.equal('program_id', programId), Query.limit(1000)]),
      db.listRows('zones', [Query.equal('program_id', programId), Query.limit(100)]),
    ]);
    if (!household) return { household, program, sessions: sessions.rows, zones: zones.rows, children: [], application: null, preferences: [], home: null };
    const fam = Query.equal('family_id', household.familyId);
    const [children, applications, preferences, homes] = await Promise.all([
      db.listRows('children', [fam, Query.orderAsc('birthdate'), Query.limit(50)]),
      db.listRows('applications', [fam, Query.equal('program_id', programId), Query.limit(1)]),
      db.listRows('preferences', [fam, Query.equal('program_id', programId), Query.limit(50)]),
      db.listRows('family_locations', [fam, Query.limit(1)]),
    ]);
    return {
      household,
      program,
      sessions: sessions.rows,
      zones: zones.rows,
      children: children.rows,
      application: applications.rows[0] ?? null,
      preferences: preferences.rows,
      home: homes.rows[0] ?? null,
    };
  }, [appwrite, db, programId]);
  return useAsync(appwrite && db && programId ? load : null, programId);
}
