import { ID } from 'appwrite';
import { ArrowLeft, Mail } from 'lucide-react';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { useAppwriteContext } from '../../app/AppwriteContext.ts';
import { NotConfiguredBanner } from '../../components/AsyncView.tsx';
import { BrandMark } from '../../components/BrandMark.tsx';
import { Banner, Button, Card, LoadingState, PageHeader, TextField } from '../../components/ui/index.ts';
import { toServiceError } from '@shared/errors.ts';
import { useAuth } from './auth-context.ts';
import { classifyOtpError, OTP_MESSAGES, pendingOtpStore, RESEND_COOLDOWN_S, safeNext, type PendingOtp } from './otp.ts';

const emailSchema = z.email('Enter a valid email address, like name@example.com');
const codeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from the email');

function useCountdown(target: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (now >= target) return;
    const t = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, [now, target]);
  return Math.max(0, Math.ceil((target - now) / 1000));
}

export function SignInPage() {
  const { appwrite } = useAppwriteContext();
  const { state, refresh } = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const navigate = useNavigate();

  const [pending, setPending] = useState<PendingOtp | null>(() => pendingOtpStore.read());
  const [email, setEmail] = useState(pending?.email ?? '');
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const usedCodes = useRef(new Set<string>());
  const codeInput = useRef<HTMLInputElement>(null);
  const cooldown = useCountdown((pending?.sentAt ?? 0) + RESEND_COOLDOWN_S * 1000);

  useEffect(() => {
    if (pending) codeInput.current?.focus();
  }, [pending]);

  if (!appwrite) {
    return (
      <div className="page page--narrow">
        <PageHeader title="Sign in" />
        <NotConfiguredBanner what="Sign-in" />
      </div>
    );
  }
  if (state.status === 'loading') return <LoadingState label="Checking your session…" />;
  if (state.status === 'signed_in') return <Navigate to={next} replace />;

  const sendCode = async (address: string) => {
    setBusy(true);
    setFormError(null);
    try {
      // For a known email Appwrite returns the existing user's ID (verified), so ID.unique() is safe.
      const token = await appwrite.log.run('account.createEmailToken', () => appwrite.account.createEmailToken({ userId: pending?.userId ?? ID.unique(), email: address }));
      const value = { userId: token.userId, email: address, expiresAt: token.expire, sentAt: Date.now() };
      pendingOtpStore.write(value);
      setPending(value);
      setCode('');
      setNotice(`We sent a 6-digit code to ${address}. It expires in 15 minutes.`);
    } catch (err) {
      const mapped = toServiceError('createEmailToken', err).mapped;
      setFormError(mapped.kind === 'validation' ? 'That email address was not accepted. Check it and try again.' : mapped.message);
    } finally {
      setBusy(false);
    }
  };

  const onEmailSubmit = (e: SyntheticEvent) => {
    e.preventDefault();
    const parsed = emailSchema.safeParse(email.trim());
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? 'Enter a valid email');
      return;
    }
    setFieldError(null);
    void sendCode(parsed.data);
  };

  const onCodeSubmit = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (!pending) return;
    const parsed = codeSchema.safeParse(code.trim());
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? 'Enter the code');
      return;
    }
    setFieldError(null);
    setFormError(null);
    setBusy(true);
    try {
      await appwrite.account.createSession({ userId: pending.userId, secret: parsed.data });
      usedCodes.current.add(parsed.data);
      pendingOtpStore.write(null);
      await refresh();
      void navigate(next, { replace: true });
    } catch (err) {
      setFormError(OTP_MESSAGES[classifyOtpError(err, { expiresAt: pending.expiresAt, usedCodes: usedCodes.current, code: parsed.data })]);
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    pendingOtpStore.write(null);
    setPending(null);
    setCode('');
    setNotice(null);
    setFormError(null);
    setFieldError(null);
  };

  return (
    <div className="page auth">
      <div className="auth__panel">
        <div className="auth__head">
          <BrandMark className="auth__mark" size={44} />
          <h1>Sign in</h1>
          <p>Families sign in with a 6-digit code sent by email. No password needed; new emails get a new account.</p>
        </div>
        {formError ? <Banner tone="error" title="Sign-in problem">{formError}</Banner> : null}
        {notice && pending ? <Banner tone="info">{notice}</Banner> : null}

      <Card>
        {!pending ? (
          <form className="stack" onSubmit={onEmailSubmit} noValidate>
            <TextField
              label="Email address"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              value={email}
              error={fieldError}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
            />
            <Button type="submit" loading={busy} loadingLabel="Sending code…" icon={<Mail size={18} aria-hidden="true" />}>
              Email me a code
            </Button>
          </form>
        ) : (
          <form className="stack" onSubmit={(e) => void onCodeSubmit(e)} noValidate>
            <p>
              Code sent to <strong>{pending.email}</strong>.
            </p>
            <TextField
              ref={codeInput}
              label="6-digit code"
              hint="Check your inbox and spam folder."
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              required
              value={code}
              error={fieldError}
              onChange={(e) => {
                setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
              }}
            />
            <div className="row">
              <Button type="submit" loading={busy} loadingLabel="Signing in…">
                Sign in
              </Button>
              <Button variant="secondary" disabled={cooldown > 0 || busy} onClick={() => void sendCode(pending.email)}>
                {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
              </Button>
              <Button variant="ghost" onClick={startOver} icon={<ArrowLeft size={18} aria-hidden="true" />}>
                Use a different email
              </Button>
            </div>
          </form>
        )}
      </Card>
      </div>
      <p className="auth__aside">
        Just looking? <Link to="/demo">Open the judge demo</Link> without an account, or <Link to="/replay/demo-summer-2027">replay a published draw</Link>.
      </p>
    </div>
  );
}
