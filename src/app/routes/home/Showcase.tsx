import {
  Check,
  ClipboardList,
  Gauge,
  Inbox,
  Loader,
  Lock,
  MapPin,
  Plus,
  ShieldCheck,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Ornament } from './Ornament.tsx';
import { pick, useTabKeys } from './useTabKeys.ts';

/* ---------- Apply ---------- */

const APPLY_SCENARIOS = [
  {
    chip: 'Rank weeks',
    prompt: 'Week 3 first, then Week 1, then Week 5',
    using: [{ icon: ClipboardList, label: '3 ranked weeks' }],
    steps: [
      { label: 'Checked each child’s age against every week', state: 'done' },
      { label: 'Saving ranked choices in one transaction', state: 'busy' },
      { label: 'Issuing your receipt code', state: 'todo', tag: 'EO-7K2Q' },
    ],
  },
  {
    chip: 'Siblings',
    prompt: 'Place Asha and Kiran together, or not at all',
    using: [{ icon: Users, label: 'Together only' }],
    steps: [
      { label: 'Linked two children as one ticket', state: 'done' },
      { label: 'Draw seats both or neither, never one', state: 'busy' },
      { label: '“Together preferred” and “independent” work too', state: 'todo', tag: 'sibling mode' },
    ],
  },
  {
    chip: 'Priority zone',
    prompt: 'We live inside the Riverside priority area',
    using: [{ icon: MapPin, label: 'Home pin' }],
    steps: [
      { label: 'Pinned your home on the organiser’s map', state: 'done' },
      { label: 'Server computes your tier from the stored point', state: 'busy' },
      { label: 'Tier 1 applied before the draw order', state: 'todo', tag: 'priority' },
    ],
  },
  {
    chip: 'One child, once',
    prompt: 'Apply for Mira (already in another household?)',
    using: [{ icon: ShieldCheck, label: 'Duplicate check' }],
    steps: [
      { label: 'Keyed hash of the child’s identity', state: 'done' },
      { label: 'Unique index refuses a second application', state: 'busy' },
      { label: 'One child, one ticket, everywhere', state: 'todo', tag: 'TablesDB' },
    ],
  },
] as const;

function StepIcon({ state }: { state: string }) {
  if (state === 'done') return <Check size={16} className="sc-step__icon sc-step__icon--done" aria-hidden="true" />;
  if (state === 'busy') return <Loader size={16} className="sc-step__icon sc-step__icon--busy" aria-hidden="true" />;
  return <Sparkles size={16} className="sc-step__icon" aria-hidden="true" />;
}

