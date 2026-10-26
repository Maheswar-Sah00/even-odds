import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { offlineEnv, renderRoute } from './helpers/render.tsx';

describe('StatusPage', () => {
  it('shows missing configuration instead of a blank page and makes no request', async () => {
    renderRoute('/status');
    expect(await screen.findByText(/Configuration missing: no connection attempted/)).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('VITE_APPWRITE_ENDPOINT');
    expect(alert).toHaveTextContent('VITE_APPWRITE_PROJECT_ID');
  });

  it('shows configured values, then reports an unreachable endpoint as not connected', async () => {
    renderRoute('/status', { env: offlineEnv });
    expect(await screen.findByText('proj123')).toBeInTheDocument();
    expect(await screen.findByText('Not connected', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByText(/Could not reach the Appwrite endpoint/)).toBeInTheDocument();
  });
});
