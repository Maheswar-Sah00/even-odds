import { Lock, PlayCircle, ScrollText } from 'lucide-react';
import { useCallback, useState } from 'react';
import { AsyncView } from '../../components/AsyncView.tsx';
import { Banner, Button, ButtonLink, Card, Dialog, StatusBadge } from '../../components/ui/index.ts';
import type { ServiceError } from '@shared/errors.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useAsync } from '../../lib/useAsync.ts';
import type { Program } from '../programs/program-view.ts';
import { consoleCalls, type ConsoleApi, type DrawStatus } from './console-api.ts';

const short = (h: string | null | undefined) => (h ? `${h.slice(0, 16)}…` : '—');

function runLabel(d: DrawStatus): { tone: 'neutral' | 'pending' | 'success' | 'danger' | 'info'; text: string } {
  if (d.status === 'draft' || d.status === 'open') return { tone: 'neutral', text: 'Applications open: inputs not frozen' };
  if (!d.run) return { tone: 'danger', text: 'Frozen without a draw run' };
  if (d.run.status === 'failed') return { tone: 'danger', text: 'Draw stopped: the database refused a planned step' };
  if (d.run.status === 'completed') return { tone: 'success', text: 'Drawn' };
  if (d.run.seed) return { tone: 'info', text: `Drawing: ${String(d.run.cursor)} plan steps committed` };
  if (d.roundAt && Date.parse(d.serverTime) < Date.parse(d.roundAt)) return { tone: 'pending', text: `Frozen; waiting for drand round ${String(d.drandRound)}` };
  return { tone: 'pending', text: 'Frozen; round published, waiting for beacon verification' };
}

/**
 * Freeze and draw status. Production organisers can freeze as soon as the
 * window closes (the hourly job does it otherwise, and runs the draw once
 * the announced round exists). In the judge sandbox both happen from the
 * demo controls.
 */
export function DrawSection({ api, program, refreshKey, onChanged }: { api: ConsoleApi; program: Program; refreshKey?: unknown; onChanged?: () => void }) {
  const load = useCallback(() => consoleCalls(api).drawStatus(), [api]);
  const state = useAsync(load, refreshKey);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tz = program.timezone;

  const freeze = async () => {
    if (!api.freeze) return;
    setBusy(true);
    setError(null);
    try {
      await api.freeze();
      setConfirm(false);
      state.reload();
      onChanged?.();
    } catch (err) {
      setError((err as ServiceError).message);
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Freeze and draw" description="At the close every input is hashed and published in one transaction, before the pre-announced drand round exists. The draw then uses only that snapshot and the verified beacon.">
      <AsyncView state={state} loadingLabel="Loading draw status…">
        {(d) => {
          const label = runLabel(d);
          const closed = Date.parse(d.serverTime) >= Date.parse(d.windowClose);
          return (
            <div className="stack">
              <p>
                <StatusBadge tone={label.tone}>{label.text}</StatusBadge>
              </p>
              <dl className="kv">
                <dt>Applications close</dt>
                <dd>{formatDateTime(d.windowClose, tz)}</dd>
                <dt>drand round</dt>
                <dd>
                  {d.drandRound && d.roundAt ? `${String(d.drandRound)}, due ${formatDateTime(d.roundAt, tz)}` : d.timing === 'demo' ? 'Announced when the sandbox is fast-forwarded to the close' : 'Not announced'}
                  {d.timing === 'demo' ? <span className="muted small"> (demo timing: due 45 s after the close)</span> : null}
                </dd>
                {d.freezeDeadline ? (
                  <>
                    <dt>Freeze deadline</dt>
                    <dd>{formatDateTime(d.freezeDeadline, tz)} (the round can never be changed)</dd>
                  </>
                ) : null}
                <dt>Inputs hash</dt>
                <dd className="mono">{d.inputsHash ?? 'Published at the freeze'}</dd>
                {d.snapshot ? (
                  <>
                    <dt>Snapshot</dt>
                    <dd>
                      {d.snapshot.applications} applications, {d.snapshot.children} children, {d.snapshot.seats} seats, {d.snapshot.overrides} override(s); frozen {formatDateTime(d.snapshot.frozenAt, tz)}
                    </dd>
                  </>
                ) : null}
                {d.run ? (
                  <>
                    <dt>Beacon</dt>
                    <dd>{d.run.beaconVerified ? 'Signature verified against the pinned quicknet key' : d.run.beaconLastError ? `Not yet: ${d.run.beaconLastError}` : 'Not fetched yet'}</dd>
                    <dt>Seed</dt>
                    <dd className="mono">{short(d.run.seed)}</dd>
                    <dt>Plan hash</dt>
                    <dd className="mono">{short(d.run.planHash)}</dd>
                    {d.run.error ? (
                      <>
                        <dt>Stopped</dt>
                        <dd>{d.run.error}</dd>
                      </>
                    ) : null}
                  </>
                ) : null}
              </dl>
              <div className="row">
                {api.freeze && (d.status === 'open' || d.status === 'draft') ? (
                  <Button icon={<Lock size={16} aria-hidden="true" />} disabled={!closed || d.status === 'draft'} onClick={() => { setConfirm(true); }}>
                    {closed ? 'Freeze inputs now' : 'Freeze available when applications close'}
                  </Button>
                ) : null}
                <ButtonLink to={`/audit/${program.$id}`} variant="secondary" icon={<ScrollText size={16} aria-hidden="true" />}>
                  Public audit
                </ButtonLink>
                <ButtonLink to={`/replay/${program.$id}`} variant="secondary" icon={<PlayCircle size={16} aria-hidden="true" />}>
                  Replay the draw
                </ButtonLink>
              </div>
              {error ? <Banner tone="error">{error}</Banner> : null}
            </div>
          );
        }}
      </AsyncView>
      <Dialog
        open={confirm}
        onClose={() => { setConfirm(false); }}
        title="Freeze the inputs?"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setConfirm(false); }}>Cancel</Button>
            <Button loading={busy} loadingLabel="Freezing…" onClick={() => void freeze()}>Freeze now</Button>
          </>
        }
      >
        <p>Every submitted application, preference, tier, approved override and session capacity is published as a hash. Nothing can be changed afterwards, including by organisers.</p>
      </Dialog>
    </Card>
  );
}
