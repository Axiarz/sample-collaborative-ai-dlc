import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createNativePublications } from '../native-publication.js';
import {
  createNativeArtifactRevisions,
  nativeArtifactRevisionId,
  parseNativeArtifactRevisionId,
} from '../native-artifact-revision.js';
import { nativeRuntimeBindingKey } from '../native-runtime-binding.js';

const scope = { projectId: 'project-1', executionId: '11111111-1111-4111-8111-111111111111' };
const attemptId = '22222222-2222-4222-8222-222222222222';
const packageId = `sha256:${'a'.repeat(64)}`;
const sha = (value) => createHash('sha256').update(value).digest('hex');

const setup = async () => {
  const objects = new Map();
  const s3 = {
    async send(command) {
      const p = command.input;
      if (command.constructor.name === 'PutObjectCommand') {
        const version = `version-${objects.size + 1}`;
        objects.set(`${p.Key}:${version}`, Buffer.from(p.Body));
        return { VersionId: version };
      }
      const bytes = objects.get(`${p.Key}:${p.VersionId}`);
      if (!bytes) throw new Error('missing version');
      return { VersionId: p.VersionId, ContentLength: bytes.length, Body: Readable.from([bytes]) };
    },
  };
  const publications = createNativePublications({
    s3,
    bucket: 'native-results-test',
    accountId: '123456789012',
    now: () => '2026-10-01T12:00:00Z',
  });
  const write = (sequence, epoch, files) =>
    publications.write({
      identity: { ...scope, attemptId, epoch },
      packageId,
      nativeSessionId: null,
      outcome: 'STOPPED',
      repository: { branch: 'main', commit: 'b'.repeat(40) },
      files,
      sequence,
    });
  const first = await write(1, 1, [
    { path: 'docs/plan.md', role: 'artifact', content: Buffer.from('# Plan v1\n') },
    { path: 'src/bird.png', role: 'code', content: Buffer.from([0, 255, 128, 12]) },
  ]);
  const second = await write(2, 2, [
    { path: 'docs/plan.md', role: 'artifact', content: Buffer.from('# Plan v2 with pipes\n') },
  ]);
  const history = new Map();
  const execution = {
    scope,
    bindingId: 'binding-1',
    attemptId,
    publicationEpoch: 2,
    configuration: { packageId },
    publication: second,
  };
  history.set(`PUBLICATION#${'1'.padStart(16, '0')}`, {
    scope,
    bindingId: 'binding-1',
    attemptId,
    epoch: 1,
    publication: first,
  });
  const reads = [];
  const ddb = {
    async send(command) {
      reads.push(command.input);
      expect(command.input.ConsistentRead).toBe(true);
      expect(command.input.Key.pk).toBe(nativeRuntimeBindingKey(scope).pk);
      return { Item: history.get(command.input.Key.sk) };
    },
  };
  const revisions = createNativeArtifactRevisions({ ddb, nativeTable: 'native', publications });
  const manifestFile = async (receipt, epoch, path) =>
    (await publications.read({ ...scope, attemptId, epoch }, receipt)).files.find(
      (f) => f.path === path,
    );
  return { revisions, execution, first, second, history, reads, manifestFile };
};

