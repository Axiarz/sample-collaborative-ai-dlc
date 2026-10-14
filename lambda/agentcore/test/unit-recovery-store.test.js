import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { createProcessStore } from '../../shared/v2-process-store.js';
import { createV2Table, deleteV2Table, makeDdb } from './helpers/v2-table.js';

const tableName = `unit-recovery-${randomUUID()}`;
let db;
let store;
beforeAll(async () => {
  db = makeDdb();
  await createV2Table(db.client, tableName);
  store = createProcessStore({ ddb: db.doc, tableName });
});
afterAll(async () => {
  await deleteV2Table(db.client, tableName);
  db.client.destroy();
});

it('admits one recovery owner and atomically fences stale unit, plan and stage writes', async () => {
  const executionId = randomUUID();
  await store.createExecution({ executionId, intentId: executionId, projectId: 'project' });
  await store.updateExecution({ executionId, status: 'SUCCEEDED', orchestratorRunId: 'original' });
  const claim = (orchestratorRunId) =>
    store.updateExecution({
      executionId,
      fromStatus: 'SUCCEEDED',
      ifOrchestratorRunId: 'original',
      status: 'FAILED',
      orchestratorRunId,
    });
  const claims = await Promise.allSettled([claim('repair-a'), claim('repair-b')]);
  expect(claims.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(claims.find((result) => result.status === 'rejected').reason.name).toBe(
    'ConditionalCheckFailedException',
  );
  const owner = (await store.getExecution(executionId, { consistentRead: true })).orchestratorRunId;
  await db.doc.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: `EXEC#${executionId}`,
        sk: 'UNITPLAN',
        units: [{ slug: 'foundation', dependsOn: [] }],
        walkingSkeleton: 'foundation',
      },
    }),
  );
  await store.putStage({
    executionId,
    stageInstanceId: 'shared-check',
    stageId: 'build',
    state: 'SUCCEEDED',
  });
  await store.updateUnitState({
    executionId,
    sectionIndex: 1,
    slug: 'foundation',
    state: 'MERGED',
  });
  const stale = { executionId, ifOrchestratorRunId: 'original' };
  expect(
    await store.updateUnitState({
      ...stale,
      sectionIndex: 1,
      slug: 'foundation',
      state: 'PENDING',
    }),
  ).toBeNull();
  await expect(
    store.updateUnitPlanDecisions({ ...stale, walkingSkeleton: 'wrong' }),
  ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  await expect(
    store.resetStageRow({ ...stale, stageInstanceId: 'shared-check' }),
  ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  expect((await store.getStage(executionId, 'shared-check')).state).toBe('SUCCEEDED');
  expect((await store.getUnitPlan(executionId)).walkingSkeleton).toBe('foundation');
  expect((await store.listUnits(executionId))[0].state).toBe('MERGED');
  const reset = await store.resetStageRow({
    executionId,
    stageInstanceId: 'shared-check',
    ifOrchestratorRunId: owner,
  });
  expect(reset).toMatchObject({ state: 'PENDING', attempt: 1 });
  expect(
    await store.resetStageRow({
      executionId,
      stageInstanceId: 'shared-check',
      ifOrchestratorRunId: owner,
    }),
  ).toBeNull();
});
