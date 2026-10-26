import { BadgeCheck, PenLine } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { AsyncView } from '../../components/AsyncView.tsx';
import { Banner, Button, Card, DataTable, Dialog, SelectField, StatusBadge } from '../../components/ui/index.ts';
import { VERIFICATION_REASON_TEXT, VERIFICATION_REASONS, type VerificationReason } from '@shared/console-input.ts';
import type { ServiceError } from '@shared/errors.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { intentKeys } from '../offers/offers-api.ts';
import { consoleCalls, type ConsoleApi, type VerificationItem } from './console-api.ts';

const short = (id: string) => id.slice(0, 8);

/**
 * Family verification queue: priority-tier claims and homes near a zone edge
 * come first. Staff check residency proof offline; here they confirm or
 * change the tier BEFORE the freeze (the tier is a draw input). Organisers
 * see receipt codes and tiers, never homes or names.
 */
export function VerificationSection({ api, refreshKey, onChanged }: { api: ConsoleApi; refreshKey?: unknown; onChanged?: () => void }) {
  const load = useCallback(() => consoleCalls(api).verificationQueue(), [api]);
  const state = useAsync(load, refreshKey);
  const keys = useRef(intentKeys());
  const [editing, setEditing] = useState<VerificationItem | null>(null);
  const [tier, setTier] = useState('0');
  const [reason, setReason] = useState<VerificationReason>('boundary_reviewed');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const submit = async (item: VerificationItem, newTier: number, code: VerificationReason) => {
    const intent = `verify:${item.publicId}:${String(newTier)}:${code}`;
    setBusy(true);
    setMessage(null);
    try {
      const r = await consoleCalls(api).verifyTier(item.publicId, newTier, code, keys.current.keyFor(intent));
      keys.current.done(intent);
      setMessage(
        r.inSnapshot
          ? { tone: 'success', text: `Receipt ${short(item.publicId)}: tier ${String(newTier)} recorded${r.auditSeq ? ` (audit entry #${String(r.auditSeq)})` : ''}.` }
          : { tone: 'warning', text: 'The inputs were frozen at the same moment, so this change is not part of the draw. It is recorded as a change after the freeze.' },
      );
      setEditing(null);
      state.reload();
      onChanged?.();
    } catch (err) {
      setMessage({ tone: 'error', text: (err as ServiceError).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Family verification queue" description="Confirm or correct claimed priority tiers before applications close. Each decision needs a reason code and is logged with your name and the reason (staff log), and pseudonymously without the reason (public audit log).">
      <AsyncView state={state} loadingLabel="Loading the queue…">
        {(q) => {
          const label = (t: number) => `Tier ${String(t)}: ${q.tierLabels[String(t)] ?? '(no label)'}`;
          return (
            <div className="stack">
              {q.locked ? <Banner tone="info">The inputs are frozen: tiers are part of the published snapshot and can no longer change.</Banner> : <p className="muted small">{q.needsReview} application(s) need review.</p>}
              {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}
              <DataTable<VerificationItem>
                caption="Applications by review priority"
                rows={q.items}
                rowKey={(i) => i.publicId}
                empty={<p className="muted">No submitted applications yet.</p>}
                columns={[
                  { key: 'id', header: 'Receipt', render: (i) => <code title={i.publicId}>{short(i.publicId)}</code> },
                  { key: 'claimed', header: 'Claimed', render: (i) => label(i.claimedTier) },
                  {
                    key: 'flags',
                    header: 'Why review',
                    render: (i) => (
                      <span className="row">
                        {i.nearBoundary ? <StatusBadge tone="pending">Within 50 m of a zone edge</StatusBadge> : null}
                        {i.priorityClaim ? <StatusBadge tone="info">Priority claim</StatusBadge> : null}
                        {!i.nearBoundary && !i.priorityClaim ? <span className="muted">Default tier</span> : null}
                      </span>
                    ),
                  },
                  { key: 'kids', header: 'Children', numeric: true, render: (i) => i.children },
                  {
                    key: 'state',
                    header: 'Verified',
                    render: (i) =>
                      i.state === 'unverified' ? <StatusBadge tone="neutral">Not yet</StatusBadge> : i.state === 'confirmed' ? <StatusBadge tone="success">Confirmed</StatusBadge> : <StatusBadge tone="danger">Changed to tier {i.verifiedTier}</StatusBadge>,
                  },
                  {
                    key: 'act',
                    header: <span className="visually-hidden">Actions</span>,
                    render: (i) =>
                      q.locked ? null : (
                        <span className="row">
                          <Button size="sm" variant="secondary" icon={<BadgeCheck size={14} aria-hidden="true" />} disabled={busy} onClick={() => void submit(i, i.claimedTier, 'residency_confirmed')}>
                            Confirm<span className="visually-hidden"> receipt {short(i.publicId)}</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<PenLine size={14} aria-hidden="true" />}
                            disabled={busy}
                            onClick={() => {
                              setEditing(i);
                              setTier(String(i.effectiveTier));
                              setReason(i.nearBoundary ? 'boundary_reviewed' : 'proof_not_provided');
                            }}
                          >
                            Change tier<span className="visually-hidden"> for receipt {short(i.publicId)}</span>
                          </Button>
                        </span>
                      ),
                  },
                ]}
              />
              <Dialog
                open={editing !== null}
                onClose={() => { setEditing(null); }}
                title="Change this family's tier?"
                footer={
                  <>
                    <Button variant="ghost" onClick={() => { setEditing(null); }}>Cancel</Button>
                    <Button loading={busy} loadingLabel="Saving…" onClick={() => { if (editing) void submit(editing, Number(tier), reason); }}>
                      Record tier {tier}
                    </Button>
                  </>
                }
              >
                {editing ? (
                  <div className="stack">
                    <p>
                      Receipt <code>{short(editing.publicId)}</code> claimed {label(editing.claimedTier)}. The tier decides their place in the lottery order, so this changes
                      the draw input. It is recorded with your name, the reason and the time.
                    </p>
                    <SelectField label="Verified tier" value={tier} onChange={(e) => { setTier(e.target.value); }}>
                      {Object.keys(q.tierLabels).sort().map((t) => <option key={t} value={t}>{label(Number(t))}</option>)}
                    </SelectField>
                    <SelectField label="Reason" value={reason} onChange={(e) => { setReason(e.target.value as VerificationReason); }}>
                      {VERIFICATION_REASONS.filter((r) => r !== 'residency_confirmed').map((r) => <option key={r} value={r}>{VERIFICATION_REASON_TEXT[r]}</option>)}
                    </SelectField>
                  </div>
                ) : null}
              </Dialog>
            </div>
          );
        }}
      </AsyncView>
    </Card>
  );
}
