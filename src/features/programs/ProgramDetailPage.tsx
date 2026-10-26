import { Query } from 'appwrite';
import { SearchX } from 'lucide-react';
import { lazy, Suspense, useCallback } from 'react';
import { useParams } from 'react-router';
import { useBrowserDb } from '../../app/AppwriteContext.ts';
import { AsyncView, NotConfiguredBanner } from '../../components/AsyncView.tsx';
import { Banner, ButtonLink, Card, DataTable, EmptyState, LoadingState, PageHeader, StatusBadge, SyntheticBadge } from '../../components/ui/index.ts';
import type { Polygon } from '@shared/geo.ts';
import { formatDate, formatDateTime } from '../../lib/format.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { OddsPanel } from '../lottery/OddsPanel.tsx';
import { OfferStatsPanel } from '../offers/OfferStatsPanel.tsx';
import { byWeek, PHASE_LABEL, PHASE_TONE, phaseOf, tierLabelsOf, type Session } from './program-view.ts';

const ZoneMap = lazy(() => import('../../components/ZoneMap.tsx').then((m) => ({ default: m.ZoneMap })));

export function ProgramDetailPage() {
  const { programId = '' } = useParams();
  const db = useBrowserDb();
  const load = useCallback(async () => {
    if (!db) throw new Error('not configured');
    const [program, sessions, zones] = await Promise.all([
      db.getRow('programs', programId),
      db.listRows('seat_ledger', [Query.equal('program_id', programId), Query.limit(1000)]),
      db.listRows('zones', [Query.equal('program_id', programId), Query.limit(100)]),
    ]);
    return { program, sessions: sessions.rows, zones: zones.rows };
  }, [db, programId]);
  const state = useAsync(db ? load : null, programId);

  if (!db) {
    return (
      <div className="page">
        <PageHeader eyebrow="Program" title="Program details" />
        <NotConfiguredBanner what="This program" />
      </div>
    );
  }

  return (
    <div className="page">
      <AsyncView
        state={state}
        loadingLabel="Loading program…"
        notFound={
          <>
            <PageHeader eyebrow="Program" title="Program not found" />
            <EmptyState icon={SearchX} title="No such program" actions={<ButtonLink to="/programs" variant="secondary">Back to programs</ButtonLink>}>
              There is no published program with this ID.
            </EmptyState>
          </>
        }
      >
        {({ program: p, sessions, zones }) => {
          const phase = phaseOf(p);
          const labels = tierLabelsOf(p);
          return (
            <div className="stack">
              <PageHeader
                eyebrow="Program"
                title={p.name}
                description={p.description ?? undefined}
                actions={phase === 'accepting' ? <ButtonLink to={`/applications/new/${p.$id}`}>Apply</ButtonLink> : null}
              />
              <div className="row">
                <StatusBadge tone={PHASE_TONE[phase]}>{PHASE_LABEL[phase]}</StatusBadge>
                {p.synthetic ? <SyntheticBadge /> : null}
              </div>
              {p.source_note ? <Banner tone="demo" title="About this data">{p.source_note}</Banner> : null}

              <Card title="Registration window" description="The draw happens after applications close. When you apply inside the window makes no difference to your chance.">
                <dl className="kv">
                  <dt>Opens</dt>
                  <dd>{formatDateTime(p.window_open, p.timezone)}</dd>
                  <dt>Closes</dt>
                  <dd>{formatDateTime(p.window_close, p.timezone)}</dd>
                  <dt>Weeks per child</dt>
                  <dd>Up to {p.max_weeks}</dd>
                  <dt>Verify</dt>
                  <dd>
                    <a href={`/audit/${p.$id}`}>Public audit log</a>
                  </dd>
                </dl>
              </Card>

              <Card title="Weeks and age groups" description="Age is worked out on the first day of each week.">
                {sessions.length === 0 ? (
                  <p className="muted">No sessions are listed yet.</p>
                ) : (
                  <div className="stack">
                    {byWeek(sessions).map((w) => (
                      <DataTable<Session>
                        key={w.week}
                        caption={`${w.label ?? w.week} (starts ${formatDate(w.weekStart)})`}
                        rows={w.sessions}
                        rowKey={(s) => s.$id}
                        columns={[
                          { key: 'group', header: 'Age group', render: (s) => s.age_group },
                          { key: 'ages', header: 'Ages', render: (s) => `${String(s.min_age)}–${String(s.max_age)}` },
                          { key: 'cap', header: 'Places', numeric: true, render: (s) => s.capacity },
                        ]}
                      />
                    ))}
                  </div>
                )}
              </Card>

              {p.status !== 'draft' ? (
                <OddsPanel programId={p.$id} timezone={p.timezone} tierLabels={labels} weekLabels={new Map(sessions.map((x) => [x.week, x.label ?? x.week]))} />
              ) : null}

              {p.status === 'drawn' || p.status === 'closed' ? (
                <OfferStatsPanel programId={p.$id} timezone={p.timezone} weekLabels={new Map(sessions.map((x) => [x.week, x.label ?? x.week]))} />
              ) : null}

              <Card title="Priority zones" description="Families whose home is inside a zone are drawn in that zone's tier. Homes near a boundary are checked by staff before any offer.">
                {zones.length === 0 ? (
                  <p className="muted">This program has no priority zones: every family is in the same tier.</p>
                ) : (
                  <Suspense fallback={<LoadingState label="Loading map…" />}>
                    <ZoneMap
                      label={`Map of ${String(zones.length)} priority zones for ${p.name}`}
                      tierLabels={labels}
                      zones={zones.map((z) => ({ id: z.$id, name: z.name, tier: z.tier, area: z.area as unknown as Polygon }))}
                    />
                  </Suspense>
                )}
              </Card>
            </div>
          );
        }}
      </AsyncView>
    </div>
  );
}
