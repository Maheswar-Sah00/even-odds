import { CircleCheck, Pencil, Undo2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useLocation, useParams } from 'react-router';
import { useAppwriteContext } from '../../app/AppwriteContext.ts';
import { AsyncView, NotConfiguredBanner } from '../../components/AsyncView.tsx';
import { Banner, Button, ButtonLink, Card, Dialog, EmptyState, PageHeader, StatusBadge, SyntheticBadge } from '../../components/ui/index.ts';
import { HONESTY_NOTE, ODDS_CAVEAT, SIBLING_MODE_TEXT, weeksForChild } from '@shared/eligibility.ts';
import type { ServiceError } from '@shared/errors.ts';
import { formatDate, formatDateTime } from '../../lib/format.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { householdApi } from '../family/household-api.ts';
import { tierLabelsOf } from '../programs/program-view.ts';
import { useApplicationContext } from './useApplicationContext.ts';

const STATUS = { submitted: { label: 'Submitted', tone: 'success' }, withdrawn: { label: 'Withdrawn', tone: 'neutral' }, draft: { label: 'Draft', tone: 'pending' } } as const;

/** Receipt code: the pseudonymous public ID used in the frozen draw inputs, grouped for reading aloud. */
const receipt = (publicId: string) => publicId.toUpperCase().match(/.{1,4}/g)?.join(' ') ?? publicId;

