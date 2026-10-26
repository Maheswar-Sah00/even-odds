import { useCallback } from 'react';
import { AsyncView } from '../../components/AsyncView.tsx';
import { Card, DataTable, StatusBadge } from '../../components/ui/index.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { consoleCalls, type ConsoleApi, type DemandReport } from './console-api.ts';

type Row = DemandReport['sessions'][number];

/** Application demand per session, counted by the server from submitted applications' ranked weeks. */
export function DemandSection({ api, refreshKey }: { api: ConsoleApi; refreshKey?: unknown }) {
  const load = useCallback(() => consoleCalls(api).demand(), [api]);
  const state = useAsync(load, refreshKey);
  return (
    <Card title="Application demand" description="How many children ranked each session, against its seats. Counted from submitted applications only; no family is identified.">
      <AsyncView state={state} loadingLabel="Counting demand…">
        {(d) => (
          <div className="stack">
            <div className="stat-row">
              <div className="stat"><span className="stat__value">{d.applications}</span><span className="stat__label">applications{d.late ? ` (${String(d.late)} late)` : ''}</span></div>
              <div className="stat"><span className="stat__value">{d.children}</span><span className="stat__label">children</span></div>
              <div className="stat"><span className="stat__value">{d.weeksRequested}</span><span className="stat__label">weeks requested</span></div>
              <div className="stat"><span className="stat__value">{d.seats}</span><span className="stat__label">seats</span></div>
              <div className="stat"><span className="stat__value">{d.oversubscribed}</span><span className="stat__label">oversubscribed sessions</span></div>
            </div>
            <DataTable<Row>
              caption="Demand by session"
              rows={d.sessions}
              rowKey={(s) => s.ledgerId}
              empty={<p className="muted">No sessions yet.</p>}
              columns={[
                { key: 'week', header: 'Week', render: (s) => s.weekLabel },
                { key: 'group', header: 'Ages', render: (s) => s.ageGroup },
                { key: 'cap', header: 'Seats', numeric: true, render: (s) => s.capacity },
                { key: 'first', header: 'First choice', numeric: true, render: (s) => s.firstChoice },
                { key: 'ranked', header: 'Ranked it', numeric: true, render: (s) => s.ranked },
                {
                  key: 'ratio',
                  header: 'Per seat',
                  numeric: true,
                  render: (s) => (s.perSeat === null ? '—' : `${s.perSeat.toFixed(1)}×`),
                },
                {
                  key: 'state',
                  header: 'Status',
                  render: (s) => (s.oversubscribed ? <StatusBadge tone="danger">Oversubscribed</StatusBadge> : <StatusBadge tone="success">Seats for everyone who ranked it</StatusBadge>),
                },
              ]}
            />
          </div>
        )}
      </AsyncView>
    </Card>
  );
}
