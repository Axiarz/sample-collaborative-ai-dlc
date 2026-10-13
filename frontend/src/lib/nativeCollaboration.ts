import { useEffect, useState } from 'react';

// Native collaboration document identities. Mirrors lambda/shared/native-realtime.js:
// native intent IDs are only unique within a project, so documents are keyed by
// the protected binding digest sha256(JSON [projectId, intentId]). The server
// derives the required token scope from these exact names (deny-by-default).

const HEX64 = /^[a-f0-9]{64}$/;

export async function nativeCollaborationDigest(
  projectId: string,
  intentId: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([projectId, intentId]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Root ID the discussions service stamps on native thread DTOs (`sprintId`). */
export const nativeDiscussionRootId = (digest: string): string => `native-discussions-${digest}`;

export const nativeDiscussionDocument = (digest: string, discussionId: string): string =>
  `native-discussion-${digest}-${discussionId}`;

export interface NativeReplyRevision {
  interactionId: string;
  sequence: number;
}

/** A shared reply draft for exactly one interaction and turn. */
export const nativeReplyDocument = (digest: string, revision: NativeReplyRevision): string => {
  if (
    !HEX64.test(revision.interactionId) ||
    !Number.isSafeInteger(revision.sequence) ||
    revision.sequence < 1
  )
    throw new Error('Invalid native reply revision');
  return `native-reply-${digest}-${revision.interactionId}-${revision.sequence}`;
};

/** The structured answer draft (QuestionEditor) for one interaction and turn. */
export const nativeAnswerDocument = (digest: string, revision: NativeReplyRevision): string =>
  nativeReplyDocument(digest, revision).replace(/^native-reply-/, 'native-answer-');

/** A native artifact discussion anchors one exact file revision. */
export const nativeArtifactRevisionId = (fileId: string, sha256: string): string =>
  `${fileId}:${sha256}`;

/**
 * Resolve the collaboration digest for a native intent. Null until computed, and
 * whenever the project/intent pair changes, so no document from a previous run
 * is ever opened under a new identity.
 */
export function useNativeCollaborationDigest(
  projectId?: string | null,
  intentId?: string | null,
): string | null {
  const [state, setState] = useState<{ key: string; digest: string } | null>(null);
  const key = projectId && intentId ? JSON.stringify([projectId, intentId]) : null;
  useEffect(() => {
    if (!projectId || !intentId || !key) return;
    let cancelled = false;
    nativeCollaborationDigest(projectId, intentId)
      .then((digest) => {
        if (!cancelled) setState({ key, digest });
      })
      .catch(() => {
        if (!cancelled) setState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, intentId, key]);
  return key && state?.key === key ? state.digest : null;
}
