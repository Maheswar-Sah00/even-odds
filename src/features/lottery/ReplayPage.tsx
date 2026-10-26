import { BarChart3, CircleCheck, CircleMinus, CircleX, Clock, Download, FlaskConical, Hammer, Play, RotateCcw, ScrollText, ShieldCheck, Upload } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useBrowserDb } from '../../app/AppwriteContext.ts';
import { NotConfiguredBanner } from '../../components/AsyncView.tsx';
import { Banner, Button, Card, DataTable, PageHeader, StatusBadge, TextAreaField, TextField, type Tone } from '../../components/ui/index.ts';
import { computePlan, inputsHash, planHash, type DrawApplication, type DrawInputs, type DrawPlan, type OrderEntry, type PlanStep, type WaitlistEntry } from '@shared/draw/index.ts';
import { SAMPLE_INPUTS, SAMPLE_SEED } from '@shared/draw/sample.ts';
import { canTamper, parseBundle, replayBundle, serializeBundle, tamper, TAMPERS, type Discrepancy, type ReplayBundle, type ReplayStep, type StepStatus, type TamperKey, type Verification } from '@shared/replay/index.ts';
import { verifyProgram } from '../audit/verify.ts';

const STEP_BADGE: Record<StepStatus, { tone: Tone; icon: typeof CircleCheck; text: string }> = {
  pass: { tone: 'success', icon: CircleCheck, text: 'Verified' },
  fail: { tone: 'danger', icon: CircleX, text: 'FAILED' },
  pending: { tone: 'pending', icon: Clock, text: 'Not yet' },
  skipped: { tone: 'neutral', icon: CircleMinus, text: 'Not checked' },
};

