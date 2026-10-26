/**
 * Normalisation of child identity inputs for the duplicate-ticket key.
 * Pure and deterministic so it can be unit tested and documented; the keyed
 * hash itself (functions/shared/child-key.ts) runs only on the server.
 */

/** Case-, accent-, punctuation- and whitespace-insensitive form of a name. */
export function normaliseName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Accepts YYYY-MM-DD or an ISO datetime; returns YYYY-MM-DD or throws for impossible dates. */
export function normaliseBirthdate(input: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(input.trim());
  if (!match) throw new Error('birthdate must start with YYYY-MM-DD');
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) {
    throw new Error('birthdate is not a real calendar date');
  }
  return `${y}-${m}-${d}`;
}

export interface ChildIdentity {
  programId: string;
  firstName: string;
  lastName: string;
  birthdate: string;
}

/** The exact message that is HMAC'd. Versioned so the format can change safely. */
export function childIdentityMessage(identity: ChildIdentity): string {
  const first = normaliseName(identity.firstName);
  const last = normaliseName(identity.lastName);
  if (!first || !last) throw new Error('first and last name must contain letters or digits');
  return ['child-key-v1', identity.programId, first, last, normaliseBirthdate(identity.birthdate)].join('\n');
}
