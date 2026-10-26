import { Scale, ScrollText } from 'lucide-react';
import { useCallback } from 'react';
import { AsyncView } from '../../components/AsyncView.tsx';
import { ButtonLink, Card, DataTable } from '../../components/ui/index.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { FairnessReportView } from '../fairness/FairnessPage.tsx';
import type { Program } from '../programs/program-view.ts';
import { consoleCalls, type ConsoleApi, type StaffLogEntry } from './console-api.ts';

const ACTION_TEXT: Record<string, string> = {
  override_created: 'Override authorised',
  override_removed: 'Override removed',
  tier_verified: 'Tier verified',
  capacity_changed: 'Capacity changed',
  inputs_frozen: 'Inputs frozen',
  draw_run: 'Draw run',
  offers_cancelled: 'Offer cancelled',
  demo_time_advanced: 'Demo time advanced',
};
const summary = (e: StaffLogEntry) =>
  Object.entries(e.detail)
    .filter(([k]) => !['public_id', 'drand_chain'].includes(k))
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('; ');

/** Every privileged change, with who made it. Organiser team only (the public log carries a pseudonymous staff reference instead). */
export function StaffLogCard({ api, program, refreshKey }: { api: ConsoleApi; program: Program; refreshKey?: unknown }) {
  const load = useCallback(() => consoleCalls(api).staffLog(), [api]);
  const state = useAsync(load, refreshKey);
  return (
    <Card
      title="Privileged changes"
      description="Written in the same transaction as each change. The public audit log carries the same events with a pseudonymous staff reference instead of a name."
      actions={<ButtonLink to={`/audit/${program.$id}`} variant="secondary" icon={<ScrollText size={16} aria-hidden="true" />}>Public audit log</ButtonLink>}
    >
      <AsyncView state={state} loadingLabel="Loading the staff log…">
        {(d) => (
          <DataTable<StaffLogEntry>
            caption="Staff log"
            hideCaption
            rows={d.entries}
            rowKey={(e) => e.id}
            empty={<p className="muted">No privileged changes yet.</p>}
            columns={[
              { key: 'at', header: 'When (server time)', render: (e) => formatDateTime(e.at, program.timezone) },
              { key: 'who', header: 'Who', render: (e) => e.actor },
              { key: 'what', header: 'What', render: (e) => ACTION_TEXT[e.action] ?? e.action },
              { key: 'target', header: 'Target', render: (e) => (e.target ? <code title={e.target}>{e.target.length > 16 ? `${e.target.slice(0, 8)}…` : e.target}</code> : '—') },
              { key: 'reason', header: 'Reason code', render: (e) => e.reasonCode ?? '—' },
              { key: 'detail', header: 'Detail', render: (e) => <span className="small">{summary(e)}</span> },
              { key: 'seq', header: 'Audit entry', numeric: true, render: (e) => (e.auditSeq ? `#${String(e.auditSeq)}` : '—') },
            ]}
          />
        )}
      </AsyncView>
    </Card>
  );
}

/** Fairness report card: the same sections as the public page, computed server-side from committed rows for organisers. */
export function FairnessCard({ api, program, refreshKey }: { api: ConsoleApi; program: Program; refreshKey?: unknown }) {
  const load = useCallback(() => consoleCalls(api).fairness(), [api]);
  const state = useAsync(load, refreshKey);
  return (
    <Card
      title="Fairness report"
      description="Computed from the frozen snapshot and the placements the draw committed. Families are counted, never named."
      actions={<ButtonLink to={`/fairness/${program.$id}`} variant="secondary" icon={<Scale size={16} aria-hidden="true" />}>Public report card</ButtonLink>}
    >
      <AsyncView state={state} loadingLabel="Computing the report…">
        {(f) => (f.ready ? <FairnessReportView report={f.report} programId={program.$id} /> : <p className="muted">Available after the draw.</p>)}
      </AsyncView>
    </Card>
  );
}
