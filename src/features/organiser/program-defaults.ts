import type { ProgramDetails } from '@shared/program-input.ts';

/** Sensible starting values for a new program: opens tomorrow, two-week window. */
export function emptyDetails(): ProgramDetails {
  const open = new Date(Date.now() + 86400_000);
  open.setMinutes(0, 0, 0);
  return {
    name: '',
    description: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    windowOpen: open.toISOString(),
    windowClose: new Date(open.getTime() + 14 * 86400_000).toISOString(),
    maxWeeks: 2,
    defaultTier: 1,
    tierLabels: { '0': 'Priority zone residents', '1': 'Everyone else' },
  };
}
