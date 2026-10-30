import type { ReactNode } from 'react';

/** `tone` colours the eyebrow by what the page is for (see the stage colours in global.css); purple when omitted. */
export function PageHeader({ eyebrow, title, description, actions, tone }: { eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode; tone?: 'purple' | 'cyan' | 'yellow' | 'green' | 'burgundy' | 'red' }) {
  return (
    <div className="page-header">
      <div>
        {eyebrow ? <p className="page-header__eyebrow" data-tone={tone}>{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p className="page-header__description">{description}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}
