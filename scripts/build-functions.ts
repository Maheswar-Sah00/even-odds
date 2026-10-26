/**
 * npm run functions:build [name...]
 * Bundles each functions/<name>/src/main.ts into a single ESM file
 * functions/<name>/dist/main.js (node-appwrite and zod inlined), plus a
 * dependency-free package.json, ready to upload as an Appwrite deployment.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'vite';

export const FUNCTIONS_DIR = resolve('functions');

export function listFunctionNames(): string[] {
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(FUNCTIONS_DIR, d.name, 'src', 'main.ts')))
    .map((d) => d.name);
}

export async function buildFunction(name: string): Promise<string> {
  const root = join(FUNCTIONS_DIR, name);
  const outDir = join(root, 'dist');
  await build({
    configFile: false,
    logLevel: 'warn',
    root,
    css: { postcss: {} },
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: join(root, 'src', 'main.ts'),
      outDir,
      emptyOutDir: true,
      target: 'node22',
      minify: false,
      sourcemap: false,
      rolldownOptions: { output: { format: 'es', entryFileNames: 'main.js', codeSplitting: false } },
    },
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ name: `even-odds-fn-${name}`, private: true, type: 'module', main: 'main.js' }, null, 2));
  return outDir;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('build-functions.ts')) {
  const requested = process.argv.slice(2);
  const names = requested.length > 0 ? requested : listFunctionNames();
  for (const name of names) {
    const out = await buildFunction(name);
    console.log(`built ${name} -> ${out}`);
  }
}
