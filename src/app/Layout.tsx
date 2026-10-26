import { LogIn, LogOut, Menu, Sparkles, X } from 'lucide-react';
import { Suspense, useEffect, useId, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, isRouteErrorResponse, useLocation, useRouteError } from 'react-router';
import { BrandMark } from '../components/BrandMark.tsx';
import { ThemeToggle } from '../components/ThemeToggle.tsx';
import { Banner, ErrorBoundary, LoadingState } from '../components/ui/index.ts';
import { useAuth } from '../features/auth/auth-context.ts';

function Brand() {
  return (
    <>
      <BrandMark className="brand__mark" size={28} />
      <span className="brand__name">even odds</span>
    </>
  );
}

function SiteHeader() {
  const { state, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const navId = useId();
  const location = useLocation();

  // Close the mobile menu after navigating.
  const [lastPath, setLastPath] = useState(location.pathname);
  if (lastPath !== location.pathname) {
    setLastPath(location.pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // The header is transparent over the page top and frosted once content scrolls under it.
  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 8);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  const signedIn = state.status === 'signed_in';
  return (
    <header className="site-header" data-scrolled={scrolled} data-menu={open}>
      <div className="site-header__inner">
        <NavLink to="/" className="brand" end aria-label="Even Odds home">
          <Brand />
        </NavLink>
        <button
          type="button"
          className="btn btn--ghost nav-toggle"
          aria-expanded={open}
          aria-controls={navId}
          onClick={() => {
            setOpen((o) => !o);
          }}
        >
          {open ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
          <span className="nav-toggle__label">Menu</span>
        </button>
        <ThemeToggle />
        <nav id={navId} className="site-nav" aria-label="Main" data-open={open}>
          <div className="site-nav__links">
            <NavLink to="/programs">Programs</NavLink>
            <NavLink to="/family">My family</NavLink>
            {signedIn && state.isOrganiser ? <NavLink to="/organiser">Organiser</NavLink> : null}
            <NavLink to="/status">Status</NavLink>
          </div>
          <div className="site-nav__actions">
            {signedIn ? (
              <button type="button" className="btn btn--ghost" onClick={() => void signOut()}>
                <LogOut size={16} aria-hidden="true" />
                <span>Sign out</span>
              </button>
            ) : (
              <Link to="/signin" className="btn btn--ghost">
                <LogIn size={16} aria-hidden="true" />
                <span>Sign in</span>
              </Link>
            )}
            <NavLink to="/demo" className="btn btn--primary">
              <Sparkles size={16} aria-hidden="true" />
              <span>Judge demo</span>
            </NavLink>
          </div>
        </nav>
      </div>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <div className="site-footer__brand">
          <Link to="/" className="brand">
            <Brand />
          </Link>
          <p>Registration is a lottery, not a race. Frozen inputs, public randomness and a draw anyone can replay.</p>
          <p className="site-footer__seal">
            <span className="site-footer__pulse" aria-hidden="true" />
            Seeded by drand · Built on Appwrite
          </p>
        </div>
        <div>
          <h2>Families</h2>
          <ul>
            <li>
              <Link to="/programs">Browse programs</Link>
            </li>
            <li>
              <Link to="/family">My family</Link>
            </li>
            <li>
              <Link to="/family/offers">Offers and waitlist</Link>
            </li>
          </ul>
        </div>
        <div>
          <h2>Verify</h2>
          <ul>
            <li>
              <Link to="/demo">Judge demo</Link>
            </li>
            <li>
              <Link to="/replay/demo-summer-2027">Replay a draw</Link>
            </li>
            <li>
              <Link to="/fairness/demo-summer-2027">Fairness</Link>
            </li>
          </ul>
        </div>
        <div>
          <h2>System</h2>
          <ul>
            <li>
              <Link to="/status">Status</Link>
            </li>
            <li>
              <Link to="/organiser">Organiser console</Link>
            </li>
            <li>
              <Link to="/signin">Sign in</Link>
            </li>
          </ul>
        </div>
      </div>
      <div className="site-footer__legal">
        <span>© {new Date().getFullYear()} Even Odds</span>
        <span>Demo data is synthetic and labelled.</span>
      </div>
    </footer>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <SiteFooter />
    </>
  );
}

/** Suspense + error boundary around lazily loaded page content. */
export function PageSlot({ children }: { children?: ReactNode }) {
  const location = useLocation();
  return (
    <ErrorBoundary key={location.pathname} label="This page">
      <Suspense fallback={<LoadingState label="Loading page…" />}>{children ?? <Outlet />}</Suspense>
    </ErrorBoundary>
  );
}

export function Layout() {
  return (
    <Shell>
      <PageSlot />
    </Shell>
  );
}

/** Route-level error boundary: an unexpected error never leaves a blank page. */
export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Unknown error';
  return (
    <Shell>
      <div className="page page--narrow">
        <Banner tone="error" title="Something went wrong">
          <p>{message}</p>
          <p>
            <a href="/">Reload the home page</a>
          </p>
        </Banner>
      </div>
    </Shell>
  );
}
