import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { nativeRuntimeImageKey } from './runtime-images.js';

// Native control records contain JSON scalars, maps and lists only. Reject
// unsupported stream attributes rather than interpreting binary/sets as authority.
const attribute = (value) => {
  if (Object.hasOwn(value, 'S')) return value.S;
  if (Object.hasOwn(value, 'N')) return Number(value.N);
  if (Object.hasOwn(value, 'BOOL')) return value.BOOL;
  if (value.NULL === true) return null;
  if (value.L) return value.L.map(attribute);
  if (value.M) return unmarshall(value.M);
  throw new Error('Unsupported native stream attribute');
};
const unmarshall = (map) =>
  Object.fromEntries(Object.entries(map).map(([k, v]) => [k, attribute(v)]));

const ACTIVE = new Set(['REQUESTED', 'UPGRADING', 'DISPATCHING', 'RUNNING', 'RECOVERING']);
const identity = (row) => row.scope ?? { projectId: row.projectId, executionId: row.executionId };
const canCancel = (row) =>
  row.sk === 'EXECUTION' && !['STOPPED', 'FAILED', 'CANCELLED'].includes(row.status);

export const nativeWakeupTargets = (row, previous) => {
  if (!row) return [];
  if (row.sk === 'RUNTIME' && row.status === 'PREPARING')
    return previous?.status === 'PREPARING' ? [] : ['preparation'];
  if (row.sk !== 'EXECUTION') return [];
  const targets = [];
  if (row.status === 'CANCEL_REQUESTED' && previous?.status !== row.status)
    targets.push('cancellation');
  else if (
    ACTIVE.has(row.status) &&
    (!previous ||
      previous.status !== row.status ||
      previous.response?.commandId !== row.response?.commandId ||
      previous.recovery?.id !== row.recovery?.id)
  )
    targets.push('execution');
  if (row.publication && (!previous || previous.publication?.id !== row.publication.id))
    targets.push('projection');
  return targets;
};

// Stream notification reduces latency. A periodic consistent table scan repairs
// expired stream records, consumer restarts and lost normal polling messages.
// Pointers contain no authority. The consumer always reloads protected state.
export const createNativeWakeupBridge = ({ ddb, sqs, tableName, queues, logger = console }) => {
  const send = (target, row) =>
    sqs
      .send(
        new SendMessageCommand({
          QueueUrl: queues[target],
          MessageBody: JSON.stringify(identity(row)),
        }),
      )
      .then((result) => {
        if (!result.MessageId) throw new Error('Native wakeup unacknowledged');
      });
  const repairRow = async (row, digest) => {
    if (digest) {
      if (canCancel(row) && row.configuration?.image?.digest === digest)
        await send('cancellation', row);
      return;
    }
    // A quiet waiting execution has no normal poll. Re-read revocations during
    // repair so expiration of the revocation stream record cannot strand it.
    if (canCancel(row) && row.configuration?.image?.digest) {
      const revoked = await ddb.send(
        new GetCommand({
          TableName: tableName,
          ConsistentRead: true,
          Key: nativeRuntimeImageKey(row.configuration.image.digest),
        }),
      );
      if (revoked.Item) await send('cancellation', row);
    }
    for (const target of nativeWakeupTargets(row)) await send(target, row);
  };
  const repair = async (digest) => {
    let ExclusiveStartKey;
    do {
      const page = await ddb.send(
        new ScanCommand({
          TableName: tableName,
          ConsistentRead: true,
          ExclusiveStartKey,
        }),
      );
      for (const row of page.Items ?? []) await repairRow(row, digest);
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  };
  return async (event) => {
    if (event?.source === 'aws.events') {
      await repair();
      return { repaired: true };
    }
    const batchItemFailures = [];
    for (const record of event?.Records ?? []) {
      try {
        const row = record.dynamodb?.NewImage ? unmarshall(record.dynamodb.NewImage) : null;
        const prior = record.dynamodb?.OldImage ? unmarshall(record.dynamodb.OldImage) : null;
        if (row?.sk === 'REVOCATION' && row.pk?.startsWith('NATIVE_RUNTIME_IMAGE#'))
          await repair(row.pk.slice('NATIVE_RUNTIME_IMAGE#'.length));
        else for (const target of nativeWakeupTargets(row, prior)) await send(target, row);
      } catch {
        logger.warn(JSON.stringify({ event: 'native_wakeup_retry' }));
        batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
      }
    }
    return { batchItemFailures };
  };
};

export const handler = (event) =>
  createNativeWakeupBridge({
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    sqs: new SQSClient({}),
    tableName: process.env.NATIVE_RUNTIME_BINDINGS_TABLE,
    queues: {
      preparation: process.env.NATIVE_RUNTIME_QUEUE_URL,
      execution: process.env.NATIVE_EXECUTION_QUEUE_URL,
      cancellation: process.env.NATIVE_CANCELLATION_QUEUE_URL,
      projection: process.env.NATIVE_PROJECTION_QUEUE_URL,
    },
  })(event);
