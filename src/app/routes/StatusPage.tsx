import { RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ConfigErrorPanel } from '../../components/ConfigErrorPanel.tsx';
import { Button, Card, LoadingState, PageHeader, StatusBadge, type Tone } from '../../components/ui/index.ts';
import { runDiagnostics, type DiagnosticCheck } from '../../lib/appwrite/diagnostics.ts';
import { useAppwriteContext } from '../AppwriteContext.ts';

type RunState = { phase: 'running' } | { phase: 'done'; checks: DiagnosticCheck[]; at: Date };

const STATUS: Record<DiagnosticCheck['status'], { label: string; tone: Tone }> = {
  ok: { label: 'OK', tone: 'success' },
  warn: { label: 'Needs setup', tone: 'pending' },
  fail: { label: 'Failed', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

function summarise(checks: DiagnosticCheck[]): { tone: Tone; text: string } {
  if (checks.some((c) => c.status === 'fail')) return { tone: 'danger', text: 'Not connected' };
  if (checks.some((c) => c.status === 'warn')) return { tone: 'pending', text: 'Connected, setup incomplete' };
  return { tone: 'success', text: 'Connected to Appwrite' };
}

export function StatusPage() {
  const { env, appwrite } = useAppwriteContext();
  const [state, setState] = useState<RunState>({ phase: 'running' });
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    if (!appwrite) return;
    let current = true;
    void runDiagnostics(appwrite).then((checks) => {
      if (current) setState({ phase: 'done', checks, at: new Date() });
    });
    return () => {
      current = false;
    };
  }, [appwrite, runId]);

  const rerun = useCallback(() => {
    setState({ phase: 'running' });
    setRunId((id) => id + 1);
  }, []);

  if (!env.ok) {
    return (
      <div className="page page--narrow stack">
        <PageHeader title="System status" />
        <p>
          <StatusBadge tone="danger">Configuration missing: no connection attempted</StatusBadge>
        </p>
        <ConfigErrorPanel issues={env.issues} />
      </div>
    );
  }

  const { config } = env;
  const summary = state.phase === 'done' ? summarise(state.checks) : null;

  return (
    <div className="page page--narrow stack">
      <PageHeader eyebrow="Diagnostics" title="System status" description="Live checks of the connection between this app and Appwrite." />
      <p aria-live="polite">
        {summary ? <StatusBadge tone={summary.tone}>{summary.text}</StatusBadge> : <StatusBadge tone="pending">Checking connection…</StatusBadge>}
      </p>

      <Card title="Configuration">
        <dl className="kv">
          <dt>Endpoint</dt>
          <dd><code>{config.endpoint}</code></dd>
          <dt>Project ID</dt>
          <dd><code>{config.projectId}</code></dd>
          <dt>Database ID</dt>
          <dd><code>{config.databaseId}</code></dd>
          <dt>Organiser team</dt>
          <dd>{config.organiserTeamId ? <code>{config.organiserTeamId}</code> : 'Not set (optional)'}</dd>
        </dl>
      </Card>

      <Card
        title="Live checks"
        actions={
          <Button variant="secondary" size="sm" onClick={rerun} loading={state.phase === 'running'} loadingLabel="Checking…" icon={<RotateCcw size={16} aria-hidden="true" />}>
            Run again
          </Button>
        }
      >
        {state.phase === 'running' ? (
          <LoadingState label="Contacting Appwrite…" />
        ) : (
          <div className="stack-sm">
            <ul className="check-list">
              {state.checks.map((check) => (
                <li key={check.id} className="check">
                  <StatusBadge tone={STATUS[check.status].tone}>{STATUS[check.status].label}</StatusBadge>
                  <strong>{check.label}</strong>
                  <span className="check__detail">
                    {check.detail}
                    {check.errorType ? <> <code>{check.errorType}</code></> : null}
                    {check.ms === undefined ? null : <span> · {check.ms} ms</span>}
                  </span>
                </li>
              ))}
            </ul>
            <p className="muted small">
              Last checked {state.at.toLocaleTimeString()}. Checks run as a guest; no API key is used in the browser.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
