// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../shared/csv.ts';
import { classify, closeRing, distanceToEdgeM, fromLeaflet, haversineM, pointInPolygon, toLeaflet, type LngLat, type Polygon } from '../../shared/geo.ts';
import { parseSessionsCsv, parseZonesGeoJson, programDetailsSchema } from '../../shared/program-input.ts';

const HEADER = 'week,week_start,age_group,min_age,max_age,capacity';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded commas/newlines, CRLF and a BOM', () => {
    const { rows, error } = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"multi\nline",z\n');
    expect(error).toBeNull();
    expect(rows.map((r) => r.cells)).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', 'z']]);
    expect(rows.map((r) => r.line)).toEqual([1, 2, 3]);
  });

  it('reports an unterminated quote', () => {
    expect(parseCsv('a\n"oops,1\n').error).toMatch(/never closed/);
  });
});

describe('parseSessionsCsv', () => {
  it('accepts a valid file and summarises it', () => {
    const r = parseSessionsCsv(`${HEADER},label\nW1,2027-06-21,6-8,6,8,10,"Week 1"\nW1,2027-06-21,9-11,9,11,8,\nW2,2027-06-28,6-8,6,8,0,\n`);
    expect(r.errors).toEqual([]);
    expect(r.summary).toEqual({ sessions: 3, weeks: 2, ageGroups: 2, totalCapacity: 18 });
    expect(r.sessions[0]).toEqual({ week: 'W1', weekStart: '2027-06-21', ageGroup: '6-8', minAge: 6, maxAge: 8, capacity: 10, label: 'Week 1' });
    expect(r.warnings.map((w) => w.message)).toEqual([expect.stringMatching(/Capacity is 0/) as unknown]);
  });

  it('validates headers', () => {
    expect(parseSessionsCsv('week,capacity\nW1,3').errors[0]?.message).toMatch(/Missing column\(s\): week_start, age_group, min_age, max_age/);
    expect(parseSessionsCsv(`${HEADER},colour\n`).errors[0]?.message).toMatch(/Unknown column\(s\): colour/);
    expect(parseSessionsCsv('').errors[0]?.message).toMatch(/empty/);
  });

  it('reports row-level errors with line and column, and imports nothing', () => {
    const r = parseSessionsCsv(`${HEADER}\nW1,2027-02-30,6-8,6,8,10\nW1,2027-06-21,6-8,9,8,10\nW2,2027-06-28,6-8,6,8,-1\nW3,2027-07-05,6-8,6,8,ten\nW4,2027-07-12,6-8,6,8\n`);
    expect(r.sessions).toEqual([]);
    expect(r.errors.map((e) => [e.line, e.column])).toEqual([
      [2, 'week_start'],
      [3, 'max_age'],
      [3, 'age_group'], // also a duplicate of line 2's (W1, 6-8)
      [4, 'capacity'],
      [5, 'capacity'],
      [6, ''],
      [6, 'capacity'], // the missing value is also an invalid capacity
    ]);
  });

  it('rejects duplicate sessions and inconsistent week start dates', () => {
    const r = parseSessionsCsv(`${HEADER}\nW1,2027-06-21,6-8,6,8,10\nW1,2027-06-21,6-8,6,8,12\nW1,2027-06-22,9-11,9,11,8\n`);
    expect(r.errors.map((e) => e.message)).toEqual([expect.stringMatching(/Duplicate session.*line 2/) as unknown, expect.stringMatching(/different start date/) as unknown]);
  });

  it('warns about overlapping age groups within a week', () => {
    const r = parseSessionsCsv(`${HEADER}\nW1,2027-06-21,6-8,6,8,10\nW1,2027-06-21,8-10,8,10,10\n`);
    expect(r.errors).toEqual([]);
    expect(r.warnings[0]?.message).toMatch(/overlap/);
  });
});

