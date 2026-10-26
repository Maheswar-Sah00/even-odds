import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { classifyOtpError, safeNext } from '../../src/features/auth/otp.ts';
import { childInputSchema, inviteCodeSchema } from '../../shared/household-input.ts';
import { offlineEnv, renderRoute } from './helpers/render.tsx';

const invalidToken = Object.assign(new Error('Invalid token passed in the request.'), { code: 401, type: 'user_invalid_token' });
const future = new Date(Date.now() + 60_000).toISOString();

describe('OTP error classification', () => {
  it('distinguishes expired, reused and invalid codes from one identical server error', () => {
    expect(classifyOtpError(invalidToken, { expiresAt: future, usedCodes: new Set(), code: '123456' })).toBe('invalid');
    expect(classifyOtpError(invalidToken, { expiresAt: new Date(Date.now() - 1000).toISOString(), usedCodes: new Set(), code: '123456' })).toBe('expired');
    expect(classifyOtpError(invalidToken, { expiresAt: future, usedCodes: new Set(['123456']), code: '123456' })).toBe('reused');
    expect(classifyOtpError(Object.assign(new Error('x'), { code: 429, type: 'general_rate_limit_exceeded' }), { expiresAt: future, usedCodes: new Set(), code: '1' })).toBe('rate_limited');
    expect(classifyOtpError(new TypeError('Failed to fetch'), { expiresAt: future, usedCodes: new Set(), code: '1' })).toBe('network');
  });

  it('only allows same-site return paths after sign-in', () => {
    expect(safeNext('/family/children')).toBe('/family/children');
    expect(safeNext('//evil.example')).toBe('/family');
    expect(safeNext('https://evil.example')).toBe('/family');
    expect(safeNext('/\\evil')).toBe('/family');
    expect(safeNext(null)).toBe('/family');
  });
});

describe('household input validation (shared by browser and Function)', () => {
  it('accepts a valid child and trims names', () => {
    expect(childInputSchema.parse({ firstName: '  Ada ', lastName: 'Lovelace', birthdate: '2018-12-10' })).toMatchObject({ firstName: 'Ada' });
  });

  it.each([
    [{ firstName: '', lastName: 'L', birthdate: '2018-12-10' }, 'firstName'],
    [{ firstName: '---', lastName: 'L', birthdate: '2018-12-10' }, 'firstName'],
    [{ firstName: 'A', lastName: 'L', birthdate: '2018-02-30' }, 'birthdate'],
    [{ firstName: 'A', lastName: 'L', birthdate: '2999-01-01' }, 'birthdate'],
    [{ firstName: 'A', lastName: 'L', birthdate: '1980-01-01' }, 'birthdate'],
    [{ firstName: 'A'.repeat(65), lastName: 'L', birthdate: '2018-12-10' }, 'firstName'],
  ])('rejects %o on %s', (input, field) => {
    const r = childInputSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path[0]).toBe(field);
  });

  it('normalises invite codes and rejects ambiguous characters', () => {
    expect(inviteCodeSchema.parse('abcde-23456')).toBe('ABCDE23456');
    expect(inviteCodeSchema.safeParse('ABCDE-2345O').success).toBe(false); // O is not in the alphabet
    expect(inviteCodeSchema.safeParse('ABC').success).toBe(false);
  });
});

describe('SignInPage', () => {
  it('validates the email before contacting Appwrite', async () => {
    const user = userEvent.setup();
    renderRoute('/signin', { env: offlineEnv });
    await user.type(await screen.findByLabelText(/Email address/), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(screen.getByText(/Enter a valid email address/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports an unreachable sign-in service instead of pretending a code was sent', async () => {
    const user = userEvent.setup();
    renderRoute('/signin', { env: offlineEnv });
    await user.type(await screen.findByLabelText(/Email address/), 'synthetic@example.com');
    await user.click(screen.getByRole('button', { name: 'Email me a code' }));
    expect(await screen.findByRole('alert', {}, { timeout: 10_000 })).toHaveTextContent(/Could not reach/);
    expect(screen.queryByLabelText(/6-digit code/)).toBeNull();
  });

  it('a signed-in user is sent straight to their destination', async () => {
    const { router } = renderRoute('/signin?next=%2Ffamily%2Fchildren', { env: offlineEnv, auth: { status: 'signed_in', user: { $id: 'u', email: 'x@example.com' } as never, isOrganiser: false } });
    await screen.findByRole('heading', { level: 1 });
    expect(router.state.location.pathname).toBe('/family/children');
  });
});
