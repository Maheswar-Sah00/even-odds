import { z } from 'zod';
import { parseCsv } from './csv.ts';
import { closeRing, isValidLngLat, type LngLat, type Polygon } from './geo.ts';

/**
 * Organiser configuration validation, shared by the browser (instant preview)
 * and the organiser Function (authoritative).
 */

const isoDateTime = (label: string) =>
  z.string({ error: `${label} is required` }).refine((v) => !Number.isNaN(Date.parse(v)), `${label} must be a valid date and time`);

const tierLabelsSchema = z
  .record(z.string().regex(/^[0-9]$/, 'Tier keys are 0-9'), z.string().trim().min(1).max(60))
  .refine((r) => Object.keys(r).length <= 10, 'At most 10 tiers');

export const programDetailsSchema = z
  .object({
    name: z.string().trim().min(3, 'Name must be at least 3 characters').max(128),
    description: z.string().trim().max(2000, 'Description must be 2000 characters or fewer').default(''),
    timezone: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Choose a valid timezone, e.g. America/New_York'),
    windowOpen: isoDateTime('Opening time'),
    windowClose: isoDateTime('Closing time'),
    maxWeeks: z.number().int().min(1, 'At least 1 week').max(12, 'At most 12 weeks'),
    defaultTier: z.number().int().min(0).max(9),
    tierLabels: tierLabelsSchema,
  })
  .refine((p) => Date.parse(p.windowClose) > Date.parse(p.windowOpen), { path: ['windowClose'], error: 'Applications must close after they open' })
  .refine((p) => Date.parse(p.windowClose) - Date.parse(p.windowOpen) >= 24 * 3600_000, {
    path: ['windowClose'],
    error: 'Keep the window open for at least 24 hours (odds freeze 24 hours before close)',
  })
  .refine((p) => String(p.defaultTier) in p.tierLabels, { path: ['defaultTier'], error: 'The default tier needs a label' });

export type ProgramDetails = z.infer<typeof programDetailsSchema>;

// ---- Sessions CSV ------------------------------------------------------------

export const SESSION_CSV_HEADERS = ['week', 'week_start', 'age_group', 'min_age', 'max_age', 'capacity'] as const;
export const SESSION_CSV_OPTIONAL = ['label'] as const;

export interface SessionRow {
  week: string;
  weekStart: string; // YYYY-MM-DD
  ageGroup: string;
  minAge: number;
  maxAge: number;
  capacity: number;
  label: string | null;
}

export interface RowIssue {
  line: number;
  column?: string;
  message: string;
}

