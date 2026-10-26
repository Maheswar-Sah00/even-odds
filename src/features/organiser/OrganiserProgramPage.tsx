import { Query } from 'appwrite';
import { CircleCheck, Eye, Rocket, SearchX } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useAppwriteContext } from '../../app/AppwriteContext.ts';
import { AsyncView, NotConfiguredBanner } from '../../components/AsyncView.tsx';
import { Banner, Button, ButtonLink, Card, Dialog, EmptyState, PageHeader, StatusBadge, SyntheticBadge } from '../../components/ui/index.ts';
import type { ServiceError } from '@shared/errors.ts';
import type { ProgramDetails } from '@shared/program-input.ts';
import type { BrowserAppwrite } from '../../lib/appwrite/client.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { PHASE_LABEL, PHASE_TONE, phaseOf, tierLabelsOf, type Program } from '../programs/program-view.ts';
import { organiserApi } from './organiser-api.ts';
import { ProgramDetailsForm } from './ProgramDetailsForm.tsx';
import { productionConsoleApi } from '../console/console-api.ts';
import { ProgramConsole } from '../console/ProgramConsole.tsx';

const toDetails = (p: Program): ProgramDetails => ({
  name: p.name,
  description: p.description ?? '',
  timezone: p.timezone,
  windowOpen: p.window_open,
  windowClose: p.window_close,
  maxWeeks: p.max_weeks,
  defaultTier: p.default_tier ?? 0,
  tierLabels: tierLabelsOf(p),
});

function PublishSection({ app, program, onChanged }: { app: BrowserAppwrite; program: Program; onChanged: () => void }) {
  const [check, setCheck] = useState<{ ok: boolean; problems: string[] } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (program.status !== 'draft') {
    return (
      <Card title="Published">
        <p>
          Published {program.published_at ? formatDateTime(program.published_at, program.timezone) : ''}. Families can see it in the catalogue.
        </p>
        <ButtonLink to={`/programs/${program.$id}`} variant="secondary" icon={<Eye size={16} aria-hidden="true" />}>
          View public page
        </ButtonLink>
      </Card>
    );
  }

  const runCheck = async () => {
    setBusy(true);
    setError(null);
    try {
      setCheck(await organiserApi(app).checkPublish(program.$id));
    } catch (err) {
      setError((err as ServiceError).message);
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      await organiserApi(app).publish(program.$id);
      setConfirm(false);
      onChanged();
    } catch (err) {
      setError((err as ServiceError).message);
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Preview and publish" description="Publishing shows the program, its sessions and zones to everyone and records the configuration in the public audit log. Weeks, ages and zones cannot change afterwards.">
      <div className="stack">
        <div className="row">
          <ButtonLink to={`/programs/${program.$id}`} variant="secondary" icon={<Eye size={16} aria-hidden="true" />}>
            Preview public page
          </ButtonLink>
          <Button variant="secondary" loading={busy && !confirm} loadingLabel="Checking…" icon={<CircleCheck size={16} aria-hidden="true" />} onClick={() => void runCheck()}>
            Check readiness
          </Button>
          <Button disabled={!check?.ok} icon={<Rocket size={16} aria-hidden="true" />} onClick={() => { setConfirm(true); }}>
            Publish
          </Button>
        </div>
        {check ? (
          check.ok ? (
            <Banner tone="success">Ready to publish.</Banner>
          ) : (
            <Banner tone="warning" title="Fix these before publishing">
              <ul>{check.problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </Banner>
          )
        ) : null}
        {error ? <Banner tone="error">{error}</Banner> : null}
      </div>
      <Dialog
        open={confirm}
        onClose={() => { setConfirm(false); }}
        title="Publish this program?"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setConfirm(false); }}>Cancel</Button>
            <Button loading={busy} loadingLabel="Publishing…" onClick={() => void publish()}>Publish now</Button>
          </>
        }
      >
        <p>
          <strong>{program.name}</strong> will appear in the catalogue. Applications open {formatDateTime(program.window_open, program.timezone)} and close{' '}
          {formatDateTime(program.window_close, program.timezone)}. You will not be able to change weeks, age groups or zones afterwards.
        </p>
      </Dialog>
    </Card>
  );
}

export function OrganiserProgramPage() {
  const { programId = '' } = useParams();
  const { appwrite, db } = useAppwriteContext();
  const [saved, setSaved] = useState<string | null>(null);
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
  const api = useMemo(() => (appwrite ? productionConsoleApi(appwrite, programId) : null), [appwrite, programId]);

  if (!appwrite || !db) {
    return (
      <div className="stack">
        <PageHeader eyebrow="Organiser" title="Program setup" />
        <NotConfiguredBanner what="Program setup" />
      </div>
    );
  }

  return (
    <div className="stack">
      <AsyncView
        state={state}
        loadingLabel="Loading program…"
        notFound={
          <>
            <PageHeader eyebrow="Organiser" title="Program setup" />
            <EmptyState icon={SearchX} title="Program not found" actions={<ButtonLink to="/organiser" variant="secondary">Back to dashboard</ButtonLink>}>
              It does not exist or belongs to another organiser team.
            </EmptyState>
          </>
        }
      >
        {({ program, sessions, zones }) => (
          <div className="stack">
            <PageHeader eyebrow="Organiser · Control centre" title={program.name} />
            <div className="row">
              <StatusBadge tone={PHASE_TONE[phaseOf(program)]}>{PHASE_LABEL[phaseOf(program)]}</StatusBadge>
              {program.synthetic ? <SyntheticBadge /> : null}
            </div>
            <ProgramConsole
              app={appwrite}
              api={api ?? productionConsoleApi(appwrite, program.$id)}
              program={program}
              sessions={sessions}
              zones={zones}
              onChanged={state.reload}
              defaultTab={program.status === 'draft' ? 'setup' : 'demand'}
              setup={
                <>
                  <PublishSection app={appwrite} program={program} onChanged={state.reload} />
                  <Card title="Details" description={program.status === 'draft' ? 'Editable until you publish.' : 'Locked after publishing.'}>
                    <ProgramDetailsForm
                      key={program.$updatedAt}
                      initial={toDetails(program)}
                      submitLabel="Save details"
                      disabled={program.status !== 'draft'}
                      onSubmit={async (details) => {
                        await organiserApi(appwrite).updateProgram(program.$id, details);
                        setSaved('Details saved.');
                        state.reload();
                      }}
                    />
                    {saved ? <Banner tone="success">{saved}</Banner> : null}
                  </Card>
                </>
              }
            />
          </div>
        )}
      </AsyncView>
    </div>
  );
}
