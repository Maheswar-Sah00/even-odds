import { ArrowRight, CalendarClock, CalendarRange, ClipboardList, Layers } from 'lucide-react';
import { Query } from 'appwrite';
import { useCallback } from 'react';
import { Link } from 'react-router';
import { useBrowserDb } from '../../app/AppwriteContext.ts';
import { AsyncView, NotConfiguredBanner } from '../../components/AsyncView.tsx';
import { ButtonLink, EmptyState, PageHeader, StatusBadge, SyntheticBadge } from '../../components/ui/index.ts';
import { formatDate, formatDateTime } from '../../lib/format.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { PHASE_LABEL, PHASE_TONE, phaseOf, summarise, type Program, type Session } from './program-view.ts';

function NextAction({ program }: { program: Program }) {
  const phase = phaseOf(program);
  if (phase === 'accepting') {
    return (
      <ButtonLink to={`/programs/${program.$id}`} size="sm" icon={<ArrowRight size={16} aria-hidden="true" />}>
        View weeks and apply<span className="visually-hidden">: {program.name}</span>
      </ButtonLink>
    );
  }
  return (
    <ButtonLink to={`/programs/${program.$id}`} size="sm" variant="secondary">
      View details<span className="visually-hidden">: {program.name}</span>
    </ButtonLink>
  );
}

function ProgramCard({ program, sessions }: { program: Program; sessions: Session[] }) {
  const s = summarise(sessions);
  const phase = phaseOf(program);
  return (
    <article className="card program-card">
      <div className="program-card__badges">
        <StatusBadge tone={PHASE_TONE[phase]}>{PHASE_LABEL[phase]}</StatusBadge>
        {program.synthetic ? <SyntheticBadge /> : null}
      </div>
      <h2 className="program-card__title">
        <Link to={`/programs/${program.$id}`}>{program.name}</Link>
      </h2>
      {program.description ? <p className="program-card__desc">{program.description}</p> : null}
      <dl className="program-card__stats">
        <div>
          <dt>Weeks</dt>
          <dd>{s.weeks}</dd>
        </div>
        <div>
          <dt>Ages</dt>
          <dd>{s.minAge === null ? '—' : `${s.minAge}–${s.maxAge}`}</dd>
        </div>
        <div>
          <dt>Places</dt>
          <dd>{s.capacity}</dd>
        </div>
      </dl>
      <dl className="program-card__meta">
        <div>
          <dt>
            <CalendarClock size={15} aria-hidden="true" />
            {phase === 'upcoming' ? 'Opens' : 'Deadline'}
          </dt>
          <dd>{formatDateTime(phase === 'upcoming' ? program.window_open : program.window_close, program.timezone)}</dd>
        </div>
        <div>
          <dt>
            <CalendarRange size={15} aria-hidden="true" />
            Dates
          </dt>
          <dd>{s.weeks > 0 && s.firstWeek && s.lastWeek ? `${formatDate(s.firstWeek)} – ${formatDate(s.lastWeek)}` : 'None listed'}</dd>
        </div>
        <div>
          <dt>
            <Layers size={15} aria-hidden="true" />
            Sessions
          </dt>
          <dd>
            {s.sessions} · up to {program.max_weeks} week{program.max_weeks === 1 ? '' : 's'} per child
          </dd>
        </div>
      </dl>
      <div className="program-card__foot">
        <NextAction program={program} />
      </div>
    </article>
  );
}

export function ProgramsPage() {
  const db = useBrowserDb();
  const load = useCallback(async () => {
    if (!db) throw new Error('not configured');
    // Drafts are hidden by row permissions; organisers would see theirs, so filter them here too.
    const programs = await db.listRows('programs', [Query.notEqual('status', 'draft'), Query.orderAsc('window_close'), Query.limit(50)]);
    const ids = programs.rows.map((p) => p.$id);
    const sessions = ids.length ? await db.listRows('seat_ledger', [Query.equal('program_id', ids), Query.limit(1000)]) : { rows: [] };
    return programs.rows.map((p) => ({ program: p, sessions: sessions.rows.filter((s) => s.program_id === p.$id) }));
  }, [db]);
  const state = useAsync(db ? load : null, db);

  return (
    <div className="page">
      <PageHeader eyebrow="Catalogue" title="Programs" description="Community programs that allocate places by lottery. Applying early or late gives the same chance." />
      {!db ? (
        <NotConfiguredBanner what="The catalogue" />
      ) : (
        <AsyncView state={state} loadingLabel="Loading programs…">
          {(list) =>
            list.length === 0 ? (
              <EmptyState icon={ClipboardList} title="No programs published yet">
                When an organiser publishes a program it appears here.
              </EmptyState>
            ) : (
              <div className="program-grid">
                {list.map(({ program, sessions }) => (
                  <ProgramCard key={program.$id} program={program} sessions={sessions} />
                ))}
              </div>
            )
          }
        </AsyncView>
      )}
    </div>
  );
}
