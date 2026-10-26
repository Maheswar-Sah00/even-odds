/**
 * Coordinates.
 *
 * Appwrite TablesDB stores and queries points as [longitude, latitude]
 * (verified on Cloud: a swapped [lat, lng] query matched nothing). Leaflet
 * uses [latitude, longitude]. Convert ONLY with the helpers below.
 */
export type LngLat = [lng: number, lat: number];
export type LatLng = [lat: number, lng: number];
/** Appwrite polygon: rings of [lng, lat]; each ring closed (first point === last point). */
export type Polygon = LngLat[][];

export const toLeaflet = ([lng, lat]: LngLat): LatLng => [lat, lng];
export const fromLeaflet = ([lat, lng]: LatLng): LngLat => [lng, lat];

export function isValidLngLat(p: readonly number[]): p is LngLat {
  return p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0] ?? 999) <= 180 && Math.abs(p[1] ?? 999) <= 90;
}

/** Closes a ring if needed (Appwrite rejects unclosed rings). */
export function closeRing(ring: readonly LngLat[]): LngLat[] {
  if (ring.length === 0) return [];
  const first = ring[0] as LngLat;
  const last = ring[ring.length - 1] as LngLat;
  return first[0] === last[0] && first[1] === last[1] ? [...ring] : [...ring, first];
}

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineM(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Distance in metres from a point to the nearest edge of a polygon (any ring).
 * Uses a local equirectangular projection around the point: accurate to well
 * under 1% at the < 1 km scales used for the 50 m boundary flag.
 */
export function distanceToEdgeM(point: LngLat, polygon: Polygon): number {
  const kx = EARTH_RADIUS_M * Math.cos(rad(point[1])) * (Math.PI / 180);
  const ky = EARTH_RADIUS_M * (Math.PI / 180);
  const project = (p: LngLat): [number, number] => [(p[0] - point[0]) * kx, (p[1] - point[1]) * ky];
  let best = Infinity;
  for (const ring of polygon) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const [ax, ay] = project(ring[i] as LngLat);
      const [bx, by] = project(ring[i + 1] as LngLat);
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

/** Ray-casting point-in-polygon (outer ring minus holes). Boundary handling is approximate; the DB is authoritative. */
export function pointInPolygon(point: LngLat, polygon: Polygon): boolean {
  const inRing = (ring: LngLat[]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i] as LngLat;
      const [xj, yj] = ring[j] as LngLat;
      if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const [outer, ...holes] = polygon;
  return outer !== undefined && inRing(outer) && !holes.some(inRing);
}

export const BOUNDARY_FLAG_M = 50;

export interface ZoneLike {
  tier: number;
  area: Polygon;
}

export interface Classification {
  /** Lowest (highest-priority) tier among zones containing the home, else the default tier. */
  tier: number;
  /** True when the home is within BOUNDARY_FLAG_M of any zone edge, inside or outside. */
  nearBoundary: boolean;
  containingZones: number;
}

/**
 * Tier rule (documented in docs/ZONES.md): a home inside several zones gets the
 * best (lowest-numbered) tier; outside every zone it gets the program default.
 * `containing` and `nearOutside` come from TablesDB queries; edge distance for
 * homes inside a zone is computed here because the DB reports 0 for them.
 */
export function classify(point: LngLat, containing: readonly ZoneLike[], nearOutside: readonly ZoneLike[], defaultTier: number): Classification {
  const tier = containing.length > 0 ? Math.min(...containing.map((z) => z.tier)) : defaultTier;
  const insideNearEdge = containing.some((z) => distanceToEdgeM(point, z.area) <= BOUNDARY_FLAG_M);
  return { tier, nearBoundary: insideNearEdge || nearOutside.length > 0, containingZones: containing.length };
}
