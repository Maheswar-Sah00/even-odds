/**
 * Formats an ISO datetime in the program's timezone, with the zone shown.
 * Note: Intl rejects dateStyle/timeStyle combined with timeZoneName
 * ("Invalid option"), so explicit fields are used.
 */
export function formatDateTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

export function formatDate(iso: string, timeZone = 'UTC'): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone }).format(new Date(iso));
}

export const PROGRAM_STATUS_LABEL = {
  draft: 'Draft',
  open: 'Accepting applications',
  frozen: 'Applications closed',
  drawn: 'Draw complete',
  closed: 'Closed',
} as const;

export const PROGRAM_STATUS_TONE = {
  draft: 'neutral',
  open: 'success',
  frozen: 'pending',
  drawn: 'info',
  closed: 'neutral',
} as const;

/** "1 day 3 hours", "45 minutes", "under a minute"; for countdowns to a server-set deadline. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return 'no time';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const part = (n: number, unit: string) => `${String(n)} ${unit}${n === 1 ? '' : 's'}`;
  if (days > 0) return hours > 0 ? `${part(days, 'day')} ${part(hours, 'hour')}` : part(days, 'day');
  if (hours > 0) return mins > 0 ? `${part(hours, 'hour')} ${part(mins, 'minute')}` : part(hours, 'hour');
  return part(mins, 'minute');
}
