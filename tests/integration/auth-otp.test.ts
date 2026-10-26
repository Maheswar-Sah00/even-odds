/**
 * The email one-time-code sign-in sequence against REAL Appwrite Auth.
 * Email delivery cannot be automated here, so the server creates the token
 * (users.createToken) and the BROWSER SDK verifies it exactly as the sign-in
 * screen does: account.createSession({ userId, secret }).
 */
import { Account, Client as BrowserClient, ID } from 'appwrite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyOtpError } from '../../src/features/auth/otp.ts';
import { aw, RUN_ID, serverEnv } from './helpers/server.ts';

const guestAccount = () => new Account(new BrowserClient().setEndpoint(serverEnv.endpoint).setProject(serverEnv.projectId));
const userId = ID.unique();
const email = `synthetic+otp-${RUN_ID}@example.com`;

beforeAll(async () => {
  await aw.users.create({ userId, email, name: '[SYNTHETIC] otp' });
});
afterAll(async () => {
  await aw.users.delete({ userId }).catch(() => undefined);
});

const fail = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected failure'); }, (e: unknown) => e);

describe('email OTP sign-in (real Appwrite Auth)', () => {
  it('createEmailToken returns the EXISTING user for a known email and a 15-minute expiry', async () => {
    const token = await guestAccount().createEmailToken({ userId: ID.unique(), email });
    expect(token.userId).toBe(userId);
    expect(token.secret).toBe(''); // the code is only ever sent by email
    const minutes = (new Date(token.expire).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(10);
    expect(minutes).toBeLessThanOrEqual(15.5);
  });

  it('a valid code creates a session; the same code cannot be used twice', async () => {
    const token = await aw.users.createToken({ userId, length: 6, expire: 300 });
    const account = guestAccount();
    const session = await account.createSession({ userId, secret: token.secret });
    expect(session.userId).toBe(userId);

    const reused = await fail(guestAccount().createSession({ userId, secret: token.secret }));
    expect(reused).toMatchObject({ code: 401, type: 'user_invalid_token' });
    expect(classifyOtpError(reused, { expiresAt: new Date(Date.now() + 60_000).toISOString(), usedCodes: new Set([token.secret]), code: token.secret })).toBe('reused');
  });

  it('a wrong code is rejected with user_invalid_token', async () => {
    const err = await fail(guestAccount().createSession({ userId, secret: '000000' }));
    expect(err).toMatchObject({ code: 401, type: 'user_invalid_token' });
    expect(classifyOtpError(err, { expiresAt: new Date(Date.now() + 60_000).toISOString(), usedCodes: new Set(), code: '000000' })).toBe('invalid');
  });

  it('an expired code is rejected with the same error; the client identifies expiry from the token time', async () => {
    const token = await aw.users.createToken({ userId, length: 6, expire: 60 });
    await new Promise((r) => setTimeout(r, 63_000));
    const err = await fail(guestAccount().createSession({ userId, secret: token.secret }));
    expect(err).toMatchObject({ code: 401, type: 'user_invalid_token' });
    expect(classifyOtpError(err, { expiresAt: token.expire, usedCodes: new Set(), code: token.secret })).toBe('expired');
  }, 120_000);
});
