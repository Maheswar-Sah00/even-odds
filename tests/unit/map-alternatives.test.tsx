import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HomeLocationFields } from '../../src/components/HomeLocationFields.tsx';

// Leaflet needs a real layout engine; the text alternative is what this test is about.
vi.mock('react-leaflet', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return { MapContainer: Pass, TileLayer: () => null, Polygon: Pass, Polyline: () => null, CircleMarker: () => null, Tooltip: Pass, useMap: () => ({ fitBounds: () => undefined }), useMapEvents: () => null };
});

/** Task 14 (WCAG 2.1.1 / 1.1.1): everything the maps do can be done, and read, without the map. */
describe('home location without the map', () => {
  it('saves typed coordinates as [longitude, latitude] using only the keyboard', async () => {
    const onSave = vi.fn();
    render(<HomeLocationFields busy={false} onSave={onSave} />);
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard('{Enter}'); // open the <details> from its summary
    await user.type(screen.getByRole('textbox', { name: 'Latitude' }), '38.8462');
    await user.type(screen.getByRole('textbox', { name: 'Longitude' }), '-77.3064');
    await user.click(screen.getByRole('button', { name: 'Save location' }));
    expect(onSave).toHaveBeenCalledWith([-77.3064, 38.8462]);
  });

  it('explains out-of-range or swapped values in an alert and saves nothing', async () => {
    const onSave = vi.fn();
    render(<HomeLocationFields busy={false} onSave={onSave} />);
    const user = userEvent.setup();
    await user.click(screen.getByText(/Enter your location another way/));
    await user.type(screen.getByRole('textbox', { name: 'Latitude' }), '-77.3');
    await user.type(screen.getByRole('textbox', { name: 'Longitude' }), '238.8');
    await user.click(screen.getByRole('button', { name: 'Save location' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Longitude must be a number from -180 to 180/);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('zone map text alternative', () => {
  it('lists every zone and tier as text, linked to the labelled map group', async () => {
    const { ZoneMap } = await import('../../src/components/ZoneMap.tsx');
    const area = [[[-77.31, 38.84], [-77.29, 38.84], [-77.29, 38.86], [-77.31, 38.84]]] as [number, number][][];
    render(<ZoneMap label="Map of 2 priority zones" tierLabels={{ '0': 'Residents', '1': 'Everyone else' }} zones={[{ id: 'a', name: 'Old Town', tier: 0, area }, { id: 'b', name: 'Riverside', tier: 1, area }]} />);
    const map = screen.getByRole('group', { name: 'Map of 2 priority zones' });
    expect(map).toHaveAccessibleDescription(/Old Town: Tier 0 \(Residents\).*Riverside: Tier 1 \(Everyone else\)/);
    expect(screen.getByRole('list', { name: 'Zones on this map' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Map of 2 priority zones' })).toBeNull();
  });
});