function ApplyPanel() {
  const [i, setI] = useState(0);
  const s = pick(APPLY_SCENARIOS, i);
  return (
    <div className="sc-apply">
      <Ornament className="sc-apply__ornament" />
      <div className="sc-chips" role="group" aria-label="Application examples">
        {APPLY_SCENARIOS.map((x, n) => (
          <button
            key={x.chip}
            type="button"
            className="sc-chip"
            aria-pressed={n === i}
            onClick={() => {
              setI(n);
            }}
          >
            {x.chip}
          </button>
        ))}
      </div>
      <div className="sc-composer" key={s.chip}>
        <div className="sc-composer__box">
          <p className="sc-composer__prompt">{s.prompt}</p>
          <div className="sc-composer__meta">
            <Plus size={18} aria-hidden="true" />
            <span className="muted">Using</span>
            {s.using.map(({ icon: Icon, label }) => (
              <span key={label} className="sc-pill">
                <Icon size={14} aria-hidden="true" /> {label}
              </span>
            ))}
            <span className="sc-pill">
              <ClipboardList size={14} aria-hidden="true" /> Summer camp 2027
            </span>
          </div>
        </div>
        <ul className="sc-steps">
          {s.steps.map((st, n) => (
            <li key={st.label} className="sc-step" style={{ animationDelay: `${String(120 + n * 160)}ms` }}>
              <StepIcon state={st.state} />
              <span className={st.state === 'todo' ? 'muted' : undefined}>{st.label}</span>
              {'tag' in st ? <span className="sc-tag">{st.tag}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ---------- Honest odds ---------- */

const TIERS = [
  { name: 'Tier 1 · in zone', band: 'Likely to very likely', fill: 0.84 },
  { name: 'Tier 2 · nearby', band: 'About even', fill: 0.52 },
  { name: 'Open · everyone else', band: 'Unlikely', fill: 0.3 },
] as const;

const DEMAND = [
  ['Week 1', 1.3],
  ['Week 3', 2.4],
  ['Week 5', 0.8],
] as const;

function OddsPanel() {
  const [t, setT] = useState(0);
  const tier = pick(TIERS, t);
  return (
    <div className="sc-three">
      <div className="sc-col">
        <p className="sc-col__title">Choose a priority tier</p>
        <ul className="sc-list" role="list">
          {TIERS.map((x, n) => (
            <li key={x.name}>
              <button
                type="button"
                className="sc-list__item"
                aria-pressed={n === t}
                onClick={() => {
                  setT(n);
                }}
              >
                <Gauge size={18} aria-hidden="true" />
                {x.name}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="sc-col sc-col--stage">
        <p className="sc-stage__title">{tier.name}</p>
        <div className="sc-orb" style={{ ['--fill' as string]: tier.fill }}>
          <span className="sc-orb__band" key={tier.band}>
            {tier.band}
          </span>
        </div>
        <p className="sc-stage__note">Chance of at least one requested week. A band, never a precise percentage.</p>
      </div>
      <div className="sc-col">
        <div className="sc-col__head">
          <p className="sc-col__title">Demand per place</p>
          <span className="sc-tag">updated hourly</span>
        </div>
        <ul className="sc-bars">
          {DEMAND.map(([week, ratio]) => (
            <li key={week}>
              <span>{week}</span>
              <span className="sc-bars__track">
                <span className="sc-bars__fill" style={{ width: `${String(Math.min(100, (ratio / 2.6) * 100))}%` }} />
              </span>
              <span className="mono">{ratio.toFixed(1)}×</span>
            </li>
          ))}
        </ul>
        <div className="sc-bubble sc-bubble--them">Does ranking Week 3 first hurt my chances?</div>
        <div className="sc-bubble">No. Ranking your true favourite first never costs you a round-one place.</div>
      </div>
    </div>
  );
}

/* ---------- Freeze & draw ---------- */

const DRAW_STEPS = [
  ['Window closes', 'Fri 18:00 · no edits after this'],
  ['Inputs frozen', 'sha256 9f2c…e41a published'],
  ['Round announced in advance', 'drand quicknet #12 345 678'],
  ['Beacon verified', 'BLS signature checked'],
  ['Seed derived', 'even-odds-seed-v1'],
  ['Lottery computed', 'plan hash 4be1…07c3'],
] as const;

function DrawPanel() {
  return (
    <div className="sc-two">
      <ol className="sc-timeline">
        {DRAW_STEPS.map(([title, detail], n) => (
          <li key={title} style={{ animationDelay: `${String(n * 220)}ms` }}>
            <span className="sc-timeline__dot" aria-hidden="true" />
            <strong>{title}</strong>
            <span className="muted mono">{detail}</span>
          </li>
        ))}
      </ol>
      <div className="sc-code" aria-label="Excerpt of frozen inputs (illustrative)">
        <div className="sc-code__bar">
          <Lock size={14} aria-hidden="true" /> frozen-inputs.json <span className="sc-tag">excerpt, formatted</span>
        </div>
        <pre tabIndex={0}>
          <code>
            {`{"applications":[
  {"children":[{"ageGroups":["8-10"],
     "rankedWeeks":["w3","w1","w5"],
     "ref":"c1","requested":2}, …],
   "late":false,"publicId":"A-1F9",
   "siblingMode":"together_only","tier":1},
  …],
 "sessions":[{"ageGroup":"8-10",
   "capacity":24,"week":"w3"}, …]}`}
          </code>
        </pre>
        <p className="sc-code__hash">
          <span className="muted">sha256</span> <span className="mono">9f2c51d0…a77be41a</span>
        </p>
      </div>
    </div>
  );
}

/* ---------- Offers ---------- */

function OffersPanel() {
  return (
    <div className="sc-three">
      <div className="sc-col">
        <p className="sc-col__title">Offer lifecycle</p>
        <ul className="sc-lifecycle">
          <li data-state="done">Seat offered</li>
          <li data-state="done">Family replies within 48 h</li>
          <li data-state="now">Declined or expired seats reopen</li>
          <li>Next on the waitlist is offered, in lottery order</li>
        </ul>
      </div>
      <div className="sc-col sc-col--stage">
        <p className="sc-stage__title">Reply window</p>
        <div className="sc-clock" aria-label="47 hours 59 minutes left (illustrative)">
          <span>47</span>:<span>59</span>
        </div>
        <p className="sc-stage__note">48 hours to accept or decline. Unanswered offers pass to the waitlist.</p>
      </div>
      <div className="sc-col">
        <div className="sc-col__head">
          <p className="sc-col__title">Illustrative messages</p>
          <span className="sc-tag">
            <Inbox size={12} aria-hidden="true" /> Family A-1F9
          </span>
        </div>
        <div className="sc-bubble">Seat offered: Week 3, ages 8–10. Please reply within 48 hours.</div>
        <div className="sc-bubble sc-bubble--them">Accept. Can we keep Week 1 on the waitlist?</div>
        <div className="sc-bubble">Done. You are #2 on the Week 1 waitlist, in lottery order.</div>
      </div>
    </div>
  );
}

/* ---------- Replay ---------- */

const REPLAY_CHECKS = [
  'Audit log integrity',
  'Round announced in advance',
  'Frozen public inputs',
  'Canonical inputs hash',
  'Application order',
  'Frozen before the round existed',
  'drand beacon (BLS)',
  'Draw seed',
  'Lottery replayed',
] as const;

function ReplayPanel() {
  return (
    <div className="sc-two">
      <ol className="sc-checks">
        {REPLAY_CHECKS.map((c, n) => (
          <li key={c} style={{ animationDelay: `${String(n * 140)}ms` }}>
            <span className="sc-checks__n mono">{String(n + 1).padStart(2, '0')}</span>
            {c}
            <span className="sc-checks__ok">
              <Check size={14} aria-hidden="true" /> pass
            </span>
          </li>
        ))}
      </ol>
      <div className="sc-verdict">
        <ShieldCheck size={40} strokeWidth={1.4} aria-hidden="true" />
        <p className="sc-verdict__title">Identical placements</p>
        <p className="muted">
          Your browser fetched the beacon from drand, recomputed every hash and reran the lottery. Nothing was taken on the server’s word.
        </p>
        <p className="sc-code__hash">
          <span className="muted">plan hash</span> <span className="mono">4be1…07c3 = 4be1…07c3</span>
        </p>
      </div>
    </div>
  );
}

/* ---------- Showcase ---------- */

const TABS: { key: string; label: string; icon: LucideIcon; panel: () => ReactNode }[] = [
  { key: 'apply', label: 'Apply', icon: ClipboardList, panel: () => <ApplyPanel /> },
  { key: 'odds', label: 'Honest odds', icon: Gauge, panel: () => <OddsPanel /> },
  { key: 'draw', label: 'Freeze & draw', icon: Lock, panel: () => <DrawPanel /> },
  { key: 'offers', label: 'Offers', icon: Inbox, panel: () => <OffersPanel /> },
  { key: 'replay', label: 'Replay', icon: ShieldCheck, panel: () => <ReplayPanel /> },
];

export function Showcase() {
  const [active, setActive] = useState(0);
  const id = useId();
  const { refs, onKeyDown } = useTabKeys(TABS.length, active, setActive);
  const tab = pick(TABS, active);
  return (
    <div className="showcase">
      <div className="showcase__tabs" role="tablist" aria-label="Product tour" onKeyDown={onKeyDown}>
        {TABS.map(({ key, label, icon: Icon }, n) => (
          <button
            key={key}
            ref={(el) => {
              refs.current[n] = el;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${key}`}
            aria-selected={n === active}
            aria-controls={`${id}-panel`}
            tabIndex={n === active ? 0 : -1}
            className="showcase__tab"
            onClick={() => {
              setActive(n);
            }}
          >
            <Icon size={20} strokeWidth={1.6} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="showcase__panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab.key}`} key={tab.key}>
        {tab.panel()}
        <p className="showcase__note">Illustrative example with synthetic data.</p>
      </div>
    </div>
  );
}
