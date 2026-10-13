import { describe, expect, it, vi } from 'vitest';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createNativeActivityStore } from '../activity-store.js';
import { nativeExecutionKey } from '../execution-store.js';

const scope = { projectId: 'project-one', executionId: '12345678-1234-4234-8234-123456789abc' };
const owner = () => ({ scope, bindingId: 'binding', attemptId: 'attempt', epoch: 1,
  runtimeSessionId: 'session', writerGeneration: 1, turnSequence: 1,
  configurationSha256: 'a'.repeat(64), version: 3, leaseToken: 'lease', leaseExpiresAt: 2000, cancelRequested: false });
const event = (index, extra = {}) => ({ index, writerGeneration: 1, sequence: 1, kind: 'stdout',
  capturedAt: 1000, content: `Message ${index}.`, display: { type: 'message', level: 'info' }, ...extra });
const batch = (events, after = 0, extra = {}) => ({ ...scope, bindingId: 'binding', attemptId: 'attempt', epoch: 1,
  runtimeSessionId: 'session', writerGeneration: 1, after, events, ...extra });
const fixture = () => {
  const row = owner();
  const items = new Map();
  const key = value => JSON.stringify({ pk: value.pk, sk: value.sk });
  const put = value => items.set(key(value), structuredClone(value));
  put({ ...nativeExecutionKey(scope), ...row });
  const state = { loseAck: false, failWrite: false };
  const ddb = { send: vi.fn(async command => {
    const input = command.input;
    if (command instanceof GetCommand) return { Item: structuredClone(items.get(key(input.Key))) };
    if (command instanceof QueryCommand) {
      const vals = input.ExpressionAttributeValues;
      const rows = [...items.values()].filter(r => r.pk === vals[':pk'] && r.sk >= vals[':after'] && r.sk <= vals[':end']).sort((a,b) => a.sk.localeCompare(b.sk));
      return { Items: rows.slice(0,input.Limit), ...(rows.length > input.Limit ? { LastEvaluatedKey: rows[input.Limit-1] } : {}) };
    }
    expect(command).toBeInstanceOf(TransactWriteCommand);
    if (state.failWrite) throw new Error('unavailable');
    const check = input.TransactItems[0].ConditionCheck;
    const current = items.get(key(check.Key));
    for (const [name, field] of Object.entries(check.ExpressionAttributeNames))
      if (current?.[field] !== check.ExpressionAttributeValues[name.replace('#',':')]) throw new Error('conditional check');
    if (current.cancelRequested || current.leaseExpiresAt <= 1000) throw new Error('conditional check');
    const cursor = input.TransactItems[1].Put;
    const previous = items.get(key(cursor.Item));
    if (cursor.ExpressionAttributeValues) {
      const v = cursor.ExpressionAttributeValues;
      if (!previous || previous.seq !== v[':seq'] || previous.index !== v[':index'] || previous.writerGeneration !== v[':generation']) throw new Error('cursor conflict');
    } else if (previous) throw new Error('cursor conflict');
    for (const op of input.TransactItems.slice(2)) if (items.has(key(op.Put.Item))) throw new Error('duplicate');
    for (const op of input.TransactItems.slice(1)) put(op.Put.Item);
    if (state.loseAck) { state.loseAck = false; throw new Error('response lost'); }
    return {};
  }) };
  const broadcast = vi.fn(async () => {});
  return { row, items, put, state, ddb, broadcast, store: createNativeActivityStore({ ddb, tableName: 'native-bindings', now: () => 1000, broadcast }) };
};

