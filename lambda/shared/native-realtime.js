import { createHash } from 'node:crypto';
// Native intent IDs are only unique within a protected project. Never mint or
// broadcast the platform's global intent:<id> scope for a native binding.
const PART = '[A-Za-z0-9][A-Za-z0-9_.-]{0,255}';
const CHANNEL = new RegExp(`^native-intent:(${PART}):(${PART})$`);
export const nativeIntentChannel = ({ projectId, executionId }) => {
  const channel = `native-intent:${projectId}:${executionId}`;
  if (!CHANNEL.test(channel)) throw new Error('Invalid native realtime scope');
  return channel;
};
export const requiredNativeScopeForChannel = channel =>
  typeof channel === 'string' && CHANNEL.test(channel) ? channel : null;

// Native collaboration documents (task-2). The digest is the protected
// binding-key digest, so one execution ID reused in two projects never shares
// a document. Discussion threads are execution-wide collaboration state; reply
// drafts are revision-specific and need a scope the token route mints only
// after re-reading the protected execution row. Drafts confer no authority.
const SHA = /^[a-f0-9]{64}$/;
const DISCUSSION = /^disc-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const nativeCollaborationDigest = (identity) => {
  nativeIntentChannel(identity);
  return createHash('sha256').update(JSON.stringify([identity.projectId, identity.executionId])).digest('hex');
};
export const nativeCollaborationScope = (identity) => `native-collab:${nativeCollaborationDigest(identity)}`;
export const nativeDiscussionDocument = (identity, discussionId) => {
  if (!DISCUSSION.test(discussionId ?? '')) throw new Error('Invalid native discussion');
  return `native-discussion-${nativeCollaborationDigest(identity)}-${discussionId}`;
};
const replyRevision = ({ interactionId, sequence }) => {
  if (!SHA.test(interactionId ?? '') || !Number.isSafeInteger(sequence) || sequence < 1)
    throw new Error('Invalid native reply revision');
  return `${interactionId}-${sequence}`;
};
export const nativeReplyDocument = (identity, revision) =>
  `native-reply-${nativeCollaborationDigest(identity)}-${replyRevision(revision)}`;
export const nativeReplyScope = (identity, revision) =>
  `native-reply:${nativeCollaborationDigest(identity)}:${replyRevision(revision).replace('-', ':')}`;

// Task-3: the structured answer draft for the same awaited turn.
export const nativeAnswerDocument = (identity, revision) =>
  `native-answer-${nativeCollaborationDigest(identity)}-${replyRevision(revision)}`;
export const nativeAnswerScope = (identity, revision) =>
  `native-answer:${nativeCollaborationDigest(identity)}:${replyRevision(revision).replace('-', ':')}`;
