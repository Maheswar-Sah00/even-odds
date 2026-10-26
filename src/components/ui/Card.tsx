import type { ReactNode } from 'react';

interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  /** Heading level for the title, to keep the document outline correct. */
  headingLevel?: 2 | 3;
  className?: string;
  as?: 'section' | 'article' | 'div';
}

export function Card({ title, description, actions, children, headingLevel = 2, className, as: Tag = 'section' }: CardProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <Tag className={['card', className].filter(Boolean).join(' ')}>
      {title || actions ? (
        <div className="card__header">
          <div>
            {title ? <Heading>{title}</Heading> : null}
            {description ? <p className="card__description">{description}</p> : null}
          </div>
          {actions ? <div className="row">{actions}</div> : null}
        </div>
      ) : null}
      {children ? <div className="card__body">{children}</div> : null}
    </Tag>
  );
}
