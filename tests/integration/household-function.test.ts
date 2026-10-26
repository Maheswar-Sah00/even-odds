/**
 * The DEPLOYED household Function, called exactly as the browser calls it
 * (browser SDK createExecution with a real user session). Requires
 * `npm run functions:deploy` to have been run against this project.
 */
import { Client as BrowserClient, ExecutionMethod, Functions } from 'appwrite';
import { Query } from 'node-appwrite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FunctionResponse } from '../../functions/shared/function-runtime.ts';
import type { TableKey } from '../../shared/config.ts';
import { createSyntheticUser, db, serverEnv } from './helpers/server.ts';

type U = Awaited<ReturnType<typeof createSyntheticUser>>;
let A: U, B: U;
const families: string[] = [];

async function call<T>(client: BrowserClient, body: unknown): Promise<{ status: number; body: FunctionResponse<T> }> {
  const ex = await new Functions(client).createExecution({ functionId: 'api', body: JSON.stringify({ area: 'household', ...(body as object) }), async: false, method: ExecutionMethod.POST, headers: { 'content-type': 'application/json' } });
  return { status: ex.responseStatusCode, body: JSON.parse(ex.responseBody) as FunctionResponse<T> };
}

beforeAll(async () => {
  [A, B] = await Promise.all([createSyntheticUser('fnA'), createSyntheticUser('fnB')]);
});

afterAll(async () => {
  for (const familyId of families) {
    for (const table of ['children', 'guardians', 'families'] as TableKey[]) {
      const { rows } = await db.listRows(table, [Query.equal(table === 'families' ? '$id' : 'family_id', familyId), Query.limit(100)]);
      await Promise.all(rows.map((r) => db.deleteRow(table, r.$id)));
    }
  }
  await Promise.all([A.remove(), B.remove()]);
});

describe('household Function (deployed, called with real sessions)', () => {
  let childId = '';

  it('creates a household for the caller identified by the platform, not the request body', async () => {
    const res = await call<{ familyId: string; created: boolean }>(A.client, { action: 'createHousehold', userId: B.userId });
    expect(res.status).toBe(200);
    if (!res.body.ok) throw new Error(res.body.error.message);
    families.push(res.body.data.familyId);
    const guardian = await db.listRows('guardians', [Query.equal('family_id', res.body.data.familyId)]);
    expect(guardian.rows.map((g) => g.user_id)).toEqual([A.userId]);
  });

  it('adds a child and reports field-level validation errors', async () => {
    const bad = await call(A.client, { action: 'addChild', child: { firstName: 'Ada', lastName: 'Lovelace', birthdate: '2018-02-30' } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ ok: false, error: { code: 'validation', field: 'child.birthdate' } });

    const good = await call<{ $id: string }>(A.client, { action: 'addChild', child: { firstName: 'Ada', lastName: 'Lovelace', birthdate: '2018-12-10' } });
    expect(good.status).toBe(200);
    if (!good.body.ok) throw new Error(good.body.error.message);
    childId = good.body.data.$id;
  });

  it("refuses to edit another household's child, without revealing that it exists", async () => {
    const res = await call(B.client, { action: 'updateChild', childId, child: { firstName: 'X', lastName: 'Y', birthdate: '2018-12-10' } });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('rejects unknown actions and guests', async () => {
    const unknown = await call(A.client, { action: 'deleteEverything' });
    expect(unknown.status).toBe(400);
    const guest = new BrowserClient().setEndpoint(serverEnv.endpoint).setProject(serverEnv.projectId);
    await expect(call(guest, { action: 'get' })).rejects.toMatchObject({ code: 401 });
  });

  it('returns the household summary, including guardian emails, only to members', async () => {
    const res = await call<{ guardians: { email: string; isYou: boolean }[] }>(A.client, { action: 'get' });
    if (!res.body.ok) throw new Error(res.body.error.message);
    expect(res.body.data.guardians).toHaveLength(1);
    expect(res.body.data.guardians[0]).toMatchObject({ isYou: true });
    const other = await call(B.client, { action: 'get' });
    expect(other.body).toEqual({ ok: true, data: null });
  });
});
