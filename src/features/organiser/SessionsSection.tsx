import { Upload } from 'lucide-react';
import { useState } from 'react';
import { Banner, Button, Card, DataTable, TextAreaField, TextField } from '../../components/ui/index.ts';
import { parseSessionsCsv, SESSION_CSV_HEADERS, type RowIssue, type SessionImport } from '@shared/program-input.ts';
import type { ServiceError } from '@shared/errors.ts';
import type { BrowserAppwrite } from '../../lib/appwrite/client.ts';
import { formatDate } from '../../lib/format.ts';
import { consoleCalls, type ConsoleApi } from '../console/console-api.ts';
import type { Program, Session } from '../programs/program-view.ts';
import { organiserApi } from './organiser-api.ts';

const SAMPLE = `${SESSION_CSV_HEADERS.join(',')},label\n2027-W25,2027-06-21,5-7,5,7,18,"Week 1: Jun 21-25"\n2027-W25,2027-06-21,8-10,8,10,20,"Week 1: Jun 21-25"`;

function IssueTable({ caption, issues }: { caption: string; issues: RowIssue[] }) {
  return (
    <DataTable<RowIssue & { key: string }>
      caption={caption}
      rows={issues.map((i, n) => ({ ...i, key: String(n) }))}
      rowKey={(i) => i.key}
      columns={[
        { key: 'line', header: 'Line', numeric: true, render: (i) => (i.line > 0 ? i.line : '—') },
        { key: 'col', header: 'Column', render: (i) => i.column ?? '' },
        { key: 'msg', header: 'Problem', render: (i) => i.message },
      ]}
    />
  );
}

function CapacityCell({ api, program, session, onSaved }: { api: ConsoleApi; program: Program; session: Session; onSaved: () => void }) {
  const [value, setValue] = useState(String(session.capacity));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = program.status === 'draft' || program.status === 'open';
  if (!editable) return <>{session.capacity}</>;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // Privileged: logged with the actor in the staff log and the public audit log.
      await consoleCalls(api).setCapacity(session.$id, Number(value));
      onSaved();
    } catch (err) {
      setError((err as ServiceError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row" style={{ alignItems: 'flex-end', justifyContent: 'flex-end' }}>
      <TextField label={<span className="visually-hidden">Capacity for {session.week} {session.age_group}</span>} type="number" min={session.taken} max={10000} value={value} error={error} style={{ width: '6.5rem' }} onChange={(e) => { setValue(e.target.value); }} />
      <Button size="sm" variant="secondary" loading={busy} loadingLabel="Saving" disabled={value === String(session.capacity)} onClick={() => void save()}>
        Save
      </Button>
    </div>
  );
}

export function SessionsSection({ app, api, program, sessions, onChanged }: { app: BrowserAppwrite; api: ConsoleApi; program: Program; sessions: Session[]; onChanged: () => void }) {
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<SessionImport | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const draft = program.status === 'draft';

  const check = (text: string) => {
    setCsv(text);
    setResult(null);
    setPreview(text.trim() ? parseSessionsCsv(text) : null);
  };

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      // The server re-parses and re-validates; the local preview is only a convenience.
      const r = await organiserApi(app).importSessions(program.$id, csv, true);
      if (!r.committed) {
        setPreview(r);
        setError('The server found problems in this file. Nothing was imported.');
        return;
      }
      setResult(`Imported ${String(r.upserted ?? 0)} sessions${r.removed ? `; removed ${String(r.removed)} no longer listed` : ''}.`);
      setCsv('');
      setPreview(null);
      onChanged();
    } catch (err) {
      setError((err as ServiceError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Sessions" description="Each session is one week for one age group, with its own capacity.">
      <div className="stack">
        {sessions.length > 0 ? (
          <DataTable<Session>
            caption="Current sessions"
            rows={[...sessions].sort((a, b) => a.week_start.localeCompare(b.week_start) || a.min_age - b.min_age)}
            rowKey={(s) => s.$id}
            columns={[
              { key: 'week', header: 'Week', render: (s) => s.label ?? s.week },
              { key: 'start', header: 'Starts', render: (s) => formatDate(s.week_start) },
              { key: 'group', header: 'Ages', render: (s) => `${s.age_group} (${String(s.min_age)}–${String(s.max_age)})` },
              { key: 'taken', header: 'Taken', numeric: true, render: (s) => s.taken },
              { key: 'cap', header: 'Capacity', numeric: true, render: (s) => <CapacityCell api={api} program={program} session={s} onSaved={onChanged} /> },
            ]}
          />
        ) : (
          <p className="muted">No sessions yet. Import them from a CSV file below.</p>
        )}

        {draft ? (
          <div className="stack-sm">
            <h3>Import from CSV</h3>
            <p className="muted small" style={{ margin: 0 }}>
              Columns: <code>{SESSION_CSV_HEADERS.join(', ')}</code>, optional <code>label</code>. Importing replaces the current session list. Rows are checked before anything is saved.
            </p>
            <label className="btn btn--secondary btn--sm" style={{ width: 'fit-content' }}>
              <Upload size={16} aria-hidden="true" />
              <span>Choose CSV file</span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="visually-hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void file.text().then(check);
                }}
              />
            </label>
            <TextAreaField label="…or paste CSV" placeholder={SAMPLE} value={csv} onChange={(e) => { check(e.target.value); }} />
            {preview ? (
              <div className="stack-sm" aria-live="polite">
                <div className="stat-row">
                  <div className="stat"><span className="stat__value">{preview.summary.sessions}</span><span className="stat__label">valid sessions</span></div>
                  <div className="stat"><span className="stat__value">{preview.summary.weeks}</span><span className="stat__label">weeks</span></div>
                  <div className="stat"><span className="stat__value">{preview.summary.ageGroups}</span><span className="stat__label">age groups</span></div>
                  <div className="stat"><span className="stat__value">{preview.summary.totalCapacity}</span><span className="stat__label">total places</span></div>
                </div>
                {preview.errors.length > 0 ? <IssueTable caption={`${String(preview.errors.length)} problem(s) to fix before importing`} issues={preview.errors} /> : null}
                {preview.warnings.length > 0 ? <IssueTable caption="Warnings (import allowed)" issues={preview.warnings} /> : null}
                <div>
                  <Button disabled={preview.errors.length > 0 || preview.sessions.length === 0} loading={busy} loadingLabel="Importing…" onClick={() => void commit()}>
                    Import {preview.sessions.length} session{preview.sessions.length === 1 ? '' : 's'}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="muted small">The session list is fixed now that the program is published. Capacity can still be raised.</p>
        )}
        {error ? <Banner tone="error">{error}</Banner> : null}
        {result ? <Banner tone="success">{result}</Banner> : null}
      </div>
    </Card>
  );
}
