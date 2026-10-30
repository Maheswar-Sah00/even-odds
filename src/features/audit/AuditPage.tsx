import { Download, PlayCircle, ScrollText } from 'lucide-react';
import { useCallback } from 'react';
import { useParams } from 'react-router';
import { useBrowserDb } from '../../app/AppwriteContext.ts';
import { AsyncView, NotConfiguredBanner } from '../../components/AsyncView.tsx';
import { Banner, Button, ButtonLink, Card, DataTable, EmptyState, PageHeader, StatusBadge, type Tone } from '../../components/ui/index.ts';
import { auditIntegrity, type AuditIssue } from '@shared/audit-chain.ts';
import { DRAND_CHAIN, roundTimeMs } from '@shared/freeze/drand.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { drawPhase, loadPublished, type DrawPhase, type PublishedRecord } from './verify.ts';

const PHASE_TONE: Record<DrawPhase, Tone> = { not_frozen: 'neutral', awaiting_round: 'pending', beacon_pending: 'pending', drawing: 'info', drawn: 'success', failed: 'danger' };
const REASON_LABEL: Record<string, string> = {
  accommodation: 'Accommodation',
  sibling_enrolled: 'Sibling already enrolled',
  staff_family: 'Staff family',
  policy_exception: 'Policy exception',
};

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** What is published for independent verification: hashes, counts and categories only. */
function FreezeSummary({ rec }: { rec: PublishedRecord }) {
  const { program, snapshot, run } = rec;
  const { phase, label } = drawPhase(rec);
  const overrideCounts = snapshot ? (JSON.parse(snapshot.override_counts) as Record<string, number>) : {};
  // Only claim the announcement when the audit log shows this exact round being announced.
  const announcedInLog = rec.audit.some((e) => {
    if (e.event !== 'program_published' && e.event !== 'drand_round_announced') return false;
    try {
      return (JSON.parse(e.payload) as { drand_round?: number }).drand_round === program.drand_round;
    } catch {
      return false;
    }
  });
  return (
    <Card title="Freeze and draw" description="The inputs are frozen and hashed before the random value exists; anyone can recompute every value below.">
      <div className="stack">
        <div className="row">
          <StatusBadge tone={PHASE_TONE[phase]}>{label}</StatusBadge>
          <ButtonLink to={`/replay/${program.$id}`} variant="secondary" size="sm" icon={<PlayCircle size={16} aria-hidden="true" />}>
            Verify and replay in your browser
          </ButtonLink>
        </div>
        <dl className="kv">
          <dt>drand round</dt>
          <dd>
            {program.drand_round ? (
              <>
                {program.drand_round} on the quicknet chain (<code title={DRAND_CHAIN.hash}>{DRAND_CHAIN.hash.slice(0, 12)}…</code>), due {formatDateTime(new Date(roundTimeMs(program.drand_round)).toISOString(), program.timezone)}.{' '}
                {announcedInLog ? 'Announced in the audit log before applications closed.' : <strong>Not the round recorded in the audit log.</strong>}
              </>
            ) : (
              'Not announced yet.'
            )}
          </dd>
          {snapshot ? (
            <>
              <dt>Frozen inputs hash</dt>
              <dd><code>{snapshot.inputs_hash}</code></dd>
              <dt>Frozen at</dt>
              <dd>{formatDateTime(snapshot.frozen_at, program.timezone)}</dd>
              <dt>Algorithm</dt>
              <dd><code>{snapshot.algorithm}</code>, inputs format <code>{snapshot.format}</code></dd>
              <dt>Records</dt>
              <dd>
                {snapshot.applications} applications, {snapshot.children} children, {snapshot.sessions} sessions ({snapshot.seats} places)
              </dd>
              <dt>Overrides</dt>
              <dd>
                {snapshot.overrides === 0
                  ? 'None.'
                  : Object.keys(overrideCounts).length === 0
                    ? `${String(snapshot.overrides)} approved before the freeze. Reasons are kept private to staff.`
                    : `${String(snapshot.overrides)} approved before the freeze: ${Object.entries(overrideCounts).map(([k, n]) => `${REASON_LABEL[k] ?? k} ${String(n)}`).join(', ')}.`}
              </dd>
            </>
          ) : null}
          {run?.beacon_verified ? (
            <>
              <dt>Beacon</dt>
              <dd>
                Verified {run.beacon_verified_at ? formatDateTime(run.beacon_verified_at, program.timezone) : ''} with {run.beacon_verifier}; randomness <code title={run.beacon_randomness ?? ''}>{run.beacon_randomness?.slice(0, 16)}…</code>
              </dd>
              <dt>Seed</dt>
              <dd><code>{run.seed}</code> ({run.seed_scheme})</dd>
            </>
          ) : run?.beacon_last_error ? (
            <>
              <dt>Beacon</dt>
              <dd>Not verified yet ({run.beacon_attempts ?? 0} attempts). The draw waits; no other source of randomness is used.</dd>
            </>
          ) : null}
          {run?.plan_hash ? (
            <>
              <dt>Plan hash</dt>
              <dd><code>{run.plan_hash}</code></dd>
            </>
          ) : null}
          {rec.result ? (
            <>
              <dt>Published result</dt>
              <dd>
                {rec.result.placements} placements and {rec.result.waitlist} waitlist entries, read back from the committed rows; SHA-256 <code>{rec.result.result_hash}</code>
              </dd>
            </>
          ) : null}
        </dl>
        {snapshot ? (
          <div>
            <Button size="sm" variant="secondary" icon={<Download size={16} aria-hidden="true" />} onClick={() => { download(`${program.$id}-frozen-inputs.json`, snapshot.canonical); }}>
              Download frozen inputs (canonical JSON)
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

export function AuditPage() {
  const { programId = '' } = useParams();
  const db = useBrowserDb();
  const load = useCallback(() => (db ? loadPublished(db, programId) : Promise.reject(new Error('not configured'))), [db, programId]);
  const state = useAsync(db ? load : null, programId);

  return (
    <div className="stack">
      <PageHeader
        eyebrow="Public verification"
        tone="burgundy"
        title="Audit log"
        description="Every key event, hash-chained: each entry includes the hash of the one before it, so any edit breaks the chain. Identifiers are pseudonymous; no names, birthdates or homes are published."
      />
      {!db ? <NotConfiguredBanner what="The audit log" /> : null}
      {db ? (
        <AsyncView state={state} loadingLabel="Loading audit log…">
          {(rec) => {
            const integrity = auditIntegrity(rec.audit);
            const issuesBySeq = new Map<number, AuditIssue[]>();
            for (const i of integrity.issues) if (i.seq !== null) issuesBySeq.set(i.seq, [...(issuesBySeq.get(i.seq) ?? []), i]);
            return (
              <div className="stack">
                <FreezeSummary rec={rec} />
                <Card
                  title="Entries"
                  description={
                    rec.audit.length === 0
                      ? undefined
                      : integrity.ok
                        ? `Chain checked in your browser: all ${String(integrity.records)} entries intact. Head ${integrity.head?.slice(0, 12) ?? ''}….`
                        : `Chain checked in your browser: ${String(integrity.issues.length)} problem(s); ${String(integrity.verified)} of ${String(integrity.records)} entries verified.`
                  }
                >
                  {integrity.issues.length > 0 ? (
                    <Banner tone="error" title="The audit log has been altered or is incomplete">
                      <ul>{integrity.issues.map((i, n) => <li key={`${String(i.seq)}-${String(n)}`}>{i.message}</li>)}</ul>
                    </Banner>
                  ) : null}
                  <p className="small muted">
                    An intact chain proves that no published entry was edited, removed, reordered or inserted after it was written. It does not prove that what an organiser entered (tiers, overrides, capacities) was true, only that it was not changed afterwards.
                  </p>
                  <DataTable
                    caption="Audit entries"
                    hideCaption
                    rows={rec.audit}
                    rowKey={(r) => r.$id}
                    empty={
                      <EmptyState icon={ScrollText} title="No audit entries yet">
                        Entries appear when the program opens, freezes and draws.
                      </EmptyState>
                    }
                    columns={[
                      { key: 'seq', header: '#', numeric: true, render: (r) => r.seq },
                      {
                        key: 'check',
                        header: 'Check',
                        render: (r) => {
                          const found = issuesBySeq.get(r.seq);
                          return found ? <StatusBadge tone="danger">{found.map((i) => i.kind.replace('_', ' ')).join(', ')}</StatusBadge> : <StatusBadge tone="success">intact</StatusBadge>;
                        },
                      },
                      { key: 'event', header: 'Event', render: (r) => r.event },
                      { key: 'time', header: 'Recorded', render: (r) => formatDateTime(r.$createdAt) },
                      { key: 'hash', header: 'Entry hash', render: (r) => <code title={r.entry_hash}>{r.entry_hash.slice(0, 12)}…</code> },
                      {
                        key: 'payload',
                        header: 'Payload',
                        render: (r) => (
                          <details>
                            <summary>View</summary>
                            <code className="small">{r.payload}</code>
                          </details>
                        ),
                      },
                    ]}
                  />
                </Card>
              </div>
            );
          }}
        </AsyncView>
      ) : null}
    </div>
  );
}
