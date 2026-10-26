import { CalendarCheck, ClipboardList, House, LayoutDashboard, PlayCircle, Scale, ScrollText, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink, useParams } from 'react-router';
import { RequireAuth, RequireOrganiser } from '../../features/auth/guards.tsx';
import { PageSlot } from '../Layout.tsx';

function SideNav({ title, children }: { title: string; children: ReactNode }) {
  return (
    <nav className="side-nav" aria-label={title}>
      <p className="side-nav__title">{title}</p>
      {children}
    </nav>
  );
}

/** Family area: requires a signed-in user (permissions still enforce row access). */
export function FamilyLayout() {
  return (
    <div className="shell">
      <SideNav title="My family">
        <NavLink to="/family" end>
          <House size={18} aria-hidden="true" /> Overview
        </NavLink>
        <NavLink to="/family/children">
          <Users size={18} aria-hidden="true" /> Children
        </NavLink>
        <NavLink to="/family/offers">
          <CalendarCheck size={18} aria-hidden="true" /> Offers
        </NavLink>
      </SideNav>
      <div>
        <RequireAuth>
          <PageSlot />
        </RequireAuth>
      </div>
    </div>
  );
}

/** Application routes share the family guard but not the sidebar. */
export function ApplicationLayout() {
  return (
    <div className="page page--narrow">
      <RequireAuth>
        <PageSlot />
      </RequireAuth>
    </div>
  );
}

/** Organiser area: requires organiser team membership. */
export function OrganiserLayout() {
  return (
    <div className="shell">
      <SideNav title="Organiser">
        <NavLink to="/organiser" end>
          <LayoutDashboard size={18} aria-hidden="true" /> Dashboard
        </NavLink>
        <NavLink to="/programs">
          <ClipboardList size={18} aria-hidden="true" /> Public catalogue
        </NavLink>
      </SideNav>
      <div>
        <RequireOrganiser>
          <PageSlot />
        </RequireOrganiser>
      </div>
    </div>
  );
}

/** Public audit, replay and fairness shell, with tabs scoped to one program. Open to everyone. */
export function AuditLayout() {
  const { programId = '' } = useParams();
  return (
    <div className="page">
      <nav className="tabs" aria-label="Verification">
        <NavLink to={`/audit/${programId}`}>
          <ScrollText size={16} aria-hidden="true" /> Audit log
        </NavLink>
        <NavLink to={`/replay/${programId}`}>
          <PlayCircle size={16} aria-hidden="true" /> Replay the draw
        </NavLink>
        <NavLink to={`/fairness/${programId}`}>
          <Scale size={16} aria-hidden="true" /> Fairness report
        </NavLink>
      </nav>
      <PageSlot />
    </div>
  );
}
