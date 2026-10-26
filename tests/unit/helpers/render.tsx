import { render } from '@testing-library/react';
import type { Models } from 'appwrite';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { AppwriteProvider } from '../../../src/app/AppwriteProvider.tsx';
import { routes } from '../../../src/app/router.tsx';
import { AuthContext, type AuthState } from '../../../src/features/auth/auth-context.ts';
import { parsePublicEnv } from '../../../shared/env.ts';

export const unconfiguredEnv = parsePublicEnv({});
/** Points at a closed local port: any request fails fast as a network error. */
export const offlineEnv = parsePublicEnv({
  VITE_APPWRITE_ENDPOINT: 'http://127.0.0.1:9/v1',
  VITE_APPWRITE_PROJECT_ID: 'proj123',
  VITE_APPWRITE_DATABASE_ID: 'even-odds',
});

export const fakeUser = { $id: 'u1', email: 'synthetic@example.com', name: '' } as Models.User;

export function renderRoute(path: string, opts: { auth?: AuthState; env?: ReturnType<typeof parsePublicEnv> } = {}) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const auth = opts.auth ?? { status: 'signed_out' };
  const result = render(
    <AppwriteProvider env={opts.env ?? unconfiguredEnv}>
      <AuthContext value={{ state: auth, refresh: () => Promise.resolve(), signOut: () => Promise.resolve() }}>
        <RouterProvider router={router} />
      </AuthContext>
    </AppwriteProvider>,
  );
  return { ...result, router };
}
