import type { BrowserAppwrite } from '../../lib/appwrite/client.ts';
import { callFunction } from '../../lib/appwrite/functions.ts';
import type { Classification, LngLat } from '@shared/geo.ts';
import type { ProgramDetails, SessionImport, ZoneInput } from '@shared/program-input.ts';

/** Typed wrappers for the organiser Function. Authorisation is enforced server-side. */
export const organiserApi = (app: BrowserAppwrite) => ({
  createProgram: (details: ProgramDetails) => callFunction<{ $id: string }>(app, 'organiser', { action: 'createProgram', details }),
  updateProgram: (programId: string, details: ProgramDetails) => callFunction<{ $id: string }>(app, 'organiser', { action: 'updateProgram', programId, details }),
  importSessions: (programId: string, csv: string, commit: boolean) =>
    callFunction<SessionImport & { committed: boolean; upserted?: number; removed?: number }>(app, 'organiser', { action: 'importSessions', programId, csv, commit }),
  setCapacity: (programId: string, ledgerId: string, capacity: number) => callFunction<{ capacity: number }>(app, 'organiser', { action: 'setCapacity', programId, ledgerId, capacity }),
  saveZones: (programId: string, zones: ZoneInput[]) => callFunction<{ saved: number; removed: number }>(app, 'organiser', { action: 'saveZones', programId, zones }),
  checkPublish: (programId: string) => callFunction<{ ok: boolean; problems: string[] }>(app, 'organiser', { action: 'checkPublish', programId }),
  publish: (programId: string) => callFunction<{ $id: string; status: string }>(app, 'organiser', { action: 'publish', programId }),
  freeze: (programId: string) =>
    callFunction<{ status: 'frozen' | 'already_frozen'; inputsHash: string; frozenAt: string; drandRound: number; drandRoundAt: string }>(app, 'organiser', { action: 'freeze', programId }),
  classifyPoint: (programId: string, point: LngLat) => callFunction<Classification>(app, 'organiser', { action: 'classifyPoint', programId, point }),
});
