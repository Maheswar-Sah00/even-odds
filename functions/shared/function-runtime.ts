import { ZodError } from 'zod';
import { ServiceError } from '../../shared/errors.ts';
import type { LogSink } from '../../shared/log.ts';
import { AppError } from './app-error.ts';
import { createServerAppwrite, type ServerAppwrite } from './appwrite-server.ts';

/** The subset of the Appwrite Node runtime context we use. */
export interface FunctionContext {
  req: { headers: Record<string, string | undefined>; bodyText?: string; method: string };
  res: { json: (body: unknown, status?: number) => unknown };
  log: (message: string) => void;
  error: (message: string) => void;
}

export type FunctionResponse<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; field?: string } };

export interface HandlerInput {
  /** Set by the platform from the caller's session; clients cannot forge x-appwrite-* headers. */
  userId: string | null;
  /** Set by the platform (x-appwrite-client-ip; verified present, and clients cannot send x-appwrite-* headers). */
  clientIp: string | null;
  body: unknown;
  aw: ServerAppwrite;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Function variable ${name} is not configured`);
  return value;
}

/**
 * Wraps a handler: builds a server client from the per-execution dynamic API
 * key, parses JSON, and turns every outcome into a JSON envelope. Only
 * AppError and validation messages reach the caller; anything else is logged
 * and reported as a generic server error.
 */
export async function runFunction<T>(ctx: FunctionContext, handler: (input: HandlerInput) => Promise<T>): Promise<unknown> {
  const sink: LogSink = (e) => {
    if (!e.ok) ctx.log(`[db] ${e.operation} failed ${e.errorKind ?? ''} ${e.errorType ?? ''} ${e.ms}ms`);
  };
  try {
    const scheduled = ctx.req.headers['x-appwrite-trigger'] === 'schedule';
    if (ctx.req.method !== 'POST' && !scheduled) throw new AppError('validation', 'Use POST.');
    let body: unknown;
    try {
      body = ctx.req.bodyText ? JSON.parse(ctx.req.bodyText) : {};
    } catch {
      throw new AppError('validation', 'The request body must be JSON.');
    }
    const aw = createServerAppwrite(
      {
        endpoint: requireEnv('APPWRITE_FUNCTION_API_ENDPOINT'),
        projectId: requireEnv('APPWRITE_FUNCTION_PROJECT_ID'),
        apiKey: ctx.req.headers['x-appwrite-key'] ?? '',
        databaseId: requireEnv('APPWRITE_DATABASE_ID'),
      },
      { sink },
    );
    const userId = ctx.req.headers['x-appwrite-user-id'] || null;
    const clientIp = ctx.req.headers['x-appwrite-client-ip'] || null;
    const data = await handler({ userId, clientIp, body, aw });
    return ctx.res.json({ ok: true, data } satisfies FunctionResponse<T>, 200);
  } catch (err) {
    if (err instanceof AppError) {
      return ctx.res.json({ ok: false, error: { code: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) } } satisfies FunctionResponse<never>, err.status);
    }
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const field = issue?.path.join('.');
      return ctx.res.json({ ok: false, error: { code: 'validation', message: issue?.message ?? 'Invalid request.', ...(field ? { field } : {}) } } satisfies FunctionResponse<never>, 400);
    }
    if (err instanceof ServiceError) {
      ctx.error(`${err.operation}: ${err.mapped.kind} ${err.mapped.type ?? ''} ${err.detail ?? ''}`);
      const retry = err.mapped.retryable;
      return ctx.res.json({ ok: false, error: { code: retry ? 'retry' : 'server', message: retry ? 'The service was busy. Please try again.' : 'Something went wrong on our side.' } } satisfies FunctionResponse<never>, retry ? 503 : 500);
    }
    ctx.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return ctx.res.json({ ok: false, error: { code: 'server', message: 'Something went wrong on our side.' } } satisfies FunctionResponse<never>, 500);
  }
}

export function requireUser(userId: string | null): string {
  if (!userId) throw new AppError('unauthorized', 'Please sign in to continue.');
  return userId;
}
