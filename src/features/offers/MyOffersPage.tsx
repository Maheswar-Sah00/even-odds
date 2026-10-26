import { CalendarCheck, CircleCheck, Hourglass, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppwriteContext } from '../../app/AppwriteContext.ts';
import { AsyncView, NotConfiguredBanner } from '../../components/AsyncView.tsx';
import { Banner, Button, ButtonLink, Card, Dialog, EmptyState, PageHeader, StatusBadge, SyntheticBadge } from '../../components/ui/index.ts';
import type { ServiceError } from '@shared/errors.ts';
import type { OfferResponse } from '@shared/offer-input.ts';
import { OFFER_STATUS_TEXT } from '@shared/offer-lifecycle.ts';
import type { BrowserAppwrite } from '../../lib/appwrite/client.ts';
import { formatDateTime, formatRemaining } from '../../lib/format.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { useHousehold } from '../family/useHousehold.ts';
import { intentKeys, offersApi, type FamilyProgramOffers } from './offers-api.ts';

type Offer = FamilyProgramOffers['offers'][number];

interface OffersData {
  serverTime: string;
  /** serverTime minus the device clock, measured when the response arrived. */
  offsetMs: number;
  programs: FamilyProgramOffers[];
}

/** Server time now, ticking every 30 s: the device clock corrected by the measured offset. */
function useServerNow(serverTime: string, offsetMs: number) {
  const [now, setNow] = useState(() => Date.parse(serverTime));
  useEffect(() => {
    const t = setInterval(() => { setNow(Date.now() + offsetMs); }, 30_000);
    return () => { clearInterval(t); };
  }, [offsetMs]);
  return now;
}

const CONFIRM: Record<Exclude<OfferResponse, 'accept'>, { title: string; body: string; button: string }> = {
  decline: { title: 'Decline this offer?', body: 'The place goes to the next family on the waitlist straight away. You cannot undo this.', button: 'Decline offer' },
  giveBack: { title: 'Give up this place?', body: 'You accepted this place. Giving it back offers it to the next family on the waitlist. You cannot undo this.', button: 'Give up place' },
};

