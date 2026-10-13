import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import gremlin from 'gremlin';
import { acceptAssistResult, updateAssistMessageVertex } from '../data-access.js';

let connection;
let g;
const prefix = `assist-owner-${randomUUID()}`;
beforeAll(() => {
  connection = new gremlin.driver.DriverRemoteConnection(
    `${process.env.GREMLIN_PROTOCOL ?? 'ws'}://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`,
  );
  g = gremlin.process.AnonymousTraversalSource.traversal().withRemote(connection);
});
afterAll(async () => {
  await g.V().has('test_owner', prefix).drop().next();
  await connection.close();
});
const pending = async (attemptId) => {
  const messageId = randomUUID();
  let query = g
    .addV('DiscussionMessage')
    .property('id', messageId)
    .property('discussion_id', 'thread')
    .property('intent_id', 'intent')
    .property('request_id', 'request')
    .property('assist_status', 'running')
    .property('content', 'pending')
    .property('test_owner', prefix);
  if (attemptId) query = query.property('assist_attempt_id', attemptId);
  await query.next();
  return {
    messageId,
    intentId: 'intent',
    discussionId: 'thread',
    requestId: 'request',
    attemptId,
    status: 'completed',
    content: 'result',
  };
};
describe('discussion owner conditional completion', () => {
  it('accepts the current attempt once and rejects stale, duplicate and redacted results', async () => {
    const current = await pending(randomUUID());
    expect(await acceptAssistResult(g, { ...current, attemptId: randomUUID() })).toBeNull();
    expect(await acceptAssistResult(g, current)).not.toBeNull();
    expect(await acceptAssistResult(g, { ...current, content: 'late overwrite' })).toBeNull();
    const redacted = await pending(randomUUID());
    await g
      .V()
      .has('id', redacted.messageId)
      .property('redacted', 'true')
      .property('content', '')
      .next();
    expect(await acceptAssistResult(g, redacted)).toBeNull();
  });
  it('preserves an in-flight legacy completion, then fences it when a retry installs an attempt', async () => {
    const legacy = await pending();
    expect(await acceptAssistResult(g, { ...legacy, status: 'failed' })).not.toBeNull();
    const attemptId = randomUUID();
    expect(
      await updateAssistMessageVertex(g, {
        ...legacy,
        scope: { idProp: 'intent_id', rootId: 'intent' },
        assistStatus: 'running',
        attemptId,
        content: 'retry',
        updatedAt: new Date().toISOString(),
      }),
    ).not.toBeNull();
    expect(await acceptAssistResult(g, legacy)).toBeNull();
    expect(await acceptAssistResult(g, { ...legacy, attemptId })).not.toBeNull();
  });
});
