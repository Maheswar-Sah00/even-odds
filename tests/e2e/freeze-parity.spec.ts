import { expect, test } from '@playwright/test';
import { DRAW_ALGORITHM } from '../../shared/draw/index.ts';
import { SAMPLE_INPUTS } from '../../shared/draw/sample.ts';
import { frozenInputsHash, serializeFrozenInputs } from '../../shared/freeze/canonical.ts';
import { deriveSeed, DRAND_CHAIN } from '../../shared/freeze/drand.ts';
import { DEFAULT_CHAIN_1000000, QUICKNET_1000000, QUICKNET_12345678 } from '../fixtures/drand-beacons.ts';

/**
 * Node.js vs browser parity for the freeze protocol: Chromium loads the SAME
 * shared/freeze sources through the Vite dev server (with the real
 * drand-client and its BLS code) and must agree with Node on canonical
 * bytes, hashes, beacon verification and seed derivation. Offline: the
 * beacons are stored real drand responses.
 */
test('the browser verifies drand beacons and canonical inputs exactly like Node.js', async ({ page }) => {
  await page.goto('/');
  const text = serializeFrozenInputs(SAMPLE_INPUTS);
  const node = {
    text,
    hash: frozenInputsHash(text),
    seed: deriveSeed({ chainHash: DRAND_CHAIN.hash, round: QUICKNET_1000000.round, randomness: QUICKNET_1000000.randomness, inputsHash: frozenInputsHash(text), programId: 'synthetic-sample' }),
  };
  expect(text).toContain(DRAW_ALGORITHM);

  const browser = await page.evaluate(
    async ({ sample, good, other, foreign }) => {
      const canonicalPath = '/shared/freeze/canonical.ts';
      const drandPath = '/shared/freeze/drand.ts';
      const c = (await import(/* @vite-ignore */ canonicalPath)) as typeof import('../../shared/freeze/canonical.ts');
      const d = (await import(/* @vite-ignore */ drandPath)) as typeof import('../../shared/freeze/drand.ts');
      const t = c.serializeFrozenInputs(sample);
      const hash = c.frozenInputsHash(t);
      const flipped = { ...good, signature: good.signature.replace(/^8/, '9') };
      return {
        text: t,
        hash,
        reparsed: c.parseFrozenInputs(t).hash,
        seed: d.deriveSeed({ chainHash: d.DRAND_CHAIN.hash, round: good.round, randomness: good.randomness, inputsHash: hash, programId: 'synthetic-sample' }),
        valid: [(await d.verifyBeacon(good, good.round)).ok, (await d.verifyBeacon(other, other.round)).ok],
        invalid: [
          (await d.verifyBeacon(flipped, good.round)).ok,
          (await d.verifyBeacon(other, good.round)).ok,
          (await d.verifyBeacon({ ...good, randomness: other.randomness }, good.round)).ok,
          (await d.verifyBeacon(foreign, foreign.round)).ok,
        ],
      };
    },
    { sample: SAMPLE_INPUTS, good: QUICKNET_1000000, other: QUICKNET_12345678, foreign: DEFAULT_CHAIN_1000000 },
  );

  expect(browser.text).toBe(node.text);
  expect(browser.hash).toBe(node.hash);
  expect(browser.reparsed).toBe(node.hash);
  expect(browser.seed).toBe(node.seed);
  expect(browser.valid).toEqual([true, true]);
  expect(browser.invalid).toEqual([false, false, false, false]);
});
