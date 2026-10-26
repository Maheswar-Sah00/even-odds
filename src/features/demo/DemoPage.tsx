import { Query } from 'appwrite';
import { CircleCheck, Copy, FastForward, FlaskConical, Hourglass, PlayCircle, RotateCcw, ScrollText, ShieldAlert, ShieldCheck, Shuffle, Snowflake, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAppwriteContext } from '../../app/AppwriteContext.ts';
import { AsyncView, NotConfiguredBanner } from '../../components/AsyncView.tsx';
import { Banner, Button, ButtonLink, Card, DataTable, Dialog, LoadingState, PageHeader, StatusBadge, SyntheticBadge } from '../../components/ui/index.ts';
import type { ServiceError } from '@shared/errors.ts';
import type { OfferResponse } from '@shared/offer-input.ts';
import { OFFER_STATUS_TEXT } from '@shared/offer-lifecycle.ts';
import type { BrowserAppwrite } from '../../lib/appwrite/client.ts';
import type { BrowserDb } from '../../lib/appwrite/db.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { useAuth } from '../auth/auth-context.ts';
import { demoApi, demoConsoleApi, type InspectorStep, type SandboxFamily, type SandboxStatus } from '../console/console-api.ts';
import { ProgramConsole } from '../console/ProgramConsole.tsx';
import { newIdempotencyKey } from '../offers/offers-api.ts';

const short = (id: string | null) => (id ? id.slice(0, 8) : '—');
const MODE_TEXT = { together_only: 'Together only', together_preferred: 'Together preferred', independent: 'Independent' } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface InspectorEntry {
  id: number;
  title: string;
  at: string;
  steps: InspectorStep[];
  error?: string;
}

/** Live countdown to the announced drand round, corrected by the server clock offset. */
function Countdown({ roundAt, offsetMs }: { roundAt: string; offsetMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(t); };
  }, []);
  const left = Math.max(0, Math.ceil((Date.parse(roundAt) - (now + offsetMs)) / 1000));
  return <span aria-live="off">{left > 0 ? `arrives in ${String(left)} s` : 'is due now; verifying…'}</span>;
}

