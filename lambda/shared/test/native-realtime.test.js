import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import {
  nativeCollaborationDigest,
  nativeCollaborationScope,
  nativeDiscussionDocument,
  nativeIntentChannel,
  nativeReplyDocument,
  nativeReplyScope,
  requiredNativeScopeForChannel,
} from '../native-realtime.js';
import { nativeRuntimeBindingKey } from '../native-runtime-binding.js';
import { broadcastToNativeIntentChannel, broadcastToIntentChannel } from '../ws-fanout.js';
import shared from '../realtime-token.js';
import * as yjs from '../../yjs-server/realtime-token.js';
const ddb = mockClient(DynamoDBDocumentClient);
const api = mockClient(ApiGatewayManagementApiClient);
const executionId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const p1 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const p2 = '7c9e6679-7425-40de-944b-e07fc1f90ae8';
beforeEach(() => {
  ddb.reset();
  api.reset();
  vi.stubEnv('CONNECTIONS_TABLE', 'connections');
  vi.stubEnv('WEBSOCKET_ENDPOINT', 'https://example.invalid');
});
afterEach(() => vi.unstubAllEnvs());
it('delivers even metadata hints only to the exact native project channel, preserving platform fanout', async () => {
  const one = nativeIntentChannel({ projectId: p1, executionId });
  const two = nativeIntentChannel({ projectId: p2, executionId });
  const platform = `intent:${executionId}`;
  const connections = new Map([
    [one, 'one'],
    [two, 'two'],
    [platform, 'platform'],
  ]);
  ddb.on(QueryCommand).callsFake((input) => ({
    Items: [
      {
        connectionId: connections.get(input.ExpressionAttributeValues[':docId']),
        tokenExp: Date.now() / 1000 + 600,
      },
    ],
  }));
  api.on(PostToConnectionCommand).resolves({});
  await broadcastToNativeIntentChannel(
    { projectId: p1, executionId },
    { action: 'agent.output', seq: 1 },
  );
  expect(
    api.commandCalls(PostToConnectionCommand).map((call) => call.args[0].input.ConnectionId),
  ).toEqual(['one']);
  await broadcastToNativeIntentChannel(
    { projectId: p2, executionId },
    { action: 'agent.output', seq: 2 },
  );
  await broadcastToIntentChannel(executionId, { action: 'agent.output', seq: 3 });
  expect(
    api.commandCalls(PostToConnectionCommand).map((call) => call.args[0].input.ConnectionId),
  ).toEqual(['one', 'two', 'platform']);
});
it('native grants cannot authorize a colliding global intent or another project, including Yjs documents', () => {
  const one = nativeIntentChannel({ projectId: p1, executionId });
  const two = nativeIntentChannel({ projectId: p2, executionId });
  const secret = 'synthetic-secret';
  const { token } = shared.signRealtimeToken(
    { sub: 'member', scopes: [one, `project:${p1}`] },
    secret,
  );
  expect(
    shared.verifyRealtimeAccess({
      token,
      secret,
      sub: 'member',
      requiredScope: requiredNativeScopeForChannel(one),
    }).ok,
  ).toBe(true);
  expect(
    shared.verifyRealtimeAccess({
      token,
      secret,
      sub: 'member',
      requiredScope: requiredNativeScopeForChannel(two),
    }).ok,
  ).toBe(false);
  for (const verifier of [shared, yjs]) {
    expect(
      verifier.verifyRealtimeAccess({
        token,
        secret,
        sub: 'member',
        requiredScope: verifier.requiredScopeForYjsDoc(`intent-artifact-${executionId}-same`),
      }).ok,
    ).toBe(false);
    // Task-2 must add a project-qualified document grammar explicitly. Until
    // then native docs are denied, never mapped to the legacy global intent.
    expect(
      verifier.requiredScopeForYjsDoc(`native-intent-${p1}-${executionId}-artifact`),
    ).toBeNull();
  }
});

it('keys native documents by the protected binding digest so a reused ID never shares a document', () => {
  const one = { projectId: p1, executionId };
  const two = { projectId: p2, executionId };
  expect(`NATIVE#${nativeCollaborationDigest(one)}`).toBe(nativeRuntimeBindingKey(one).pk);
  const discussionId = `disc-${executionId}`;
  for (const verifier of [shared, yjs]) {
    expect(verifier.requiredScopeForYjsDoc(nativeDiscussionDocument(one, discussionId))).toBe(
      nativeCollaborationScope(one),
    );
    expect(verifier.requiredScopeForYjsDoc(nativeDiscussionDocument(two, discussionId))).toBe(
      nativeCollaborationScope(two),
    );
    const revision = { interactionId: 'a'.repeat(64), sequence: 3 };
    expect(verifier.requiredScopeForYjsDoc(nativeReplyDocument(one, revision))).toBe(
      nativeReplyScope(one, revision),
    );
  }
  expect(nativeCollaborationScope(one)).not.toBe(nativeCollaborationScope(two));
});
it('a collaboration grant opens discussions but never a reply draft, a platform document or another project', () => {
  const one = { projectId: p1, executionId };
  const secret = 'synthetic-secret';
  const { token } = shared.signRealtimeToken(
    { sub: 'member', scopes: [nativeIntentChannel(one), nativeCollaborationScope(one)] },
    secret,
  );
  const access = (verifier, docName) =>
    verifier.verifyRealtimeAccess({
      token,
      secret,
      sub: 'member',
      requiredScope: verifier.requiredScopeForYjsDoc(docName),
    }).ok;
  for (const verifier of [shared, yjs]) {
    expect(access(verifier, nativeDiscussionDocument(one, `disc-${executionId}`))).toBe(true);
    expect(
      access(
        verifier,
        nativeDiscussionDocument({ projectId: p2, executionId }, `disc-${executionId}`),
      ),
    ).toBe(false);
    expect(
      access(verifier, nativeReplyDocument(one, { interactionId: 'a'.repeat(64), sequence: 1 })),
    ).toBe(false);
    expect(access(verifier, `intent-discussion-${executionId}-disc-${executionId}`)).toBe(false);
  }
});
it('rejects malformed native document identities instead of building ambiguous names', () => {
  const one = { projectId: p1, executionId };
  expect(() => nativeDiscussionDocument(one, 'disc-not-a-uuid')).toThrow();
  expect(() => nativeReplyDocument(one, { interactionId: 'a'.repeat(63), sequence: 1 })).toThrow();
  expect(() => nativeReplyDocument(one, { interactionId: 'a'.repeat(64), sequence: 0 })).toThrow();
  expect(() => nativeCollaborationDigest({ projectId: 'bad:id', executionId })).toThrow();
});
