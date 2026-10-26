# Priority zones and tiers

## Rules (implemented in `shared/geo.ts` and `functions/shared/organiser.ts`)

1. Each zone is a polygon with a **tier** (0-9). Lower tiers draw first.
2. A home inside one or more zones gets the **lowest** tier among them.
3. A home outside every zone gets the program's **default tier**.
4. A home within **50 m** of any zone edge (inside or outside) is flagged
   `near_boundary`. A boundary case is never treated as unquestionably
   eligible: staff verify the address before any offer that depends on it.
5. Tiers are computed **on the server** from the stored home point. Clients
   never send a tier; the claimed tier is only ever written by server code,
   and the verified tier only by organisers.

## How the database is used

- Containment: `Query.intersects('area', [lng, lat])` on the `zones.area`
  polygon column (spatial index `sp_area`). Edges count as inside.
- Near a zone from outside: `Query.distanceLessThan('area', [lng, lat], 50, true)`.
- Near an edge from inside: TablesDB reports distance 0 for interior points,
  so the distance to the nearest edge is computed in `distanceToEdgeM`
  (local equirectangular projection; checked against haversine in tests).

## Coordinate order

TablesDB and GeoJSON use **[longitude, latitude]**. Leaflet uses
**[latitude, longitude]**. Conversion happens only in `toLeaflet` /
`fromLeaflet` (`shared/geo.ts`), used by `src/components/ZoneMap.tsx`.

## Demo zones

`data/demo/zones.geojson` contains two **synthetic** zones drawn loosely over
Fairfax, Virginia. They are not official boundaries.
