import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  nativeArtifactRevisionId,
  nativeCollaborationDigest,
  nativeDiscussionDocument,
  nativeDiscussionRootId,
  nativeReplyDocument,
} from './nativeCollaboration';

// Must match lambda/shared/native-realtime.js (the server derives scopes from these names).
describe('native collaboration identities', () => {
  it('uses the protected binding digest of [projectId, intentId]', async () => {
    const expected = createHash('sha256').update(JSON.stringify(['project-1', 'run-1'])).digest('hex');
    expect(await nativeCollaborationDigest('project-1', 'run-1')).toBe(expected);
    expect(await nativeCollaborationDigest('project-2', 'run-1')).not.toBe(expected);
  });
  it('builds the exact document and anchor names the server accepts', () => {
    const digest = 'd'.repeat(64);
    expect(nativeReplyDocument(digest, { interactionId: 'a'.repeat(64), sequence: 2 })).toBe(
      `native-reply-${digest}-${'a'.repeat(64)}-2`,
    );
    expect(nativeDiscussionDocument(digest, 'disc-1')).toBe(`native-discussion-${digest}-disc-1`);
    expect(nativeDiscussionRootId(digest)).toBe(`native-discussions-${digest}`);
    expect(nativeArtifactRevisionId(`nf-${'c'.repeat(64)}`, 'e'.repeat(64))).toBe(`nf-${'c'.repeat(64)}:${'e'.repeat(64)}`);
  });
  it('refuses an unverifiable reply revision', () => {
    expect(() => nativeReplyDocument('d'.repeat(64), { interactionId: 'interaction', sequence: 1 })).toThrow();
    expect(() => nativeReplyDocument('d'.repeat(64), { interactionId: 'a'.repeat(64), sequence: 0 })).toThrow();
  });
});
