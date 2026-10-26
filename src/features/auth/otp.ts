import { isAppwriteLike } from '@shared/errors.ts';

/**
 * Appwrite returns the SAME error (401 user_invalid_token) for a wrong,
 * expired or already-used code (verified on Cloud). So the client classifies:
 *  - expired: the token's own `expire` time (from createEmailToken) has passed;
 *  - reused: this browser already signed in successfully with this exact code;
 *  - invalid: anything else (mistyped, or superseded by a newer code).
 */
export type OtpErrorKind = 'invalid' | 'expired' | 'reused' | 'rate_limited' | 'network' | 'unknown';

export function classifyOtpError(err: unknown, ctx: { expiresAt: string; usedCodes: ReadonlySet<string>; code: string }, now = Date.now()): OtpErrorKind {
  if (err instanceof TypeError) return 'network';
  if (!isAppwriteLike(err)) return 'unknown';
  if (err.code === 429) return 'rate_limited';
  if (err.code === 401 && err.type === 'user_invalid_token') {
    if (ctx.usedCodes.has(ctx.code)) return 'reused';
    if (now >= new Date(ctx.expiresAt).getTime()) return 'expired';
    return 'invalid';
  }
  return 'unknown';
}

export const OTP_MESSAGES: Record<OtpErrorKind, string> = {
  invalid: "That code didn't work. Check the 6 digits in your latest email and try again. Requesting a new code replaces the old one.",
  expired: 'This code has expired (codes last 15 minutes). Request a new code.',
  reused: 'This code has already been used. Request a new code to sign in again.',
  rate_limited: 'Too many attempts. Please wait a few minutes before trying again.',
  network: 'Could not reach the sign-in service. Check your connection and try again.',
  unknown: 'Sign-in failed. Please request a new code and try again.',
};

/** Seconds a user must wait before requesting another code. */
export const RESEND_COOLDOWN_S = 60;

export interface PendingOtp {
  userId: string;
  email: string;
  expiresAt: string;
  sentAt: number;
}

const KEY = 'even-odds:pending-otp';

/** Survives a reload of the sign-in page; cleared on success. Never stores the code itself. */
export const pendingOtpStore = {
  read(): PendingOtp | null {
    try {
      const raw = sessionStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as PendingOtp) : null;
    } catch {
      return null;
    }
  },
  write(value: PendingOtp | null) {
    try {
      if (value) sessionStorage.setItem(KEY, JSON.stringify(value));
      else sessionStorage.removeItem(KEY);
    } catch {
      /* storage unavailable: the flow still works within this page load */
    }
  },
};

/** Only same-site paths are accepted as a post-sign-in destination. */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/family';
}
