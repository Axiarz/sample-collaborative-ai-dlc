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

it('claims a stale repair once and rejects late cleanup and a racing generic start', async () => {
  const executionId = randomUUID();
  await store.createExecution({ executionId, intentId: executionId, projectId: 'project' });
  await store.updateExecution({
    executionId,
    status: 'FAILED',
    orchestratorRunId: 'lost-worker',
    failureReason: 'lane_repair_in_progress',
    repairStartedAt: '2020-01-01T00:00:00.000Z',
    repairPlan: { owner: 'lost-worker', sectionIndex: 1, walkingSkeleton: 'foundation' },
  });
  const old = await store.getExecution(executionId, { consistentRead: true });
  const takeover = (owner) =>
    store.updateExecution({
      executionId,
      fromStatus: 'FAILED',
      ifOrchestratorRunId: old.orchestratorRunId,
      ifUpdatedAt: old.updatedAt,
      orchestratorRunId: owner,
      repairStartedAt: new Date().toISOString(),
      repairPlan: { ...old.repairPlan, owner },
    });
  const results = await Promise.allSettled([takeover('successor-a'), takeover('successor-b')]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  await expect(
    store.updateExecution({
      executionId,
      fromStatus: 'FAILED',
      ifOrchestratorRunId: old.orchestratorRunId,
      ifUpdatedAt: old.updatedAt,
      status: 'CREATED',
      failureReason: null,
    }),
  ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  await expect(
    store.updateExecution({
      executionId,
      ifOrchestratorRunId: old.orchestratorRunId,
      failureReason: 'lane_repair_failed',
      repairPlan: null,
    }),
  ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  await expect(
    store.deleteWorkflowCheckpoint(executionId, {
      ifOrchestratorRunId: old.orchestratorRunId,
    }),
  ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  const current = await store.getExecution(executionId, { consistentRead: true });
  expect(current.repairPlan.owner).toBe(current.orchestratorRunId);
  expect(current.failureReason).toBe('lane_repair_in_progress');
});
