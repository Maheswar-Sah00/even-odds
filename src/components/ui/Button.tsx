import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { Spinner } from './Loading.tsx';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface StyleProps {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  icon?: ReactNode;
}

const classes = ({ variant = 'primary', size = 'md', block }: StyleProps, extra?: string) =>
  ['btn', `btn--${variant}`, size === 'md' ? '' : `btn--${size}`, block ? 'btn--block' : '', extra ?? ''].filter(Boolean).join(' ');

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, StyleProps {
  /** Shows a spinner, disables the button and announces the busy state. */
  loading?: boolean;
  loadingLabel?: string;
}

export function Button({ variant, size, block, icon, loading = false, loadingLabel, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={classes({ variant, size, block }, className)}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : icon}
      <span>{loading && loadingLabel ? loadingLabel : children}</span>
    </button>
  );
}

export interface ButtonLinkProps extends LinkProps, StyleProps {}

/** A navigation link styled as a button. Use for navigation, Button for actions. */
export function ButtonLink({ variant, size, block, icon, className, children, ...rest }: ButtonLinkProps) {
  return (
    <Link className={classes({ variant, size, block }, className)} {...rest}>
      {icon}
      <span>{children}</span>
    </Link>
  );
}
