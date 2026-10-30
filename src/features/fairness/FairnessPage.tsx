import { Query } from 'appwrite';
import { CircleCheck, CircleX, Clock, Download, PlayCircle, Scale } from 'lucide-react';
import { useCallback } from 'react';
import { useParams } from 'react-router';
import { useBrowserDb } from '../../app/AppwriteContext.ts';
import { AsyncView, NotConfiguredBanner } from '../../components/AsyncView.tsx';
import { Banner, Button, ButtonLink, Card, DataTable, EmptyState, PageHeader, StatusBadge, type Tone } from '../../components/ui/index.ts';
import type { BiasTest, FairnessReport, OfferStatus, RateRow, WaitlistStatus } from '@shared/fairness.ts';
import type { ReplayStep } from '@shared/replay/replay.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { verifyProgram } from '../audit/verify.ts';
import { buildFairness, type FairnessData, type OfferStatsRow } from './fairness-data.ts';
import './fairness.css';

/** Groups this small are flagged: a rate over a handful of families says very little. */
const SMALL_SAMPLE = 10;
const pct = (r: number) => `${(r * 100).toFixed(0)}%`;
const interval = (r: RateRow) => `${pct(r.low)}–${pct(r.high)}`;

const STEP_BADGE: Record<ReplayStep['status'], { tone: Tone; icon: typeof CircleCheck; text: string }> = {
  pass: { tone: 'success', icon: CircleCheck, text: 'Verified' },
  fail: { tone: 'danger', icon: CircleX, text: 'FAILED' },
  pending: { tone: 'pending', icon: Clock, text: 'Not yet' },
  skipped: { tone: 'neutral', icon: Clock, text: 'Skipped' },
};

