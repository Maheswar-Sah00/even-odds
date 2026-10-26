import { Permission, Role } from 'node-appwrite';

/**
 * Row permission builders. Clients only ever get READ on private rows; every
 * write goes through server code. Organisers are granted via their Team.
 */

/** families, children, preferences, placements, waitlist: guardians + organisers. */
export function familyRowPermissions(guardianUserIds: readonly string[], organiserTeamId: string): string[] {
  return [...guardianUserIds.map((id) => Permission.read(Role.user(id))), Permission.read(Role.team(organiserTeamId))];
}

/** family_locations: guardians ONLY. Organisers see tiers, never home coordinates. */
export function privateLocationPermissions(guardianUserIds: readonly string[]): string[] {
  return guardianUserIds.map((id) => Permission.read(Role.user(id)));
}

/** overrides: organisers only. */
export function organiserOnlyPermissions(organiserTeamId: string): string[] {
  return [Permission.read(Role.team(organiserTeamId))];
}
