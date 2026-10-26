import { Radio, RefreshCw } from 'lucide-react';
import { AsyncView } from '../../components/AsyncView.tsx';
import { Banner, Card, DataTable, StatusBadge } from '../../components/ui/index.ts';
import { oddsAssumptions, type SessionDemand, type TierOdds } from '@shared/odds.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useLiveOdds } from './useLiveOdds.ts';

const BAND_TONE: Record<string, 'success' | 'info' | 'pending' | 'neutral' | 'danger'> = {
  'Very likely': 'success',
  Likely: 'success',
  'About even': 'info',
  Unlikely: 'pending',
  'Very unlikely': 'danger',
};

function parse<T>(json: string): T[] {
  try {
    return JSON.parse(json) as T[];
  } catch {
    return [];
  }
}

interface OddsPanelProps {
  programId: string;
  timezone: string;
  tierLabels: Record<string, string>;
  weekLabels: Map<string, string>;
}

/**
 * Public demand and odds for a program. Shows banded chances (never
 * unjustified precision), demand per place, when the estimate was made, and
 * plain-language caveats.
 */
export function OddsPanel({ programId, timezone, tierLabels, weekLabels }: OddsPanelProps) {
  const { initial, snapshot, mode } = useLiveOdds(programId);
  return (
    <Card title="Demand and odds" description="Estimated from the applications submitted so far. These are estimates, not guarantees.">
      <AsyncView state={initial} loadingLabel="Loading the latest estimate…">
        {() => {
          if (!snapshot) {
            return <p className="muted">No estimate has been published yet. Estimates are computed by a scheduled job at most once an hour while applications are open.</p>;
          }
          const tiers = parse<TierOdds>(snapshot.tiers);
          const sessions = parse<SessionDemand>(snapshot.sessions);
          return (
            <div className="stack">
              <Banner tone="info" title="Estimates, not guarantees">
                The actual result comes from a public random draw after applications close. When you apply, early or late, does not change your chance.
              </Banner>
              <p className="row small" data-computed-at={snapshot.computed_at}>
                <span>
                  Estimated {formatDateTime(snapshot.computed_at, timezone)} from {snapshot.applicants} application{snapshot.applicants === 1 ? '' : 's'} ({snapshot.children} children) for {snapshot.seats} places.
                </span>
                {snapshot.frozen ? (
                  <StatusBadge tone="pending">Frozen since {formatDateTime(snapshot.freeze_at, timezone)}</StatusBadge>
                ) : (
                  <StatusBadge tone={mode === 'live' ? 'success' : 'neutral'}>
                    {mode === 'live' ? <><Radio size={12} aria-hidden="true" /> Live updates on</> : mode === 'polling' ? <><RefreshCw size={12} aria-hidden="true" /> Checking every 5 minutes</> : 'Connecting…'}
                  </StatusBadge>
                )}
              </p>
              <p className="muted small" style={{ margin: 0 }}>
                {snapshot.frozen
                  ? 'Odds stop updating 24 hours before applications close, so nobody can time a late change off live numbers.'
                  : `Updated at most once an hour by a scheduled job. They freeze ${formatDateTime(snapshot.freeze_at, timezone)}, 24 hours before applications close.`}
              </p>

              <DataTable<TierOdds>
                caption="Chance that a child gets at least one requested week, by priority tier"
                rows={tiers}
                rowKey={(t) => String(t.tier)}
                empty={<p className="muted">No applications yet.</p>}
                columns={[
                  { key: 'tier', header: 'Priority tier', render: (t) => tierLabels[String(t.tier)] ?? `Tier ${String(t.tier)}` },
                  {
                    key: 'band',
                    header: 'Chance of at least one week',
                    render: (t) => (t.band ? <StatusBadge tone={BAND_TONE[t.band] ?? 'neutral'}>{t.bandRange ?? t.band}</StatusBadge> : <span className="muted">Not shown: fewer than 5 children in this tier (privacy)</span>),
                  },
                  { key: 'n', header: 'Children applying', numeric: true, render: (t) => t.children },
                ]}
              />

              <DataTable<SessionDemand>
                caption="Demand per place, by session"
                rows={sessions}
                rowKey={(s) => `${s.week}:${s.ageGroup}`}
                columns={[
                  { key: 'week', header: 'Week', render: (s) => weekLabels.get(s.week) ?? s.week },
                  { key: 'group', header: 'Ages', render: (s) => s.ageGroup },
                  { key: 'cap', header: 'Places', numeric: true, render: (s) => s.capacity },
                  { key: 'first', header: 'First choice', numeric: true, render: (s) => s.firstChoice },
                  { key: 'ranked', header: 'Ranked at all', numeric: true, render: (s) => s.totalRanked },
                  { key: 'dps', header: 'Children per place', numeric: true, render: (s) => (s.demandPerSeat === null ? '—' : s.demandPerSeat.toFixed(1)) },
                ]}
              />

              <details>
                <summary>What this estimate means and assumes</summary>
                <p>
                  We rerun the draw rules {snapshot.iterations.toLocaleString()} times on today&apos;s applications with random orders, and count how often a child in each tier gets at least one of their requested weeks. The band summarises that share; when our uncertainty spans two bands, both are shown.
                </p>
                <ul>
                  {oddsAssumptions(snapshot.iterations).map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
                <p className="muted small">
                  Model {snapshot.model_version}; seed <code>{snapshot.seed}</code> (anyone can reproduce this estimate).
                </p>
              </details>
            </div>
          );
        }}
      </AsyncView>
    </Card>
  );
}
