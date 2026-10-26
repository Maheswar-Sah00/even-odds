import { Crosshair, Save } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import type { LngLat } from '@shared/geo.ts';
import { Button, TextField } from './ui/index.ts';

/**
 * Keyboard and screen-reader alternative to clicking the map (WCAG 2.1.1,
 * Task 14): type the coordinates, or let the device supply them. No address is
 * sent to a third-party geocoder, so the home location stays private.
 */
export function HomeLocationFields({
  onSave,
  busy,
  summary = 'Can’t use the map? Enter your location another way',
  note = 'Your phone or a maps app can show the latitude and longitude of your home. Only your household can see them.',
  saveLabel = 'Save location',
}: {
  onSave: (p: LngLat) => void;
  busy: boolean;
  summary?: string;
  note?: string;
  saveLabel?: string;
}) {
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [error, setError] = useState<string | null>(null);
  const canLocate = typeof navigator !== 'undefined' && 'geolocation' in navigator;

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const la = Number(lat.trim());
    const lo = Number(lng.trim());
    if (lat.trim() === '' || !Number.isFinite(la) || la < -90 || la > 90) {
      setError('Latitude must be a number from -90 to 90, for example 38.8462.');
      return;
    }
    if (lng.trim() === '' || !Number.isFinite(lo) || lo < -180 || lo > 180) {
      setError('Longitude must be a number from -180 to 180, for example -77.3064.');
      return;
    }
    setError(null);
    onSave([lo, la]);
  };

  const locate = () => {
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(5));
        setLng(pos.coords.longitude.toFixed(5));
        onSave([pos.coords.longitude, pos.coords.latitude]);
      },
      () => { setError('Your device did not share its location. Enter the coordinates instead.'); },
      { enableHighAccuracy: false, timeout: 15_000 },
    );
  };

  return (
    <details className="location-alt">
      <summary>{summary}</summary>
      <form className="stack-sm" onSubmit={submit} noValidate>
        <p className="muted small">{note}</p>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <TextField label="Latitude" inputMode="decimal" autoComplete="off" value={lat} onChange={(e) => { setLat(e.target.value); }} />
          <TextField label="Longitude" inputMode="decimal" autoComplete="off" value={lng} onChange={(e) => { setLng(e.target.value); }} />
        </div>
        {error ? <p className="field__error" role="alert">{error}</p> : null}
        <div className="row">
          <Button type="submit" size="sm" icon={<Save size={16} aria-hidden="true" />} loading={busy} loadingLabel="Saving…">
            {saveLabel}
          </Button>
          {canLocate ? (
            <Button size="sm" variant="secondary" icon={<Crosshair size={16} aria-hidden="true" />} disabled={busy} onClick={locate}>
              Use my current location
            </Button>
          ) : null}
        </div>
      </form>
    </details>
  );
}