export interface SessionImport {
  sessions: SessionRow[];
  errors: RowIssue[];
  warnings: RowIssue[];
  summary: { sessions: number; weeks: number; ageGroups: number; totalCapacity: number };
}

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function realDate(v: string): boolean {
  if (!DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
}

const intIn = (v: string, min: number, max: number) => (/^\d+$/.test(v.trim()) ? Number(v) >= min && Number(v) <= max : false);

/** Parses and validates a sessions CSV. Nothing is written; callers show the result first. */
export function parseSessionsCsv(text: string, maxRows = 500): SessionImport {
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const sessions: SessionRow[] = [];
  const empty = (): SessionImport => ({ sessions: [], errors, warnings, summary: { sessions: 0, weeks: 0, ageGroups: 0, totalCapacity: 0 } });

  const { rows, error } = parseCsv(text);
  if (error) {
    errors.push({ line: 0, message: error });
    return empty();
  }
  const [header, ...body] = rows;
  if (!header) {
    errors.push({ line: 1, message: 'The file is empty.' });
    return empty();
  }
  const cols = header.cells.map((c) => c.trim().toLowerCase());
  const missing = SESSION_CSV_HEADERS.filter((h) => !cols.includes(h));
  const unknown = cols.filter((c) => !(SESSION_CSV_HEADERS as readonly string[]).includes(c) && !(SESSION_CSV_OPTIONAL as readonly string[]).includes(c));
  const dupes = cols.filter((c, i) => cols.indexOf(c) !== i);
  if (missing.length) errors.push({ line: header.line, message: `Missing column(s): ${missing.join(', ')}. Required: ${SESSION_CSV_HEADERS.join(', ')}.` });
  if (unknown.length) errors.push({ line: header.line, message: `Unknown column(s): ${unknown.join(', ')}.` });
  if (dupes.length) errors.push({ line: header.line, message: `Duplicate column(s): ${[...new Set(dupes)].join(', ')}.` });
  if (errors.length) return empty();
  if (body.length === 0) errors.push({ line: header.line + 1, message: 'No sessions found below the header row.' });
  if (body.length > maxRows) {
    errors.push({ line: 0, message: `At most ${maxRows} sessions per import (found ${body.length}).` });
    return empty();
  }

  const at = (cells: string[], name: string) => (cells[cols.indexOf(name)] ?? '').trim();
  const seen = new Map<string, number>();
  const weekStarts = new Map<string, string>();

  for (const row of body) {
    const issues: RowIssue[] = [];
    const add = (column: string, message: string) => issues.push({ line: row.line, column, message });
    if (row.cells.length !== cols.length) add('', `Expected ${cols.length} values, found ${row.cells.length}.`);
    const week = at(row.cells, 'week');
    const weekStart = at(row.cells, 'week_start');
    const ageGroup = at(row.cells, 'age_group');
    const minAge = at(row.cells, 'min_age');
    const maxAge = at(row.cells, 'max_age');
    const capacity = at(row.cells, 'capacity');
    const label = cols.includes('label') ? at(row.cells, 'label') : '';

    if (!CODE.test(week)) add('week', 'Week code must be 1-16 letters, digits, ".", "-" or "_" (e.g. 2027-W26).');
    if (!realDate(weekStart)) add('week_start', 'Week start must be a real date as YYYY-MM-DD.');
    if (!CODE.test(ageGroup)) add('age_group', 'Age group must be 1-16 letters, digits, ".", "-" or "_" (e.g. 6-8).');
    if (!intIn(minAge, 0, 25)) add('min_age', 'Minimum age must be a whole number from 0 to 25.');
    if (!intIn(maxAge, 0, 25)) add('max_age', 'Maximum age must be a whole number from 0 to 25.');
    if (intIn(minAge, 0, 25) && intIn(maxAge, 0, 25) && Number(minAge) > Number(maxAge)) add('max_age', 'Maximum age must be at least the minimum age.');
    if (!intIn(capacity, 0, 10000)) add('capacity', 'Capacity must be a whole number from 0 to 10000.');
    if (label.length > 64) add('label', 'Label must be 64 characters or fewer.');
    // Spreadsheet formula prefixes (CSV injection): labels are shown publicly and may be exported later.
    if (/^[=+\-@\t\r]/.test(label)) add('label', 'Label cannot start with =, +, -, @ or a tab.');

    const key = `${week}\u0000${ageGroup}`;
    if (seen.has(key)) add('age_group', `Duplicate session: week ${week}, age group ${ageGroup} is already on line ${String(seen.get(key))}.`);
    else seen.set(key, row.line);
    if (realDate(weekStart) && CODE.test(week)) {
      const prior = weekStarts.get(week);
      if (prior && prior !== weekStart) add('week_start', `Week ${week} has a different start date (${prior}) on another line.`);
      weekStarts.set(week, weekStart);
    }

    if (issues.length) {
      errors.push(...issues);
      continue;
    }
    if (Number(capacity) === 0) warnings.push({ line: row.line, column: 'capacity', message: 'Capacity is 0: nobody can be placed in this session.' });
    sessions.push({ week, weekStart, ageGroup, minAge: Number(minAge), maxAge: Number(maxAge), capacity: Number(capacity), label: label || null });
  }

  // Overlapping age groups within one week make a child eligible for two sessions.
  const byWeek = new Map<string, SessionRow[]>();
  for (const s of sessions) byWeek.set(s.week, [...(byWeek.get(s.week) ?? []), s]);
  for (const [week, list] of byWeek) {
    const sorted = [...list].sort((a, b) => a.minAge - b.minAge);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev && cur && cur.minAge <= prev.maxAge) {
        warnings.push({ line: 0, message: `Week ${week}: age groups ${prev.ageGroup} and ${cur.ageGroup} overlap (a child could fit both).` });
      }
    }
  }

  return {
    sessions: errors.length ? [] : sessions,
    errors,
    warnings,
    summary: {
      sessions: sessions.length,
      weeks: new Set(sessions.map((s) => s.week)).size,
      ageGroups: new Set(sessions.map((s) => s.ageGroup)).size,
      totalCapacity: sessions.reduce((n, s) => n + s.capacity, 0),
    },
  };
}

