import { Query } from 'appwrite';
import { Pencil, Plus, Ticket, Users } from 'lucide-react';
import { useCallback, useState, type SyntheticEvent } from 'react';
import { useAppwriteContext } from '../../app/AppwriteContext.ts';
import { AsyncView, NotConfiguredBanner } from '../../components/AsyncView.tsx';
import { Banner, Button, ButtonLink, Card, DataTable, Dialog, EmptyState, PageHeader, SelectField, StatusBadge, TextField } from '../../components/ui/index.ts';
import { childInputSchema, type ChildInput } from '@shared/household-input.ts';
import type { ServiceError } from '@shared/errors.ts';
import type { BrowserRow } from '../../lib/appwrite/db.ts';
import { FunctionError } from '../../lib/appwrite/functions.ts';
import { formatDate } from '../../lib/format.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { householdApi } from './household-api.ts';
import { useHousehold } from './useHousehold.ts';

type ChildRow = BrowserRow<'children'>;
type FieldErrors = Partial<Record<keyof ChildInput, string>>;

function ageToday(birthdate: string): number {
  const b = new Date(birthdate);
  const now = new Date();
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  if (now.getUTCMonth() < b.getUTCMonth() || (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

function ChildForm({ initial, submitLabel, onSubmit, onCancel }: { initial: ChildInput; submitLabel: string; onSubmit: (c: ChildInput) => Promise<void>; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const parsed = childInputSchema.safeParse(value);
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) next[issue.path[0] as keyof ChildInput] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    setFormError(null);
    setBusy(true);
    try {
      await onSubmit(parsed.data);
    } catch (err) {
      if (err instanceof FunctionError && err.field?.startsWith('child.')) {
        setErrors({ [err.field.slice(6)]: err.message });
      } else {
        setFormError((err as ServiceError).message);
      }
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof ChildInput) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setValue((v) => ({ ...v, [k]: e.target.value }));
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      {formError ? <Banner tone="error">{formError}</Banner> : null}
      <TextField label="First name" autoComplete="off" required value={value.firstName} error={errors.firstName ?? null} onChange={set('firstName')} />
      <TextField label="Last name" autoComplete="off" required value={value.lastName} error={errors.lastName ?? null} onChange={set('lastName')} />
      <TextField label="Date of birth" type="date" required value={value.birthdate} error={errors.birthdate ?? null} hint="Used to check age eligibility for each week." onChange={set('birthdate')} />
      <div className="row">
        <Button type="submit" loading={busy} loadingLabel="Saving…">
          {submitLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TicketControl({ child, programs, tickets, onChanged }: { child: ChildRow; programs: BrowserRow<'programs'>[]; tickets: BrowserRow<'tickets'>[]; onChanged: () => void }) {
  const { appwrite } = useAppwriteContext();
  const [programId, setProgramId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'warning' | 'error'; text: string } | null>(null);
  const entered = new Set(tickets.filter((t) => t.child_id === child.$id).map((t) => t.program_id));
  const available = programs.filter((p) => !entered.has(p.$id));
  if (!appwrite) return null;

  const register = async () => {
    if (!programId) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await householdApi(appwrite).registerTicket(programId, child.$id);
      if (result.status === 'possible_duplicate') {
        setMessage({
          tone: 'warning',
          text: `${child.first_name} appears to already have a ticket for this program through another household. To protect children's privacy we can't show any details. If their other parent or carer applied, ask them to send you an invite code so you share one household. We've let that household know.`,
        });
      } else {
        setMessage({ tone: 'success', text: `${child.first_name} has a ticket for this program.` });
        onChanged();
      }
    } catch (err) {
      setMessage({ tone: 'error', text: (err as ServiceError).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-sm">
      <div className="row">
        {programs
          .filter((p) => entered.has(p.$id))
          .map((p) => (
            <StatusBadge key={p.$id} tone="success">
              Ticket: {p.name}
            </StatusBadge>
          ))}
      </div>
      {available.length > 0 ? (
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <SelectField label={`Enter ${child.first_name} in a program`} value={programId} onChange={(e) => { setProgramId(e.target.value); }}>
            <option value="">Choose a program…</option>
            {available.map((p) => (
              <option key={p.$id} value={p.$id}>
                {p.name}
              </option>
            ))}
          </SelectField>
          <Button variant="secondary" disabled={!programId} loading={busy} loadingLabel="Checking…" icon={<Ticket size={16} aria-hidden="true" />} onClick={() => void register()}>
            Get ticket
          </Button>
        </div>
      ) : null}
      {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}
    </div>
  );
}

export function ChildrenPage() {
  const { appwrite, db } = useAppwriteContext();
  const household = useHousehold();
  const familyId = household.status === 'success' ? (household.data?.familyId ?? null) : null;
  const [dialog, setDialog] = useState<{ mode: 'add' } | { mode: 'edit'; child: ChildRow } | null>(null);

  const load = useCallback(async () => {
    if (!db || !familyId) throw new Error('not ready');
    const [children, tickets, programs] = await Promise.all([
      db.listRows('children', [Query.equal('family_id', familyId), Query.orderAsc('birthdate'), Query.limit(50)]),
      db.listRows('tickets', [Query.equal('family_id', familyId), Query.limit(200)]),
      db.listRows('programs', [Query.equal('status', 'open'), Query.limit(50)]),
    ]);
    return { children: children.rows, tickets: tickets.rows, programs: programs.rows };
  }, [db, familyId]);
  const data = useAsync(db && familyId ? load : null, familyId);

  if (!appwrite || !db) {
    return (
      <div className="stack">
        <PageHeader eyebrow="My family" title="Children" />
        <NotConfiguredBanner what="Your children" />
      </div>
    );
  }
  const api = householdApi(appwrite);

  return (
    <div className="stack">
      <PageHeader
        eyebrow="My family"
        title="Children"
        description="Children's details are visible only to your household's guardians. Organisers of a program see only a scrambled ticket for each child entered, never names or birthdays."
        actions={familyId ? <Button icon={<Plus size={18} aria-hidden="true" />} onClick={() => { setDialog({ mode: 'add' }); }}>Add a child</Button> : null}
      />
      <AsyncView state={household} loadingLabel="Loading your household…">
        {(h) =>
          h === null ? (
            <EmptyState icon={Users} title="Set up your household first" actions={<ButtonLink to="/family">Go to household overview</ButtonLink>}>
              Create a household, or join one with an invite code, before adding children.
            </EmptyState>
          ) : (
            <AsyncView state={data} loadingLabel="Loading children…">
              {({ children, tickets, programs }) =>
                children.length === 0 ? (
                  <EmptyState icon={Users} title="No children added yet" actions={<Button onClick={() => { setDialog({ mode: 'add' }); }}>Add a child</Button>}>
                    Add each child once; you can then enter them in programs.
                  </EmptyState>
                ) : (
                  <div className="stack">
                    <DataTable
                      caption="Children in your household"
                      hideCaption
                      rows={children}
                      rowKey={(c) => c.$id}
                      columns={[
                        { key: 'name', header: 'Name', render: (c) => `${c.first_name} ${c.last_name}` },
                        { key: 'dob', header: 'Date of birth', render: (c) => formatDate(c.birthdate) },
                        { key: 'age', header: 'Age', numeric: true, render: (c) => ageToday(c.birthdate) },
                        {
                          key: 'edit',
                          header: <span className="visually-hidden">Actions</span>,
                          render: (c) => (
                            <Button variant="ghost" size="sm" icon={<Pencil size={16} aria-hidden="true" />} onClick={() => { setDialog({ mode: 'edit', child: c }); }}>
                              Edit<span className="visually-hidden"> {c.first_name}</span>
                            </Button>
                          ),
                        },
                      ]}
                    />
                    {programs.length > 0 ? (
                      <Card title="Program tickets" description="One ticket per child per program. A second guardian cannot create a duplicate.">
                        <div className="stack">
                          {children.map((c) => (
                            <TicketControl key={c.$id} child={c} programs={programs} tickets={tickets} onChanged={data.reload} />
                          ))}
                        </div>
                      </Card>
                    ) : (
                      <p className="muted">No programs are accepting applications right now.</p>
                    )}
                  </div>
                )
              }
            </AsyncView>
          )
        }
      </AsyncView>

      <Dialog open={dialog !== null} onClose={() => { setDialog(null); }} title={dialog?.mode === 'edit' ? `Edit ${dialog.child.first_name}` : 'Add a child'}>
        {dialog ? (
          <ChildForm
            key={dialog.mode === 'edit' ? dialog.child.$id : 'new'}
            initial={dialog.mode === 'edit' ? { firstName: dialog.child.first_name, lastName: dialog.child.last_name, birthdate: dialog.child.birthdate.slice(0, 10) } : { firstName: '', lastName: '', birthdate: '' }}
            submitLabel={dialog.mode === 'edit' ? 'Save changes' : 'Add child'}
            onCancel={() => { setDialog(null); }}
            onSubmit={async (child) => {
              if (dialog.mode === 'edit') await api.updateChild(dialog.child.$id, child);
              else await api.addChild(child);
              setDialog(null);
              data.reload();
            }}
          />
        ) : null}
      </Dialog>
    </div>
  );
}
