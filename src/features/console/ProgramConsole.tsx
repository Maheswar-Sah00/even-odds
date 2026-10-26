import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Card, DataTable } from '../../components/ui/index.ts';
import type { BrowserAppwrite } from '../../lib/appwrite/client.ts';
import type { BrowserRow } from '../../lib/appwrite/db.ts';
import { OffersSection } from '../organiser/OffersSection.tsx';
import { SessionsSection } from '../organiser/SessionsSection.tsx';
import { ZonesSection } from '../organiser/ZonesSection.tsx';
import { tierLabelsOf, type Program, type Session } from '../programs/program-view.ts';
import { FairnessCard, StaffLogCard } from './AuditSection.tsx';
import type { ConsoleApi } from './console-api.ts';
import { DemandSection } from './DemandSection.tsx';
import { DrawSection } from './DrawSection.tsx';
import { OverridesSection } from './OverridesSection.tsx';
import { VerificationSection } from './VerificationSection.tsx';

const CONSOLE_TABS = [
  { id: 'setup', label: 'Program & sessions' },
  { id: 'zones', label: 'Zones & tiers' },
  { id: 'demand', label: 'Demand' },
  { id: 'verification', label: 'Verification' },
  { id: 'overrides', label: 'Overrides' },
  { id: 'draw', label: 'Freeze & draw' },
  { id: 'offers', label: 'Offers & waitlists' },
  { id: 'audit', label: 'Audit & fairness' },
] as const;
export type ConsoleTab = (typeof CONSOLE_TABS)[number]['id'];

interface ProgramConsoleProps {
  app: BrowserAppwrite;
  api: ConsoleApi;
  program: Program;
  sessions: Session[];
  zones: BrowserRow<'zones'>[];
  onChanged: () => void;
  /** Bumped when something outside the console (e.g. a demo control) changed the data. */
  refreshKey?: string | number;
  /** Production-only cards shown at the top of the setup tab (publish, program details). */
  setup?: ReactNode;
  defaultTab?: ConsoleTab;
}

/**
 * The organiser control centre: one tabbed console for production programs
 * and for the judge sandbox. Every action goes through `api`, so the same
 * screens drive both, and the server decides what each caller may do.
 */
export function ProgramConsole({ app, api, program, sessions, zones, onChanged, refreshKey, setup, defaultTab = 'setup' }: ProgramConsoleProps) {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: ConsoleTab = CONSOLE_TABS.some((t) => t.id === requested) ? (requested as ConsoleTab) : defaultTab;
  const base = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const select = (id: ConsoleTab) => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set('tab', id);
      return next;
    }, { replace: true });
  };
  const onKey = (e: KeyboardEvent) => {
    const i = CONSOLE_TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? CONSOLE_TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const t = CONSOLE_TABS[(next + CONSOLE_TABS.length) % CONSOLE_TABS.length];
    if (!t) return;
    select(t.id);
    refs.current.get(t.id)?.focus();
  };
  const key = `${String(refreshKey ?? '')}:${program.$updatedAt}`;
  const labels = tierLabelsOf(program);

  return (
    <div className="stack">
      <div className="tabs" role="tablist" aria-label="Organiser console sections" onKeyDown={onKey}>
        {CONSOLE_TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el);
            }}
            type="button"
            role="tab"
            id={`${base}-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${base}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            className={tab === t.id ? 'active' : undefined}
            onClick={() => { select(t.id); }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-${tab}`} className="stack">
        {tab === 'setup' ? (
          <>
            {setup}
            <SessionsSection app={app} api={api} program={program} sessions={sessions} onChanged={onChanged} />
          </>
        ) : null}
        {tab === 'zones' ? (
          <>
            <Card title="Eligibility tiers" description="Lower tiers draw first. Homes outside every zone get the default tier.">
              <DataTable<{ tier: string; label: string }>
                caption="Tiers"
                hideCaption
                rows={Object.entries(labels).sort(([a], [b]) => Number(a) - Number(b)).map(([tier, label]) => ({ tier, label }))}
                rowKey={(r) => r.tier}
                columns={[
                  { key: 't', header: 'Tier', render: (r) => r.tier },
                  { key: 'l', header: 'Label', render: (r) => r.label },
                  { key: 'd', header: '', render: (r) => (String(program.default_tier ?? '') === r.tier ? 'Default (outside every zone)' : '') },
                ]}
              />
            </Card>
            <ZonesSection key={`${program.$id}:${zones.map((z) => z.$updatedAt).join()}`} app={app} program={program} saved={zones} onChanged={onChanged} classify={api.classifyPoint} />
          </>
        ) : null}
        {tab === 'demand' ? <DemandSection api={api} refreshKey={key} /> : null}
        {tab === 'verification' ? <VerificationSection api={api} refreshKey={key} onChanged={onChanged} /> : null}
        {tab === 'overrides' ? <OverridesSection api={api} timezone={program.timezone} refreshKey={key} onChanged={onChanged} /> : null}
        {tab === 'draw' ? <DrawSection api={api} program={program} refreshKey={key} onChanged={onChanged} /> : null}
        {tab === 'offers' ? (
          program.status === 'drawn' || program.status === 'closed' ? (
            <OffersSection api={api} program={program} refreshKey={key} />
          ) : (
            <Card title="Offers and waitlist"><p className="muted">Offers and waitlists exist after the draw.</p></Card>
          )
        ) : null}
        {tab === 'audit' ? (
          <>
            <StaffLogCard api={api} program={program} refreshKey={key} />
            <FairnessCard api={api} program={program} refreshKey={key} />
          </>
        ) : null}
      </div>
    </div>
  );
}
