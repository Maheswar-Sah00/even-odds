import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../../src/features/auth/auth-context.ts';
import type { FamilyProgramOffers } from '../../src/features/offers/offers-api.ts';
import { fakeUser, offlineEnv, renderRoute } from './helpers/render.tsx';

const family: AuthState = { status: 'signed_in', user: fakeUser, isOrganiser: false };
const serverTime = new Date().toISOString();
const program: FamilyProgramOffers = {
  programId: 'p1',
  name: '[SYNTHETIC] Summer camp',
  timezone: 'UTC',
  synthetic: true,
  status: 'drawn',
  offersIssuedAt: serverTime,
  offersSweptAt: null,
  offers: [
    {
      placementId: 'pl1', childId: 'c1', childName: 'Ada', week: 'W1', weekLabel: 'Week 1', ageGroup: 'young', status: 'offered', displayStatus: 'offered',
      offeredAt: serverTime, expiresAt: new Date(Date.parse(serverTime) + 47 * 3600_000 + 30 * 60_000).toISOString(), respondedAt: null, source: 'draw', round: 1,
    },
  ],
  waitlist: [{ entryId: 'w1', childId: 'c1', childName: 'Ada', week: 'W2', weekLabel: 'Week 2', ageGroup: 'young', position: 3, status: 'waiting', ahead: 2 }],
};

const respond = vi.fn();
vi.mock('../../src/features/offers/offers-api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/offers/offers-api.ts')>();
  return {
    ...actual,
    offersApi: () => ({
      mine: () => Promise.resolve({ serverTime, programs: [program] }),
      respond,
      overview: vi.fn(),
      cancel: vi.fn(),
      process: vi.fn(),
    }),
  };
});

const getHousehold = vi.hoisted(() => vi.fn<() => Promise<unknown>>(() => Promise.resolve({ familyId: 'f1', guardians: [], children: [] })));
vi.mock('../../src/features/family/household-api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/family/household-api.ts')>();
  return { ...actual, householdApi: () => ({ get: getHousehold }) };
});

describe('family offers page', () => {
  it('shows the server-clock deadline and waitlist place, and retries a failed accept with the SAME key', async () => {
    const user = userEvent.setup();
    respond.mockRejectedValueOnce(Object.assign(new Error('The service was busy. Please try again.'), { code: 'retry' }));
    respond.mockResolvedValueOnce({ status: 'changed', offers: [], promoted: 0 });
    renderRoute('/family/offers', { auth: family, env: offlineEnv });

    expect(await screen.findByText(/1 day 23 hours left/)).toBeInTheDocument();
    expect(screen.getByText(/position 3, 2 still waiting ahead/)).toBeInTheDocument();
    expect(screen.getByText('Pending reply')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('The service was busy. Please try again.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    expect(await screen.findByText(/Done: place accepted/)).toBeInTheDocument();

    expect(respond).toHaveBeenCalledTimes(2);
    const [first, second] = respond.mock.calls as [string, string[], string, string][];
    expect(first?.slice(0, 3)).toEqual(['p1', ['pl1'], 'accept']);
    expect(second?.[3]).toBe(first?.[3]);
    expect(first?.[3]).toMatch(/^[0-9a-f]{32}$/);
  });

  it('without a household, points to household setup instead of showing an error', async () => {
    getHousehold.mockResolvedValueOnce(null);
    renderRoute('/family/offers', { auth: family, env: offlineEnv });
    expect(await screen.findByText('Set up your household first')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create or join a household' })).toHaveAttribute('href', '/family');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
