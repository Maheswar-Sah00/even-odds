import { Check, Copy, Database, FlaskConical, Hash, PlayCircle, Radio, Scale, ScrollText, Terminal, type LucideIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { DEMO_PROGRAM } from './constants.ts';
import { pick, useTabKeys } from './useTabKeys.ts';

const SNIPPETS: { key: string; label: string; icon: LucideIcon; what: string; code: string }[] = [
  {
    key: 'seed',
    label: 'TypeScript',
    icon: Hash,
    what: 'the seed',
    code: `import { createHash } from 'node:crypto';

// even-odds-seed-v1: domain-separated, from a verified beacon
const seed = createHash('sha256')
  .update([
    'even-odds-seed-v1', chainHash, round,
    randomness, inputsHash, programId,
  ].join('\\n'))
  .digest('hex');

// must equal draw_runs.seed and the beacon_verified entry`,
  },
  {
    key: 'beacon',
    label: 'cURL',
    icon: Radio,
    what: 'the beacon',
    code: `# Ask drand (quicknet) for the round announced at publish time
curl https://api.drand.sh/\\
52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971\\
/public/$ROUND

# { "round": …, "randomness": "…", "signature": "…" }
# randomness must match draw_runs; the replay checks the BLS signature`,
  },
  {
    key: 'inputs',
    label: 'Shell',
    icon: Terminal,
    what: 'the inputs',
    code: `# Save the program's frozen inputs (canonical JSON), then:
sha256sum frozen-inputs.json

# must equal programs.inputs_hash, draw_runs.inputs_hash
# and the inputs_frozen audit entry, written before
# the drand round existed`,
  },
];

const PRODUCTS: { to: string; icon: LucideIcon; title: string; body: string; tone: string }[] = [
  { to: `/replay/${DEMO_PROGRAM}`, icon: PlayCircle, title: 'Replay', body: 'Rerun the lottery in your browser, step by step', tone: 'burgundy' },
  { to: `/audit/${DEMO_PROGRAM}`, icon: ScrollText, title: 'Audit log', body: 'A hash-chained record of every decision', tone: 'purple' },
  { to: `/fairness/${DEMO_PROGRAM}`, icon: Scale, title: 'Fairness', body: 'Outcomes by tier, mode and timing, as a report card', tone: 'green' },
  { to: '/demo', icon: FlaskConical, title: 'Judge demo', body: 'A private sandbox, seeded and ready in one click', tone: 'cyan' },
];

const SMALL = [
  { icon: Database, title: 'TablesDB', body: 'Transactions, unique indexes and capped seat counters', tone: 'green' },
  { icon: Radio, title: 'drand', body: 'Public randomness that nobody, including us, controls', tone: 'yellow' },
  { icon: Hash, title: 'Canonical JSON', body: 'Byte-exact files, so a hash means one thing', tone: 'burgundy' },
] as const;

export function VerifySection() {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const id = useId();
  const { refs, onKeyDown } = useTabKeys(SNIPPETS.length, active, (i) => {
    setActive(i);
    setCopied(false);
  });
  const s = pick(SNIPPETS, active);

  const copy = () => {
    void navigator.clipboard
      .writeText(s.code)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => {
          setCopied(false);
        }, 1600);
      })
      .catch(() => {
        /* clipboard blocked: nothing to do */
      });
  };

  return (
    <div className="verify">
      <div className="verify__code-card">
        <h2 className="display-2">
          Check <span className="verify__accent">{s.what}</span>
          <br />
          yourself, in minutes
        </h2>
        <div className="codebox">
          <div className="codebox__bar">
            <div role="tablist" aria-label="Verification snippets" className="codebox__tabs" onKeyDown={onKeyDown}>
              {SNIPPETS.map(({ key, label, icon: Icon }, n) => (
                <button
                  key={key}
                  ref={(el) => {
                    refs.current[n] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`${id}-${key}`}
                  aria-selected={n === active}
                  aria-controls={`${id}-code`}
                  tabIndex={n === active ? 0 : -1}
                  className="codebox__tab"
                  onClick={() => {
                    setActive(n);
                    setCopied(false);
                  }}
                >
                  <Icon size={15} aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
            <button type="button" className="codebox__copy" onClick={copy}>
              {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
              <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <pre className="codebox__pre" role="tabpanel" id={`${id}-code`} aria-labelledby={`${id}-${s.key}`} tabIndex={0}>
            <code>{s.code}</code>
          </pre>
        </div>
        <Link to={`/replay/${DEMO_PROGRAM}`} className="btn btn--primary btn--lg btn--block">
          Open the in-browser replay
        </Link>
      </div>

      <div className="verify__grid">
        {PRODUCTS.map(({ to, icon: Icon, title, body, tone }) => (
          <Link key={title} to={to} className="vcard" data-tone={tone}>
            <span className="vcard__blob" aria-hidden="true" />
            <Icon size={28} strokeWidth={1.5} className="vcard__icon" aria-hidden="true" />
            <span className="vcard__title">{title}</span>
            <span className="vcard__body">{body}</span>
          </Link>
        ))}
        <div className="verify__small">
          {SMALL.map(({ icon: Icon, title, body, tone }) => (
            <div key={title} className="vsmall" data-tone={tone}>
              <Icon size={18} strokeWidth={1.6} className="vsmall__icon" aria-hidden="true" />
              <span className="vsmall__title">{title}</span>
              <span className="vsmall__body">{body}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
