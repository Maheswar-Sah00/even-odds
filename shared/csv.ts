/**
 * Minimal RFC 4180 CSV parser: quoted fields, escaped quotes (""), commas and
 * newlines inside quotes, CRLF or LF line endings, optional UTF-8 BOM.
 * Returns rows with their 1-based source line number for error reporting.
 */
export interface CsvRow {
  line: number;
  cells: string[];
}

export function parseCsv(text: string): { rows: CsvRow[]; error: string | null } {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  let fieldStarted = false;

  const endField = () => {
    cells.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    if (!(cells.length === 1 && cells[0] === '')) rows.push({ line: rowLine, cells });
    cells = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted && field === '') {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRow();
      line++;
      rowLine = line;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (inQuotes) return { rows, error: `Line ${rowLine}: a quoted field is never closed.` };
  if (field !== '' || cells.length > 0) endRow();
  return { rows, error: null };
}
