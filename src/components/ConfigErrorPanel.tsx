import type { EnvIssue } from '@shared/env.ts';
import { Banner } from './ui/index.ts';

/** Shown instead of the app whenever browser configuration is missing or invalid. */
export function ConfigErrorPanel({ issues }: { issues: readonly EnvIssue[] }) {
  return (
    <Banner tone="error" title="Configuration needed">
      <p>Even Odds cannot connect to Appwrite because the browser configuration is incomplete. Nothing has been sent to any server.</p>
      <ul>
        {issues.map((issue) => (
          <li key={`${issue.variable}:${issue.message}`}>
            <code>{issue.variable}</code>: {issue.message}
          </li>
        ))}
      </ul>
      <p>
        Copy <code>.env.example</code> to <code>.env.local</code>, fill in the values from the Appwrite console, then restart{' '}
        <code>npm run dev</code>. See the README for details.
      </p>
    </Banner>
  );
}
