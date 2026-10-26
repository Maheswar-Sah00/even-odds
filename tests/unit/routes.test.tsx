import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AuthState } from '../../src/features/auth/auth-context.ts';
import { GOLDEN_PLAN_HASH } from '../fixtures/draw-golden.ts';
import { fakeUser, renderRoute } from './helpers/render.tsx';

const family: AuthState = { status: 'signed_in', user: fakeUser, isOrganiser: false };
const organiser: AuthState = { status: 'signed_in', user: fakeUser, isOrganiser: true };

// Lazy pages such as /audit (drand BLS verifier) can take over a second to load in jsdom.
const h1 = () => screen.findByRole('heading', { level: 1 }, { timeout: 5000 });

describe('route map', () => {
  it.each([
    ['/', 'Registration is a lottery, not a race.'],
    ['/programs', 'Programs'],
    ['/signin', 'Sign in'],
    ['/audit/p1', 'Audit log'],
    ['/replay/p1', 'Replay the draw'],
    ['/status', 'System status'],
    ['/does-not-exist', 'Page not found'],
  ])('public route %s renders', async (path, title) => {
    renderRoute(path);
    expect(await h1()).toHaveTextContent(title);
  });

  it('/programs/:id shows a clear error when the app cannot load data', async () => {
    renderRoute('/programs/p1');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it.each(['/family', '/family/children', '/family/offers', '/applications/new/p1', '/applications/a1', '/organiser', '/organiser/programs/p1'])(
    'signed-out visitors to %s are redirected to sign-in with a return path',
    async (path) => {
      const { router } = renderRoute(path);
      expect(await h1()).toHaveTextContent('Sign in');
      expect(router.state.location.pathname).toBe('/signin');
      expect(router.state.location.search).toBe(`?next=${encodeURIComponent(path)}`);
    },
  );

  it.each([
    ['/family', 'Household overview'],
    ['/family/children', 'Children'],
    ['/family/offers', 'Offers and waitlist'],
    ['/applications/new/p1', 'Apply to a program'],
    ['/applications/a1', 'Your application'],
  ])('signed-in families can open %s', async (path, title) => {
    renderRoute(path, { auth: family });
    expect(await h1()).toHaveTextContent(title);
  });

  it('families are refused the organiser area and do not see its nav link', async () => {
    renderRoute('/organiser', { auth: family });
    expect(await h1()).toHaveTextContent('Organisers only');
    expect(within(screen.getByRole('navigation', { name: 'Main' })).queryByRole('link', { name: 'Organiser' })).toBeNull();
  });

  it.each([
    ['/organiser', 'Dashboard'],
    ['/organiser/programs/p1', 'Program setup'],
  ])('organisers can open %s', async (path, title) => {
    renderRoute(path, { auth: organiser });
    expect(await h1()).toHaveTextContent(title);
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Organiser' })).toBeInTheDocument();
  });

  it('the replay page recomputes the synthetic sample draw in the browser', async () => {
    const user = userEvent.setup();
    renderRoute('/replay/p1');
    await user.click(await screen.findByRole('button', { name: 'Try with synthetic sample data' }));
    expect(await screen.findByRole('table', { name: 'Lottery order' })).toBeInTheDocument();
    expect(screen.getByText(GOLDEN_PLAN_HASH)).toBeInTheDocument();
  });
});

describe('navigation', () => {
  it('mobile menu toggle exposes its state and closes on Escape', async () => {
    const user = userEvent.setup();
    renderRoute('/');
    const toggle = await screen.findByRole('button', { name: 'Menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('the first Tab stop is the skip link', async () => {
    const user = userEvent.setup();
    renderRoute('/');
    await h1();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveFocus();
  });
});
