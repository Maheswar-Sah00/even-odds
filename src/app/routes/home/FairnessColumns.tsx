import { Plus } from 'lucide-react';
import { useId, useState } from 'react';

const COLUMNS = [
  {
    title: 'Open window',
    tone: 'cyan',
    body: 'Registration stays open for days, not minutes. Applying in the first minute or the last gives exactly the same chance: the lottery never reads when you applied.',
    figure: ['Day 1', '=', 'Day 7'],
    caption: 'one ticket either way',
  },
  {
    title: 'Siblings together',
    tone: 'green',
    body: 'Choose “together only”, “together preferred” or “independent”. A together-only family is placed as one unit or not at all, so nobody gets one child in and one out.',
    figure: ['2 children', '·', '1 ticket'],
    caption: 'all or nothing, by your choice',
  },
  {
    title: 'Honest odds',
    tone: 'yellow',
    body: 'Banded, hourly estimates of the chance of at least one week, per priority tier, plus demand per place for every session. Never a falsely precise percentage.',
    figure: ['Likely', '→', 'very likely'],
    caption: 'a band, recomputed every hour',
  },
  {
    title: 'Frozen, then drawn',
    tone: 'purple',
    body: 'Inputs are locked and their hash published before the public random number exists. A drand round announced in advance seeds the draw, so nobody can pick a lucky number.',
    figure: ['sha256', '→', 'drand'],
    caption: 'commit first, randomness second',
  },
  {
    title: 'Replay by anyone',
    tone: 'burgundy',
    body: 'Anyone can rerun the draw in their own browser from the published artifacts and get identical placements, or deliberately tamper with a file and watch the check fail.',
    figure: ['Their draw', '=', 'yours'],
    caption: 'recomputed, not trusted',
  },
] as const;

/** Sarvam-style expanding columns: one open panel, the others as vertical spines. */
export function FairnessColumns() {
  const [open, setOpen] = useState(0);
  const id = useId();
  return (
    <div className="fcols">
      {COLUMNS.map((c, n) => {
        const isOpen = n === open;
        const num = String(n + 1).padStart(2, '0');
        return (
          <div key={c.title} className="fcol" data-open={isOpen} data-tone={c.tone}>
            <h3 className="fcol__heading">
              <button
                type="button"
                className="fcol__trigger"
                aria-expanded={isOpen}
                aria-controls={`${id}-${num}`}
                onClick={() => {
                  setOpen(n);
                }}
              >
                <span className="fcol__num mono">{num}</span>
                <span className="fcol__title">{c.title}</span>
                <Plus size={20} strokeWidth={1.5} className="fcol__plus" aria-hidden="true" />
              </button>
            </h3>
            <div className="fcol__panel" id={`${id}-${num}`} hidden={!isOpen}>
              <p className="fcol__body">{c.body}</p>
              <div className="fcol__figure" aria-hidden="true">
                <span>
                  {c.figure[0]} <em>{c.figure[1]}</em> {c.figure[2]}
                </span>
                <small>{c.caption}</small>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
