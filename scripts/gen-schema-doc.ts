/** npm run docs:schema: regenerates docs/SCHEMA.md from shared/schema.ts. */
import { writeFileSync } from 'node:fs';
import { TABLE_KEYS } from '../shared/config.ts';
import { SCHEMA, type ColumnSpec } from '../shared/schema.ts';

const typeLabel = (c: ColumnSpec): string => {
  switch (c.type) {
    case 'varchar':
      return `varchar(${c.size})${c.array ? '[]' : ''}`;
    case 'integer':
      return `integer${c.min !== undefined || c.max !== undefined ? ` [${c.min ?? ''}..${c.max ?? ''}]` : ''}`;
    case 'enum':
      return `enum(${c.elements.join(' \\| ')})`;
    default:
      return c.type;
  }
};

const lines: string[] = [
  '# Even Odds schema (TablesDB)',
  '',
  '> Generated from `shared/schema.ts` by `npm run docs:schema`. Do not edit by hand.',
  '',
  'Fields marked **ADDITION** are not in the design brief\'s data model; the reason is given inline.',
  'All tables live in one TablesDB database. Clients never receive create/update/delete permissions;',
  'every write goes through server code holding the API key.',
  '',
];

for (const key of TABLE_KEYS) {
  const t = SCHEMA[key];
  lines.push(`## \`${key}\``, '', t.description, '');
  lines.push(`- Row security: **${t.rowSecurity ? 'on' : 'off'}**`);
  lines.push(`- Table permissions: ${t.permissions.length ? t.permissions.map((p) => `\`${p}\``).join(', ') : 'none (server only, or per-row grants)'}`);
  lines.push('', '| Column | Type | Required | Meaning |', '|---|---|---|---|');
  for (const [name, c] of Object.entries(t.columns) as [string, ColumnSpec][]) {
    lines.push(`| \`${name}\` | ${typeLabel(c)} | ${c.required ? 'yes' : 'no'} | ${c.description.replace(/\|/g, '\\|')} |`);
  }
  lines.push('', '| Index | Type | Columns |', '|---|---|---|');
  for (const i of t.indexes) lines.push(`| \`${i.key}\` | ${i.type} | ${i.columns.join(', ')} |`);
  lines.push('');
}

writeFileSync('docs/SCHEMA.md', lines.join('\n'));
console.log('Wrote docs/SCHEMA.md');
