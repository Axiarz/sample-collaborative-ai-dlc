import { expect, it } from 'vitest';
import { upstreamRecoveryProblem } from '../lane-repair.js';
import { stageInstanceId } from '../../shared/v2-execution-plan.js';

it.each(['missing', 'FAILED', 'SUCCEEDED', 'SKIPPED'])(
  'checks every upstream parallel instance (%s)',
  (state) => {
    const plan = {
      namespace: 'workflow@1',
      stages: [
        { stageId: 'construct', parallelSection: 1 },
        { stageId: 'next-section', parallelSection: 2 },
      ],
    };
    const records = {
      unitPlan: { units: [{ slug: 'a' }, { slug: 'b' }] },
      stages: [
        {
          stageInstanceId: stageInstanceId(plan.namespace, 'construct', 'a', 1),
          state: 'SUCCEEDED',
        },
        ...(state === 'missing'
          ? []
          : [{ stageInstanceId: stageInstanceId(plan.namespace, 'construct', 'b', 1), state }]),
      ],
    };
    expect(upstreamRecoveryProblem({}, records, plan, 'next-section')).toBe(
      ['SUCCEEDED', 'SKIPPED'].includes(state) ? null : 'construct [unit b]',
    );
  },
);
