import { CircleAlert } from 'lucide-react';
import { useId, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

interface FieldChrome {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
}

function FieldWrapper({ id, label, hint, error, required, children }: FieldChrome & { id: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {required ? (
          <>
            {' '}
            <span className="field__required" aria-hidden="true">*</span>
            <span className="visually-hidden">(required)</span>
          </>
        ) : null}
      </label>
      {hint ? (
        <span className="field__hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {children}
      {error ? (
        <span className="field__error" id={`${id}-error`}>
          <CircleAlert size={14} aria-hidden="true" />
          {error}
        </span>
      ) : null}
    </div>
  );
}

const describedBy = (id: string, hint: unknown, error: unknown) =>
  [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;

export type TextFieldProps = FieldChrome & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & { id?: string; ref?: Ref<HTMLInputElement> };

/** Labelled input with hint and error text wired to aria-describedby. */
export function TextField({ label, hint, error, required, id: idProp, className, ...input }: TextFieldProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  return (
    <FieldWrapper id={id} label={label} hint={hint} error={error ?? null} required={required ?? false}>
      <input
        id={id}
        className={['field__control', className].filter(Boolean).join(' ')}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...input}
      />
    </FieldWrapper>
  );
}

export type SelectFieldProps = FieldChrome & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> & { id?: string };

export function SelectField({ label, hint, error, required, id: idProp, className, children, ...select }: SelectFieldProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  return (
    <FieldWrapper id={id} label={label} hint={hint} error={error ?? null} required={required ?? false}>
      <select
        id={id}
        className={['field__control', className].filter(Boolean).join(' ')}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...select}
      >
        {children}
      </select>
    </FieldWrapper>
  );
}

export type TextAreaFieldProps = FieldChrome & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> & { id?: string };

export function TextAreaField({ label, hint, error, required, id: idProp, className, ...rest }: TextAreaFieldProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  return (
    <FieldWrapper id={id} label={label} hint={hint} error={error ?? null} required={required ?? false}>
      <textarea
        id={id}
        className={['field__control', 'textarea', className].filter(Boolean).join(' ')}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      />
    </FieldWrapper>
  );
}