describe('verified native artifact revisions', () => {
  it('round-trips the revision ID and rejects every other shape', () => {
    const id = nativeArtifactRevisionId({ fileId: `nf-${'c'.repeat(64)}`, sha256: 'd'.repeat(64) });
    expect(parseNativeArtifactRevisionId(id)).toEqual({
      fileId: `nf-${'c'.repeat(64)}`,
      sha256: 'd'.repeat(64),
    });
    for (const bad of [
      '',
      `nf-${'c'.repeat(64)}`,
      `nf-${'C'.repeat(64)}:${'d'.repeat(64)}`,
      `x:${'d'.repeat(64)}`,
      null,
    ]) {
      expect(parseNativeArtifactRevisionId(bad)).toBeNull();
    }
  });

  it('verifies a file in the current publication without any history read', async () => {
    const f = await setup();
    const file = await f.manifestFile(f.second, 2, 'docs/plan.md');
    const verified = await f.revisions.verify(f.execution, {
      fileId: file.id,
      sha256: file.sha256,
      publicationId: f.second.id,
    });
    expect(verified).toMatchObject({
      path: 'docs/plan.md',
      sha256: sha('# Plan v2 with pipes\n'),
      publicationId: f.second.id,
      publicationSequence: 2,
    });
    expect(f.reads).toHaveLength(0);
  });

  it('reads the exact older revision from its immutable history row after the file changed', async () => {
    const f = await setup();
    const old = await f.manifestFile(f.first, 1, 'docs/plan.md');
    const read = await f.revisions.read(
      f.execution,
      { fileId: old.id, sha256: old.sha256, publicationId: f.first.id, publicationSequence: 1 },
      { maxBytes: 1024 },
    );
    expect(read).toMatchObject({
      content: '# Plan v1\n',
      encoding: 'utf8',
      truncated: false,
      publicationSequence: 1,
    });
    // The same file ID at the current publication has different bytes: the
    // older hash must never be satisfied by the latest file.
    await expect(
      f.revisions.verify(f.execution, {
        fileId: old.id,
        sha256: old.sha256,
        publicationId: f.second.id,
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_REVISION_INVALID' });
  });

  it.each([
    ['another binding generation', (row) => ({ ...row, bindingId: 'binding-old' })],
    [
      'a mismatched sequence',
      (row) => ({ ...row, publication: { ...row.publication, sequence: 7 } }),
    ],
    ['another project', (row) => ({ ...row, scope: { ...scope, projectId: 'project-2' } })],
  ])('rejects a history row from %s', async (_label, mutate) => {
    const f = await setup();
    const key = `PUBLICATION#${'1'.padStart(16, '0')}`;
    f.history.set(key, mutate(f.history.get(key)));
    const old = await f.manifestFile(f.first, 1, 'docs/plan.md');
    await expect(
      f.revisions.verify(f.execution, {
        fileId: old.id,
        sha256: old.sha256,
        publicationId: f.first.id,
        publicationSequence: 1,
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_REVISION_INVALID' });
  });

  it('rejects a changed package identity, unknown files, and missing publications', async () => {
    const f = await setup();
    const file = await f.manifestFile(f.second, 2, 'docs/plan.md');
    const revision = { fileId: file.id, sha256: file.sha256, publicationId: f.second.id };
    await expect(
      f.revisions.verify(
        { ...f.execution, configuration: { packageId: `sha256:${'f'.repeat(64)}` } },
        revision,
      ),
    ).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_REVISION_INVALID' });
    await expect(
      f.revisions.verify(f.execution, { ...revision, fileId: `nf-${'0'.repeat(64)}` }),
    ).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_REVISION_INVALID' });
    await expect(
      f.revisions.verify({ ...f.execution, publication: undefined }, revision),
    ).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_REVISION_INVALID' });
    await expect(
      f.revisions.verify(f.execution, { ...revision, publicationId: 'e'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_REVISION_INVALID' });
  });

  it('never supplies binary bytes and marks truncated text explicitly', async () => {
    const f = await setup();
    const png = await f.manifestFile(f.first, 1, 'src/bird.png');
    const binary = await f.revisions.read(
      f.execution,
      { fileId: png.id, sha256: png.sha256, publicationId: f.first.id, publicationSequence: 1 },
      { maxBytes: 1024 },
    );
    expect(binary).toMatchObject({ encoding: 'binary', content: null });
    const plan = await f.manifestFile(f.second, 2, 'docs/plan.md');
    const text = await f.revisions.read(
      f.execution,
      { fileId: plan.id, sha256: plan.sha256, publicationId: f.second.id },
      { maxBytes: 6 },
    );
    expect(text).toMatchObject({ content: '# Plan', truncated: true });
  });
});
