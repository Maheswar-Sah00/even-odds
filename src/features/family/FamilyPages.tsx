import { Query } from 'appwrite';
import { Copy, House, UserPlus } from 'lucide-react';
import { useCallback, useState, type SyntheticEvent } from 'react';
import { Link } from 'react-router';
import { useAppwriteContext } from '../../app/AppwriteContext.ts';
import { AsyncView, NotConfiguredBanner } from '../../components/AsyncView.tsx';
import { Banner, Button, ButtonLink, Card, Dialog, PageHeader, StatusBadge, TextField } from '../../components/ui/index.ts';
import { formatInviteCode, inviteCodeSchema } from '@shared/household-input.ts';
import type { ServiceError } from '@shared/errors.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { householdApi, type HouseholdSummary } from './household-api.ts';
import { useHousehold } from './useHousehold.ts';

function NoHousehold({ onReady }: { onReady: () => void }) {
  const { appwrite } = useAppwriteContext();
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  if (!appwrite) return null;
  const api = householdApi(appwrite);

  const create = async () => {
    setBusy('create');
    setError(null);
    try {
      await api.create();
      onReady();
    } catch (err) {
      setError((err as ServiceError).message);
    } finally {
      setBusy(null);
    }
  };

  const join = async (e: SyntheticEvent) => {
    e.preventDefault();
    const parsed = inviteCodeSchema.safeParse(code);
    if (!parsed.success) {
      setCodeError(parsed.error.issues[0]?.message ?? 'Check the code');
      return;
    }
    setCodeError(null);
    setBusy('join');
    setError(null);
    try {
      await api.acceptInvite(parsed.data);
      onReady();
    } catch (err) {
      setError((err as ServiceError).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      {error ? <Banner tone="error">{error}</Banner> : null}
      <div className="card-grid">
        <Card title="Start a household" description="For the first guardian in your family.">
          <Button onClick={() => void create()} loading={busy === 'create'} loadingLabel="Creating…" icon={<House size={18} aria-hidden="true" />}>
            Create my household
          </Button>
        </Card>
        <Card title="Join a household" description="Another guardian already set one up and gave you an invite code.">
          <form className="stack-sm" onSubmit={(e) => void join(e)} noValidate>
            <TextField label="Invite code" placeholder="ABCDE-23456" autoComplete="off" value={code} error={codeError} onChange={(e) => { setCode(e.target.value); }} />
            <Button type="submit" variant="secondary" loading={busy === 'join'} loadingLabel="Joining…">
              Join household
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

function InvitePanel({ household }: { household: HouseholdSummary }) {
  const { appwrite } = useAppwriteContext();
  const [invite, setInvite] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!appwrite) return null;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setInvite(await householdApi(appwrite).createInvite());
    } catch (err) {
      setError((err as ServiceError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Guardians" description="Everyone listed can see and manage this household's children and applications.">
      <div className="stack">
        <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {household.guardians.map((g) => (
            <li key={g.userId} className="row">
              <span>{g.email || 'Guardian'}</span>
              {g.isYou ? <StatusBadge tone="info">You</StatusBadge> : null}
              <StatusBadge>{g.role === 'primary' ? 'Created the household' : 'Joined by invite'}</StatusBadge>
            </li>
          ))}
        </ul>
        {error ? <Banner tone="error">{error}</Banner> : null}
        <div>
          <Button variant="secondary" onClick={() => void create()} loading={busy} loadingLabel="Creating invite…" icon={<UserPlus size={18} aria-hidden="true" />}>
            Invite another guardian
          </Button>
        </div>
      </div>
      <Dialog
        open={invite !== null}
        onClose={() => {
          setInvite(null);
          setCopied(false);
        }}
        title="Share this invite code"
        footer={<Button onClick={() => { setInvite(null); setCopied(false); }}>Done</Button>}
      >
        {invite ? (
          <div className="stack-sm">
            <p>Give this code to the other guardian. They sign in with their own email, choose “Join a household” and enter it. It works once.</p>
            <p className="row">
              <code style={{ fontSize: '1.5rem', letterSpacing: '0.08em' }}>{formatInviteCode(invite.code)}</code>
              <Button
                variant="ghost"
                size="sm"
                icon={<Copy size={16} aria-hidden="true" />}
                onClick={() => {
                  void navigator.clipboard.writeText(formatInviteCode(invite.code)).then(() => {
                    setCopied(true);
                  });
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </p>
            <p className="muted small">Expires {formatDateTime(invite.expiresAt)}. We only store a scrambled version, so we cannot show it again.</p>
          </div>
        ) : null}
      </Dialog>
    </Card>
  );
}

function ApplicationsCard({ familyId }: { familyId: string }) {
  const { db } = useAppwriteContext();
  const load = useCallback(async () => {
    if (!db) throw new Error('not configured');
    const apps = await db.listRows('applications', [Query.equal('family_id', familyId), Query.limit(50)]);
    const ids = [...new Set(apps.rows.map((a) => a.program_id))];
    const programs = ids.length ? await db.listRows('programs', [Query.equal('$id', ids), Query.limit(50)]) : { rows: [] };
    return apps.rows.map((a) => ({ app: a, program: programs.rows.find((p) => p.$id === a.program_id) }));
  }, [db, familyId]);
  const state = useAsync(db ? load : null, familyId);
  return (
    <Card title="Applications" actions={<ButtonLink to="/programs" variant="secondary" size="sm">Browse programs</ButtonLink>}>
      <AsyncView state={state} loadingLabel="Loading applications…">
        {(list) =>
          list.length === 0 ? (
            <p className="muted">No applications yet. Open a program in the catalogue and choose Apply.</p>
          ) : (
            <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {list.map(({ app, program }) => (
                <li key={app.$id} className="row">
                  <Link to={`/applications/${app.$id}`}>{program?.name ?? 'Program'}</Link>
                  <StatusBadge tone={app.status === 'submitted' ? 'success' : 'neutral'}>{app.status === 'submitted' ? 'Submitted' : app.status === 'withdrawn' ? 'Withdrawn' : 'Draft'}</StatusBadge>
                </li>
              ))}
            </ul>
          )
        }
      </AsyncView>
    </Card>
  );
}

function LinkRequests({ familyId }: { familyId: string }) {
  const { appwrite, db } = useAppwriteContext();
  const load = useCallback(() => (db ? db.listRows('link_requests', [Query.equal('family_id', familyId), Query.equal('status', 'open'), Query.limit(20)]) : Promise.reject(new Error('not configured'))), [db, familyId]);
  const state = useAsync(db ? load : null, familyId);
  if (!appwrite || state.status !== 'success' || state.data.rows.length === 0) return null;
  return (
    <Banner tone="warning" title="Someone may be applying for one of your children">
      <p>
        A guardian with a different account tried to register a child whose details match one of yours. We did not share any of your information with them. If they are
        your child&apos;s other parent or carer, send them an invite code so you share one household and one ticket.
      </p>
      <div className="row">
        {state.data.rows.map((r) => (
          <Button key={r.$id} size="sm" variant="secondary" onClick={() => void householdApi(appwrite).dismissLinkRequest(r.$id).then(state.reload)}>
            Dismiss notice
          </Button>
        ))}
      </div>
    </Banner>
  );
}

export function FamilyHomePage() {
  const { appwrite } = useAppwriteContext();
  const household = useHousehold();
  const header = <PageHeader tone="cyan" eyebrow="My family" title="Household overview" description="Your household holds your children's details and applications. Only its guardians can see it." />;
  if (!appwrite) {
    return (
      <div className="stack">
        {header}
        <NotConfiguredBanner what="Your household" />
      </div>
    );
  }

  return (
    <div className="stack">
      {header}
      <AsyncView state={household} loadingLabel="Loading your household…">
        {(h) =>
          h === null ? (
            <NoHousehold onReady={household.reload} />
          ) : (
            <div className="stack">
              <LinkRequests familyId={h.familyId} />
              <ApplicationsCard familyId={h.familyId} />
              <InvitePanel household={h} />
              <Card title="Children" actions={<ButtonLink to="/family/children" variant="secondary" size="sm">Manage children</ButtonLink>}>
                <p className="muted">Add each child once. You choose which programs to enter them in when you apply.</p>
              </Card>
            </div>
          )
        }
      </AsyncView>
    </div>
  );
}

