import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { AsyncView } from '../../components/AsyncView.tsx';
import { Banner, Button, Card, DataTable, Dialog, SelectField, StatusBadge } from '../../components/ui/index.ts';
import { OVERRIDE_POOLS, OVERRIDE_REASON_TEXT, type OverrideReason } from '@shared/console-input.ts';
import type { ServiceError } from '@shared/errors.ts';
import { OVERRIDE_REASONS } from '@shared/schema.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { intentKeys } from '../offers/offers-api.ts';
import { consoleCalls, type ConsoleApi, type OverrideRow } from './console-api.ts';

const short = (id: string) => id.slice(0, 8);
/** Recorded for staff only (not published, Task 14); the draw treats both pools the same (docs/DRAW-ALGORITHM.md). */
const POOL_TEXT = { general: 'General', accommodation: 'Accommodation' } as const;

/**
 * Pre-freeze overrides: a family drawn ahead of everyone else for a listed
 * reason. Each needs a reason code, is created by an authorised organiser at
 * server time, and is frozen into the published input snapshot (where it is
 * identified by receipt code only; the reason stays in the staff log). Nothing can be added or removed after the freeze.
 */
export function OverridesSection({ api, timezone, refreshKey, onChanged }: { api: ConsoleApi; timezone: string; refreshKey?: unknown; onChanged?: () => void }) {
  const load = useCallback(async () => {
    const calls = consoleCalls(api);
    const [list, queue] = await Promise.all([calls.overrides(), calls.verificationQueue()]);
    return { ...list, receipts: queue.items.map((i) => i.publicId) };
  }, [api]);
  const state = useAsync(load, refreshKey);
  const keys = useRef(intentKeys());
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<OverrideRow | null>(null);
  const [publicId, setPublicId] = useState('');
  const [reason, setReason] = useState<OverrideReason>('accommodation');
  const [pool, setPool] = useState<'general' | 'accommodation'>('accommodation');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const run = async (intent: string, fn: (key: string) => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ tone: 'success', text: await fn(keys.current.keyFor(intent)) });
      keys.current.done(intent);
      setAdding(false);
      setRemoving(null);
      state.reload();
      onChanged?.();
    } catch (err) {
      setMessage({ tone: 'error', text: (err as ServiceError).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Pre-freeze overrides"
      description="An override draws a family ahead of all others, for a listed reason only. It is logged with your name and the server time, and frozen into the published inputs as the receipt code only: the reason is never published."
      actions={
        <Button icon={<Plus size={16} aria-hidden="true" />} disabled={state.status !== 'success' || state.data.locked} onClick={() => { setAdding(true); }}>
          Add override
        </Button>
      }
    >
      <AsyncView state={state} loadingLabel="Loading overrides…">
        {(d) => (
          <div className="stack">
            {d.locked ? <Banner tone="info">The inputs are frozen. Overrides listed here are part of the published snapshot; none can be added or removed.</Banner> : null}
            {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}
            <DataTable<OverrideRow>
              caption="Overrides"
              rows={d.overrides}
              rowKey={(o) => o.publicId}
              empty={<p className="muted">No overrides. Every family is ordered by tier and the lottery alone.</p>}
              columns={[
                { key: 'id', header: 'Receipt', render: (o) => <code title={o.publicId}>{short(o.publicId)}</code> },
                { key: 'reason', header: 'Reason', render: (o) => OVERRIDE_REASON_TEXT[o.reasonCode] },
                { key: 'pool', header: 'Pool', render: (o) => POOL_TEXT[o.pool] },
                { key: 'who', header: 'Authorised by', render: (o) => o.actor },
                { key: 'when', header: 'When (server time)', render: (o) => formatDateTime(o.createdAt, timezone) },
                {
                  key: 'frozen',
                  header: 'In snapshot',
                  render: (o) =>
                    o.inSnapshot === null ? <StatusBadge tone="pending">Will be frozen at close</StatusBadge> : o.inSnapshot ? <StatusBadge tone="success">Frozen into the inputs</StatusBadge> : <StatusBadge tone="danger">Not in the draw (after freeze)</StatusBadge>,
                },
                {
                  key: 'act',
                  header: <span className="visually-hidden">Actions</span>,
                  render: (o) =>
                    d.locked ? null : (
                      <Button size="sm" variant="ghost" icon={<Trash2 size={14} aria-hidden="true" />} disabled={busy} onClick={() => { setRemoving(o); }}>
                        Remove<span className="visually-hidden"> override for {short(o.publicId)}</span>
                      </Button>
                    ),
                },
              ]}
            />
            <Dialog
              open={adding}
              onClose={() => { setAdding(false); }}
              title="Add a pre-freeze override?"
              footer={
                <>
                  <Button variant="ghost" onClick={() => { setAdding(false); }}>Cancel</Button>
                  <Button
                    loading={busy}
                    loadingLabel="Saving…"
                    disabled={!publicId}
                    onClick={() => void run(`add:${publicId}:${reason}:${pool}`, async (key) => {
                      const r = await consoleCalls(api).createOverride(publicId, reason, pool, key);
                      return r.inSnapshot ? `Override recorded for receipt ${short(publicId)}${r.auditSeq ? ` (audit entry #${String(r.auditSeq)})` : ''}. It will be frozen into the inputs.` : 'The inputs were frozen at the same moment; this override is not part of the draw.';
                    })}
                  >
                    Authorise override
                  </Button>
                </>
              }
            >
              <div className="stack">
                <p>The family draws before every family without an override. The public sees only that this receipt code has an override, never the reason; the reason and your name are kept in the staff log.</p>
                <SelectField label="Application (receipt code)" value={publicId} onChange={(e) => { setPublicId(e.target.value); }}>
                  <option value="">Choose a receipt…</option>
                  {d.receipts.filter((r) => !d.overrides.some((o) => o.publicId === r)).map((r) => <option key={r} value={r}>{short(r)}…</option>)}
                </SelectField>
                <SelectField label="Reason" value={reason} onChange={(e) => { setReason(e.target.value as OverrideReason); }}>
                  {OVERRIDE_REASONS.map((r) => <option key={r} value={r}>{OVERRIDE_REASON_TEXT[r]}</option>)}
                </SelectField>
                <SelectField label="Pool (recorded for staff only; the draw treats both pools the same)" value={pool} onChange={(e) => { setPool(e.target.value as 'general' | 'accommodation'); }}>
                  {OVERRIDE_POOLS.map((p) => <option key={p} value={p}>{POOL_TEXT[p]}</option>)}
                </SelectField>
              </div>
            </Dialog>
            <Dialog
              open={removing !== null}
              onClose={() => { setRemoving(null); }}
              title="Remove this override?"
              footer={
                <>
                  <Button variant="ghost" onClick={() => { setRemoving(null); }}>Keep it</Button>
                  <Button variant="danger" loading={busy} loadingLabel="Removing…" onClick={() => { if (removing) void run(`remove:${removing.publicId}`, async (key) => { await consoleCalls(api).removeOverride(removing.publicId, key); return `Override for receipt ${short(removing.publicId)} removed.`; }); }}>
                    Remove override
                  </Button>
                </>
              }
            >
              <p>The family goes back to normal lottery order. The removal is logged like the override was.</p>
            </Dialog>
          </div>
        )}
      </AsyncView>
    </Card>
  );
}
