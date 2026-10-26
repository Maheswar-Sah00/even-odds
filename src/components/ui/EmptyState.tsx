import { Inbox, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function EmptyState({ icon: Icon = Inbox, title, children, actions }: { icon?: LucideIcon; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      <Icon className="empty__icon" size={32} aria-hidden="true" />
      <p className="empty__title">{title}</p>
      {children ? <div className="empty__body">{children}</div> : null}
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}
