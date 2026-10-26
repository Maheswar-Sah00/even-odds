import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'success' | 'pending' | 'danger' | 'info' | 'demo';

/** A status label. Colour is never the only signal: the text always states the status. */
export function StatusBadge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

/** Marks synthetic demo data, as required for every demo record. */
export function SyntheticBadge() {
  return (
    <StatusBadge tone="demo">
      <span>Synthetic demo data</span>
    </StatusBadge>
  );
}