function StartDemo() {
  const { appwrite } = useAppwriteContext();
  const { refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    if (!appwrite) return;
    setBusy(true);
    setError(null);
    try {
      // A guest session: no email, no password, no external setup. It identifies this browser's sandbox.
      await appwrite.log.run('account.createAnonymousSession', () => appwrite.account.createAnonymousSession());
      await refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Card title="Start the judge demo" description="One click, no sign-up. You get a private sandbox: a pre-seeded camp program with 16 synthetic families, which only you can see.">
      <div className="stack">
        <ol className="start-steps">
          <li>
            <span className="start-steps__icon" aria-hidden="true">
              <ShieldCheck size={20} strokeWidth={1.6} />
            </span>
            <span>
              <strong>See the database say no</strong>
              Watch the database block a duplicate child and refuse an over-full sibling group.
            </span>
          </li>
          <li>
            <span className="start-steps__icon" aria-hidden="true">
              <Snowflake size={20} strokeWidth={1.6} />
            </span>
            <span>
              <strong>Freeze, then seed</strong>
              Fast-forward to the close: inputs are frozen and hashed, then a live drand round seeds the draw.
            </span>
          </li>
          <li>
            <span className="start-steps__icon" aria-hidden="true">
              <PlayCircle size={20} strokeWidth={1.6} />
            </span>
            <span>
              <strong>Draw, reply, replay</strong>
              Run the draw, reply as families, expire offers, then replay the draw in your own browser.
            </span>
          </li>
        </ol>
        <div>
          <Button size="lg" icon={<FlaskConical size={18} aria-hidden="true" />} loading={busy} loadingLabel="Starting…" onClick={() => void start()}>
            Start the judge demo
          </Button>
        </div>
        {error ? <Banner tone="error">{error}</Banner> : null}
      </div>
    </Card>
  );
}

function StepCard({ n, title, state, children, action }: { n: number; title: string; state: 'done' | 'ready' | 'later'; children: ReactNode; action?: ReactNode }) {
  return (
    <li className="demo-step" data-state={state}>
      <div className="demo-step__head">
        <span className="demo-step__n" aria-hidden="true">{state === 'done' ? <CircleCheck size={18} /> : n}</span>
        <h3>
          <span className="visually-hidden">Step {n}: </span>
          {title}
        </h3>
        {state === 'done' ? <StatusBadge tone="success">Done</StatusBadge> : state === 'later' ? <StatusBadge tone="neutral">Later</StatusBadge> : null}
      </div>
      <div className="demo-step__body">{children}</div>
      {action ? <div className="row">{action}</div> : null}
    </li>
  );
}

function Inspector({ entries }: { entries: InspectorEntry[] }) {
  return (
    <Card title="Database inspector" description="What TablesDB actually answered for each control, newest first. Nothing here is scripted: every line comes from the server's response.">
      {entries.length === 0 ? (
        <p className="muted">Run a step of the demo script to see the operations and the database's answers.</p>
      ) : (
        <ol className="inspector" aria-live="polite">
          {entries.map((e) => (
            <li key={e.id}>
              <p className="inspector__title">
                <strong>{e.title}</strong> <span className="muted small">{new Date(e.at).toLocaleTimeString()}</span>
              </p>
              {e.error ? <Banner tone="error">{e.error}</Banner> : null}
              <ul>
                {e.steps.map((s, i) => (
                  <li key={i} className="inspector__step" data-outcome={s.outcome}>
                    <StatusBadge tone={s.outcome === 'ok' ? 'success' : s.outcome === 'refused' ? 'danger' : 'info'}>{s.outcome === 'ok' ? 'committed' : s.outcome === 'refused' ? 'refused' : 'info'}</StatusBadge>{' '}
                    <code>{s.op}</code> {s.detail}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/** Demo names carry a [SYNTHETIC] prefix; the roster's caption already says so, so cells show the plain name. */
const plainName = (name: string) => name.replace(/^\[SYNTHETIC\]\s*/, '');
const initials = (label: string) => label.replace(/ household$/i, '').slice(0, 2).toUpperCase();
const TIER_TONE = ['green', 'cyan'] as const; // tier 0 is the top priority; lower tiers stay neutral
const AVATAR_TONES = ['burgundy', 'purple', 'green', 'cyan', 'yellow', 'red'] as const;

function Applied({ iso, timeZone }: { iso: string; timeZone: string }) {
  const d = new Date(iso);
  return (
    <span className="cell-stack">
      <span>{new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone }).format(d)}</span>
      <span className="cell-sub">{new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone }).format(d)}</span>
    </span>
  );
}

function Roster({ status, busy, onRespond }: { status: SandboxStatus; busy: boolean; onRespond: (f: SandboxFamily, r: OfferResponse) => void }) {
  const drawn = status.program.status === 'drawn';
  return (
    <DataTable<SandboxFamily>
      caption="Synthetic households in your sandbox"
      hideCaption
      rows={status.families}
      rowKey={(f) => f.key}
      columns={[
        {
          key: 'name',
          header: 'Household',
          className: 'cell-primary',
          render: (f) => {
            const tone = AVATAR_TONES[Array.from(f.key).reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_TONES.length];
            return (
              <div className="cell-person">
                <span className="avatar" data-tone={tone} aria-hidden="true">
                  {initials(f.label)}
                </span>
                <span className="cell-stack">
                  <strong>{f.label}</strong>
                  <span className="cell-sub">{f.children.map((c) => plainName(c.name)).join(', ')}</span>
                  {f.children.length > 1 ? (
                    <span className="pill pill--sm">
                      <span className="visually-hidden">Siblings: </span>
                      {MODE_TEXT[f.siblingMode]}
                    </span>
                  ) : null}
                  {f.note ? <span className="cell-note">{f.note}</span> : null}
                </span>
              </div>
            );
          },
        },
        { key: 'receipt', header: 'Receipt', render: (f) => <code className="chip-code" title={f.publicId ?? ''}>{short(f.publicId)}</code> },
        {
          key: 'tier',
          header: 'Priority tier',
          render: (f) => (
            <span className="cell-stack">
              {f.tierLabel ? <span className="pill" data-tone={TIER_TONE[f.tier ?? 2]}>{f.tierLabel}</span> : <span className="cell-empty">—</span>}
              {f.nearBoundary ? <StatusBadge tone="pending">Near a zone edge</StatusBadge> : null}
            </span>
          ),
        },
        { key: 'applied', header: 'Applied', className: 'cell-nowrap', render: (f) => (f.submittedAt ? <Applied iso={f.submittedAt} timeZone={status.program.timezone} /> : <span className="cell-empty">—</span>) },
        {
          key: 'result',
          header: 'Result',
          className: 'cell-result',
          render: (f) =>
            !drawn ? (
              <span className="cell-empty">After the draw</span>
            ) : (
              <ul className="offer-lines">
                {f.offers.length === 0 && f.waiting === 0 ? <li className="cell-empty">No week</li> : null}
                {f.offers.map((o) => (
                  <li key={o.placementId}>
                    <span className="offer-lines__week">
                      {o.week.replace(/^\d{4}-/, '')} · {o.ageGroup.replace('-', '–')}
                    </span>
                    <StatusBadge tone={OFFER_STATUS_TEXT[o.status].tone}>{`${OFFER_STATUS_TEXT[o.status].label}${o.source === 'waitlist' ? ' (from waitlist)' : ''}`}</StatusBadge>
                  </li>
                ))}
                {f.waiting > 0 ? <li className="cell-sub">+{f.waiting} on the waitlist</li> : null}
              </ul>
            ),
        },
        {
          key: 'act',
          header: <span className="visually-hidden">Reply as this household</span>,
          className: 'cell-actions',
          render: (f) => {
            if (!drawn || !f.publicId) return null;
            const pending = f.offers.some((o) => o.status === 'offered');
            const accepted = f.offers.some((o) => o.status === 'accepted');
            return (
              <span className="row-actions">
                {pending ? (
                  <>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => { onRespond(f, 'accept'); }}>Accept<span className="visually-hidden"> for {f.label}</span></Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => { onRespond(f, 'decline'); }}>Decline<span className="visually-hidden"> for {f.label}</span></Button>
                  </>
                ) : null}
                {!pending && accepted ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => { onRespond(f, 'giveBack'); }}>Give back<span className="visually-hidden"> for {f.label}</span></Button> : null}
              </span>
            );
          },
        },
      ]}
    />
  );
}

async function loadConsoleRows(db: BrowserDb, programId: string) {
  const [program, sessions, zones] = await Promise.all([
    db.getRow('programs', programId),
    db.listRows('seat_ledger', [Query.equal('program_id', programId), Query.limit(100)]),
    db.listRows('zones', [Query.equal('program_id', programId), Query.limit(50)]),
  ]);
  return { program, sessions: sessions.rows, zones: zones.rows };
}

function Sandbox({ app, db }: { app: BrowserAppwrite; db: BrowserDb }) {
  const load = useCallback(async () => {
    const status = await demoApi(app).status();
    return { status, rows: await loadConsoleRows(db, status.program.id), offsetMs: Date.parse(status.draw.serverTime) - Date.now() };
  }, [app, db]);
  const state = useAsync(load, 'sandbox');
  const consoleApi = useMemo(() => demoConsoleApi(app), [app]);
  const [entries, setEntries] = useState<InspectorEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'close' | 'expire' | 'reset' | null>(null);
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  const alive = useRef(true);
  const counter = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const log = (title: string, steps: InspectorStep[], error?: string) => {
    counter.current += 1;
    const entry: InspectorEntry = { id: counter.current, title, at: new Date().toISOString(), steps, ...(error ? { error } : {}) };
    setEntries((list) => [entry, ...list].slice(0, 15));
  };
  const changed = () => {
    state.reload();
    setRefreshKey((k) => k + 1);
  };
  const act = async (id: string, title: string, work: () => Promise<InspectorStep[]>) => {
    setBusy(id);
    try {
      log(title, await work());
      setDone((d) => new Set(d).add(id));
    } catch (err) {
      log(title, [], (err as ServiceError).message);
    } finally {
      setBusy(null);
      setConfirm(null);
      if (alive.current) changed();
    }
  };

  const api = demoApi(app);
  const runDraw = () =>
    act('draw', 'Run the draw', async () => {
      const all: InspectorStep[] = [];
      for (let i = 0; i < 60 && alive.current; i++) {
        const r = await api.runDraw();
        all.push(...r.steps.filter((s) => !all.some((x) => x.detail === s.detail)));
        const d = r.status;
        if (d.status === 'drawn' && d.offersIssuedAt) break;
        if (d.run?.status === 'failed') break;
        if (d.roundAt && Date.parse(d.serverTime) < Date.parse(d.roundAt)) {
          setWaitingFor(d.roundAt);
          await sleep(Math.min(60_000, Date.parse(d.roundAt) - Date.parse(d.serverTime) + 3000));
        } else {
          setWaitingFor(null);
          await sleep(1000);
        }
      }
      setWaitingFor(null);
      return all;
    });
  const expire = () =>
    act('expire', 'Fast-forward 48 hours', async () => {
      const r = await api.expireOffers();
      const steps = [...r.steps];
      let more = r.sweep.more;
      for (let i = 0; more && i < 12 && alive.current; i++) {
        const next = await consoleApi.command<{ expired: number; promoted: number; more: boolean }>({ action: 'processOffers' });
        steps.push({ op: 'sweep', detail: `Continued: ${String(next.expired)} more expired, ${String(next.promoted)} more offered from the waitlist.`, outcome: 'ok' });
        more = next.more;
      }
      return steps;
    });

  return (
    <AsyncView state={state} loadingLabel="Preparing your private sandbox: writing the program, 8 sessions and 16 synthetic households to TablesDB (about 15 seconds the first time)…">
      {({ status, rows, offsetMs }) => {
        const s = status.program.status;
        const open = s === 'open';
        const frozen = s === 'frozen';
        const drawn = s === 'drawn';
        const pendingOffers = status.families.some((f) => f.offers.some((o) => o.status === 'offered'));
        const hint = status.duplicateHint;
        return (
          <div className="stack">
            <Banner tone="demo" title="Judge sandbox: everything here is synthetic">
              Your own copy of a seeded program, private to this browser session. Demo time only moves this sandbox's deadlines; it never changes a clock or any real program. Every
              control runs the production code against real TablesDB rows.
            </Banner>
            <div className="row">
              <StatusBadge tone="demo">{`Program status: ${s}`}</StatusBadge>
              <SyntheticBadge />
              {status.program.demoAdvancedMs > 0 ? <StatusBadge tone="info">{`Demo time advanced ${(status.program.demoAdvancedMs / 3600_000).toFixed(1)} h`}</StatusBadge> : null}
              <Button size="sm" variant="ghost" icon={<RotateCcw size={16} aria-hidden="true" />} disabled={busy !== null} onClick={() => { setConfirm('reset'); }}>
                Reset sandbox
              </Button>
            </div>

            <div className="demo-grid">
              <Card title="Demo script" description="Seven steps, about two minutes. Each one is a real database operation.">
                <ol className="demo-steps">
                  <StepCard
                    n={1}
                    title="Two parents, one ticket"
                    state={done.has('duplicate') ? 'done' : open ? 'ready' : 'later'}
                    action={open ? <Button size="sm" icon={<Copy size={16} aria-hidden="true" />} loading={busy === 'duplicate'} loadingLabel="Trying…" disabled={busy !== null} onClick={() => void act('duplicate', 'Two parents, one ticket', async () => (await api.duplicateChild()).steps)}>Register Maya again from a second household</Button> : null}
                  >
                    A second household registers the Rivera family's Maya. The unique index on (program, child key) refuses the second ticket. Try it yourself as a family too: add a
                    child named <code>{hint.firstName}</code> <code>{hint.lastName}</code>, born {hint.birthdate}, and apply to this program.
                  </StepCard>
                  <StepCard
                    n={2}
                    title="Fast-forward to the close, freeze the inputs"
                    state={!open ? 'done' : 'ready'}
                    action={open ? <Button size="sm" icon={<FastForward size={16} aria-hidden="true" />} loading={busy === 'close'} loadingLabel="Freezing…" disabled={busy !== null} onClick={() => { setConfirm('close'); }}>Fast-forward to the close</Button> : null}
                  >
                    Moves this sandbox's window so it closed a second ago, announces a drand round 45 s ahead, then freezes: every input is hashed and published in one transaction.
                  </StepCard>
                  <StepCard
                    n={3}
                    title="A live drand round seeds the draw"
                    state={drawn ? 'done' : frozen ? 'ready' : 'later'}
                    action={
                      frozen ? (
                        <Button size="sm" icon={<Shuffle size={16} aria-hidden="true" />} loading={busy === 'draw'} loadingLabel={waitingFor ? 'Waiting for drand…' : 'Drawing…'} disabled={busy !== null} onClick={() => void runDraw()}>
                          Run the draw
                        </Button>
                      ) : null
                    }
                  >
                    {status.draw.drandRound && status.draw.roundAt && !drawn ? (
                      <p>
                        <Hourglass size={14} aria-hidden="true" /> Round {status.draw.drandRound} <Countdown roundAt={waitingFor ?? status.draw.roundAt} offsetMs={offsetMs} />
                      </p>
                    ) : null}
                    The beacon is fetched from drand, its BLS signature verified, and the seed derived. Each family is then placed in one transaction: capped seat increments plus
                    unique placements.
                  </StepCard>
                  <StepCard
                    n={4}
                    title="The database refused: full-seat rollback"
                    state={done.has('rollback') ? 'done' : drawn ? 'ready' : 'later'}
                    action={drawn ? <Button size="sm" icon={<ShieldAlert size={16} aria-hidden="true" />} loading={busy === 'rollback'} loadingLabel="Trying…" disabled={busy !== null} onClick={() => void act('rollback', 'Full-seat rollback', async () => (await api.rollback()).steps)}>Squeeze a sibling pair into a full week</Button> : null}
                  >
                    {status.rollbackFamily.children.map((c) => `${c.name} (${c.ageGroup})`).join(' and ')} try to take one week together in which one age group is full. Both
                    seats are staged in one transaction; the cap refuses it at commit and nothing is kept.
                  </StepCard>
                  <StepCard n={5} title="Families reply" state={done.has('reply') ? 'done' : drawn && pendingOffers ? 'ready' : 'later'}>
                    Accept or decline for any household in the table below. A decline releases the seat and offers it to the next waiting child in lottery order.
                  </StepCard>
                  <StepCard
                    n={6}
                    title="Fast-forward 48 hours: offers expire, the waitlist moves"
                    state={done.has('expire') ? 'done' : drawn && pendingOffers ? 'ready' : 'later'}
                    action={drawn && pendingOffers ? <Button size="sm" icon={<FastForward size={16} aria-hidden="true" />} loading={busy === 'expire'} loadingLabel="Expiring…" disabled={busy !== null} onClick={() => { setConfirm('expire'); }}>Fast-forward 48 hours</Button> : null}
                  >
                    Moves every pending offer's clock 48 h earlier. Expiry is then decided by Appwrite server time, and freed seats go to the waitlist in strict lottery order.
                  </StepCard>
                  <StepCard
                    n={7}
                    title="Replay it yourself"
                    state={drawn ? 'ready' : 'later'}
                    action={
                      <>
                        <ButtonLink size="sm" to={`/replay/${status.program.id}`} icon={<PlayCircle size={16} aria-hidden="true" />}>Replay the draw</ButtonLink>
                        <ButtonLink size="sm" variant="secondary" to={`/audit/${status.program.id}`} icon={<ScrollText size={16} aria-hidden="true" />}>Audit log</ButtonLink>
                      </>
                    }
                  >
                    Your browser fetches the drand beacon, verifies its signature and the inputs hash, recomputes the draw and checks every placement.
                  </StepCard>
                </ol>
              </Card>
              <div className="stack">
                <Inspector entries={entries} />
                <Card title="Why TablesDB" description="The guarantees above are the database's, not the app's.">
                  <ul className="small">
                    <li><strong>Transactions</strong>: a sibling group, a freeze, an offer reply and every privileged change with its log commit whole or not at all.</li>
                    <li><strong>incrementRowColumn with max</strong>: a seat counter that cannot pass capacity; the commit is refused instead.</li>
                    <li><strong>Unique indexes</strong>: one ticket per child, one placement per child and week, one exit per offer state.</li>
                    <li><strong>Geo queries</strong>: tiers from point-in-polygon and 50 m edge checks on the zone polygons.</li>
                    <li><strong>Row permissions + Teams</strong>: this sandbox is readable only through your private Team; families see only their rows.</li>
                    <li><strong>Bulk upserts</strong>: the 16 households were seeded in a handful of bulk writes.</li>
                  </ul>
                </Card>
              </div>
            </div>

            <Card
              className="card--table"
              title={<><Users size={18} aria-hidden="true" /> Synthetic households <span className="table-caption__count">{status.families.length}</span></>}
              description="All 16 applicant households, by receipt code as the organiser sees them, plus the names a demo can show because they are invented."
            >
              <Roster
                status={status}
                busy={busy !== null}
                onRespond={(f, response) => {
                  if (!f.publicId) return;
                  const id = f.publicId;
                  void act('reply', `${f.label}: ${response === 'giveBack' ? 'give back' : response}`, async () => (await api.respondAs(id, response)).steps);
                }}
              />
            </Card>

            <section className="stack" aria-labelledby="sandbox-console">
              <h2 id="sandbox-console">Organiser console (your sandbox)</h2>
              <p className="muted">The same control centre organisers use. Every change here is logged with you as the actor.</p>
              <ProgramConsole app={app} api={consoleApi} program={rows.program} sessions={rows.sessions} zones={rows.zones} onChanged={changed} refreshKey={refreshKey} defaultTab="demand" />
            </section>

            <Dialog
              open={confirm === 'close'}
              onClose={() => { setConfirm(null); }}
              title="Fast-forward to the close?"
              footer={
                <>
                  <Button variant="ghost" onClick={() => { setConfirm(null); }}>Cancel</Button>
                  <Button loading={busy === 'close'} loadingLabel="Freezing…" onClick={() => void act('close', 'Fast-forward to the close', async () => (await api.closeApplications()).steps)}>Close and freeze</Button>
                </>
              }
            >
              <p>Applications in your sandbox close now and every input is frozen. Overrides and tier decisions you made are included; nothing can change afterwards except by resetting the sandbox.</p>
            </Dialog>
            <Dialog
              open={confirm === 'expire'}
              onClose={() => { setConfirm(null); }}
              title="Fast-forward 48 hours?"
              footer={
                <>
                  <Button variant="ghost" onClick={() => { setConfirm(null); }}>Cancel</Button>
                  <Button loading={busy === 'expire'} loadingLabel="Expiring…" onClick={() => void expire()}>Expire pending offers</Button>
                </>
              }
            >
              <p>Every offer still awaiting a reply in your sandbox expires and its seat goes to the waitlist. Accepted places are kept.</p>
            </Dialog>
            <Dialog
              open={confirm === 'reset'}
              onClose={() => { setConfirm(null); }}
              title="Reset your sandbox?"
              footer={
                <>
                  <Button variant="ghost" onClick={() => { setConfirm(null); }}>Cancel</Button>
                  <Button
                    variant="danger"
                    loading={busy === 'reset'}
                    loadingLabel="Resetting…"
                    onClick={() =>
                      void act('reset', 'Reset sandbox', async () => {
                        const r = await api.reset(newIdempotencyKey());
                        setDone(new Set());
                        setEntries([]);
                        return [{ op: 'reset', detail: `Fresh seeded scenario (generation ${String(r.generation)}); the previous sandbox and its rows are being deleted.`, outcome: 'ok' }];
                      })
                    }
                  >
                    Reset sandbox
                  </Button>
                </>
              }
            >
              <p>Deletes everything in your sandbox, including any application you made in it as a family, and restores the seeded scenario. Nothing outside your sandbox is touched.</p>
            </Dialog>
          </div>
        );
      }}
    </AsyncView>
  );
}

/** /demo: the judge sandbox. Starts a guest session if needed; everything else is server-side. */
export function DemoPage() {
  const { appwrite, db } = useAppwriteContext();
  const { state } = useAuth();
  return (
    <div className="page">
      <div className="stack">
        <PageHeader eyebrow="Judge demo" title="Even Odds in two minutes" description="A pre-seeded, private sandbox: watch TablesDB enforce fairness, then replay the draw yourself." />
        {!appwrite || !db ? (
          <NotConfiguredBanner what="The judge demo" />
        ) : state.status === 'loading' ? (
          <LoadingState label="Checking your session…" />
        ) : state.status === 'signed_in' ? (
          <Sandbox app={appwrite} db={db} />
        ) : state.status === 'error' ? (
          <Banner tone="error">{state.message}</Banner>
        ) : (
          <StartDemo />
        )}
      </div>
    </div>
  );
}
