import { CircleAlert, CircleCheck, FlaskConical, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

type BannerTone = 'info' | 'success' | 'warning' | 'error' | 'demo';

const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert, demo: FlaskConical } as const;

interface BannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}

/**
 * Page- or section-level message. Errors use role="alert" so screen readers
 * announce them; other tones use role="status".
 */
export function Banner({ tone = 'info', title, children, actions }: BannerProps) {
  const Icon = ICONS[tone];
  return (
    <div className={`banner banner--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon className="banner__icon" size={20} aria-hidden="true" />
      <div className="banner__body stack-sm">
        {title ? <p className="banner__title">{title}</p> : null}
        {children ? <div>{children}</div> : null}
        {actions ? <div className="row">{actions}</div> : null}
      </div>
    </div>
  );
}

/** States plainly that a screen is a placeholder for functionality not yet connected. */
export function NotConnectedBanner({ feature, task }: { feature: string; task: string }) {
  return (
    <Banner tone="demo" title="Placeholder: not yet connected">
      {feature} is built in {task}. Nothing on this screen reads or writes live data yet.
    </Banner>
  );
}
