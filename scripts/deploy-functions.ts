/**
 * npm run functions:deploy [name...]
 * Builds, configures and deploys Appwrite Functions from functions/<name>.
 * Function settings come from FUNCTION_CONFIG below; secrets come from
 * .env.server and are stored as function variables (never in the bundle).
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DeploymentStatus, Functions, type Models, ProjectKeyScopes, Runtime } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';
import { createServerAppwrite } from '../functions/shared/appwrite-server.ts';
import { formatEnvIssues, loadServerEnv } from '../functions/shared/server-env.ts';
import { buildFunction, listFunctionNames } from './build-functions.ts';

interface FunctionConfig {
  name: string;
  /** Who may execute. Callers are re-checked inside the function. */
  execute: string[];
  scopes: ProjectKeyScopes[];
  timeout: number;
  /** Minutes between scheduled runs. The Free plan supports intervals only (no cron), minimum 60. */
  intervalMinutes?: number;
  /** Names of .env.server values to expose as function variables. */
  variables: string[];
}

const DB_SCOPES = [ProjectKeyScopes.RowsRead, ProjectKeyScopes.RowsWrite, ProjectKeyScopes.TablesRead];

/**
 * The Free plan allows only 2 Functions per project (verified: a third returns
 * 403 additional_resource_not_allowed), so all user requests share "api"
 * (routed by body.area) and all scheduled work shares "jobs".
 */
export const FUNCTION_CONFIG: Record<string, FunctionConfig> = {
  api: {
    name: 'API (household, applications, organiser, offers, console, demo)',
    execute: ['users'],
    // teams.write: the judge sandbox creates its private per-visitor Team (functions/shared/sandbox.ts).
    scopes: [...DB_SCOPES, ProjectKeyScopes.UsersRead, ProjectKeyScopes.TeamsRead, ProjectKeyScopes.TeamsWrite],
    timeout: 30,
    variables: ['APPWRITE_DATABASE_ID', 'CHILD_KEY_SECRET', 'APPWRITE_ORGANISER_TEAM_ID'],
  },
  jobs: {
    name: 'Jobs (hourly: odds, freeze, draw, offers, sandbox clean-up)',
    execute: ['users'],
    // teams.write: idle judge sandboxes are removed together with their Team.
    scopes: [...DB_SCOPES, ProjectKeyScopes.TeamsRead, ProjectKeyScopes.TeamsWrite],
    timeout: 120,
    intervalMinutes: 60,
    variables: ['APPWRITE_DATABASE_ID', 'APPWRITE_ORGANISER_TEAM_ID'],
  },
};

const env = loadServerEnv();
if (!env.ok) {
  console.error(formatEnvIssues(env.issues));
  process.exit(2);
}
const aw = createServerAppwrite(env.config, { sink: null });
const functions = new Functions(aw.client);

async function ensureFunction(id: string, cfg: FunctionConfig) {
  const common = {
    functionId: id,
    name: cfg.name,
    runtime: Runtime.Node22,
    execute: cfg.execute,
    scopes: cfg.scopes,
    timeout: cfg.timeout,
    entrypoint: 'main.js',
    commands: '',
    logging: true,
    ...(cfg.intervalMinutes ? { interval: cfg.intervalMinutes } : {}),
  };
  try {
    await functions.get({ functionId: id });
    await functions.update(common);
    console.log(`  updated settings for ${id}`);
  } catch (err) {
    if ((err as { code?: number }).code !== 404) throw err;
    await functions.create(common);
    console.log(`  created function ${id}`);
  }

  const existing = await functions.listVariables({ functionId: id });
  for (const key of cfg.variables) {
    const value = process.env[key];
    if (!value) {
      console.warn(`  WARNING: ${key} is not set in .env.server; the function will report it as missing`);
      continue;
    }
    const found = existing.variables.find((v) => v.key === key);
    if (found) await functions.updateVariable({ functionId: id, variableId: found.$id, key, value, secret: true });
    else await functions.createVariable({ functionId: id, variableId: `${id}-${key.toLowerCase().replace(/_/g, '-')}`.slice(0, 36), key, value, secret: true });
  }
}

async function deploy(id: string): Promise<Models.Deployment> {
  const outDir = await buildFunction(id);
  // Relative paths only: GNU tar treats "C:" in an absolute Windows path as a remote host.
  const archive = join(outDir, '..', 'deployment.tar.gz');
  execFileSync('tar', ['-czf', '../deployment.tar.gz', '.'], { cwd: outDir });
  let deployment = await functions.createDeployment({ functionId: id, code: InputFile.fromPath(archive, `${id}.tar.gz`), activate: true });
  const deadline = Date.now() + 180_000;
  while (![DeploymentStatus.Ready, DeploymentStatus.Failed, DeploymentStatus.Canceled].includes(deployment.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    deployment = await functions.getDeployment({ functionId: id, deploymentId: deployment.$id });
  }
  return deployment;
}

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : listFunctionNames();
let failed = false;
for (const id of names) {
  const cfg = FUNCTION_CONFIG[id];
  if (!cfg) {
    console.error(`No FUNCTION_CONFIG entry for "${id}"`);
    failed = true;
    continue;
  }
  console.log(`Deploying ${id}…`);
  await ensureFunction(id, cfg);
  const d = await deploy(id);
  console.log(`  deployment ${d.$id}: ${d.status}`);
  if (d.status !== DeploymentStatus.Ready) {
    console.error(d.buildLogs.slice(-2000));
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
