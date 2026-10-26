import { Ban, RefreshCw } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { AsyncView } from '../../components/AsyncView.tsx';
import { Banner, Button, Card, DataTable, Dialog, StatusBadge } from '../../components/ui/index.ts';
import type { ServiceError } from '@shared/errors.ts';
import { OFFER_STATUS_TEXT } from '@shared/offer-lifecycle.ts';
import { formatDateTime, formatRemaining } from '../../lib/format.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { consoleCalls, type ConsoleApi } from '../console/console-api.ts';
import { intentKeys, type OrganiserOffersOverview } from '../offers/offers-api.ts';
import type { Program } from '../programs/program-view.ts';

const short = (id: string) => id.slice(0, 8);
type OfferRow = OrganiserOffersOverview['offers'][number];
type WaitRow = OrganiserOffersOverview['waitlist'][number];

/**
 * Organiser view of outstanding offers and waitlist positions after the draw.
 * Families appear by their pseudonymous receipt code and ticket ref only.
 * `refreshKey` changes when something outside this section (a demo control)
 * changed the offers, so the table reloads.
 */
export function OffersSection({ api, program, refreshKey }: { api: ConsoleApi; program: Program; refreshKey?: string | number }) {
  const load = useCallback(() => consoleCalls(api).offersOverview(), [api]);
  const state = useAsync(program.status === 'drawn' || program.status === 'closed' ? load : null, `${program.$id}:${String(refreshKey ?? '')}`);
  const keys = useRef(intentKeys());
  const [busy, setBusy] = useState<'process' | 'cancel' | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [cancel, setCancel] = useState<OfferRow | null>(null);

  if (program.status !== 'drawn' && program.status !== 'closed') return null;

  const run = async (what: 'process' | 'cancel', fn: () => Promise<string>) => {
    setBusy(what);
    setMessage(null);
    try {
      setMessage({ tone: 'success', text: await fn() });
      state.reload();
    } catch (err) {
      setMessage({ tone: 'error', text: (err as ServiceError).message });
    } finally {
      setBusy(null);
      setCancel(null);
    }
  };

  const processNow = () =>
    run('process', async () => {
      const r = await consoleCalls(api).processOffers();
      return `Expired ${String(r.expired)} offer(s), offered ${String(r.promoted)} place(s) from the waitlist${r.more ? '. More work remains: press the button again, or the hourly job continues it.' : '.'}`;
    });

  const cancelOffer = (o: OfferRow) =>
    run('cancel', async () => {
      const intent = `cancel:${o.placementId}`;
      const r = await consoleCalls(api).cancelOffers([o.placementId], keys.current.keyFor(intent));
      keys.current.done(intent);
      return r.status === 'changed' ? `Offer cancelled; ${String(r.promoted)} place(s) offered from the waitlist.` : 'That offer was already cancelled.';
    });

  return (
    <Card
      title="Offers and waitlist"
      description="Offers expire 48 hours after they are made (server clock). Released places go to the next waiting child in lottery order, keeping sibling rules and age-group capacity."
      actions={
        <Button variant="secondary" icon={<RefreshCw size={16} aria-hidden="true" />} loading={busy === 'process'} loadingLabel="Processing…" onClick={() => void processNow()}>
          Process expiries now
        </Button>
      }
    >
      <AsyncView state={state} loadingLabel="Loading offers…">
        {(data) => {
          const now = Date.parse(data.serverTime);
          const outstanding = data.offers.filter((o) => o.status === 'offered' || o.status === 'accepted');
          const waiting = data.waitlist.filter((w) => w.status === 'waiting');
          return (
            <div className="stack">
              {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}
              <p className="muted small">
                {data.offersIssuedAt ? `Offers issued ${formatDateTime(data.offersIssuedAt, program.timezone)}.` : 'Offers have not been issued yet; the jobs Function issues them after the draw completes.'}{' '}
                {data.offersSweptAt ? `Last sweep ${formatDateTime(data.offersSweptAt, program.timezone)}.` : ''}
              </p>
              <DataTable
                caption="Seats by session"
                rows={data.sessions}
                rowKey={(s) => `${s.week}/${s.ageGroup}`}
                columns={[
                  { key: 'week', header: 'Week', render: (s) => s.weekLabel },
                  { key: 'group', header: 'Age group', render: (s) => s.ageGroup },
                  { key: 'cap', header: 'Places', numeric: true, render: (s) => s.capacity },
                  { key: 'taken', header: 'Held', numeric: true, render: (s) => s.taken },
                  { key: 'pending', header: 'Pending', numeric: true, render: (s) => s.pending },
                  { key: 'accepted', header: 'Accepted', numeric: true, render: (s) => s.accepted },
                  { key: 'waiting', header: 'Waiting', numeric: true, render: (s) => s.waiting },
                ]}
              />
              <DataTable<OfferRow>
                caption={`Outstanding offers (${String(outstanding.length)})`}
                rows={outstanding}
                rowKey={(o) => o.placementId}
                empty={<p className="muted">No pending or accepted offers.</p>}
                columns={[
                  { key: 'family', header: 'Receipt', render: (o) => <code title={o.publicId}>{short(o.publicId)}</code> },
                  { key: 'ref', header: 'Ticket', render: (o) => <code title={o.ref}>{short(o.ref)}</code> },
                  { key: 'week', header: 'Week', render: (o) => `${o.weekLabel} (${o.ageGroup})` },
                  {
                    key: 'status',
                    header: 'Status',
                    render: (o) => (
                      <StatusBadge tone={o.displayStatus === 'lapsed' ? 'danger' : OFFER_STATUS_TEXT[o.status].tone}>
                        {o.displayStatus === 'lapsed' ? 'Lapsed, awaiting sweep' : OFFER_STATUS_TEXT[o.status].label}
                      </StatusBadge>
                    ),
                  },
                  {
                    key: 'expires',
                    header: 'Expires',
                    render: (o) => (o.status === 'offered' && o.expiresAt ? `${formatDateTime(o.expiresAt, program.timezone)} (${formatRemaining(Date.parse(o.expiresAt) - now)})` : '—'),
                  },
                  { key: 'source', header: 'From', render: (o) => (o.source === 'waitlist' ? 'Waitlist' : `Draw, round ${String(o.round ?? '?')}`) },
                  {
                    key: 'act',
                    header: <span className="visually-hidden">Actions</span>,
                    render: (o) => (
                      <Button size="sm" variant="ghost" icon={<Ban size={14} aria-hidden="true" />} disabled={busy !== null} onClick={() => { setCancel(o); }}>
                        Cancel
                      </Button>
                    ),
                  },
                ]}
              />
              <DataTable<WaitRow>
                caption={`Waitlist (${String(waiting.length)} waiting)`}
                rows={data.waitlist}
                rowKey={(w) => w.entryId}
                empty={<p className="muted">Nobody is on the waitlist.</p>}
                columns={[
                  { key: 'week', header: 'Session', render: (w) => `${w.weekLabel} (${w.ageGroup})` },
                  { key: 'pos', header: 'Position', numeric: true, render: (w) => w.position },
                  { key: 'rank', header: 'Lottery order', numeric: true, render: (w) => w.rank ?? '—' },
                  { key: 'family', header: 'Receipt', render: (w) => <code title={w.publicId}>{short(w.publicId)}</code> },
                  { key: 'ref', header: 'Ticket', render: (w) => <code title={w.ref}>{short(w.ref)}</code> },
                  { key: 'status', header: 'Status', render: (w) => (w.status === 'waiting' ? 'Waiting' : w.status === 'promoted' ? 'Offered a place' : 'Removed') },
                ]}
              />
            </div>
          );
        }}
      </AsyncView>
      <Dialog
        open={cancel !== null}
        onClose={() => { setCancel(null); }}
        title="Cancel this offer?"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setCancel(null); }}>Keep it</Button>
            <Button variant="danger" loading={busy === 'cancel'} loadingLabel="Cancelling…" onClick={() => { if (cancel) void cancelOffer(cancel); }}>
              Cancel offer
            </Button>
          </>
        }
      >
        <p>The family loses this place and it is offered to the next child on the waitlist. This is recorded in the public audit log (pseudonymously) and cannot be undone.</p>
      </Dialog>
    </Card>
  );
}
