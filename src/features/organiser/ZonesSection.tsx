import { Crosshair, MapPin, PenLine, Trash2, Upload } from 'lucide-react';
import { HomeLocationFields } from '../../components/HomeLocationFields.tsx';
import { lazy, Suspense, useState } from 'react';
import { Banner, Button, Card, DataTable, LoadingState, SelectField, TextField } from '../../components/ui/index.ts';
import { closeRing, type Classification, type LngLat, type Polygon } from '@shared/geo.ts';
import { parseZonesGeoJson, zoneInputSchema, type ZoneInput } from '@shared/program-input.ts';
import type { ServiceError } from '@shared/errors.ts';
import type { BrowserAppwrite } from '../../lib/appwrite/client.ts';
import type { BrowserRow } from '../../lib/appwrite/db.ts';
import { tierLabelsOf, type Program } from '../programs/program-view.ts';
import { organiserApi } from './organiser-api.ts';

const ZoneMap = lazy(() => import('../../components/ZoneMap.tsx').then((m) => ({ default: m.ZoneMap })));

type Mode = 'view' | 'draw' | 'test';

/**
 * Zone editor. Zones can be imported as GeoJSON (the keyboard-accessible
 * path) or drawn by clicking vertices on the map. Edits are local until
 * "Save zones", which the organiser Function validates and stores.
 */
