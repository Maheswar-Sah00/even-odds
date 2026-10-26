import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, MapPin, Send } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAppwriteContext } from '../../app/AppwriteContext.ts';
import { AsyncView, NotConfiguredBanner } from '../../components/AsyncView.tsx';
import { HomeLocationFields } from '../../components/HomeLocationFields.tsx';
import { Banner, Button, ButtonLink, Card, EmptyState, LoadingState, PageHeader, SelectField, StatusBadge, SyntheticBadge } from '../../components/ui/index.ts';
import { HONESTY_NOTE, ODDS_CAVEAT, SIBLING_MODE_TEXT, weeksForChild, type WeekEligibility } from '@shared/eligibility.ts';
import type { ServiceError } from '@shared/errors.ts';
import type { LngLat, Polygon } from '@shared/geo.ts';
import { SIBLING_MODES } from '@shared/schema.ts';
import type { BrowserRow } from '../../lib/appwrite/db.ts';
import { FunctionError } from '../../lib/appwrite/functions.ts';
import { formatDate, formatDateTime } from '../../lib/format.ts';
import { householdApi } from '../family/household-api.ts';
import { phaseOf, tierLabelsOf } from '../programs/program-view.ts';
import { useApplicationContext, type ApplicationContext } from './useApplicationContext.ts';

const ZoneMap = lazy(() => import('../../components/ZoneMap.tsx').then((m) => ({ default: m.ZoneMap })));

type SiblingMode = (typeof SIBLING_MODES)[number];
interface ChildChoice {
  selected: boolean;
  /** Chosen weeks, in ranked order (index 0 = favourite). */
  weeks: string[];
  requested: number;
}

const STEPS = ['Program and home', 'Children', 'Weeks', 'Rank weeks', 'Siblings', 'Review'] as const;

