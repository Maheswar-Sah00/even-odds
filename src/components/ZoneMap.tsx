import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useEffect, useId, useMemo } from 'react';
import { CircleMarker, MapContainer, Polygon, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import { fromLeaflet, toLeaflet, type LngLat, type Polygon as GeoPolygon } from '@shared/geo.ts';
import { tierColor } from '../lib/tiers.ts';

/**
 * Zone map. Data in and out is ALWAYS [longitude, latitude] (TablesDB order);
 * conversion to Leaflet's [latitude, longitude] happens only inside this file.
 */
export interface MapZone {
  id: string;
  name: string;
  tier: number;
  area: GeoPolygon;
}


function FitToZones({ zones }: { zones: readonly MapZone[] }) {
  const map = useMap();
  useEffect(() => {
    const points = zones.flatMap((z) => z.area.flat().map(toLeaflet));
    if (points.length > 0) map.fitBounds(L.latLngBounds(points), { padding: [24, 24] });
  }, [map, zones]);
  return null;
}

function ClickCapture({ onClick }: { onClick: (p: LngLat) => void }) {
  useMapEvents({
    click(e) {
      onClick(fromLeaflet([e.latlng.lat, e.latlng.lng]));
    },
  });
  return null;
}

interface ZoneMapProps {
  zones: readonly MapZone[];
  tierLabels: Record<string, string>;
  /** Accessible description of what the map shows. */
  label: string;
  onMapClick?: (p: LngLat) => void;
  /** Vertices of a polygon being drawn. */
  draft?: readonly LngLat[];
  marker?: LngLat | null;
  height?: number;
  /** Text alternative listing every zone and its tier (on by default; off where a table already lists them). */
  zoneList?: boolean;
}

export function ZoneMap({ zones, tierLabels, label, onMapClick, draft = [], marker = null, height = 380, zoneList = true }: ZoneMapProps) {
  const fallbackCenter = useMemo(() => toLeaflet([-77.3, 38.85]), []);
  const listId = useId();
  return (
    <figure className="map-figure" style={{ margin: 0 }}>
      {/* A labelled group, not role="img": the map has keyboard-operable controls (Task 14). */}
      <div role="group" aria-label={label} aria-describedby={zoneList && zones.length > 0 ? listId : undefined} style={{ height }} className="map-frame">
        <MapContainer center={fallbackCenter} zoom={12} style={{ height: '100%', width: '100%' }} scrollWheelZoom={false} keyboard>
          <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          {zones.map((z) => (
            <Polygon key={z.id} positions={z.area.map((ring) => ring.map(toLeaflet))} pathOptions={{ color: tierColor(z.tier), weight: 2, fillOpacity: 0.18 }}>
              <Tooltip sticky>
                {z.name}: {tierLabels[String(z.tier)] ?? `Tier ${z.tier}`}
              </Tooltip>
            </Polygon>
          ))}
          {draft.length > 0 ? <Polyline positions={draft.map(toLeaflet)} pathOptions={{ color: '#c98a00', dashArray: '6 4', weight: 3 }} /> : null}
          {draft.map((p, i) => (
            <CircleMarker key={`${String(p[0])},${String(p[1])},${String(i)}`} center={toLeaflet(p)} radius={4} pathOptions={{ color: '#c98a00' }} />
          ))}
          {marker ? <CircleMarker center={toLeaflet(marker)} radius={7} pathOptions={{ color: '#1e2124', fillColor: '#ffffff', fillOpacity: 1, weight: 3 }} /> : null}
          {onMapClick ? <ClickCapture onClick={onMapClick} /> : null}
          <FitToZones zones={zones} />
        </MapContainer>
      </div>
      <figcaption className="map-legend">
        {Object.entries(tierLabels)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([tier, text]) => (
            <span key={tier} className="map-legend__item">
              <span className="map-legend__swatch" style={{ background: tierColor(Number(tier)) }} aria-hidden="true" />
              Tier {tier}: {text}
            </span>
          ))}
        {zoneList && zones.length > 0 ? (
          <ul id={listId} className="map-zone-list" aria-label="Zones on this map">
            {zones.map((z) => (
              <li key={z.id}>
                {z.name}: Tier {z.tier} ({tierLabels[String(z.tier)] ?? 'no label'})
              </li>
            ))}
          </ul>
        ) : null}
      </figcaption>
    </figure>
  );
}
