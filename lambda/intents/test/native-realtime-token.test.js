import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { nativeRuntimeBindingKey } from '../../shared/native-runtime-binding.js';
import { verifyRealtimeToken } from '../../shared/realtime-token.js';
import {
  nativeAnswerDocument,
  nativeAnswerScope,
  nativeCollaborationScope,
  nativeReplyDocument,
  nativeReplyScope,
} from '../../shared/native-realtime.js';
import shared from '../../shared/realtime-token.js';
const { store, membership, snapshot } = vi.hoisted(() => ({
  store: { getExecution: vi.fn() },
  membership: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock('../../shared/workflow-source-membership.js', () => ({
  fetchWorkflowSourceMembership: (_g, ...args) => snapshot(...args),
}));
vi.mock('../../shared/v2-process-store.js', () => ({ createProcessStore: () => store }));
vi.mock('../../shared/trackers.js', async (original) => ({
  ...(await original()),
  fetchMembershipRole: membership,
}));
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: () => async () => ({ accessKeyId: 'test', secretAccessKey: 'test' }),
}));
vi.mock('gremlin', async (original) => {
  const actual = await original();
  return {
    ...actual,
    default: {
      ...actual.default,
      driver: {
        ...actual.default.driver,
        DriverRemoteConnection: class {
          async close() {}
        },
      },
    },
  };
});
import { handler } from '../index.js';
const send = vi.spyOn(DynamoDBDocumentClient.prototype, 'send');
const scope = { projectId: 'p1', executionId: 'native1' };
const ownerKey = { ...nativeRuntimeBindingKey(scope), sk: 'EXECUTION' };
const request = (projectId = 'p1', sub = 'member1') => ({
  httpMethod: 'POST',
  path: `/projects/${projectId}/intents/native1/realtime-token`,
  pathParameters: { projectId, intentId: 'native1' },
  body: '{}',
  requestContext: { authorizer: { claims: { sub } } },
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NATIVE_RUNTIME_BINDINGS_TABLE', 'native-bindings');
  vi.stubEnv('REALTIME_DOC_SECRET', 'synthetic-token-signing-key');
  store.getExecution.mockResolvedValue(null);
  membership.mockResolvedValue('member');
  send.mockImplementation(async (command) => {
    // Fail any image-policy or unrelated lookup: result reads must not acquire
    // execution authorization or depend on the image-policy store.
    expect(command.input.TableName).toBe('native-bindings');
    expect(command.input.ConsistentRead).toBe(true);
    expect(command.input.Key).toEqual(ownerKey);
    return { Item: { scope, bindingId: 'binding1', status: 'AWAITING_USER' } };
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('deployed intents realtime-token handler', () => {
  it('issues a verifiable native token without platform META or graph Intent', async () => {
    const result = await handler(request());
    expect(result.statusCode).toBe(200);
    const { token, scopes } = JSON.parse(result.body);
    expect(scopes).toEqual([
      'native-intent:p1:native1',
      nativeCollaborationScope(scope),
      'project:p1',
    ]);
    expect(verifyRealtimeToken(token, 'synthetic-token-signing-key')).toMatchObject({
      ok: true,
      payload: { sub: 'member1', scopes },
    });
    expect(store.getExecution).toHaveBeenCalledExactlyOnceWith('native1', { consistentRead: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(membership).toHaveBeenCalledTimes(2);
  });
  it('mints disjoint native scopes for the same requested ID in two protected projects', async () => {
    const projects = ['p1', 'p2'];
    send.mockImplementation(async (command) => {
      const projectId = projects.find(
        (projectId) =>
          nativeRuntimeBindingKey({ projectId, executionId: 'native1' }).pk ===
          command.input.Key.pk,
      );
      return projectId
        ? {
            Item: {
              scope: { projectId, executionId: 'native1' },
              bindingId: 'binding-' + projectId,
            },
          }
        : {};
    });
    // A same-ID platform META must not redirect an explicitly native target.
    store.getExecution.mockResolvedValue({ projectId: 'p1', executionBackend: 'platform' });
    const tokens = [];
    for (const project of projects) {
      const result = await handler({
        ...request(project),
        body: JSON.stringify({ executionBackend: 'native' }),
      });
      expect(result.statusCode).toBe(200);
      tokens.push(JSON.parse(result.body));
    }
    expect(tokens[0].scopes).toEqual([
      'native-intent:p1:native1',
      nativeCollaborationScope({ projectId: 'p1', executionId: 'native1' }),
      'project:p1',
    ]);
    expect(tokens[1].scopes).toEqual([
      'native-intent:p2:native1',
      nativeCollaborationScope({ projectId: 'p2', executionId: 'native1' }),
      'project:p2',
    ]);
    expect(tokens[0].scopes.filter((scope) => tokens[1].scopes.includes(scope))).toEqual([]);
    expect(store.getExecution).not.toHaveBeenCalled();
  });
  it('rejects a foreign project even when the requester belongs to it', async () => {
    send.mockResolvedValue({ Item: { scope, bindingId: 'binding1' } });
    const result = await handler(request('p2'));
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).not.toHaveProperty('token');
  });
  it('does not authorize missing native records through a supplied project fallback', async () => {
    send.mockResolvedValue({});
    expect((await handler(request())).statusCode).toBe(404);
  });
  it.each(['revoked', 'unavailable'])(
    'keeps token/result access independent of image policy (%s)',
    async (imageStatus) => {
      // Only protected owner reads are allowed by the spy above. No IMAGE# lookup
      // is made even when the projected execution reports an unavailable image.
      store.getExecution.mockResolvedValue({
        projectId: 'p1',
        executionBackend: 'native',
        imageStatus,
      });
      expect((await handler(request())).statusCode).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
  it('fails closed and sanitizes a protected ownership-store failure', async () => {
    send.mockRejectedValue(new Error('private storage diagnostic'));
    const result = await handler(request());
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body)).toEqual({
      error: 'Realtime ownership is temporarily unavailable',
    });
  });
  it('rechecks membership after resolving ownership before signing', async () => {
    membership.mockResolvedValueOnce('member').mockResolvedValueOnce(null);
    const result = await handler(request());
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).not.toHaveProperty('token');
  });
  it.each([
    ['outsider', 403],
    [null, 401],
  ])(
    'denies a non-member or unauthenticated request before owner reads (%s)',
    async (sub, status) => {
      membership.mockResolvedValue(null);
      expect((await handler(request('p1', sub))).statusCode).toBe(status);
      expect(send).not.toHaveBeenCalled();
    },
  );
  it.each(['platform', undefined])(
    'preserves platform token issuance with a failed native store (%s)',
    async (executionBackend) => {
      store.getExecution.mockResolvedValue({ projectId: 'p1', executionBackend });
      send.mockRejectedValue(new Error('Native store unavailable'));
      expect((await handler(request())).statusCode).toBe(200);
      expect(send).not.toHaveBeenCalled();
    },
  );
  it('does not grant arbitrary IDs when native preparation is disabled', async () => {
    vi.stubEnv('NATIVE_RUNTIME_BINDINGS_TABLE', '');
    expect((await handler(request())).statusCode).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('revision-specific native reply drafts', () => {
  const interactionId = 'a'.repeat(64);
  const runtimeKey = nativeRuntimeBindingKey(scope);
  const rows = (execution = {}, binding = {}) => ({
    [runtimeKey.sk]: {
      projectId: 'p1',
      executionId: 'native1',
      bindingId: 'binding1',
      projectIdentity: 'vertex-1',
      ...binding,
    },
    EXECUTION: {
      scope,
      bindingId: 'binding1',
      status: 'AWAITING_USER',
      turnSequence: 2,
      interaction: { id: interactionId, sequence: 2 },
      ...execution,
    },
  });
  const draft = (document = { kind: 'reply', interactionId, sequence: 2 }, extra = {}) => ({
    ...request(),
    body: JSON.stringify({ executionBackend: 'native', document, ...extra }),
  });
  let records;
  beforeEach(() => {
    records = rows();
    snapshot.mockResolvedValue({
      role: 'member',
      membershipId: 'edge-1',
      projectIdentity: 'vertex-1',
    });
    send.mockImplementation(async (command) => ({ Item: records[command.input.Key.sk] }));
  });
  it('adds exactly the awaited interaction/turn scope, which opens only that Yjs document', async () => {
    const result = await handler(draft());
    expect(result.statusCode).toBe(200);
    const { token, scopes } = JSON.parse(result.body);
    const revision = { interactionId, sequence: 2 };
    expect(scopes).toEqual([
      'native-intent:p1:native1',
      nativeCollaborationScope(scope),
      'project:p1',
      nativeReplyScope(scope, revision),
    ]);
    const access = (docName) =>
      shared.verifyRealtimeAccess({
        token,
        secret: 'synthetic-token-signing-key',
        sub: 'member1',
        requiredScope: shared.requiredScopeForYjsDoc(docName),
      }).ok;
    expect(access(nativeReplyDocument(scope, revision))).toBe(true);
    expect(access(nativeReplyDocument(scope, { interactionId, sequence: 3 }))).toBe(false);
    expect(access(nativeReplyDocument(scope, { interactionId: 'b'.repeat(64), sequence: 2 }))).toBe(
      false,
    );
    expect(access(nativeReplyDocument({ projectId: 'p2', executionId: 'native1' }, revision))).toBe(
      false,
    );
    expect(snapshot).toHaveBeenCalledWith('p1', 'member1');
  });
  it('mints the structured answer draft scope for the same awaited turn only', async () => {
    const result = await handler(draft({ kind: 'answer', interactionId, sequence: 2 }));
    expect(result.statusCode).toBe(200);
    const { token, scopes } = JSON.parse(result.body);
    const revision = { interactionId, sequence: 2 };
    expect(scopes).toContain(nativeAnswerScope(scope, revision));
    expect(scopes).not.toContain(nativeReplyScope(scope, revision));
    const access = (docName) =>
      shared.verifyRealtimeAccess({
        token,
        secret: 'synthetic-token-signing-key',
        sub: 'member1',
        requiredScope: shared.requiredScopeForYjsDoc(docName),
      }).ok;
    expect(access(nativeAnswerDocument(scope, revision))).toBe(true);
    expect(access(nativeReplyDocument(scope, revision))).toBe(false);
    expect(access(nativeAnswerDocument(scope, { interactionId, sequence: 3 }))).toBe(false);
    records = rows({ status: 'DISPATCHING' });
    expect((await handler(draft({ kind: 'answer', interactionId, sequence: 2 }))).statusCode).toBe(
      409,
    );
  });
  it('a plain native token cannot open any reply draft', async () => {
    const { token } = JSON.parse(
      (await handler({ ...request(), body: JSON.stringify({ executionBackend: 'native' }) })).body,
    );
    const requiredScope = shared.requiredScopeForYjsDoc(
      nativeReplyDocument(scope, { interactionId, sequence: 2 }),
    );
    expect(
      shared.verifyRealtimeAccess({
        token,
        secret: 'synthetic-token-signing-key',
        sub: 'member1',
        requiredScope,
      }).ok,
    ).toBe(false);
  });
  it.each([
    ['a changed interaction', { interaction: { id: 'b'.repeat(64), sequence: 2 } }],
    ['an older turn', { turnSequence: 3, interaction: { id: interactionId, sequence: 3 } }],
    ['an accepted reply', { status: 'DISPATCHING' }],
    ['a cancellation', { cancelRequested: true }],
  ])('refuses %s as a stale tab', async (_label, execution) => {
    records = rows(execution);
    const result = await handler(draft());
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).not.toHaveProperty('token');
  });
  it('denies a recreated project, a revoked member, and a foreign project', async () => {
    records = rows({}, { projectIdentity: 'vertex-old' });
    expect((await handler(draft())).statusCode).toBe(403);
    records = rows();
    snapshot.mockResolvedValue(null);
    expect((await handler(draft())).statusCode).toBe(403);
    snapshot.mockResolvedValue({
      role: 'member',
      membershipId: 'edge-1',
      projectIdentity: 'vertex-1',
    });
    expect(
      (
        await handler({
          ...draft(),
          path: '/projects/p2/intents/native1/realtime-token',
          pathParameters: { projectId: 'p2', intentId: 'native1' },
        })
      ).statusCode,
    ).toBe(404);
  });
  it.each([
    [{ kind: 'reply', interactionId, sequence: '2' }],
    [{ kind: 'reply', interactionId: 'A'.repeat(64), sequence: 2 }],
    [{ kind: 'question', interactionId, sequence: 2 }],
    [{ kind: 'reply', interactionId, sequence: 2, extra: true }],
    [null],
  ])('rejects malformed document requests before signing (%j)', async (document) => {
    expect((await handler(draft(document))).statusCode).toBe(400);
  });
  it('never mints a reply scope on a platform target', async () => {
    const result = await handler({
      ...request(),
      body: JSON.stringify({
        executionBackend: 'platform',
        document: { kind: 'reply', interactionId, sequence: 2 },
      }),
    });
    expect(result.statusCode).toBe(400);
  });
});