function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** The verification steps, as a list (each badge also says its status in words). */
function StepList({ steps }: { steps: ReplayStep[] }) {
  return (
    <ol className="check-list" aria-label="Verification steps">
      {steps.map((s) => {
        const b = STEP_BADGE[s.status];
        const Icon = b.icon;
        return (
          <li key={s.key} className="check" data-step={s.key} data-status={s.status}>
            <span>
              <StatusBadge tone={b.tone}>
                <Icon size={12} aria-hidden="true" /> {b.text}
              </StatusBadge>
            </span>
            <strong>{s.title}</strong>
            <div className="check__detail small">
              <p style={{ margin: 0 }}>{s.summary}</p>
              {s.details.length > 0 ? (
                <ul style={{ margin: 'var(--space-1) 0 0', paddingLeft: '1.2rem' }}>
                  {s.details.map((d, i) => (
                    <li key={`${s.key}-${String(i)}`}>{d}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Verdict({ v }: { v: Verification }) {
  const failed = v.steps.filter((s) => s.status === 'fail');
  if (failed.length > 0) {
    return (
      <Banner tone="error" title={`Verification failed at ${String(failed.length)} step(s)`}>
        {failed.map((s) => s.title).join(', ')}. The published artifacts do not reproduce the published outcome; see the steps below.
      </Banner>
    );
  }
  if (v.replayMatches) {
    return (
      <Banner tone="success" title="Reproduced independently">
        Every step was recomputed in this browser. The committed placements are exactly the ones the lottery gives for the frozen inputs and the drand beacon.
      </Banner>
    );
  }
  return <Banner tone="info" title="Nothing failed so far">Some steps cannot run yet because the protocol has not reached them.</Banner>;
}

/** Inspect the frozen public inputs: every field that exists, nothing else. */
function InputsView({ v, programId }: { v: Verification; programId: string }) {
  const inputs = v.inputs;
  if (!inputs || !v.canonical) return null;
  const canonical = v.canonical;
  return (
    <Card
      title="Frozen public inputs"
      description="Exactly what the lottery read. Families appear only as random receipt codes and children as ticket references; the file format has no field for names, birthdates, addresses, guardians or child keys."
      actions={
        <Button size="sm" variant="secondary" icon={<Download size={16} aria-hidden="true" />} onClick={() => { download(`${programId}-frozen-inputs.json`, canonical); }}>
          Canonical file
        </Button>
      }
    >
      <div className="stack">
        <p className="small muted">
          SHA-256 of this file, recomputed here: <code>{v.inputsHash}</code>. You can check it yourself: <code>sha256sum {programId}-frozen-inputs.json</code>.
        </p>
        <DataTable
          caption="Sessions (capacity snapshot)"
          rows={inputs.sessions}
          rowKey={(s) => `${s.week}/${s.ageGroup}`}
          columns={[
            { key: 'w', header: 'Week', render: (s) => s.week },
            { key: 'g', header: 'Age group', render: (s) => s.ageGroup },
            { key: 'c', header: 'Seats', numeric: true, render: (s) => s.capacity },
          ]}
        />
        <DataTable<DrawApplication>
          caption={`Applications (${String(inputs.applications.length)})`}
          rows={inputs.applications}
          rowKey={(a) => a.publicId}
          columns={[
            { key: 'id', header: 'Receipt code', render: (a) => <code>{a.publicId}</code> },
            { key: 't', header: 'Tier', numeric: true, render: (a) => a.tier },
            { key: 'l', header: 'Late', render: (a) => (a.late ? 'Yes' : 'No') },
            { key: 's', header: 'Siblings', render: (a) => a.siblingMode.replace('_', ' ') },
            { key: 'o', header: 'Override', render: (a) => { const o = inputs.overrides.find((x) => x.publicId === a.publicId); return o ? (o.reasonCode?.replace('_', ' ') ?? 'Yes') : ''; } },
            {
              key: 'c',
              header: 'Children: ranked weeks (age group), weeks wanted',
              render: (a) =>
                a.children.map((c) => (
                  <div key={c.ref} className="small">
                    <code>{c.ref.slice(0, 10)}…</code> {c.rankedWeeks.map((w, i) => `${w} (${c.ageGroups[i] ?? '?'})`).join(', ')}; wants {c.requested}
                  </div>
                )),
            },
          ]}
        />
      </div>
    </Card>
  );
}

function DiscrepancyTable({ items }: { items: Discrepancy[] }) {
  return (
    <DataTable<Discrepancy & { i: number }>
      caption="Differences between the replay and the published result"
      rows={items.map((d, i) => ({ ...d, i }))}
      rowKey={(d) => String(d.i)}
      columns={[
        { key: 'what', header: 'What differs', render: (d) => d.message },
        { key: 'r', header: 'Replay says', render: (d) => d.replayed ?? '(nothing)' },
        { key: 'p', header: 'Published result says', render: (d) => d.published ?? '(nothing)' },
      ]}
    />
  );
}

function PlanView({ plan, v }: { plan: DrawPlan; v: Verification | null }) {
  const order = new Map(plan.order.map((o) => [o.publicId, o.position]));
  const outcomeOf = new Map(v?.outcomes?.entries.map((e) => [`${e.childRef}\u0000${e.week}`, e.status]) ?? []);
  return (
    <div className="stack">
      {plan.warnings.length > 0 ? (
        <Banner tone="warning" title="Input warnings">
          <ul>{plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </Banner>
      ) : null}
      <DataTable<OrderEntry>
        caption="Lottery order"
        rows={plan.order}
        rowKey={(o) => o.publicId}
        columns={[
          { key: 'pos', header: '#', numeric: true, render: (o) => o.position },
          { key: 'id', header: 'Receipt code', render: (o) => <code>{o.publicId}</code> },
          { key: 'class', header: 'Override', render: (o) => (o.priorityClass === 0 ? 'Yes' : '') },
          { key: 'tier', header: 'Tier', numeric: true, render: (o) => o.tier },
          { key: 'late', header: 'Late', render: (o) => (o.late ? 'Yes' : '') },
          { key: 'hash', header: 'Lottery hash', render: (o) => <code title={o.lotteryHash}>{o.lotteryHash.slice(0, 16)}…</code> },
        ]}
      />
      <DataTable<PlanStep>
        caption="Placements, in the order they were made"
        rows={plan.steps}
        rowKey={(s) => String(s.index)}
        columns={[
          { key: 'i', header: 'Step', numeric: true, render: (s) => s.index + 1 },
          { key: 'r', header: 'Round', numeric: true, render: (s) => s.round },
          { key: 'who', header: 'Receipt code (lottery #)', render: (s) => <><code>{s.publicId}</code> (#{order.get(s.publicId) ?? '?'})</> },
          { key: 'what', header: 'Placed', render: (s) => s.placements.map((p) => `${p.childRef.slice(0, 10)}… → ${p.week} (${p.ageGroup})`).join(', ') },
          { key: 'kind', header: 'Type', render: (s) => (s.kind === 'group' ? 'Siblings together' : 'Single child') },
          ...(v?.outcomes ? [{ key: 'now', header: 'Offer now (live)', render: (s: PlanStep) => s.placements.map((p) => outcomeOf.get(`${p.childRef}\u0000${p.week}`) ?? '—').join(', ') }] : []),
        ]}
      />
      <DataTable<WaitlistEntry>
        caption="Waitlist per session (positions in draw order)"
        rows={plan.waitlist}
        rowKey={(w) => `${w.week}/${w.ageGroup}/${String(w.position)}`}
        columns={[
          { key: 's', header: 'Session', render: (w) => `${w.week} (${w.ageGroup})` },
          { key: 'p', header: 'Position', numeric: true, render: (w) => w.position },
          { key: 'id', header: 'Receipt code', render: (w) => <code>{w.publicId}</code> },
          { key: 'c', header: 'Child', render: (w) => <code>{w.childRef.slice(0, 10)}…</code> },
        ]}
      />
      {v?.outcomes ? (
        <p className="small muted">
          "Offer now" is the live offer status the server reported at {v.outcomes.computedAt}. It changes as families reply, so it is not part of any hash: it is the server's word about events after the draw.
        </p>
      ) : null}
    </div>
  );
}

/** The audit report, separating what cryptography proves from what it cannot. */
function AuditView({ v }: { v: Verification }) {
  const a = v.audit;
  return (
    <Card title="Audit log integrity" description="Every record checked in this browser: number sequence, payload hashes, entry hashes and the link to the previous entry.">
      <div className="stack">
        <div className="stat-row">
          <div className="stat"><span className="stat__label">Records</span><span className="stat__value">{a.records}</span></div>
          <div className="stat"><span className="stat__label">Fully verified</span><span className="stat__value">{a.verified}</span></div>
          <div className="stat"><span className="stat__label">Problems</span><span className="stat__value">{a.issues.length}</span></div>
        </div>
        {a.issues.length > 0 ? (
          <DataTable
            caption="Problems found"
            rows={a.issues.map((iss, i) => ({ ...iss, i }))}
            rowKey={(r) => String(r.i)}
            columns={[
              { key: 'seq', header: 'Entry', numeric: true, render: (r) => r.seq ?? '?' },
              { key: 'k', header: 'Kind', render: (r) => r.kind.replace('_', ' ') },
              { key: 'm', header: 'What it means', render: (r) => r.message },
            ]}
          />
        ) : null}
        <p className="small">
          Chain head: <code>{a.head ?? 'none'}</code>. Note it down: if entries were later cut off the end of the log, the head would change.
        </p>
        <div className="small muted stack-sm">
          <p style={{ margin: 0 }}>
            <strong>What this proves:</strong> no published record has been edited, removed, reordered or inserted since it was written, and the hashes inside the records (inputs, beacon, seed, plan, result) are the ones checked above.
          </p>
          <p style={{ margin: 0 }}>
            <strong>What it cannot prove:</strong> that the data an organiser entered was true. Tiers, residency, ages and overrides are recorded as entered; the chain shows they were not changed afterwards, not that they were right. Server timestamps are the platform's word.
          </p>
        </div>
      </div>
    </Card>
  );
}

/**
 * Public replay portal. Loads the published artifacts, then verifies every
 * step in this browser with the same shared code the server ran (shared/replay):
 * no server verdict is read. Visitors can download the bundle, change any
 * artifact and watch verification fail.
 */
export function ReplayPage() {
  const { programId = '' } = useParams();
  const db = useBrowserDb();
  const [bundle, setBundle] = useState<ReplayBundle | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [origin, setOrigin] = useState<'published' | 'file' | 'modified' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTamper, setLastTamper] = useState<TamperKey | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const verifyAll = () =>
    run(async () => {
      if (!db) return;
      const { bundle: b, verification: v } = await verifyProgram(db, programId);
      setBundle(b);
      setVerification(v);
      setOrigin('published');
      setLastTamper(null);
    });

  /** Offline: verifies exactly the given bundle (its own beacon, or the server copy it carries). */
  const verifyBundle = (b: ReplayBundle, from: 'file' | 'modified', key: TamperKey | null = null) =>
    run(async () => {
      setBundle(b);
      setVerification(await replayBundle(b));
      setOrigin(from);
      setLastTamper(key);
    });

  const failedStep = lastTamper && verification ? verification.steps.find((s) => s.status === 'fail') : null;
  const firstFail = verification?.steps.find((s) => s.status === 'fail');

  return (
    <div className="stack">
      <PageHeader
        eyebrow="Public verification"
        title="Replay the draw"
        description="Check the published draw yourself. This page fetches the frozen inputs, the audit log and the published result, asks drand for the random value, and reruns the same lottery code the server ran, entirely in your browser."
      />
      {!db ? <NotConfiguredBanner what="The published draw" /> : null}

      <Card
        title="Verify the published draw"
        description="Seven steps, all computed here: inspect the frozen inputs, recompute their hash, verify the drand round, derive the seed, run the lottery, compare every placement with the published result, and check the audit log."
      >
        <div className="stack">
          <div className="row">
            <Button icon={<ShieldCheck size={16} aria-hidden="true" />} loading={busy && origin !== 'file'} loadingLabel="Verifying…" disabled={!db || busy} onClick={() => void verifyAll()}>
              Verify the published draw
            </Button>
            <label className="btn btn--secondary btn--sm">
              <Upload size={16} aria-hidden="true" />
              <span>Verify a bundle file</span>
              <input
                type="file"
                accept=".json,application/json"
                className="visually-hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void f.text().then((t) => run(async () => { await verifyBundle(parseBundle(t), 'file'); }));
                }}
              />
            </label>
            {bundle ? (
              <Button size="sm" variant="secondary" icon={<Download size={16} aria-hidden="true" />} onClick={() => { download(`${programId}-replay-bundle.json`, serializeBundle(bundle)); }}>
                Download bundle
              </Button>
            ) : null}
            <Link to={`/fairness/${programId}`} className="btn btn--ghost btn--sm">
              <BarChart3 size={16} aria-hidden="true" />
              <span>Fairness report</span>
            </Link>
            <Link to={`/audit/${programId}`} className="btn btn--ghost btn--sm">
              <ScrollText size={16} aria-hidden="true" />
              <span>Audit log</span>
            </Link>
          </div>
          {error ? <Banner tone="error" title="Could not verify">{error}</Banner> : null}
          {/* One short announcement; the full result below is read at the user's own pace (Task 14). */}
          <p role="status" className="visually-hidden">
            {busy ? 'Verifying…' : verification ? (firstFail ? `Verification found a problem: the check "${firstFail.title}" failed.` : 'Verification finished with no failed checks.') : ''}
          </p>
          <div>
            {verification ? (
              <div className="stack">
                {origin !== 'published' ? (
                  <Banner tone="warning" title={origin === 'modified' ? 'You are verifying a modified copy' : 'You are verifying a file you loaded'}>
                    {origin === 'modified' && lastTamper
                      ? `${TAMPERS[lastTamper].description} ${failedStep ? `Verification now fails at "${failedStep.title}".` : 'Verification did not fail — please report this.'}`
                      : 'No network was used: the beacon in the file is verified against the pinned drand key here. Compare its chain head with the live log.'}
                  </Banner>
                ) : null}
                <Verdict v={verification} />
                <StepList steps={verification.steps} />
                {verification.discrepancies.length > 0 ? <DiscrepancyTable items={verification.discrepancies} /> : null}
              </div>
            ) : null}
          </div>
        </div>
      </Card>

      {bundle ? (
        <Card title="Try to break it" description="Change one published artifact and verify again, offline. Each change must make verification fail; restore the published copy to start over.">
          <div className="stack-sm">
            <div className="row">
              {(Object.keys(TAMPERS) as TamperKey[]).map((k) => (
                <Button key={k} size="sm" variant="secondary" icon={<Hammer size={16} aria-hidden="true" />} disabled={busy || !canTamper(bundle, k)} onClick={() => void verifyBundle(tamper(bundle, k), 'modified', k)}>
                  {TAMPERS[k].label}
                </Button>
              ))}
              <Button size="sm" variant="ghost" icon={<RotateCcw size={16} aria-hidden="true" />} disabled={busy || !db} onClick={() => void verifyAll()}>
                Restore the published copy
              </Button>
            </div>
            <p className="small muted">For any other change, download the bundle, edit it in a text editor and load it with "Verify a bundle file".</p>
          </div>
        </Card>
      ) : null}

      {verification ? <InputsView v={verification} programId={programId} /> : null}

      {verification?.plan ? (
        <Card
          title="Replayed result"
          description={`Computed in this browser from the frozen inputs and seed ${verification.seed?.slice(0, 12) ?? ''}…: ${String(verification.plan.summary.placements)} placements for ${String(verification.plan.summary.childrenWithAWeek)} of ${String(verification.plan.summary.children)} children (${String(verification.plan.summary.seats)} seats); ${String(verification.plan.waitlist.length)} waitlist entries.`}
        >
          <PlanView plan={verification.plan} v={verification} />
        </Card>
      ) : null}

      {verification ? <AuditView v={verification} /> : null}

      <ManualReplay />
    </div>
  );
}

interface ManualResult {
  plan: DrawPlan;
  planHash: string;
  inputsHash: string;
}

/** Run the lottery on any inputs and seed (e.g. the synthetic sample), without published artifacts. */
function ManualReplay() {
  const [inputsText, setInputsText] = useState('');
  const [seed, setSeed] = useState('');
  const [result, setResult] = useState<ManualResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const replay = (text: string, seedHex: string) => {
    setError(null);
    setResult(null);
    try {
      const inputs = JSON.parse(text) as DrawInputs;
      const plan = computePlan(inputs, seedHex.trim());
      setResult({ plan, planHash: planHash(plan), inputsHash: inputsHash(inputs) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <Card title="Run the lottery on your own inputs" description="No published artifacts needed: paste any inputs file and seed, or use the synthetic sample, and the draw module runs here.">
      <details>
        <summary>Show the manual replay</summary>
        <div className="stack" style={{ marginTop: 'var(--space-3)' }}>
          <div>
            <Button size="sm" variant="ghost" icon={<FlaskConical size={16} aria-hidden="true" />} onClick={() => { const t = JSON.stringify(SAMPLE_INPUTS, null, 2); setInputsText(t); setSeed(SAMPLE_SEED); replay(t, SAMPLE_SEED); }}>
              Try with synthetic sample data
            </Button>
          </div>
          <TextAreaField label="Inputs (JSON)" value={inputsText} onChange={(e) => { setInputsText(e.target.value); }} />
          <TextField label="Seed (64 hex characters)" value={seed} onChange={(e) => { setSeed(e.target.value); }} className="mono" />
          <div>
            <Button icon={<Play size={16} aria-hidden="true" />} disabled={!inputsText.trim()} onClick={() => { replay(inputsText, seed); }}>
              Replay in this browser
            </Button>
          </div>
          {error ? <Banner tone="error" title="Could not replay">{error}</Banner> : null}
          {result ? (
            <div className="stack">
              <dl className="kv small">
                <dt>Inputs hash</dt>
                <dd><code>{result.inputsHash}</code></dd>
                <dt>Plan hash</dt>
                <dd><code>{result.planHash}</code></dd>
              </dl>
              <PlanView plan={result.plan} v={null} />
            </div>
          ) : null}
        </div>
      </details>
    </Card>
  );
}