export function ZonesSection({
  app,
  program,
  saved,
  onChanged,
  classify,
}: {
  app: BrowserAppwrite;
  program: Program;
  saved: BrowserRow<'zones'>[];
  onChanged: () => void;
  /** Server-side point classification; without it (the judge sandbox) the map is view-only. */
  classify?: ((point: LngLat) => Promise<Classification>) | undefined;
}) {
  const draft = program.status === 'draft';
  const labels = tierLabelsOf(program);
  const tiers = Object.keys(labels).sort((a, b) => Number(a) - Number(b));
  const [zones, setZones] = useState<ZoneInput[]>(() => saved.map((z) => ({ name: z.name, tier: z.tier, area: z.area as unknown as Polygon })));
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<Mode>('view');
  const [vertices, setVertices] = useState<LngLat[]>([]);
  const [newName, setNewName] = useState('');
  const [newTier, setNewTier] = useState(tiers[0] ?? '0');
  const [message, setMessage] = useState<{ tone: 'error' | 'success' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<{ point: LngLat; result: Classification | null } | null>(null);

  const finishDrawing = () => {
    const parsed = zoneInputSchema.safeParse({ name: newName || `Zone ${String(zones.length + 1)}`, tier: Number(newTier), area: [closeRing(vertices)] });
    if (!parsed.success) {
      setMessage({ tone: 'error', text: parsed.error.issues[0]?.message ?? 'Invalid zone' });
      return;
    }
    setZones([...zones, parsed.data]);
    setDirty(true);
    setVertices([]);
    setNewName('');
    setMode('view');
    setMessage({ tone: 'info', text: `Added "${parsed.data.name}". Save zones to keep it.` });
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await organiserApi(app).saveZones(program.$id, zones);
      setDirty(false);
      setMessage({ tone: 'success', text: `Saved ${String(r.saved)} zone(s).` });
      onChanged();
    } catch (err) {
      setMessage({ tone: 'error', text: (err as ServiceError).message });
    } finally {
      setBusy(false);
    }
  };

  const onMapClick = (p: LngLat) => {
    if (mode === 'draw') setVertices((v) => [...v, p]);
    if (mode === 'test') {
      if (!classify) return;
      setProbe({ point: p, result: null });
      classify(p).then((result) => { setProbe({ point: p, result }); }, (err: unknown) => { setMessage({ tone: 'error', text: (err as ServiceError).message }); });
    }
  };

  return (
    <Card title="Priority zones" description="Homes inside a zone get its tier (the lowest tier wins if zones overlap). Homes within 50 m of any edge are flagged for staff verification.">
      <div className="stack">
        <div className="row">
          {draft ? (
            <>
              <Button size="sm" variant={mode === 'draw' ? 'primary' : 'secondary'} icon={<PenLine size={16} aria-hidden="true" />} aria-pressed={mode === 'draw'} onClick={() => { setMode(mode === 'draw' ? 'view' : 'draw'); setVertices([]); }}>
                {mode === 'draw' ? 'Cancel drawing' : 'Draw a zone'}
              </Button>
              <label className="btn btn--secondary btn--sm">
                <Upload size={16} aria-hidden="true" />
                <span>Import GeoJSON</span>
                <input
                  type="file"
                  accept=".geojson,.json,application/geo+json,application/json"
                  className="visually-hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    void file.text().then((text) => {
                      const r = parseZonesGeoJson(text);
                      if (r.errors.length) setMessage({ tone: 'error', text: r.errors.join(' ') });
                      else {
                        setZones(r.zones);
                        setDirty(true);
                        setMessage({ tone: 'info', text: `Loaded ${String(r.zones.length)} zone(s) from ${file.name}. Review the map, then save.` });
                      }
                    });
                  }}
                />
              </label>
            </>
          ) : null}
          {classify ? (
            <Button size="sm" variant={mode === 'test' ? 'primary' : 'secondary'} icon={<Crosshair size={16} aria-hidden="true" />} aria-pressed={mode === 'test'} disabled={dirty} onClick={() => { setMode(mode === 'test' ? 'view' : 'test'); setProbe(null); }}>
              {mode === 'test' ? 'Stop testing' : 'Test a location'}
            </Button>
          ) : null}
        </div>

        {mode === 'draw' ? (
          <Banner tone="info" title="Drawing a zone">
            <p>Click the map to place each corner ({vertices.length} placed). The shape closes automatically.</p>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <TextField label="Zone name" value={newName} onChange={(e) => { setNewName(e.target.value); }} />
              <SelectField label="Tier" value={newTier} onChange={(e) => { setNewTier(e.target.value); }}>
                {tiers.map((t) => (
                  <option key={t} value={t}>Tier {t}: {labels[t]}</option>
                ))}
              </SelectField>
              <Button size="sm" disabled={vertices.length < 3} onClick={finishDrawing}>Finish zone</Button>
              <Button size="sm" variant="ghost" disabled={vertices.length === 0} onClick={() => { setVertices((v) => v.slice(0, -1)); }}>Undo corner</Button>
            </div>
          </Banner>
        ) : null}
        {mode === 'test' ? (
          <>
            <Banner tone="info">Click anywhere on the map to see which tier a home there would get, as computed by the server.</Banner>
            <HomeLocationFields busy={false} onSave={onMapClick} summary="Test coordinates without the map" note="Enter a latitude and longitude to see the tier the server would compute there." saveLabel="Test this location" />
          </>
        ) : null}

        <Suspense fallback={<LoadingState label="Loading map…" />}>
          <ZoneMap
            label={`Priority zone map for ${program.name}: ${String(zones.length)} zone(s)`}
            tierLabels={labels}
            zones={zones.map((z, i) => ({ id: String(i), ...z }))}
            draft={vertices}
            marker={probe?.point ?? null}
            zoneList={false}
            {...(mode === 'view' ? {} : { onMapClick })}
          />
        </Suspense>

        {probe ? (
          <Banner tone={probe.result?.nearBoundary ? 'warning' : 'info'} title={<><MapPin size={16} aria-hidden="true" /> Location test</>}>
            {probe.result
              ? `Tier ${String(probe.result.tier)} (${labels[String(probe.result.tier)] ?? 'no label'}); inside ${String(probe.result.containingZones)} zone(s)${probe.result.nearBoundary ? '; within 50 m of a boundary, so staff would verify this address' : ''}.`
              : 'Checking…'}
            <p className="muted small">
              Longitude {probe.point[0].toFixed(5)}, latitude {probe.point[1].toFixed(5)}
            </p>
          </Banner>
        ) : null}

        <DataTable<ZoneInput & { i: number }>
          caption="Zones"
          rows={zones.map((z, i) => ({ ...z, i }))}
          rowKey={(z) => String(z.i)}
          empty={<p className="muted">No zones: every family will be in the default tier ({labels[String(program.default_tier ?? '')] ?? 'not set'}).</p>}
          columns={[
            { key: 'name', header: 'Zone', render: (z) => z.name },
            { key: 'tier', header: 'Tier', render: (z) => `Tier ${String(z.tier)}: ${labels[String(z.tier)] ?? '(no label)'}` },
            { key: 'pts', header: 'Corners', numeric: true, render: (z) => (z.area[0]?.length ?? 1) - 1 },
            ...(draft
              ? [{
                  key: 'del',
                  header: <span className="visually-hidden">Actions</span>,
                  render: (z: ZoneInput & { i: number }) => (
                    <Button size="sm" variant="ghost" icon={<Trash2 size={16} aria-hidden="true" />} onClick={() => { setZones(zones.filter((_, j) => j !== z.i)); setDirty(true); }}>
                      Remove<span className="visually-hidden"> {z.name}</span>
                    </Button>
                  ),
                }]
              : []),
          ]}
        />
        {draft ? (
          <div className="row">
            <Button disabled={!dirty} loading={busy} loadingLabel="Saving…" onClick={() => void save()}>
              Save zones
            </Button>
            {dirty ? <span className="muted small">Unsaved changes</span> : null}
          </div>
        ) : null}
        {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}
      </div>
    </Card>
  );
}