function idempotencyKeyFor(programId: string): string {
  const storageKey = `even-odds:submit-key:${programId}`;
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const fresh = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
    sessionStorage.setItem(storageKey, fresh);
    return fresh;
  } catch {
    return `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
  }
}

function Wizard({ ctx, reload }: { ctx: ApplicationContext & { household: NonNullable<ApplicationContext['household']> }; reload: () => void }) {
  const { appwrite } = useAppwriteContext();
  const navigate = useNavigate();
  const { program, sessions, children, application, preferences } = ctx;
  const labels = tierLabelsOf(program);
  const eligibility = useMemo(() => new Map(children.map((c) => [c.$id, weeksForChild(c.birthdate, sessions)])), [children, sessions]);
  const weekInfo = useMemo(() => new Map([...eligibility.values()].flat().map((w) => [w.week, w])), [eligibility]);

  const [step, setStep] = useState(0);
  const [choices, setChoices] = useState<Record<string, ChildChoice>>(() =>
    Object.fromEntries(
      children.map((c) => {
        const pref = preferences.find((p) => p.child_id === c.$id);
        return [c.$id, { selected: Boolean(pref), weeks: pref?.ranked_weeks ?? [], requested: pref?.requested_weeks ?? 1 }];
      }),
    ),
  );
  const [mode, setMode] = useState<SiblingMode>(application?.sibling_mode ?? 'together_preferred');
  const [home, setHome] = useState<LngLat | null>(ctx.home ? (ctx.home.home) : null);
  const [homeTier, setHomeTier] = useState<{ tier: number; tierLabel: string; nearBoundary: boolean } | null>(null);
  const [homeBusy, setHomeBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [announce, setAnnounce] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const selected = children.filter((c) => choices[c.$id]?.selected);

  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  if (!appwrite) return null;
  const api = householdApi(appwrite);

  const update = (childId: string, patch: Partial<ChildChoice>) => {
    setChoices((all) => ({ ...all, [childId]: { ...(all[childId] ?? { selected: false, weeks: [], requested: 1 }), ...patch } }));
  };

  const saveHome = async (p: LngLat) => {
    setHome(p);
    setHomeBusy(true);
    setError(null);
    try {
      await api.setHome(p);
      setHomeTier(await api.classifyMyHome(program.$id));
    } catch (err) {
      setError((err as ServiceError).message);
    } finally {
      setHomeBusy(false);
    }
  };

  const validateStep = (): string | null => {
    if (step === 1 && selected.length === 0) return 'Choose at least one child.';
    if (step === 2) {
      const missing = selected.find((c) => (choices[c.$id]?.weeks.length ?? 0) === 0);
      if (missing) return `Choose at least one week for ${missing.first_name}.`;
    }
    if (step === 4 && mode === 'together_only' && selected.length > 1) {
      const common = selected.map((c) => new Set(choices[c.$id]?.weeks ?? [])).reduce((a, b) => new Set([...a].filter((w) => b.has(w))));
      if (common.size === 0) return '"Together only" needs at least one week that every child has chosen. Go back to Weeks, or choose another option.';
    }
    return null;
  };

  const next = () => {
    const problem = validateStep();
    setStepError(problem);
    if (!problem) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const back = () => {
    setStepError(null);
    setStep((s) => Math.max(0, s - 1));
  };

  const move = (child: BrowserRow<'children'>, index: number, delta: -1 | 1) => {
    const weeks = [...(choices[child.$id]?.weeks ?? [])];
    const target = index + delta;
    if (target < 0 || target >= weeks.length) return;
    [weeks[index], weeks[target]] = [weeks[target] ?? '', weeks[index] ?? ''];
    update(child.$id, { weeks });
    const name = weekInfo.get(weeks[target] ?? '')?.label ?? weeks[target];
    setAnnounce(`${name} moved to position ${String(target + 1)} for ${child.first_name}.`);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.submitApplication({
        programId: program.$id,
        siblingMode: selected.length > 1 ? mode : 'independent',
        children: selected.map((c) => {
          const ch = choices[c.$id] ?? { selected: true, weeks: [], requested: 1 };
          return { childId: c.$id, rankedWeeks: ch.weeks, requestedWeeks: Math.min(ch.requested, ch.weeks.length) };
        }),
        idempotencyKey: idempotencyKeyFor(program.$id),
      });
      try {
        sessionStorage.removeItem(`even-odds:submit-key:${program.$id}`);
      } catch {
        /* ignore */
      }
      void navigate(`/applications/${result.applicationId}`, { state: { justSubmitted: result.status } });
    } catch (err) {
      const message = (err as ServiceError).message;
      // The server refuses a key reused for a changed request: the next attempt gets a fresh key.
      if (err instanceof FunctionError && err.code === 'conflict') {
        try {
          sessionStorage.removeItem(`even-odds:submit-key:${program.$id}`);
        } catch {
          /* ignore */
        }
      }
      setError(err instanceof FunctionError && err.code === 'validation' ? `Please fix: ${message}` : message);
      reload();
    } finally {
      setSubmitting(false);
    }
  };

  const weekName = (w: WeekEligibility | undefined, code: string) => (w?.label ?? code) + (w ? ` (from ${formatDate(w.weekStart)})` : '');

  return (
    <div className="stack">
      <ol className="stepper" aria-label="Application steps">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined} className={i < step ? 'done' : undefined}>
            {s}
            {i < step ? <span className="visually-hidden"> (done)</span> : null}
          </li>
        ))}
      </ol>
      <div aria-live="polite" className="visually-hidden">
        {announce}
      </div>
      {error ? <Banner tone="error" title="Your application was not saved">{error}</Banner> : null}

      <Card>
        <h2 ref={headingRef} tabIndex={-1} style={{ outline: 'none' }}>
          Step {step + 1} of {STEPS.length}: {STEPS[step]}
        </h2>
        <div className="stack" style={{ marginTop: 'var(--space-4)' }}>
          {step === 0 ? (
            <>
              <p>
                You are applying to <strong>{program.name}</strong>. Applications close {formatDateTime(program.window_close, program.timezone)}. Applying now or on the last day gives the same chance.
              </p>
              <h3>Where do you live? (optional)</h3>
              <p className="muted">
                Click your home on the map, or enter its coordinates below the map. It sets your priority tier and is visible only to your household; organisers see the tier, never the location. Without a location you are in the &ldquo;{labels[String(program.default_tier ?? '')] ?? 'default'}&rdquo; tier.
              </p>
              <Suspense fallback={<LoadingState label="Loading map…" />}>
                <ZoneMap
                  label="Map for choosing your home location, showing the priority zones"
                  tierLabels={labels}
                  zones={ctx.zones.map((z) => ({ id: z.$id, name: z.name, tier: z.tier, area: z.area as unknown as Polygon }))}
                  marker={home}
                  onMapClick={(p) => void saveHome(p)}
                  height={320}
                />
              </Suspense>
              <HomeLocationFields busy={homeBusy} onSave={(p) => void saveHome(p)} />
              <p aria-live="polite">
                {homeBusy ? (
                  'Saving your location…'
                ) : homeTier ? (
                  <>
                    <MapPin size={16} aria-hidden="true" /> Saved. Your tier: <strong>{homeTier.tierLabel}</strong>
                    {homeTier.nearBoundary ? '. Your home is close to a zone boundary, so staff will check your address before any offer that depends on it.' : '.'}
                  </>
                ) : home ? (
                  'A home location is saved. Click the map to change it.'
                ) : null}
              </p>
            </>
          ) : null}

          {step === 1 ? (
            children.length === 0 ? (
              <EmptyState title="No children in your household" actions={<ButtonLink to="/family/children">Add children</ButtonLink>}>
                Add your children first, then come back to apply.
              </EmptyState>
            ) : (
              <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="visually-hidden">Children to include</legend>
                {children.map((c) => {
                  const eligibleWeeks = (eligibility.get(c.$id) ?? []).filter((w) => w.ageGroup);
                  return (
                    <label key={c.$id} className="choice">
                      <input type="checkbox" checked={choices[c.$id]?.selected ?? false} disabled={eligibleWeeks.length === 0} onChange={(e) => { update(c.$id, { selected: e.target.checked }); }} />
                      <strong>
                        {c.first_name} {c.last_name}
                      </strong>
                      <span className="choice__detail">{eligibleWeeks.length === 0 ? 'Not old enough or too old for any week of this program.' : `Eligible for ${String(eligibleWeeks.length)} of ${String(eligibility.get(c.$id)?.length ?? 0)} weeks.`}</span>
                    </label>
                  );
                })}
                <p className="muted small">
                  Missing someone? <Link to="/family/children">Add a child</Link>.
                </p>
              </fieldset>
            )
          ) : null}

          {step === 2
            ? selected.map((c) => (
                <fieldset key={c.$id} className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
                  <legend className="field__label">Weeks {c.first_name} can attend</legend>
                  {(eligibility.get(c.$id) ?? []).map((w) => {
                    const chosen = choices[c.$id]?.weeks.includes(w.week) ?? false;
                    return (
                      <label key={w.week} className="choice">
                        <input
                          type="checkbox"
                          checked={chosen}
                          disabled={!w.ageGroup}
                          onChange={(e) => {
                            const weeks = choices[c.$id]?.weeks ?? [];
                            update(c.$id, { weeks: e.target.checked ? [...weeks, w.week] : weeks.filter((x) => x !== w.week) });
                          }}
                        />
                        <span>{weekName(w, w.week)}</span>
                        <span className="choice__detail">{w.ageGroup ? `Age ${String(w.age)}: ${w.ageGroup} group` : w.reason}</span>
                      </label>
                    );
                  })}
                </fieldset>
              ))
            : null}

          {step === 3 ? (
            <>
              <Banner tone="info" title="Rank honestly">{HONESTY_NOTE}</Banner>
              {selected.map((c) => {
                const ch = choices[c.$id] ?? { selected: true, weeks: [], requested: 1 };
                const cap = Math.min(program.max_weeks, ch.weeks.length);
                return (
                  <section key={c.$id} className="stack-sm" aria-labelledby={`rank-${c.$id}`}>
                    <h3 id={`rank-${c.$id}`}>{c.first_name}: favourite first</h3>
                    <ol className="rank-list">
                      {ch.weeks.map((code, i) => (
                        <li key={code}>
                          <span className="rank-list__label">{weekName(weekInfo.get(code), code)}</span>
                          <Button size="sm" variant="ghost" icon={<ArrowUp size={16} aria-hidden="true" />} disabled={i === 0} onClick={() => { move(c, i, -1); }}>
                            <span className="visually-hidden">Move {weekInfo.get(code)?.label ?? code} up</span>
                          </Button>
                          <Button size="sm" variant="ghost" icon={<ArrowDown size={16} aria-hidden="true" />} disabled={i === ch.weeks.length - 1} onClick={() => { move(c, i, 1); }}>
                            <span className="visually-hidden">Move {weekInfo.get(code)?.label ?? code} down</span>
                          </Button>
                        </li>
                      ))}
                    </ol>
                    <SelectField label={`How many weeks would you like for ${c.first_name}?`} hint={`Up to ${String(program.max_weeks)} per child. Everyone gets a chance at one week before anyone gets a second.`} value={String(Math.min(ch.requested, cap))} onChange={(e) => { update(c.$id, { requested: Number(e.target.value) }); }}>
                      {Array.from({ length: cap }, (_, n) => n + 1).map((n) => (
                        <option key={n} value={n}>
                          {n} week{n === 1 ? '' : 's'}
                        </option>
                      ))}
                    </SelectField>
                  </section>
                );
              })}
            </>
          ) : null}

          {step === 4 ? (
            selected.length > 1 ? (
              <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="visually-hidden">How should we place your children?</legend>
                {SIBLING_MODES.map((m) => (
                  <label key={m} className="choice">
                    <input type="radio" name="sibling-mode" value={m} checked={mode === m} onChange={() => { setMode(m); }} />
                    <strong>{SIBLING_MODE_TEXT[m].title}</strong>
                    <span className="choice__detail">{SIBLING_MODE_TEXT[m].body}</span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <p>You are applying for one child, so sibling options do not apply. {selected[0]?.first_name} will be placed on their own.</p>
            )
          ) : null}

          {step === 5 ? (
            <>
              <dl className="kv">
                <dt>Program</dt>
                <dd>{program.name}</dd>
                <dt>Siblings</dt>
                <dd>{selected.length > 1 ? SIBLING_MODE_TEXT[mode].title : 'Not applicable (one child)'}</dd>
                <dt>Home</dt>
                <dd>{home ? (homeTier ? homeTier.tierLabel : 'Location saved') : `Not given (${labels[String(program.default_tier ?? '')] ?? 'default tier'})`}</dd>
              </dl>
              {selected.map((c) => {
                const ch = choices[c.$id] ?? { selected: true, weeks: [], requested: 1 };
                return (
                  <section key={c.$id} className="stack-sm">
                    <h3>
                      {c.first_name}: {Math.min(ch.requested, ch.weeks.length)} week{Math.min(ch.requested, ch.weeks.length) === 1 ? '' : 's'} requested
                    </h3>
                    <ol>
                      {ch.weeks.map((code) => (
                        <li key={code}>{weekName(weekInfo.get(code), code)}</li>
                      ))}
                    </ol>
                  </section>
                );
              })}
              <Banner tone="info" title="Before you submit">
                <p>{HONESTY_NOTE}</p>
                <p>{ODDS_CAVEAT}</p>
                <p>You can change or withdraw your application until applications close. Your tier is worked out by the server from your home location; organisers verify it before offers.</p>
              </Banner>
            </>
          ) : null}

          {stepError ? <Banner tone="error">{stepError}</Banner> : null}
        </div>
        <div className="wizard-nav">
          <Button variant="ghost" onClick={back} disabled={step === 0} icon={<ArrowLeft size={18} aria-hidden="true" />}>
            Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button onClick={next} disabled={step === 1 && children.length === 0}>
              Next <ArrowRight size={18} aria-hidden="true" />
            </Button>
          ) : (
            <Button onClick={() => void submit()} loading={submitting} loadingLabel="Submitting…" icon={<Send size={18} aria-hidden="true" />}>
              {application ? 'Update application' : 'Submit application'}
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}

export function NewApplicationPage() {
  const { programId = '' } = useParams();
  const { appwrite } = useAppwriteContext();
  const state = useApplicationContext(programId);

  if (!appwrite) {
    return (
      <div className="stack">
        <PageHeader eyebrow="New application" title="Apply to a program" />
        <NotConfiguredBanner what="Applications" />
      </div>
    );
  }

  return (
    <div className="stack">
      <AsyncView state={state} loadingLabel="Loading application…" notFound={<><PageHeader title="Apply to a program" /><EmptyState title="Program not found" actions={<ButtonLink to="/programs">Browse programs</ButtonLink>} /></>}>
        {(ctx) => {
          const phase = phaseOf(ctx.program);
          return (
            <>
              <PageHeader eyebrow={ctx.application ? 'Edit application' : 'New application'} title={`Apply: ${ctx.program.name}`} />
              {ctx.program.synthetic ? <p><SyntheticBadge /></p> : null}
              {ctx.household === null ? (
                <EmptyState title="Set up your household first" actions={<ButtonLink to="/family">Go to your household</ButtonLink>}>
                  Applications belong to a household so that every guardian sees the same one.
                </EmptyState>
              ) : phase !== 'accepting' && !(ctx.program.late_policy === 'accept_late' && ctx.program.status === 'open') ? (
                <Banner tone="warning" title="Not accepting applications">
                  {phase === 'upcoming' ? `Applications open ${formatDateTime(ctx.program.window_open, ctx.program.timezone)}.` : 'Applications for this program are closed.'}
                </Banner>
              ) : (
                <>
                  {ctx.application ? (
                    <Banner tone="info">
                      You already applied ({<StatusBadge tone={ctx.application.status === 'submitted' ? 'success' : 'neutral'}>{ctx.application.status}</StatusBadge>}). Submitting again replaces your choices; your receipt and place in the lottery stay the same.
                    </Banner>
                  ) : null}
                  <Wizard ctx={{ ...ctx, household: ctx.household }} reload={state.reload} />
                </>
              )}
            </>
          );
        }}
      </AsyncView>
    </div>
  );
}
