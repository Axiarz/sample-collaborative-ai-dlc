import { signRealtimeToken } from '../shared/realtime-token.js';
import {
  resolveNativeAwareIntentProject,
  resolveNativeCollaborationAccess,
} from '../shared/native-realtime-ownership.js';
import {
  nativeCollaborationScope,
  nativeAnswerScope,
  nativeIntentChannel,
  nativeReplyScope,
} from '../shared/native-realtime.js';
import { fetchWorkflowSourceMembership } from '../shared/workflow-source-membership.js';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const nativeReplyRevisionRequest = (target) =>
  target.executionBackend === 'native' &&
  Object.keys(target).length === 2 &&
  target.document !== null &&
  typeof target.document === 'object' &&
  !Array.isArray(target.document) &&
  Object.keys(target.document).length === 3 &&
  ['reply', 'answer'].includes(target.document.kind) &&
  SHA256_HEX.test(target.document.interactionId ?? '') &&
  Number.isSafeInteger(target.document.sequence) &&
  target.document.sequence >= 1;
import { isPlatformExecution } from '../shared/execution-backend.js';

export const issueIntentRealtimeToken = async ({
  body,
  store,
  intentId,
  projectId,
  sub,
  ddb,
  g,
  response,
  authorize,
  getSecret,
}) => {
  const target = body ? JSON.parse(body) : {};
  if (
    target.executionBackend !== undefined &&
    !['native', 'platform'].includes(target.executionBackend)
  )
    return response(400, { error: 'Invalid realtime backend' });
  // A native reply draft is a revision-specific Yjs document. Its scope is
  // minted only while that exact interaction/turn is awaiting a reply.
  const replyDocument = target.document;
  if (replyDocument !== undefined && !nativeReplyRevisionRequest(target))
    return response(400, { error: 'Invalid realtime document' });
  const meta =
    target.executionBackend === 'native'
      ? null
      : await store.getExecution(intentId, { consistentRead: true });
  let owner = meta && isPlatformExecution(meta) ? meta.projectId : null;
  const native = !owner;
  if (!owner && process.env.NATIVE_RUNTIME_BINDINGS_TABLE) {
    try {
      owner = await resolveNativeAwareIntentProject({
        ddb,
        nativeTable: process.env.NATIVE_RUNTIME_BINDINGS_TABLE,
        projectId,
        intentId,
        platformProject: async () => null,
      });
    } catch {
      return response(503, { error: 'Realtime ownership is temporarily unavailable' });
    }
  }
  if (owner !== projectId) return response(404, { error: 'Intent not found' });
  // Image execution policy does not authorize result reads. Only protected
  // ownership/current project membership authorizes this content-free channel.
  const secret = await getSecret();
  const currentAuth = await authorize(g, projectId, sub, response);
  if (currentAuth.res) return currentAuth.res;
  const identity = { projectId, executionId: intentId };
  const scopes = native
    ? [nativeIntentChannel(identity), nativeCollaborationScope(identity), `project:${projectId}`]
    : [`intent:${intentId}`, `project:${projectId}`];
  if (replyDocument !== undefined) {
    if (!native) return response(400, { error: 'Invalid realtime document' });
    let access;
    try {
      access = await resolveNativeCollaborationAccess({
        ddb,
        nativeTable: process.env.NATIVE_RUNTIME_BINDINGS_TABLE,
        ...identity,
        membership: () => fetchWorkflowSourceMembership(g, projectId, sub),
      });
    } catch (err) {
      if (err?.code === 'WORKFLOW_SOURCE_FORBIDDEN') return response(403, { error: 'Forbidden' });
      return response(503, { error: 'Realtime ownership is temporarily unavailable' });
    }
    if (access.status === 403) return response(403, { error: 'Forbidden' });
    const row = access.execution;
    if (access.status !== 200 || !row) return response(404, { error: 'Intent not found' });
    if (
      row.status !== 'AWAITING_USER' ||
      row.cancelRequested ||
      row.interaction?.id !== replyDocument.interactionId ||
      row.interaction?.sequence !== replyDocument.sequence ||
      (row.turnSequence ?? 1) !== replyDocument.sequence
    )
      return response(409, { error: 'Native interaction changed; refresh before replying' });
    const revision = {
      interactionId: replyDocument.interactionId,
      sequence: replyDocument.sequence,
    };
    scopes.push(
      replyDocument.kind === 'answer'
        ? nativeAnswerScope(identity, revision)
        : nativeReplyScope(identity, revision),
    );
  }
  const { token, exp } = signRealtimeToken({ sub, scopes }, secret);
  return response(200, { token, exp, scopes });
};
