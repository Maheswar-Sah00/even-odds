// Global tokens and base styles first, so page stylesheets (imported by routes) can build on them.
import './styles/global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { AppwriteProvider } from './app/AppwriteProvider.tsx';
import { createRouter } from './app/router.tsx';
import { AuthProvider } from './features/auth/AuthProvider.tsx';
import { envResult } from './lib/env.ts';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element in index.html');

if (!envResult.ok) {
  console.error('Even Odds configuration is invalid:', envResult.issues);
}

createRoot(rootElement).render(
  <StrictMode>
    <AppwriteProvider env={envResult}>
      <AuthProvider>
        <RouterProvider router={createRouter()} />
      </AuthProvider>
    </AppwriteProvider>
  </StrictMode>,
);