describe('geo', () => {
  const square: Polygon = [closeRing([[-77.31, 38.84], [-77.29, 38.84], [-77.29, 38.86], [-77.31, 38.86]])];

  it('converts between TablesDB [lng, lat] and Leaflet [lat, lng] without loss', () => {
    const p: LngLat = [-77.3, 38.85];
    expect(toLeaflet(p)).toEqual([38.85, -77.3]);
    expect(fromLeaflet(toLeaflet(p))).toEqual(p);
  });

  it('closes rings', () => {
    expect(square[0]).toHaveLength(5);
    expect(closeRing(square[0] ?? [])).toHaveLength(5);
  });

  it('measures distance to the nearest edge consistently with haversine', () => {
    const p: LngLat = [-77.2903, 38.85]; // 0.0003 deg west of the east edge
    const d = distanceToEdgeM(p, square);
    expect(Math.abs(d - haversineM(p, [-77.29, 38.85]))).toBeLessThan(0.5);
    expect(d).toBeGreaterThan(20);
    expect(d).toBeLessThan(30);
  });

  it('point-in-polygon agrees with expectations away from edges', () => {
    expect(pointInPolygon([-77.30, 38.85], square)).toBe(true);
    expect(pointInPolygon([-77.20, 38.85], square)).toBe(false);
  });

  it('tier rule: lowest containing tier wins; default tier outside; boundary flag inside or outside', () => {
    const a = { tier: 1, area: square };
    const b = { tier: 0, area: [closeRing([[-77.32, 38.83], [-77.28, 38.83], [-77.28, 38.87], [-77.32, 38.87]])] };
    expect(classify([-77.30, 38.85], [a, b], [], 3)).toEqual({ tier: 0, nearBoundary: false, containingZones: 2 });
    expect(classify([-77.10, 38.85], [], [], 3)).toEqual({ tier: 3, nearBoundary: false, containingZones: 0 });
    expect(classify([-77.2903, 38.85], [a], [], 3).nearBoundary).toBe(true);
    expect(classify([-77.2896, 38.85], [], [a], 3)).toEqual({ tier: 3, nearBoundary: true, containingZones: 0 });
  });
});

describe('zones GeoJSON', () => {
  const feature = (coords: unknown, props: object = { name: 'Z', tier: 1 }, type = 'Polygon') => JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: props, geometry: { type, coordinates: coords } }] });

  it('parses polygons and closes open rings', () => {
    const r = parseZonesGeoJson(feature([[[-77.31, 38.84], [-77.29, 38.84], [-77.29, 38.86]]]));
    expect(r.errors).toEqual([]);
    expect(r.zones[0]?.area[0]).toHaveLength(4);
  });

  it('rejects non-polygons, bad JSON, out-of-range coordinates and missing tiers', () => {
    expect(parseZonesGeoJson('{').errors[0]).toMatch(/not valid JSON/);
    expect(parseZonesGeoJson(feature([-77, 38], { name: 'P', tier: 0 }, 'Point')).errors[0]).toMatch(/only Polygon/);
    // A [lat, lng] mix-up puts a latitude of -77.3 in the longitude slot, fine, but 120 in the latitude slot is invalid.
    expect(parseZonesGeoJson(feature([[[38.84, 120], [38.86, 120], [38.86, 121]]])).errors[0]).toMatch(/longitude, latitude/);
    expect(parseZonesGeoJson(feature([[[-77.31, 38.84], [-77.29, 38.84], [-77.29, 38.86]]], { name: 'NoTier' })).errors[0]).toMatch(/Feature 1/);
  });
});

describe('program details', () => {
  const base = {
    name: 'Summer camp',
    description: '',
    timezone: 'America/New_York',
    windowOpen: '2027-01-10T14:00:00.000Z',
    windowClose: '2027-02-10T14:00:00.000Z',
    maxWeeks: 3,
    defaultTier: 1,
    tierLabels: { '0': 'Residents', '1': 'Everyone else' },
  };

  it('accepts a valid configuration', () => {
    expect(programDetailsSchema.safeParse(base).success).toBe(true);
  });

  it.each([
    [{ windowClose: '2027-01-09T14:00:00.000Z' }, 'windowClose'],
    [{ windowClose: '2027-01-10T20:00:00.000Z' }, 'windowClose'],
    [{ timezone: 'Mars/Olympus' }, 'timezone'],
    [{ maxWeeks: 0 }, 'maxWeeks'],
    [{ defaultTier: 5 }, 'defaultTier'],
  ])('rejects %o', (patch, path) => {
    const r = programDetailsSchema.safeParse({ ...base, ...patch });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path[0]).toBe(path);
  });
});
