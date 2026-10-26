/**
 * Task 13: the public fairness report is computed from artifacts the replay
 * has just verified, end to end, and renders computed numbers only. Uses the
 * SYNTHETIC published fixture (sample inputs frozen for real quicknet round
 * 1,000,000).
 */
import { render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { fairnessReport, familiesFromInputs } from '../../shared/fairness.ts';
import { SAMPLE_INPUTS } from '../../shared/draw/sample.ts';
import { replayBundle } from '../../shared/replay/replay.ts';
import { tamper } from '../../shared/replay/tamper.ts';
import { buildFairness } from '../../src/features/fairness/fairness-data.ts';
import { FairnessReportView } from '../../src/features/fairness/FairnessPage.tsx';
import { publishedFixture, ROUND_AT } from '../fixtures/replay-bundle.ts';
import { renderRoute } from './helpers/render.tsx';

const now = ROUND_AT + 3600_000;
const opts = { permutations: 200 };

describe('fairness report from verified artifacts', () => {
  it('is computed from the verified inputs, committed order and published result', async () => {
    const { bundle, plan } = publishedFixture();
    const v = await replayBundle(bundle, { now });
    expect(v.replayMatches).toBe(true);
    const d = buildFairness(v, [], opts);
    if (!d.ready) throw new Error(d.reason);
    expect(d.orderCommittedAtFreeze).toBe(true);
    expect(d.replayMatches).toBe(true);
    expect(d.inputsHash).toBe(bundle.snapshot?.inputsHash);
    const r = d.report;
    expect(r.drawPlacements).toBe(plan.summary.placements);
    expect(r.childrenWithAWeek).toBe(plan.summary.childrenWithAWeek);
    expect(r.seats).toBe(plan.summary.seats);
    expect(r.families).toBe(plan.summary.applications);
    expect(r.invariants).toMatchObject({ oversoldSeats: 0, duplicatePlacements: 0, overRequested: 0, unexplainedPlacements: 0, siblingSplits: 0 });
    expect(r.applicationOrder).toEqual({ source: 'published_order', missing: 0, extra: 0 });
    expect(r.firstCome).not.toBeNull();
  });

  it.each(['inputs', 'inputs_hash', 'audit'] as const)('shows no report when the %s artifact is modified', async (key) => {
    const v = await replayBundle(tamper(publishedFixture().bundle, key), { now });
    const d = buildFairness(v, [], opts);
    expect(d.ready).toBe(false);
    expect(d.steps.some((s) => s.status === 'fail')).toBe(true);
  });

  it('shows no report when the published result file is modified', async () => {
    const v = await replayBundle(tamper(publishedFixture().bundle, 'result'), { now });
    const d = buildFairness(v, [], opts);
    expect(d.ready).toBe(false);
    if (!d.ready) expect(d.reason).toMatch(/result/i);
  });

  it('never reports the replay as matching when the beacon is modified', async () => {
    const v = await replayBundle(tamper(publishedFixture().bundle, 'beacon'), { now });
    const d = buildFairness(v, [], opts);
    expect(d.steps.find((s) => s.key === 'compare')?.status).not.toBe('pass');
    if (d.ready) expect(d.replayMatches).not.toBe(true);
  });

  it('describes a consistently-hashed result that diverged from the plan, and flags it', async () => {
    // The database "committed" an extra placement: a week f6-c1 never ranked.
    const { bundle } = publishedFixture({ result: (r) => ({ ...r, placements: [...r.placements, { publicId: 'f6', childRef: 'f6-c1', week: 'W1', ageGroup: 'old', round: 2 }] }) });
    const v = await replayBundle(bundle, { now });
    const d = buildFairness(v, [], opts);
    if (!d.ready) throw new Error(d.reason);
    expect(d.replayMatches).toBe(false);
    expect(d.report.invariants.unexplainedPlacements).toBe(1);
    expect(d.report.invariants.oversoldSeats).toBe(1); // W1/old has 1 seat, already taken by a1-c2
  });

  it('computes no time groups or first-come baseline when no order was committed', async () => {
    const v = await replayBundle(publishedFixture({ applicationOrder: null }).bundle, { now });
    const d = buildFairness(v, [], opts);
    if (!d.ready) throw new Error(d.reason);
    expect(d.orderCommittedAtFreeze).toBe(false);
    expect(d.report.applicationOrder.source).toBe('none');
    expect(d.report.firstCome).toBeNull();
  });

  it('checks the seats held now against capacity now (offer_stats)', async () => {
    const v = await replayBundle(publishedFixture().bundle, { now });
    const d = buildFairness(v, [{ week: 'W1', age_group: 'old', capacity: 1, taken: 2, computed_at: '2026-10-25T00:00:00.000Z' }], opts);
    if (!d.ready) throw new Error(d.reason);
    expect(d.report.invariants.oversoldSessions).toEqual([{ week: 'W1', ageGroup: 'old', capacity: 1, taken: 2 }]);
    expect(d.offerStatsAt).toBe('2026-10-25T00:00:00.000Z');
  });
});

describe('fairness report view', () => {
  const renderView = (report: ReturnType<typeof fairnessReport>, extra: { replayMatches?: boolean } = {}) => {
    const router = createMemoryRouter([{ path: '/', element: <FairnessReportView report={report} programId="synthetic-sample" {...extra} /> }]);
    return render(<RouterProvider router={router} />);
  };

  it('renders the computed numbers, sample sizes and the caveats', () => {
    const { plan } = publishedFixture();
    const report = fairnessReport({
      families: familiesFromInputs(SAMPLE_INPUTS),
      placements: plan.steps.flatMap((s) => s.placements.map((p) => ({ publicId: s.publicId, ...p }))),
      sessions: SAMPLE_INPUTS.sessions,
      maxWeeks: SAMPLE_INPUTS.maxWeeks,
      applicationOrder: ['a1', 'b2', 'c3', 'd4', 'f6'],
      permutations: 50,
    });
    renderView(report);
    expect(screen.getByText(`${String(report.drawPlacements)} / ${String(report.seats)}`)).toBeInTheDocument();
    expect(screen.getByText(`${String(report.familiesWithAWeek)} / ${String(report.families)}`)).toBeInTheDocument();
    const bySize = screen.getByRole('table', { name: 'By family size' });
    const one = report.bySize.find((g) => g.group === '1 child');
    expect(within(bySize).getByText(`${String(one?.families)} (${String(one?.children)})`)).toBeInTheDocument();
    expect(screen.getAllByText('small sample').length).toBeGreaterThan(0);
    expect(screen.getByText(/do not, on their own, show discrimination/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Comparison: first come, first served' })).toBeInTheDocument();
    // Too few families for the tests: they say so instead of claiming anything.
    expect(screen.getAllByText('Not meaningful here').length).toBe(report.tests.length);
    expect(screen.queryByText(/does not match the replay/)).toBeNull();
  });

  it('labels offer outcomes as live and reports them under their own headings', () => {
    const fam = { publicId: 'p1', tier: 1, siblingMode: 'independent' as const, children: [{ ref: 'c1', rankedWeeks: ['W1'], ageGroups: ['A'], requested: 1 }] };
    const placement = { publicId: 'p1', childRef: 'c1', week: 'W1', ageGroup: 'A' };
    renderView(fairnessReport({ families: [fam], placements: [placement], sessions: [{ week: 'W1', ageGroup: 'A', capacity: 1 }], applicationOrder: ['p1'], outcomes: { entries: [{ ...placement, source: 'draw', status: 'accepted' }], waitlist: [] }, permutations: 10 }));
    expect(screen.getByText(/are not hashed, and are the server's word/)).toBeInTheDocument();
    const accepted = screen.getByRole('table', { name: 'Families holding an accepted offer now, by application time' });
    expect(within(accepted).getByRole('columnheader', { name: 'Holding an accepted offer' })).toBeInTheDocument();
    expect(within(accepted).queryByRole('columnheader', { name: 'Got a week: lottery' })).toBeNull();
  });

  it('warns in red when the published result does not match the replay', () => {
    renderView(fairnessReport({ families: [], placements: [], sessions: [], permutations: 10 }), { replayMatches: false });
    expect(screen.getByRole('alert')).toHaveTextContent('The published result does not match the replay');
  });
});

describe('fairness route', () => {
  it('is public and explains when the app is not configured', async () => {
    renderRoute('/fairness/p1');
    expect(await screen.findByRole('heading', { name: 'Fairness report card' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Fairness report/ })).toHaveAttribute('href', '/fairness/p1');
    expect(screen.getByText(/App not configured/)).toBeInTheDocument();
  });
});
