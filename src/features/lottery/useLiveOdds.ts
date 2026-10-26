import { Channel, Query, Realtime } from 'appwrite';
import { useCallback, useEffect, useState } from 'react';
import { useAppwriteContext } from '../../app/AppwriteContext.ts';
import type { BrowserRow } from '../../lib/appwrite/db.ts';
import { useAsync } from '../../lib/useAsync.ts';

export type Snapshot = BrowserRow<'odds_snapshots'>;
export type LiveMode = 'connecting' | 'live' | 'polling';

/** Odds change at most hourly, so polling every 5 minutes is ample when Realtime is unavailable. */
export const POLL_MS = 5 * 60_000;

/**
 * The published odds snapshot for a program, kept fresh by Appwrite Realtime.
 * Subscribes to exactly ONE public aggregate row (no private data, one
 * channel per viewer). If the Realtime subscription fails, falls back to
 * polling and says so.
 */
export function useLiveOdds(programId: string) {
  const { appwrite, db } = useAppwriteContext();
  const load = useCallback(async () => {
    if (!db) throw new Error('not configured');
    const { rows } = await db.listRows('odds_snapshots', [Query.equal('program_id', programId), Query.limit(1)]);
    return rows[0] ?? null;
  }, [db, programId]);
  const initial = useAsync(db ? load : null, programId);
  const [live, setLive] = useState<Snapshot | null>(null);
  const [mode, setMode] = useState<LiveMode>('connecting');
  const rowId = initial.status === 'success' ? initial.data?.$id : undefined;
  const { reload } = initial;

  useEffect(() => {
    if (!appwrite || !rowId) return;
    let cancelled = false;
    let unsubscribe: (() => Promise<void>) | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (cancelled) return;
      setMode('polling');
      poll = setInterval(reload, POLL_MS);
    };
    const channel = Channel.tablesdb(appwrite.config.databaseId).table(appwrite.config.tables.odds_snapshots).row(rowId);
    new Realtime(appwrite.client)
      .subscribe(channel, (event) => {
        if (!cancelled) setLive(event.payload as Snapshot);
      })
      .then(
        (sub) => {
          if (cancelled) void sub.unsubscribe();
          else {
            unsubscribe = sub.unsubscribe;
            setMode('live');
          }
        },
        startPolling,
      );
    return () => {
      cancelled = true;
      if (unsubscribe) void unsubscribe();
      if (poll) clearInterval(poll);
    };
  }, [appwrite, rowId, reload]);

  const snapshot = live && initial.status === 'success' && initial.data && live.$updatedAt >= initial.data.$updatedAt ? live : initial.status === 'success' ? initial.data : null;
  return { initial, snapshot, mode };
}
