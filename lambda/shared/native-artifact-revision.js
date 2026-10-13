// Verified native artifact revisions for collaboration: discussion anchors and
// Quorum context. A revision is one committed file's exact bytes, identified by
// its stable file ID and content hash within a named immutable publication.
// The protected execution row or its PUBLICATION#<sequence> history row is the
// authority; the Neptune projection is never consulted. Reads confer no
// execution, approval or edit authority.
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { nativeRuntimeBindingKey } from './native-runtime-binding.js';

const SHA = /^[a-f0-9]{64}$/;
const FILE_ID = /^nf-[a-f0-9]{64}$/;
const REVISION = /^(nf-[a-f0-9]{64}):([a-f0-9]{64})$/;
export const NATIVE_ARTIFACT_CONTEXT_MAX_FILE_BYTES = 3 * 1024 * 1024;

export const nativeArtifactRevisionId = ({ fileId, sha256 }) => {
  if (!FILE_ID.test(fileId ?? '') || !SHA.test(sha256 ?? ''))
    throw new Error('Invalid native artifact revision');
  return `${fileId}:${sha256}`;
};
export const parseNativeArtifactRevisionId = (value) => {
  const match = typeof value === 'string' ? REVISION.exec(value) : null;
  return match ? { fileId: match[1], sha256: match[2] } : null;
};

const unavailable = () =>
  Object.assign(new Error('Native artifact revision could not be verified'), {
    code: 'NATIVE_ARTIFACT_REVISION_INVALID',
  });

const describe = ({ manifest, file, found }) => ({
  fileId: file.id,
  path: file.path,
  sha256: file.sha256,
  bytes: file.bytes,
  mediaType: file.mediaType,
  publicationId: found.receipt.id,
  publicationSequence: manifest.sequence,
});

export const createNativeArtifactRevisions = ({ ddb, nativeTable, publications }) => {
  // Resolve the immutable publication receipt plus the identity its objects
  // were written under. The current publication uses the row's publication
  // epoch; an older one must come from its own conditional history row.
  const receiptFor = async (execution, { publicationId, publicationSequence }) => {
    const { projectId, executionId } = execution.scope ?? {};
    if (execution.publication?.id === publicationId) {
      return {
        identity: {
          projectId,
          executionId,
          attemptId: execution.attemptId,
          epoch: execution.publicationEpoch,
        },
        receipt: execution.publication,
      };
    }
    if (!Number.isSafeInteger(publicationSequence) || publicationSequence < 1) return null;
    const { Item: item } = await ddb.send(
      new GetCommand({
        TableName: nativeTable,
        Key: {
          pk: nativeRuntimeBindingKey({ projectId, executionId }).pk,
          sk: `PUBLICATION#${String(publicationSequence).padStart(16, '0')}`,
        },
        ConsistentRead: true,
      }),
    );
    if (
      !item ||
      item.publication?.id !== publicationId ||
      item.publication?.sequence !== publicationSequence ||
      item.bindingId !== execution.bindingId ||
      item.scope?.projectId !== projectId ||
      item.scope?.executionId !== executionId
    )
      return null;
    return {
      identity: { projectId, executionId, attemptId: item.attemptId, epoch: item.epoch },
      receipt: item.publication,
    };
  };

  const locate = async (execution, revision) => {
    if (
      !execution?.publication ||
      !SHA.test(revision?.publicationId ?? '') ||
      !FILE_ID.test(revision?.fileId ?? '') ||
      !SHA.test(revision?.sha256 ?? '')
    )
      throw unavailable();
    const found = await receiptFor(execution, revision);
    if (!found) throw unavailable();
    let manifest;
    try {
      manifest = await publications.read(found.identity, found.receipt);
    } catch {
      throw unavailable();
    }
    if (manifest.packageId !== execution.configuration?.packageId) throw unavailable();
    const file = manifest.files.find((entry) => entry.id === revision.fileId);
    if (!file || file.sha256 !== revision.sha256) throw unavailable();
    return { found, manifest, file };
  };

  return Object.freeze({
    // Metadata only: used to anchor a revision-specific discussion.
    async verify(execution, revision) {
      return describe(await locate(execution, revision));
    },
    // Exact verified bytes for Quorum. Text larger than maxBytes is supplied
    // as a clearly truncated prefix; binary content is never supplied.
    async read(execution, revision, { maxBytes }) {
      const located = await locate(execution, revision);
      // Match the inline viewer: never download a large object to build context.
      if (located.file.bytes > NATIVE_ARTIFACT_CONTEXT_MAX_FILE_BYTES)
        return { ...describe(located), encoding: 'too_large', content: null, truncated: false };
      let bytes;
      try {
        ({ bytes } = await publications.file(
          located.found.identity,
          located.manifest,
          located.file.id,
        ));
      } catch {
        throw unavailable();
      }
      let text = null;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (text.includes('\0')) text = null;
      } catch {
        text = null;
      }
      const truncated = text !== null && Buffer.byteLength(text) > maxBytes;
      return {
        ...describe(located),
        encoding: text === null ? 'binary' : 'utf8',
        content:
          text === null
            ? null
            : truncated
              ? Buffer.from(text).subarray(0, maxBytes).toString('utf8')
              : text,
        truncated,
      };
    },
  });
};
