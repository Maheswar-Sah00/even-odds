import { Plus, Trash2 } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { Banner, Button, SelectField, TextAreaField, TextField } from '../../components/ui/index.ts';
import { programDetailsSchema, type ProgramDetails } from '@shared/program-input.ts';
import type { ServiceError } from '@shared/errors.ts';
import { FunctionError } from '../../lib/appwrite/functions.ts';

const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'Asia/Kolkata', 'UTC'];

/** datetime-local works in the browser's timezone; convert explicitly both ways. */
const toLocalInput = (iso: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : '');

type Errors = Partial<Record<keyof ProgramDetails | 'form', string>>;

export function ProgramDetailsForm({ initial, submitLabel, onSubmit, disabled }: { initial: ProgramDetails; submitLabel: string; onSubmit: (d: ProgramDetails) => Promise<void>; disabled?: boolean }) {
  const [value, setValue] = useState<ProgramDetails>(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tiers = Object.entries(value.tierLabels).sort(([a], [b]) => Number(a) - Number(b));

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const parsed = programDetailsSchema.safeParse(value);
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) next[(issue.path[0] as keyof ProgramDetails | undefined) ?? 'form'] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await onSubmit(parsed.data);
    } catch (err) {
      const field = err instanceof FunctionError ? err.field?.split('.')[1] : undefined;
      setErrors(field ? { [field]: err instanceof Error ? err.message : '' } : { form: (err as ServiceError).message });
    } finally {
      setBusy(false);
    }
  };

  const setTier = (tier: string, label: string) => {
    setValue((v) => ({ ...v, tierLabels: { ...v.tierLabels, [tier]: label } }));
  };
  const addTier = () => {
    const next = String(Math.max(-1, ...Object.keys(value.tierLabels).map(Number)) + 1);
    if (Number(next) > 9) return;
    setTier(next, '');
  };
  const removeTier = (tier: string) => {
    setValue((v) => {
      const rest = Object.fromEntries(Object.entries(v.tierLabels).filter(([k]) => k !== tier));
      return { ...v, tierLabels: rest };
    });
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      {errors.form ? <Banner tone="error">{errors.form}</Banner> : null}
      <fieldset disabled={disabled === true || busy} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <TextField label="Program name" required value={value.name} error={errors.name ?? null} onChange={(e) => { setValue({ ...value, name: e.target.value }); }} />
        <TextAreaField label="Description" hint="Shown to families in the catalogue." value={value.description} error={errors.description ?? null} onChange={(e) => { setValue({ ...value, description: e.target.value }); }} />
        <SelectField label="Program timezone" hint="Used to display times to families." value={value.timezone} error={errors.timezone ?? null} onChange={(e) => { setValue({ ...value, timezone: e.target.value }); }}>
          {[...new Set([browserZone, ...TIMEZONES, value.timezone])].map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </SelectField>
        <div className="card-grid">
          <TextField label="Applications open" type="datetime-local" required hint={`In your browser's time (${browserZone}).`} value={toLocalInput(value.windowOpen)} error={errors.windowOpen ?? null} onChange={(e) => { setValue({ ...value, windowOpen: fromLocalInput(e.target.value) }); }} />
          <TextField label="Applications close" type="datetime-local" required hint="The draw runs after this time." value={toLocalInput(value.windowClose)} error={errors.windowClose ?? null} onChange={(e) => { setValue({ ...value, windowClose: fromLocalInput(e.target.value) }); }} />
          <TextField label="Maximum weeks per child" type="number" min={1} max={12} required value={String(value.maxWeeks)} error={errors.maxWeeks ?? null} onChange={(e) => { setValue({ ...value, maxWeeks: Number(e.target.value) }); }} />
        </div>

        <fieldset className="stack-sm" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-4)' }}>
          <legend className="field__label">Priority tiers</legend>
          <p className="field__hint" style={{ margin: 0 }}>Lower numbers draw first. Zones are assigned a tier on the map; homes outside every zone get the default tier.</p>
          {tiers.map(([tier, label]) => (
            <div key={tier} className="row" style={{ alignItems: 'flex-end' }}>
              <TextField label={`Tier ${tier} label`} value={label} onChange={(e) => { setTier(tier, e.target.value); }} />
              <Button variant="ghost" size="sm" icon={<Trash2 size={16} aria-hidden="true" />} onClick={() => { removeTier(tier); }} disabled={tiers.length <= 1}>
                Remove<span className="visually-hidden"> tier {tier}</span>
              </Button>
            </div>
          ))}
          <div>
            <Button variant="secondary" size="sm" icon={<Plus size={16} aria-hidden="true" />} onClick={addTier} disabled={tiers.length >= 10}>
              Add tier
            </Button>
          </div>
          <SelectField label="Default tier (homes outside every zone)" value={String(value.defaultTier)} error={errors.defaultTier ?? errors.tierLabels ?? null} onChange={(e) => { setValue({ ...value, defaultTier: Number(e.target.value) }); }}>
            {tiers.map(([tier, label]) => (
              <option key={tier} value={tier}>
                Tier {tier}: {label || '(no label)'}
              </option>
            ))}
          </SelectField>
        </fieldset>
        <div>
          <Button type="submit" loading={busy} loadingLabel="Saving…">
            {submitLabel}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
