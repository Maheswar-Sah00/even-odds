import { useId, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  numeric?: boolean;
  /** Extra class on the column's header and cells (e.g. 'cell-actions'). */
  className?: string;
}

interface DataTableProps<T> {
  caption: ReactNode;
  /** Visually hide the caption but keep it for screen readers. */
  hideCaption?: boolean;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
}

const cellClass = (c: { numeric?: boolean; className?: string }) => [c.numeric ? 'num' : '', c.className ?? ''].filter(Boolean).join(' ') || undefined;

/** Semantic, horizontally scrollable table. Renders `empty` when there are no rows. */
export function DataTable<T>({ caption, hideCaption, columns, rows, rowKey, empty }: DataTableProps<T>) {
  const captionId = useId();
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-labelledby={captionId}>
      <table className="table">
        <caption id={captionId} className={hideCaption ? 'visually-hidden' : undefined}>
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cellClass(c)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => (
                <td key={c.key} className={cellClass(c)}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
