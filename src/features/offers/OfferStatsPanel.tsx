import { Query } from 'appwrite';
import { useCallback } from 'react';
import { useBrowserDb } from '../../app/AppwriteContext.ts';
import { AsyncView } from '../../components/AsyncView.tsx';
import { Card, DataTable } from '../../components/ui/index.ts';
import type { BrowserRow } from '../../lib/appwrite/db.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useAsync } from '../../lib/useAsync.ts';

type Stat = BrowserRow<'offer_stats'>;

/**
 * Public, pseudonymous offer status: counts per session from the offer_stats
 * table (no families, children or refs). Shown once the draw has run.
 */
export function OfferStatsPanel({ programId, timezone, weekLabels }: { programId: string; timezone: string; weekLabels: Map<string, string> }) {
  const db = useBrowserDb();
  const load = useCallback(async () => {
    if (!db) throw new Error('not configured');
    return (await db.listRows('offer_stats', [Query.equal('program_id', programId), Query.orderAsc('week'), Query.limit(500)])).rows;
  }, [db, programId]);
  const state = useAsync(db ? load : null, programId);

  return (
    <Card title="Offers and waitlist" description="Counts only. Families and children are never shown publicly; individual offers and promotions appear in the audit log under pseudonymous ticket refs.">
      <AsyncView state={state} loadingLabel="Loading offer status…">
        {(rows) =>
          rows.length === 0 ? (
            <p className="muted">Offer counts appear here after the draw.</p>
          ) : (
            <div className="stack-sm">
              <DataTable<Stat>
                caption="Offer status by session"
                hideCaption
                rows={rows}
                rowKey={(r) => r.$id}
                columns={[
                  { key: 'week', header: 'Week', render: (r) => weekLabels.get(r.week) ?? r.week },
                  { key: 'group', header: 'Age group', render: (r) => r.age_group },
                  { key: 'cap', header: 'Places', numeric: true, render: (r) => r.capacity },
                  { key: 'pending', header: 'Awaiting reply', numeric: true, render: (r) => r.pending },
                  { key: 'accepted', header: 'Accepted', numeric: true, render: (r) => r.accepted },
                  { key: 'free', header: 'Free', numeric: true, render: (r) => Math.max(0, r.capacity - r.taken) },
                  { key: 'waiting', header: 'Waiting', numeric: true, render: (r) => r.waiting },
                  { key: 'promoted', header: 'Offered from waitlist', numeric: true, render: (r) => r.promoted },
                ]}
              />
              <p className="muted small">Updated {formatDateTime(rows.map((r) => r.computed_at).sort().at(-1) ?? new Date().toISOString(), timezone)}.</p>
            </div>
          )
        }
      </AsyncView>
    </Card>
  );
}