// ---- Zones (GeoJSON) ---------------------------------------------------------

export interface ZoneInput {
  name: string;
  tier: number;
  area: Polygon;
}

const lngLat = z.tuple([z.number(), z.number()]).refine((p) => isValidLngLat(p), 'Coordinates must be [longitude, latitude] within range');

export const zoneInputSchema = z.object({
  name: z.string().trim().min(1, 'Zone name is required').max(64),
  tier: z.number().int().min(0).max(9),
  area: z
    .array(z.array(lngLat).min(3, 'A ring needs at least 3 points'))
    .min(1, 'A polygon needs at least one ring')
    .max(10)
    .transform((rings) => rings.map((r) => closeRing(r as LngLat[])))
    .refine((rings) => rings.every((r) => r.length >= 4), 'A closed ring needs at least 3 distinct points'),
});

/**
 * Accepts a GeoJSON FeatureCollection (or a single Feature) of Polygons.
 * GeoJSON positions are [longitude, latitude], the same order as TablesDB.
 * Feature properties: name (string) and tier (0-9).
 */
export function parseZonesGeoJson(text: string): { zones: ZoneInput[]; errors: string[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { zones: [], errors: ['The file is not valid JSON.'] };
  }
  // Hostile or malformed files (null, arrays, non-array "features", null features) are reported, never thrown (Task 14).
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const d = isObject(doc) ? (doc as { type?: unknown; features?: unknown }) : {};
  const features = d.type === 'FeatureCollection' ? (Array.isArray(d.features) ? (d.features as unknown[]) : null) : d.type === 'Feature' ? [doc] : null;
  if (!features) return { zones: [], errors: ['Expected a GeoJSON FeatureCollection or Feature.'] };
  const zones: ZoneInput[] = [];
  const errors: string[] = [];
  features.forEach((f, i) => {
    const feat = (isObject(f) ? f : {}) as { geometry?: { type?: string; coordinates?: unknown } | null; properties?: { name?: unknown; tier?: unknown } | null };
    if (!isObject(feat.geometry) || feat.geometry.type !== 'Polygon') {
      errors.push(`Feature ${i + 1}: only Polygon geometries are supported (found ${(isObject(feat.geometry) && feat.geometry.type) || 'none'}).`);
      return;
    }
    const parsed = zoneInputSchema.safeParse({ name: feat.properties?.name ?? `Zone ${i + 1}`, tier: Number(feat.properties?.tier), area: feat.geometry.coordinates });
    if (!parsed.success) errors.push(`Feature ${i + 1}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    else zones.push(parsed.data);
  });
  if (features.length === 0) errors.push('The file has no features.');
  return { zones, errors };
}

// ---- Organiser Function requests --------------------------------------------

const id36 = z.string().min(1).max(36);

export const organiserRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('createProgram'), details: programDetailsSchema }),
  z.object({ action: z.literal('updateProgram'), programId: id36, details: programDetailsSchema }),
  z.object({ action: z.literal('importSessions'), programId: id36, csv: z.string().max(200_000), commit: z.boolean() }),
  z.object({ action: z.literal('setCapacity'), programId: id36, ledgerId: id36, capacity: z.number().int() }),
  z.object({ action: z.literal('saveZones'), programId: id36, zones: z.array(zoneInputSchema).max(50) }),
  z.object({ action: z.literal('checkPublish'), programId: id36 }),
  z.object({ action: z.literal('publish'), programId: id36 }),
  z.object({ action: z.literal('freeze'), programId: id36 }),
  z.object({ action: z.literal('classifyPoint'), programId: id36, point: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]) }),
]);

export type OrganiserRequest = z.input<typeof organiserRequestSchema>;