describe('trusted native OUTPUT ingestion', () => {
  it('persists ordering and cursor atomically before broadcasting/acknowledging', async () => {
    const f = fixture();
    expect(await f.store.ingest(f.row, batch([event(1),event(2)]))).toBe(2);
    expect(await f.store.cursor(f.row)).toBe(2);
    expect(f.broadcast).toHaveBeenCalledTimes(2);
    expect(f.broadcast.mock.calls[0][0]).toEqual(scope);
    expect(JSON.stringify(f.broadcast.mock.calls)).not.toContain('Message');
    expect(f.broadcast.mock.calls[0][1]).not.toHaveProperty('content');
    const output = await f.store.history(scope);
    expect(output.outputs.map(r => r.seq)).toEqual([1,2]);
    expect(output.outputs[0]).toMatchObject({ stageInstanceId: null, content: 'Message 1.', display: { type: 'message' }, timestamp: '1970-01-01T00:00:01.000Z' });
  });
  it('retries an identical batch after a lost transaction response without duplicating output', async () => {
    const f = fixture(); f.state.loseAck = true;
    const b = batch([event(1),event(2)]);
    await expect(f.store.ingest(f.row,b)).rejects.toThrow('response lost');
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(await f.store.ingest(f.row,b)).toBe(2);
    expect((await f.store.history(scope)).outputs).toHaveLength(2);
    await expect(f.store.ingest(f.row,batch([event(1,{content:'changed'})]))).rejects.toMatchObject({code:'NATIVE_ACTIVITY_CONFLICT'});
  });
  it('does not advance the cursor on a failed persistence attempt', async () => {
    const f = fixture(); f.state.failWrite = true;
    await expect(f.store.ingest(f.row,batch([event(1)]))).rejects.toThrow();
    expect(await f.store.cursor(f.row)).toBe(0);
    expect(f.broadcast).not.toHaveBeenCalled();
  });
  it('allows only one competing transaction and accepts its identical retry', async () => {
    const f = fixture(); const b = batch([event(1)]);
    const results = await Promise.allSettled([f.store.ingest(f.row,b), f.store.ingest(f.row,b)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await f.store.ingest(f.row,b)).toBe(1);
    expect(f.broadcast).toHaveBeenCalledTimes(1);
  });
  it.each(['projectId','executionId','bindingId','attemptId','epoch','runtimeSessionId','writerGeneration'])('rejects mismatched %s', async field => {
    const f = fixture();
    await expect(f.store.ingest(f.row,batch([event(1)],0,{[field]:'foreign'}))).rejects.toMatchObject({code:'NATIVE_ACTIVITY_CONFLICT'});
    expect(f.broadcast).not.toHaveBeenCalled();
  });
  it('rejects unordered, old-turn and delayed old-generation events', async () => {
    const f = fixture();
    for (const events of [[event(2)], [event(1,{sequence:2})], [event(1,{writerGeneration:2})]])
      await expect(f.store.ingest(f.row,batch(events))).rejects.toMatchObject({code:'NATIVE_ACTIVITY_CONFLICT'});
    f.row.writerGeneration = 2;
    f.put({...nativeExecutionKey(scope),...f.row});
    await expect(f.store.ingest(f.row,batch([event(1)]))).rejects.toMatchObject({code:'NATIVE_ACTIVITY_CONFLICT'});
  });
  it('keeps global OUTPUT order across recovery and paginates beyond 64 rows', async () => {
    const f = fixture();
    await f.store.ingest(f.row,batch(Array.from({length:64},(_,i)=>event(i+1))));
    f.row.writerGeneration = 2; f.row.turnSequence = 2; f.row.version++;
    f.put({...nativeExecutionKey(scope),...f.row});
    await f.store.ingest(f.row,batch([event(1,{writerGeneration:2,sequence:2})],0,{writerGeneration:2}));
    const first = await f.store.history(scope);
    expect(first.outputs).toHaveLength(64); expect(first.nextAfter).toBe(64);
    const second = await f.store.history(scope, first.nextAfter);
    expect(second.outputs.map(r=>r.seq)).toEqual([65]); expect(second.nextAfter).toBe(null);
  });
  it('checks the protected owner on duplicate acknowledgment as well as new writes', async () => {
    const f = fixture(); const b = batch([event(1)]);
    await f.store.ingest(f.row,b);
    f.put({...nativeExecutionKey(scope),...f.row, version: 4, cancelRequested: true});
    await expect(f.store.ingest(f.row,b)).rejects.toMatchObject({code:'NATIVE_ACTIVITY_CONFLICT'});
    await expect(f.store.ingest(f.row,batch([event(2)],1))).rejects.toThrow();
  });
});