function Receipt({ programId, applicationId }: { programId: string; applicationId: string }) {
  const { appwrite } = useAppwriteContext();
  const location = useLocation();
  const justSubmitted = (location.state as { justSubmitted?: string } | null)?.justSubmitted;
  const state = useApplicationContext(programId);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!appwrite) return null;

  return (
    <AsyncView state={state} loadingLabel="Loading your application…">
      {(ctx) => {
        const app = ctx.application;
        if (!app || app.$id !== applicationId) {
          return <EmptyState title="Application not found">This application does not exist or belongs to another household.</EmptyState>;
        }
        const p = ctx.program;
        const labels = tierLabelsOf(p);
        const editable = p.status === 'open';
        const s = STATUS[app.status];
        const weekLabel = new Map(ctx.sessions.map((x) => [x.week, x.label ?? x.week]));
        return (
          <div className="stack">
            <PageHeader eyebrow="Application receipt" title={p.name} />
            {justSubmitted ? (
              <Banner tone="success" title={justSubmitted === 'updated' ? 'Application updated' : 'Application received'}>
                Keep your receipt code. You can change your choices until applications close.
              </Banner>
            ) : null}
            <div className="row">
              <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
              {p.synthetic ? <SyntheticBadge /> : null}
              {app.late ? <StatusBadge tone="pending">Late application</StatusBadge> : null}
            </div>
            <Card title="Receipt">
              <dl className="kv">
                <dt>Receipt code</dt>
                <dd>
                  <span className="receipt-code">{receipt(app.public_id)}</span>
                  <br />
                  <span className="muted small">This pseudonymous code is how your application appears in the public draw inputs. It does not reveal who you are.</span>
                </dd>
                <dt>First submitted</dt>
                <dd>{app.submitted_at ? formatDateTime(app.submitted_at, p.timezone) : '—'} (does not affect your chance)</dd>
                <dt>Siblings</dt>
                <dd>{SIBLING_MODE_TEXT[app.sibling_mode].title}</dd>
                <dt>Priority tier</dt>
                <dd>
                  {labels[String(app.verified_tier ?? app.claimed_tier ?? '')] ?? '—'} {app.verified_tier === null || app.verified_tier === undefined ? '(claimed: worked out from your home location; organisers verify it before offers)' : '(verified)'}
                  {app.near_boundary ? <><br /><span className="muted small">Your home is within 50 m of a zone boundary, so staff will check your address.</span></> : null}
                </dd>
              </dl>
            </Card>
            <Card title="Your choices">
              <div className="stack">
                {ctx.preferences.map((pref) => {
                  const child = ctx.children.find((c) => c.$id === pref.child_id);
                  const ages = child ? new Map(weeksForChild(child.birthdate, ctx.sessions).map((w) => [w.week, w])) : new Map();
                  return (
                    <section key={pref.$id} className="stack-sm">
                      <h3>
                        {child?.first_name ?? 'Child'}: {pref.requested_weeks} week{pref.requested_weeks === 1 ? '' : 's'} requested
                      </h3>
                      <ol>
                        {pref.ranked_weeks.map((w, i) => (
                          <li key={w}>
                            {weekLabel.get(w) ?? w}
                            {ages.get(w) ? ` (from ${formatDate((ages.get(w) as { weekStart: string }).weekStart)}, ${pref.ranked_age_groups?.[i] ?? ''} group)` : ''}
                          </li>
                        ))}
                      </ol>
                    </section>
                  );
                })}
              </div>
            </Card>
            <Banner tone="info" title="About your chances">
              <p>{ODDS_CAVEAT}</p>
              <p>{HONESTY_NOTE}</p>
            </Banner>
            {error ? <Banner tone="error">{error}</Banner> : null}
            {editable ? (
              <div className="row">
                <ButtonLink to={`/applications/new/${p.$id}`} variant="secondary" icon={<Pencil size={16} aria-hidden="true" />}>
                  {app.status === 'withdrawn' ? 'Re-apply' : 'Change choices'}
                </ButtonLink>
                {app.status === 'submitted' ? (
                  <Button variant="ghost" icon={<Undo2 size={16} aria-hidden="true" />} onClick={() => { setConfirm(true); }}>
                    Withdraw application
                  </Button>
                ) : null}
              </div>
            ) : (
              <p className="muted">Applications are closed, so this application can no longer be changed.</p>
            )}
            <Dialog
              open={confirm}
              onClose={() => { setConfirm(false); }}
              title="Withdraw this application?"
              footer={
                <>
                  <Button variant="ghost" onClick={() => { setConfirm(false); }}>Keep it</Button>
                  <Button
                    variant="danger"
                    loading={busy}
                    loadingLabel="Withdrawing…"
                    onClick={() => {
                      setBusy(true);
                      setError(null);
                      householdApi(appwrite)
                        .withdrawApplication(p.$id)
                        .then(() => { setConfirm(false); state.reload(); }, (err: unknown) => { setError((err as ServiceError).message); setConfirm(false); })
                        .finally(() => { setBusy(false); });
                    }}
                  >
                    Withdraw
                  </Button>
                </>
              }
            >
              <p>Your children will not be entered in the draw. You can re-apply until applications close.</p>
            </Dialog>
            <p className="muted small">
              <CircleCheck size={14} aria-hidden="true" /> Stored in Appwrite TablesDB; only your household&apos;s guardians and the program organisers can read it.
            </p>
          </div>
        );
      }}
    </AsyncView>
  );
}

export function ApplicationPage() {
  const { applicationId = '' } = useParams();
  const { db } = useAppwriteContext();
  const load = useCallback(() => (db ? db.getRow('applications', applicationId) : Promise.reject(new Error('not configured'))), [db, applicationId]);
  const app = useAsync(db ? load : null, applicationId);

  if (!db) {
    return (
      <div className="stack">
        <PageHeader eyebrow="Application" title="Your application" />
        <NotConfiguredBanner what="Applications" />
      </div>
    );
  }
  return (
    <AsyncView
      state={app}
      loadingLabel="Loading your application…"
      notFound={
        <>
          <PageHeader eyebrow="Application" title="Your application" />
          <EmptyState title="Application not found" actions={<ButtonLink to="/family">Go to your household</ButtonLink>}>
            It does not exist, or it belongs to another household.
          </EmptyState>
        </>
      }
    >
      {(row) => <Receipt programId={row.program_id} applicationId={row.$id} />}
    </AsyncView>
  );
}
