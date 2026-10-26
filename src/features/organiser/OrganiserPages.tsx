import { Query } from 'appwrite';
import { ClipboardList, Plus } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAppwriteContext } from '../../app/AppwriteContext.ts';
import { AsyncView, NotConfiguredBanner } from '../../components/AsyncView.tsx';
import { Button, DataTable, Dialog, EmptyState, PageHeader, StatusBadge, SyntheticBadge } from '../../components/ui/index.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { PHASE_LABEL, PHASE_TONE, phaseOf, type Program } from '../programs/program-view.ts';
import { organiserApi } from './organiser-api.ts';
import { emptyDetails } from './program-defaults.ts';
import { ProgramDetailsForm } from './ProgramDetailsForm.tsx';

export { OrganiserProgramPage } from './OrganiserProgramPage.tsx';

export function OrganiserDashboardPage() {
  const { appwrite, db } = useAppwriteContext();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  // Organisers can read their team's programs, drafts included, through row permissions.
  const load = useCallback(() => (db ? db.listRows('programs', [Query.orderDesc('$createdAt'), Query.limit(100)]) : Promise.reject(new Error('not configured'))), [db]);
  const state = useAsync(db ? load : null, db);

  if (!appwrite || !db) {
    return (
      <div className="stack">
        <PageHeader eyebrow="Organiser" title="Dashboard" />
        <NotConfiguredBanner what="The organiser dashboard" />
      </div>
    );
  }

  return (
    <div className="stack">
      <PageHeader
        eyebrow="Organiser"
        title="Dashboard"
        description="Programs your team organises. Drafts are visible only to organisers until you publish them."
        actions={<Button icon={<Plus size={18} aria-hidden="true" />} onClick={() => { setCreating(true); }}>New program</Button>}
      />
      <AsyncView state={state} loadingLabel="Loading programs…">
        {(list) => (
          <DataTable<Program>
            caption="Your programs"
            hideCaption
            rows={list.rows}
            rowKey={(p) => p.$id}
            empty={
              <EmptyState icon={ClipboardList} title="No programs yet" actions={<Button onClick={() => { setCreating(true); }}>Create your first program</Button>}>
                Create a program, import its sessions, draw priority zones, then publish it to the catalogue.
              </EmptyState>
            }
            columns={[
              { key: 'name', header: 'Program', render: (p) => <Link to={`/organiser/programs/${p.$id}`}>{p.name}</Link> },
              {
                key: 'status',
                header: 'Status',
                render: (p) => (
                  <span className="row">
                    <StatusBadge tone={PHASE_TONE[phaseOf(p)]}>{PHASE_LABEL[phaseOf(p)]}</StatusBadge>
                    {p.synthetic ? <SyntheticBadge /> : null}
                  </span>
                ),
              },
              { key: 'close', header: 'Applications close', render: (p) => formatDateTime(p.window_close, p.timezone) },
            ]}
          />
        )}
      </AsyncView>
      <Dialog open={creating} onClose={() => { setCreating(false); }} title="New program">
        {creating ? (
          <ProgramDetailsForm
            initial={emptyDetails()}
            submitLabel="Create draft"
            onSubmit={async (details) => {
              const created = await organiserApi(appwrite).createProgram(details);
              setCreating(false);
              void navigate(`/organiser/programs/${created.$id}`);
            }}
          />
        ) : null}
      </Dialog>
    </div>
  );
}
