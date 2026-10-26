import { createBrowserRouter, type RouteObject } from 'react-router';
import { LoadingState } from '../components/ui/index.ts';
import { ApplicationLayout, AuditLayout, FamilyLayout, OrganiserLayout } from './layouts/SectionLayouts.tsx';
import { Layout, RouteError } from './Layout.tsx';
import { HomePage } from './routes/HomePage.tsx';
import { NotFoundPage } from './routes/NotFoundPage.tsx';

/** Lazily loads a named page component so each area is its own chunk. */
const page =
  <M extends Record<string, unknown>>(load: () => Promise<M>, name: keyof M & string) =>
  async () => {
    const mod = await load();
    return { Component: mod[name] as React.ComponentType };
  };

/**
 * Route map. Family and organiser areas are wrapped in guards (layouts), but
 * the real protection is Appwrite row permissions and server Functions.
 */
export const routes: RouteObject[] = [
  {
    element: <Layout />,
    errorElement: <RouteError />,
    hydrateFallbackElement: <LoadingState label="Loading Even Odds…" />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'status', lazy: page(() => import('./routes/StatusPage.tsx'), 'StatusPage') },
      { path: 'demo', lazy: page(() => import('../features/demo/DemoPage.tsx'), 'DemoPage') },
      { path: 'signin', lazy: page(() => import('../features/auth/SignInPage.tsx'), 'SignInPage') },
      { path: 'programs', lazy: page(() => import('../features/programs/ProgramsPage.tsx'), 'ProgramsPage') },
      { path: 'programs/:programId', lazy: page(() => import('../features/programs/ProgramDetailPage.tsx'), 'ProgramDetailPage') },
      {
        path: 'family',
        element: <FamilyLayout />,
        children: [
          { index: true, lazy: page(() => import('../features/family/FamilyPages.tsx'), 'FamilyHomePage') },
          { path: 'children', lazy: page(() => import('../features/family/ChildrenPage.tsx'), 'ChildrenPage') },
          { path: 'offers', lazy: page(() => import('../features/offers/MyOffersPage.tsx'), 'MyOffersPage') },
        ],
      },
      {
        path: 'applications',
        element: <ApplicationLayout />,
        children: [
          { path: 'new/:programId', lazy: page(() => import('../features/applications/NewApplicationPage.tsx'), 'NewApplicationPage') },
          { path: ':applicationId', lazy: page(() => import('../features/applications/ApplicationPage.tsx'), 'ApplicationPage') },
        ],
      },
      {
        path: 'organiser',
        element: <OrganiserLayout />,
        children: [
          { index: true, lazy: page(() => import('../features/organiser/OrganiserPages.tsx'), 'OrganiserDashboardPage') },
          { path: 'programs/:programId', lazy: page(() => import('../features/organiser/OrganiserPages.tsx'), 'OrganiserProgramPage') },
        ],
      },
      {
        element: <AuditLayout />,
        children: [
          { path: 'audit/:programId', lazy: page(() => import('../features/audit/AuditPage.tsx'), 'AuditPage') },
          { path: 'replay/:programId', lazy: page(() => import('../features/lottery/ReplayPage.tsx'), 'ReplayPage') },
          { path: 'fairness/:programId', lazy: page(() => import('../features/fairness/FairnessPage.tsx'), 'FairnessPage') },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
