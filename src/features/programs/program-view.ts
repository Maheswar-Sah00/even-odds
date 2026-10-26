import type { BrowserRow } from '../../lib/appwrite/db.ts';

export type Program = BrowserRow<'programs'>;
export type Session = BrowserRow<'seat_ledger'>;

export type Phase = 'draft' | 'upcoming' | 'accepting' | 'closed';

/** Where a program is in its registration lifecycle, from server-set status and window times. */
export function phaseOf(p: Pick<Program, 'status' | 'window_open' | 'window_close'>, now = Date.now()): Phase {
  if (p.status === 'draft') return 'draft';
  if (p.status !== 'open') return 'closed';
  if (now < Date.parse(p.window_open)) return 'upcoming';
  if (now > Date.parse(p.window_close)) return 'closed';
  return 'accepting';
}

export const PHASE_LABEL: Record<Phase, string> = {
  draft: 'Draft (not published)',
  upcoming: 'Opens soon',
  accepting: 'Accepting applications',
  closed: 'Applications closed',
};

export const PHASE_TONE = { draft: 'neutral', upcoming: 'info', accepting: 'success', closed: 'neutral' } as const;

export interface SessionSummary {
  sessions: number;
  weeks: number;
  minAge: number | null;
  maxAge: number | null;
  capacity: number;
  firstWeek: string | null;
  lastWeek: string | null;
}

export function summarise(sessions: readonly Session[]): SessionSummary {
  const starts = sessions.map((s) => s.week_start).sort();
  return {
    sessions: sessions.length,
    weeks: new Set(sessions.map((s) => s.week)).size,
    minAge: sessions.length ? Math.min(...sessions.map((s) => s.min_age)) : null,
    maxAge: sessions.length ? Math.max(...sessions.map((s) => s.max_age)) : null,
    capacity: sessions.reduce((n, s) => n + s.capacity, 0),
    firstWeek: starts[0] ?? null,
    lastWeek: starts[starts.length - 1] ?? null,
  };
}

export function tierLabelsOf(p: Pick<Program, 'tier_labels'>): Record<string, string> {
  try {
    return JSON.parse(p.tier_labels ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/** Groups sessions by week, weeks in date order, age groups by minimum age. */
export function byWeek(sessions: readonly Session[]): { week: string; weekStart: string; label: string | null; sessions: Session[] }[] {
  const map = new Map<string, Session[]>();
  for (const s of sessions) map.set(s.week, [...(map.get(s.week) ?? []), s]);
  return [...map.entries()]
    .map(([week, list]) => ({ week, weekStart: list[0]?.week_start ?? '', label: list[0]?.label ?? null, sessions: [...list].sort((a, b) => a.min_age - b.min_age) }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}