function ProgramOffers({ app, program, now, onChanged }: { app: BrowserAppwrite; program: FamilyProgramOffers; now: number; onChanged: () => void }) {
  const keys = useRef(intentKeys());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<{ response: Exclude<OfferResponse, 'accept'>; ids: string[] } | null>(null);
  const tz = program.timezone;

  const act = async (response: OfferResponse, ids: string[]) => {
    const intent = `${response}:${[...ids].sort().join(',')}`;
    setBusy(intent);
    setMessage(null);
    try {
      const res = await offersApi(app).respond(program.programId, ids, response, keys.current.keyFor(intent));
      keys.current.done(intent);
      const what = response === 'accept' ? 'accepted' : response === 'decline' ? 'declined' : 'given back';
      setMessage({ tone: 'success', text: res.status === 'changed' ? `Done: ${ids.length > 1 ? 'places' : 'place'} ${what}.` : `Already ${what}. Nothing changed.` });
      setConfirm(null);
      onChanged();
    } catch (err) {
      // Keep the key: retrying this same intent must not act twice.
      const e = err as ServiceError & { code?: string };
      setMessage({ tone: 'error', text: e.message });
      setConfirm(null);
      if (e.code === 'expired' || e.code === 'conflict') {
        keys.current.done(intent);
        onChanged();
      }
    } finally {
      setBusy(null);
    }
  };

  const weeks = [...new Set(program.offers.map((o) => o.week))];
  const notIssued = !program.offersIssuedAt;

  return (
    <Card
      title={program.name}
      description={program.offersIssuedAt ? `Offers issued ${formatDateTime(program.offersIssuedAt, tz)}. Each offer must be answered within 48 hours.` : undefined}
      actions={program.synthetic ? <SyntheticBadge /> : null}
    >
      <div className="stack">
        {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}
        {notIssued && program.offers.length > 0 ? (
          <Banner tone="info" title="Offers are being prepared">The draw is complete. Your offers will open for replies shortly; the 48-hour clock starts then.</Banner>
        ) : null}

        {weeks.map((week) => {
          const offers = program.offers.filter((o) => o.week === week);
          const open = offers.filter((o) => o.displayStatus === 'offered');
          return (
            <section key={week} className="stack-sm" aria-label={offers[0]?.weekLabel ?? week}>
              <h3>{offers[0]?.weekLabel ?? week}</h3>
              <ul className="stack-sm offer-list">
                {offers.map((o) => (
                  <OfferRow
                    key={o.placementId}
                    offer={o}
                    tz={tz}
                    now={now}
                    disabled={notIssued || busy !== null}
                    busy={busy}
                    onAccept={() => void act('accept', [o.placementId])}
                    onDecline={() => { setConfirm({ response: 'decline', ids: [o.placementId] }); }}
                    onGiveBack={() => { setConfirm({ response: 'giveBack', ids: [o.placementId] }); }}
                  />
                ))}
              </ul>
              {open.length > 1 ? (
                <div className="row">
                  <Button
                    icon={<CalendarCheck size={16} aria-hidden="true" />}
                    disabled={notIssued || busy !== null}
                    loading={busy === `accept:${open.map((o) => o.placementId).sort().join(',')}`}
                    loadingLabel="Accepting…"
                    onClick={() => void act('accept', open.map((o) => o.placementId))}
                  >
                    Accept all {open.length} for this week
                  </Button>
                </div>
              ) : null}
            </section>
          );
        })}

        {program.waitlist.length > 0 ? (
          <section className="stack-sm" aria-label="Waitlist">
            <h3>Waitlist</h3>
            <p className="muted small">
              When a place is declined, expires or is given back, it is offered to the next child in lottery order straight away, as long as they still want a week and, for siblings who must be together, there is room for all of them.
            </p>
            <ul className="stack-sm">
              {program.waitlist.map((w) => (
                <li key={w.entryId}>
                  <strong>{w.childName}</strong>: {w.weekLabel} ({w.ageGroup} group) –{' '}
                  {w.status === 'waiting' ? (
                    <>
                      position {w.position}
                      {w.ahead !== null ? `, ${w.ahead === 0 ? 'nobody' : String(w.ahead)} still waiting ahead` : ''}
                    </>
                  ) : w.status === 'promoted' ? (
                    'offered a place (see above)'
                  ) : (
                    'no longer waiting'
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      <Dialog
        open={confirm !== null}
        onClose={() => { setConfirm(null); }}
        title={confirm ? CONFIRM[confirm.response].title : ''}
        footer={
          confirm ? (
            <>
              <Button variant="ghost" onClick={() => { setConfirm(null); }}>Keep it</Button>
              <Button variant="danger" loading={busy !== null} loadingLabel="Saving…" onClick={() => void act(confirm.response, confirm.ids)}>
                {CONFIRM[confirm.response].button}
              </Button>
            </>
          ) : null
        }
      >
        <p>{confirm ? CONFIRM[confirm.response].body : ''}</p>
      </Dialog>
    </Card>
  );
}

function OfferRow(props: { offer: Offer; tz: string; now: number; disabled: boolean; busy: string | null; onAccept: () => void; onDecline: () => void; onGiveBack: () => void }) {
  const { offer: o, tz, now } = props;
  const lapsed = o.displayStatus === 'lapsed' || (o.displayStatus === 'offered' && o.expiresAt !== null && Date.parse(o.expiresAt) <= now);
  const text = lapsed ? { label: 'Expired', tone: 'danger' as const } : OFFER_STATUS_TEXT[o.status];
  return (
    <li className="offer-row">
      <div className="stack-sm">
        <div className="row">
          <strong>{o.childName}</strong>
          <span className="muted">{o.ageGroup} group</span>
          <StatusBadge tone={text.tone}>{text.label}</StatusBadge>
          {o.source === 'waitlist' ? <StatusBadge tone="info">From the waitlist</StatusBadge> : null}
        </div>
        {o.status === 'offered' && o.expiresAt && !lapsed ? (
          <span className="small">
            <Hourglass size={14} aria-hidden="true" /> Reply by {formatDateTime(o.expiresAt, tz)} ({formatRemaining(Date.parse(o.expiresAt) - now)} left)
          </span>
        ) : null}
        {lapsed ? <span className="small muted">The 48-hour reply window has passed. The place is being offered to the next family.</span> : null}
        {o.respondedAt && o.status !== 'offered' ? <span className="small muted">Updated {formatDateTime(o.respondedAt, tz)}</span> : null}
      </div>
      <div className="row">
        {o.status === 'offered' && !lapsed ? (
          <>
            <Button size="sm" icon={<CircleCheck size={16} aria-hidden="true" />} disabled={props.disabled} loading={props.busy === `accept:${o.placementId}`} loadingLabel="Accepting…" onClick={props.onAccept}>
              Accept
            </Button>
            <Button size="sm" variant="ghost" icon={<X size={16} aria-hidden="true" />} disabled={props.disabled} onClick={props.onDecline}>
              Decline
            </Button>
          </>
        ) : null}
        {o.status === 'accepted' ? (
          <Button size="sm" variant="ghost" icon={<Undo2 size={16} aria-hidden="true" />} disabled={props.disabled} onClick={props.onGiveBack}>
            Give up place
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export function MyOffersPage() {
  const { appwrite } = useAppwriteContext();
  const load = useCallback(async () => {
    if (!appwrite) throw new Error('not configured');
    const data = await offersApi(appwrite).mine();
    return { ...data, offsetMs: Date.parse(data.serverTime) - Date.now() } satisfies OffersData;
  }, [appwrite]);
  const household = useHousehold();
  const hasHousehold = household.status === 'success' && household.data !== null;
  const state = useAsync(appwrite && hasHousehold ? load : null, hasHousehold);

  return (
    <div className="stack">
      <PageHeader eyebrow="My family" title="Offers and waitlist" description="Places from the draw and from the waitlist. Replies and expiry are decided by the server clock, not your device." />
      {!appwrite ? (
        <NotConfiguredBanner what="Offers" />
      ) : (
        <AsyncView state={household} loadingLabel="Loading your offers…">
          {(h) =>
            h === null ? (
              <EmptyState icon={CalendarCheck} title="Set up your household first" actions={<ButtonLink to="/family">Create or join a household</ButtonLink>}>
                Offers belong to a household. Once yours exists and a program you applied to has run its draw, places appear here.
              </EmptyState>
            ) : (
              <AsyncView state={state} loadingLabel="Loading your offers…">
                {(data) => <OffersBody app={appwrite} data={data} onChanged={state.reload} />}
              </AsyncView>
            )
          }
        </AsyncView>
      )}
    </div>
  );
}

function OffersBody({ app, data, onChanged }: { app: BrowserAppwrite; data: OffersData; onChanged: () => void }) {
  const now = useServerNow(data.serverTime, data.offsetMs);
  if (data.programs.length === 0) {
    return (
      <EmptyState title="No offers yet" actions={<ButtonLink to="/programs" variant="secondary">Browse programs</ButtonLink>}>
        Offers appear here after a program you applied to has run its draw.
      </EmptyState>
    );
  }
  return (
    <>
      {data.programs.map((p) => (
        <ProgramOffers key={p.programId} app={app} program={p} now={now} onChanged={onChanged} />
      ))}
    </>
  );
}
