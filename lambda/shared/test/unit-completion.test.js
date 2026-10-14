import { describe, it, expect } from 'vitest';
import {
  effectiveSkeleton,
  skeletonProblem,
  unitCompletion,
  unitPlanIdentity,
} from '../unit-completion.js';

const unitPlan = {
  units: [
    { slug: 'foundation', dependsOn: [] },
    { slug: 'feature', dependsOn: ['foundation'] },
  ],
  batches: [['foundation'], ['feature']],
  walkingSkeleton: 'feature',
};
const records = () => ({
  meta: { status: 'SUCCEEDED', orchestratorRunId: 'run1' },
  unitPlan,
  units: [
    { slug: 'foundation', sectionIndex: 1, state: 'MERGED' },
    { slug: 'feature', sectionIndex: 1, state: 'BLOCKED' },
    { slug: 'old-plan-unit', sectionIndex: 1, state: 'PENDING' },
  ],
});

describe('active-plan completion', () => {
  it('counts active work and detects false success regardless of the terminal META status', () => {
    expect(unitCompletion(records())).toMatchObject({
      state: 'incomplete',
      total: 2,
      integrated: 1,
      skipped: 0,
    });
  });
  it('requires an exact-plan human skip receipt for partial delivery', () => {
    const input = records();
    input.units[1].completionSkip = {
      humanTaskId: 'halt',
      planIdentity: unitPlanIdentity(unitPlan),
    };
    expect(unitCompletion(input).state).toBe('partial');
    input.unitPlan = {
      ...unitPlan,
      units: [...unitPlan.units, { slug: 'new-work', dependsOn: [] }],
    };
    expect(unitCompletion(input).state).toBe('incomplete');
  });
  it('keeps legacy accepted partial delivery distinct without trusting a prior run decision', () => {
    const input = records();
    input.humanTasks = [
      {
        humanTaskId: 'eg-halt-s1-r0-run1',
        orchestratorRunId: 'run1',
        status: 'approved',
        answer: { decision: 'skip' },
      },
    ];
    expect(unitCompletion(input)).toMatchObject({ state: 'partial', legacyPartial: true });
    input.meta.orchestratorRunId = 'run2';
    expect(unitCompletion(input).state).toBe('incomplete');
  });
  it('counts missing lane rows as unfinished', () => {
    const input = records();
    input.units = [];
    expect(unitCompletion(input, [1])).toMatchObject({
      state: 'incomplete',
      total: 2,
      integrated: 0,
    });
  });
});

it('defaults only an absent decision and respects skeleton-off ceremonies', () => {
  expect(effectiveSkeleton({ ...unitPlan, walkingSkeleton: null })).toBe('foundation');
  expect(effectiveSkeleton(unitPlan)).toBe('feature');
  expect(skeletonProblem(unitPlan)).toContain('depends on foundation');
  expect(skeletonProblem(unitPlan, undefined, [{ policy: { skeleton: 'off' } }])).toBeNull();
  expect(skeletonProblem({ ...unitPlan, walkingSkeleton: 'foundation' })).toBeNull();
});
