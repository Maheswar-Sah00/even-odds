import { parsePublicEnv } from '@shared/env.ts';

/** Validated browser configuration, computed once at startup. Never throws. */
export const envResult = parsePublicEnv(import.meta.env);