function Steps({ steps }: { steps: ReplayStep[] }) {
  return (
    <ul className="check-list">
      {steps.map((s) => {
        const b = STEP_BADGE[s.status];
        const Icon = b.icon;
        return (
          <li key={s.key} className="check">
            <StatusBadge tone={b.tone}><Icon size={12} aria-hidden="true" /> {b.text}</StatusBadge>
            <strong>{s.title}</strong>
            <div className="check__detail small">{s.summary}</div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Placement rate with its 95% interval on a 0–100% scale: filled circle =
 * lottery, hollow diamond = first come. Shape, not only colour, tells them
 * apart; the same numbers are in the table cells beside it.
 */
function RatePlot({ lottery, firstCome }: { lottery: RateRow; firstCome?: RateRow | undefined }) {
  const x = (r: number) => 4 + r * 152;
  const label = `Lottery ${pct(lottery.rate)} (95% interval ${interval(lottery)})${firstCome ? `; first come ${pct(firstCome.rate)} (${interval(firstCome)})` : ''}`;
  return (
    <svg className="rate-plot" viewBox="0 0 160 30" role="img" aria-label={label}>
      <title>{label}</title>
      <line className="rate-plot__axis" x1={4} x2={156} y1={29} y2={29} />
      {[0, 0.5, 1].map((t) => <line key={t} className="rate-plot__tick" x1={x(t)} x2={x(t)} y1={2} y2={29} />)}
      <line className="rate-plot__ci rate-plot__ci--lottery" x1={x(lottery.low)} x2={x(lottery.high)} y1={9} y2={9} />
      <circle className="rate-plot__lottery" cx={x(lottery.rate)} cy={9} r={4} />
      {firstCome ? (
        <>
          <line className="rate-plot__ci rate-plot__ci--fc" x1={x(firstCome.low)} x2={x(firstCome.high)} y1={21} y2={21} />
          <rect className="rate-plot__fc" x={x(firstCome.rate) - 3.5} y={17.5} width={7} height={7} transform={`rotate(45 ${String(x(firstCome.rate))} 21)`} />
        </>
      ) : null}
    </svg>
  );
}

function Legend({ firstCome }: { firstCome: boolean }) {
  return (
    <p className="rate-legend small" aria-hidden="true">
      <span><svg width="12" height="12" viewBox="0 0 12 12"><circle className="rate-plot__lottery" cx="6" cy="6" r="4" /></svg> Lottery (this draw)</span>
      {firstCome ? <span><svg width="12" height="12" viewBox="0 0 12 12"><rect className="rate-plot__fc" x="2.5" y="2.5" width="7" height="7" transform="rotate(45 6 6)" /></svg> First come (counterfactual)</span> : null}
      <span className="muted">Lines: 95% interval. Scale 0–100%.</span>
    </p>
  );
}

function RateTable({ caption, rows, compare, measure = 'Got a week: lottery', childMeasure = 'Children with a week' }: { caption: string; rows: RateRow[]; compare?: RateRow[] | undefined; measure?: string; childMeasure?: string }) {
  const fc = (r: RateRow) => compare?.find((x) => x.group === r.group);
  return (
    <DataTable<RateRow>
      caption={caption}
      rows={rows}
      rowKey={(r) => r.group}
      columns={[
        { key: 'g', header: 'Group', render: (r) => <>{r.group}{r.families < SMALL_SAMPLE ? <> <StatusBadge tone="pending">small sample</StatusBadge></> : null}</> },
        { key: 'n', header: 'Families (children)', numeric: true, render: (r) => `${String(r.families)} (${String(r.children)})` },
        { key: 'p', header: measure, numeric: true, render: (r) => <>{r.placed} ({pct(r.rate)})<div className="muted small">95%: {interval(r)}</div></> },
        ...(compare
          ? [{ key: 'fc', header: 'Would get a week: first come', numeric: true, render: (r: RateRow) => { const c = fc(r); return c ? <>{c.placed} ({pct(c.rate)})<div className="muted small">95%: {interval(c)}</div></> : '—'; } }]
          : []),
        { key: 'c', header: childMeasure, numeric: true, render: (r) => `${String(r.childrenPlaced)} of ${String(r.children)}` },
        { key: 'plot', header: 'Rate (0–100%)', render: (r) => <RatePlot lottery={r} firstCome={fc(r)} /> },
      ]}
    />
  );
}

function Invariants({ r }: { r: FairnessReport }) {
  const i = r.invariants;
  const item = (n: number, label: string, detail: string) => (
    <li>
      <StatusBadge tone={n === 0 ? 'success' : 'danger'}>{n === 0 ? <CircleCheck size={12} aria-hidden="true" /> : <CircleX size={12} aria-hidden="true" />} {n}</StatusBadge> <strong>{label}</strong>
      <div className="muted small">{detail}</div>
    </li>
  );
  return (
    <ul className="stack-sm fairness-steps">
      {item(i.oversoldSeats, 'oversold seats', i.oversoldSessions.length ? `Over capacity: ${i.oversoldSessions.map((s) => `${s.week}/${s.ageGroup} ${String(s.taken)} of ${String(s.capacity)}`).join(', ')}.` : 'No session holds more children than its capacity, by the draw or by the seats held now.')}
      {item(i.siblingSplits, `"together only" families split (of ${String(i.togetherOnlyFamilies)})`, 'A week where one sibling was placed while a sibling who still wanted weeks was left out.')}
      {item(i.duplicatePlacements, 'duplicate placements', 'The same child placed twice in one week.')}
      {item(i.overRequested, 'children over their request', 'Children given more weeks than they asked for.')}
      {item(i.unexplainedPlacements, 'placements the inputs cannot explain', 'A placement for an unknown child, a week the child did not rank, the wrong age group or a session that does not exist.')}
    </ul>
  );
}

function TestResult({ t }: { t: BiasTest }) {
  const tone: Tone = t.status === 'not_meaningful' ? 'neutral' : (t.pValue ?? 1) < 0.05 ? 'pending' : 'success';
  const text = t.status === 'not_meaningful' ? 'Not meaningful here' : (t.pValue ?? 1) < 0.05 ? 'Association found' : 'No evidence of association';
  return (
    <li>
      <StatusBadge tone={tone}>{text}</StatusBadge> <strong>{t.question}</strong>
      <div className="small">{t.conclusion}</div>
      {t.status === 'tested' ? (
        <div className="muted small">
          χ² = {t.statistic.toFixed(2)} across {t.groups} groups; {t.permutations.toLocaleString('en')} within-group shuffles; {t.informativeFamilies} of {t.families} families compared ({t.informativeStrata} of {t.strata} priority groups had both outcomes).
        </div>
      ) : null}
    </li>
  );
}

const OFFER_LABEL: Record<OfferStatus, string> = { offered: 'Awaiting reply', accepted: 'Accepted', declined: 'Declined', expired: 'Expired (no reply in 48 h)', released: 'Given back', cancelled: 'Cancelled by organiser' };
const WAIT_LABEL: Record<WaitlistStatus, string> = { waiting: 'Still waiting', promoted: 'Received an offer', removed: 'Removed' };

function Outcomes({ r, at }: { r: FairnessReport; at: string | null }) {
  const o = r.outcomes;
  if (!o) return <p className="muted">No offer outcomes have been published yet.</p>;
  const statuses = Object.keys(OFFER_LABEL) as OfferStatus[];
  return (
    <div className="stack">
      <p className="muted small">Live counts from the offers job{at ? `, recounted ${formatDateTime(at)}` : ''}. These change as families reply, are not hashed, and are the server's word about events after the draw.</p>
      <div className="stat-row">
        <div className="stat" data-tone="green"><span className="stat__value">{o.seatsHeld}</span><span className="stat__label">seats held now (pending or accepted)</span></div>
        <div className="stat" data-tone="green"><span className="stat__value">{o.accepted}</span><span className="stat__label">offers accepted</span></div>
        <div className="stat" data-tone="yellow"><span className="stat__value">{o.waitlist.children}</span><span className="stat__label">children on a waitlist</span></div>
      </div>
      <DataTable
        caption="Offers by status"
        rows={statuses}
        rowKey={(s) => s}
        columns={[
          { key: 's', header: 'Status', render: (s) => OFFER_LABEL[s] },
          ...o.offers.map((g) => ({ key: g.source, header: g.source === 'draw' ? `From the draw (${String(g.total)})` : `From the waitlist (${String(g.total)})`, numeric: true, render: (s: OfferStatus) => g.byStatus[s] })),
        ]}
      />
      <DataTable
        caption={`Waitlist entries (${String(o.waitlist.total)})`}
        rows={Object.keys(WAIT_LABEL) as WaitlistStatus[]}
        rowKey={(s) => s}
        columns={[
          { key: 's', header: 'Status', render: (s) => WAIT_LABEL[s] },
          { key: 'n', header: 'Entries', numeric: true, render: (s) => o.waitlist.byStatus[s] },
        ]}
      />
      {r.applicationOrder.source !== 'none' ? <RateTable caption="Families holding an accepted offer now, by application time" rows={o.acceptedByApplicationTime} measure="Holding an accepted offer" childMeasure="Children with an accepted offer" /> : null}
    </div>
  );
}

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** The report sections, shared by the public page and the organiser console. */
export function FairnessReportView({ report: r, programId, replayMatches = null, outcomesAt = null, onDownload }: { report: FairnessReport; programId: string; replayMatches?: boolean | null; outcomesAt?: string | null; onDownload?: () => void }) {
  const fc = r.firstCome;
  const timed = r.applicationOrder.source !== 'none';
  return (
    <div className="stack">
      {replayMatches === false ? (
        <Banner tone="error" title="The published result does not match the replay">
          The numbers below describe what the database committed, which is not what the lottery gives for these inputs and this seed. See the <a href={`/replay/${programId}`}>replay</a> for each difference.
        </Banner>
      ) : null}

      <Card title="Seats and placements" description="From the published result: the placements the database committed when the draw ran.">
        <div className="stack">
          <div className="stat-row">
            <div className="stat" data-tone="purple"><span className="stat__value">{r.drawPlacements} / {r.seats}</span><span className="stat__label">seats allocated by the draw</span></div>
            <div className="stat" data-tone={r.invariants.oversoldSeats === 0 ? 'green' : 'red'}><span className="stat__value">{r.invariants.oversoldSeats}</span><span className="stat__label">oversold seats</span></div>
            <div className="stat" data-tone="cyan"><span className="stat__value">{r.familiesWithAWeek} / {r.families}</span><span className="stat__label">families with a week</span></div>
            <div className="stat" data-tone="cyan"><span className="stat__value">{r.childrenWithAWeek} / {r.children}</span><span className="stat__label">children with a week ({r.childrenFullyServed} got every week asked for)</span></div>
          </div>
          {r.unusedSeats > 0 ? <p className="muted small">{r.unusedSeats} seats were left after the draw: nobody who could take them (right week, right age group, still wanting a week) was left.</p> : null}
          <Invariants r={r} />
        </div>
      </Card>

      <Card title="Who got a week" description="Share of families who got at least one week, by group. Every group shows its size; groups under 10 families are flagged, because a rate over a handful of families says very little.">
        <div className="stack">
          <Legend firstCome={!!fc} />
          {timed ? (
            <RateTable caption="By application time (quarters of the submission order)" rows={r.byApplicationTime} compare={fc?.byApplicationTime} />
          ) : (
            <Banner tone="info" title="No application order was committed for this program">
              It was frozen before application order was recorded, so time groups and the first-come comparison cannot be computed from verified data. Nothing is estimated in its place.
            </Banner>
          )}
          <RateTable caption="By family size" rows={r.bySize} compare={fc?.bySize} />
          <RateTable caption="By priority tier (lower tiers draw first, by the program's policy)" rows={r.byTier} compare={fc?.byTier} />
          {r.applicationOrder.missing > 0 || r.applicationOrder.extra > 0 ? (
            <Banner tone="warning" title="Application order and inputs differ">
              {r.applicationOrder.missing} families in the draw have no place in the committed order (shown as "Unknown"); {r.applicationOrder.extra} entries in the order are not in the draw.
            </Banner>
          ) : null}
        </div>
      </Card>

      {fc ? (
        <Card title="Comparison: first come, first served" description="A counterfactual, computed in this browser on the same frozen applications and the same seats. It did not happen.">
          <div className="stack">
            <p className="small">
              Same rules as the draw (priority class, tier, on-time before late, sibling modes, ranked weeks, requested weeks), with two changes: within each priority group families are served in <strong>submission order</strong> instead of lottery order, and each family books all its weeks before the next one starts, as on a first-come booking site.
            </p>
            <DataTable
              caption="Totals"
              rows={[
                { k: 'Families with a week', l: r.familiesWithAWeek, f: fc.familiesWithAWeek },
                { k: 'Children with a week', l: r.childrenWithAWeek, f: fc.childrenWithAWeek },
                { k: 'Week placements', l: r.drawPlacements, f: fc.placements },
                { k: '"Together only" families split', l: r.invariants.siblingSplits, f: fc.siblingSplits },
              ]}
              rowKey={(x) => x.k}
              columns={[
                { key: 'k', header: 'Measure', render: (x) => x.k },
                { key: 'l', header: 'Lottery (this draw)', numeric: true, render: (x) => x.l },
                { key: 'f', header: 'First come (counterfactual)', numeric: true, render: (x) => x.f },
              ]}
            />
            <p className="muted small">The application-time table above shows the difference that matters: under first come, earlier applicants are served first by construction.</p>
          </div>
        </Card>
      ) : null}

      <Card title="Statistical tests" description="Stratified permutation tests: families are only compared with families of the same priority group (override, tier, on time or late), so a policy difference between tiers can never look like bias. Seeded with the inputs hash, so anyone recomputes the same p-values.">
        <ul className="stack-sm fairness-steps">
          {r.tests.map((t) => <TestResult key={t.key} t={t} />)}
        </ul>
      </Card>

      <Card title="Offers and waitlist" description="What happened after the draw.">
        <Outcomes r={r} at={outcomesAt} />
      </Card>

      <Card title="What this report does not show">
        <ul className="small stack-sm">
          <li><strong>Differences between groups do not, on their own, show discrimination, and similar rates do not show fairness.</strong> Groups differ in size, in the weeks they ranked, in how many weeks they asked for and in sibling rules; any of these can move a rate.</li>
          <li>A test with no evidence of association is not proof of no effect: at these sample sizes, small effects go undetected. A test that finds one happens 1 time in 20 by chance alone.</li>
          <li>Tiers and overrides are the program's policy, applied as entered by the organiser. This report checks that the draw applied them; it cannot say whether they were right, or whether residency, ages or override reasons were true.</li>
          <li>Hashes prove the files were not changed after they were committed. They do not prove the organiser entered true data, or that every eligible family was included.</li>
          <li>Families are pseudonymous (receipt codes). No names, birthdates, addresses or guardians are published or used here.</li>
        </ul>
      </Card>

      <div className="row">
        {onDownload ? (
          <Button variant="secondary" size="sm" icon={<Download size={16} aria-hidden="true" />} onClick={onDownload}>
            Download this report (JSON)
          </Button>
        ) : null}
        <ButtonLink to={`/replay/${programId}`} variant="ghost" size="sm" icon={<PlayCircle size={16} aria-hidden="true" />}>Replay the draw</ButtonLink>
      </div>
    </div>
  );
}

/**
 * Public fairness report card (Task 13). Everything is computed in this
 * browser from published artifacts it has just verified (shared/replay):
 * no number is supplied by the server or hard-coded. docs/FAIRNESS.md.
 */
export function FairnessPage() {
  const { programId = '' } = useParams();
  const db = useBrowserDb();
  const load = useCallback(async (): Promise<FairnessData | null> => {
    if (!db) return null;
    const [{ bundle, verification }, stats] = await Promise.all([
      verifyProgram(db, programId),
      db.listRows('offer_stats', [Query.equal('program_id', programId), Query.limit(500)]).catch(() => ({ rows: [] as OfferStatsRow[] })),
    ]);
    return buildFairness(verification, stats.rows, { resultHash: verification.result ? (bundle.result?.resultHash ?? null) : null });
  }, [db, programId]);
  const state = useAsync(load, programId);

  return (
    <div className="stack">
      <PageHeader
        eyebrow="Public verification"
        tone="burgundy"
        title="Fairness report card"
        description="Computed in your browser from the frozen inputs, the committed application order and the published result, each re-hashed here first. Families are counted, never named."
      />
      {!db ? <NotConfiguredBanner what="The fairness report" /> : null}
      {db ? (
        <AsyncView state={state} loadingLabel="Verifying the published artifacts and computing the report…" notFound={<EmptyState icon={Scale} title="Program not found">There is no public program with this ID.</EmptyState>}>
          {(d) =>
            !d ? null : (
              <div className="stack">
                <Card title="Where these numbers come from" description={d.ready ? `Report computed in ${String(d.ms)} ms in this browser.` : undefined}>
                  <Steps steps={d.steps} />
                </Card>
                {d.ready ? (
                  <FairnessReportView
                    report={d.report}
                    programId={programId}
                    replayMatches={d.replayMatches}
                    outcomesAt={d.outcomesAt}
                    onDownload={() => { download(`fairness-${programId}.json`, { program: programId, inputsHash: d.inputsHash, resultHash: d.resultHash, applicationOrderCommittedAtFreeze: d.orderCommittedAtFreeze, outcomesAt: d.outcomesAt, offerStatsAt: d.offerStatsAt, report: d.report }); }}
                  />
                ) : (
                  <Banner tone="info" title="No report yet">{d.reason}</Banner>
                )}
              </div>
            )
          }
        </AsyncView>
      ) : null}
    </div>
  );
}
