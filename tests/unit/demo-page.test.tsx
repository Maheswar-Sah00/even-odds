import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { offlineEnv, renderRoute } from './helpers/render.tsx';

describe('/demo (judge sandbox)', () => {
  it('offers a one-click start with no sign-up when signed out', async () => {
    renderRoute('/demo', { env: offlineEnv });
    expect(await screen.findByRole('heading', { level: 1 }, { timeout: 5000 })).toHaveTextContent('Even Odds in two minutes');
    expect(screen.getByRole('button', { name: 'Start the judge demo' })).toBeInTheDocument();
  });

  it('explains plainly when the app is not configured', async () => {
    renderRoute('/demo');
    expect(await screen.findByRole('heading', { level: 1 }, { timeout: 5000 })).toHaveTextContent('Even Odds in two minutes');
    expect(screen.getByRole('alert')).toHaveTextContent('not configured');
  });

  it('is linked from the home page', async () => {
    renderRoute('/');
    expect(await screen.findByRole('link', { name: 'Try the judge demo' })).toHaveAttribute('href', '/demo');
  });
});
