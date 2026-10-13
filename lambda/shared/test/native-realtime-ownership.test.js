import { describe, expect, it, vi } from 'vitest';
import { resolveNativeAwareIntentProject, resolveNativeCollaborationAccess } from '../native-realtime-ownership.js';
import { nativeRuntimeBindingKey } from '../native-runtime-binding.js';

describe('protected native realtime ownership', () => {
  it('resolves the protected execution without any platform graph Intent', async () => {
    const platformProject = vi.fn(async () => null);
    const ddb = {send:vi.fn(async command => {
      expect(command.input.ConsistentRead).toBe(true);
      expect(command.input.Key).toEqual({...nativeRuntimeBindingKey({projectId:'p1',executionId:'i1'}),sk:'EXECUTION'});
      return {Item:{scope:{projectId:'p1',executionId:'i1'},bindingId:'binding'}};
    })};
    expect(await resolveNativeAwareIntentProject({ddb,nativeTable:'native',processTable:'platform',projectId:'p1',intentId:'i1',platformProject})).toBe('p1');
    expect(platformProject).not.toHaveBeenCalled();
  });
  it('does not grant a foreign native channel through the requested project fallback', async () => {
    const ddb={send:vi.fn(async()=>({}))};
    expect(await resolveNativeAwareIntentProject({ddb,nativeTable:'native',processTable:'platform',projectId:'p1',intentId:'foreign',platformProject:async()=>null})).toBe(null);
  });
  it('rejects mismatched protected projects and preserves platform ownership', async () => {
    const input={nativeTable:'native',processTable:'platform',projectId:'p1',intentId:'i1',platformProject:async()=>null};
    expect(await resolveNativeAwareIntentProject({...input,ddb:{send:async()=>({Item:{scope:{projectId:'p2',executionId:'i1'},bindingId:'binding'}})}})).toBe(null);
    expect(await resolveNativeAwareIntentProject({...input,ddb:{send:async cmd=>cmd.input.TableName==='platform'?{Item:{projectId:'p1',executionBackend:'platform'}}:{}}})).toBe('p1');
  });
});

describe('protected native collaboration access', () => {
  const key = nativeRuntimeBindingKey({ projectId: 'p1', executionId: 'i1' });
  const member = { role: 'member', membershipId: 'edge-1', projectIdentity: 'vertex-1' };
  const ddbFor = (records) => ({
    send: vi.fn(async (command) => {
      expect(command.input.ConsistentRead).toBe(true);
      return { Item: records[command.input.Key.sk] };
    }),
  });
  const records = (binding = {}, execution = {}) => ({
    RUNTIME: { projectId: 'p1', executionId: 'i1', bindingId: 'b1', projectIdentity: 'vertex-1', ...binding },
    EXECUTION: { scope: { projectId: 'p1', executionId: 'i1' }, bindingId: 'b1', ...execution },
  });
  const resolve = (ddb, membership = async () => member, projectId = 'p1') =>
    resolveNativeCollaborationAccess({ ddb, nativeTable: 'native', projectId, executionId: 'i1', membership });

  it('returns the protected binding, execution and membership snapshot', async () => {
    const result = await resolve(ddbFor(records()));
    expect(result).toMatchObject({ status: 200, member, binding: { bindingId: 'b1' }, execution: { bindingId: 'b1' } });
    expect(key.sk).toBe('RUNTIME');
  });
  it('checks membership before reading any execution record', async () => {
    const ddb = ddbFor(records());
    expect(await resolve(ddb, async () => null)).toEqual({ status: 403 });
    expect(await resolve(ddb, async () => ({ ...member, role: 'viewer' }))).toEqual({ status: 403 });
    expect(ddb.send).not.toHaveBeenCalled();
  });
  it('denies a recreated project identity even for a current member', async () => {
    expect(await resolve(ddbFor(records({ projectIdentity: 'vertex-old' })))).toEqual({ status: 403 });
  });
  it.each([
    ['a missing binding', { RUNTIME: undefined }],
    ['a foreign binding', records({ projectId: 'p2' })],
    ['a changed binding generation', records({}, { bindingId: 'b2' })],
    ['a foreign execution scope', records({}, { scope: { projectId: 'p2', executionId: 'i1' } })],
  ])('treats %s as not found', async (_label, rows) => {
    expect(await resolve(ddbFor(rows))).toEqual({ status: 404 });
  });
  it('allows a prepared draft without an execution row', async () => {
    expect(await resolve(ddbFor({ RUNTIME: records().RUNTIME }))).toMatchObject({ status: 200, execution: null });
  });
});
