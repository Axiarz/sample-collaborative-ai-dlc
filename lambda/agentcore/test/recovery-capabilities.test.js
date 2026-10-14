import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dispatchInvocation } from '../http-server.js';
import {
  deployedRecoveryCapabilities,
  recoveryDispatchPayload,
  runtimeRecoveryCapabilities,
} from '../recovery-capabilities.js';
import { commandDefinition } from '../../shared/agent-command-registry.js';

describe('side-effect-free recovery metadata and checked dispatch', () => {
  it('distinguishes changed deployed source even when the declared capability version is unchanged', () => {
    const directory = mkdtempSync(join(tmpdir(), 'recovery-image-'));
    try {
      mkdirSync(join(directory, 'agentcore'));
      mkdirSync(join(directory, 'shared'));
      writeFileSync(join(directory, 'agentcore', 'http-server.js'), 'export const build = 1;');
      writeFileSync(join(directory, 'shared', 'unit-completion.js'), 'export const policy = 1;');
      const root = pathToFileURL(`${directory}/`);
      const before = runtimeRecoveryCapabilities(root);
      writeFileSync(join(directory, 'shared', 'unit-completion.js'), 'export const policy = 2;');
      const after = runtimeRecoveryCapabilities(root);
      expect(after.capabilities).toEqual(before.capabilities);
      expect(after.sourceSha256).not.toBe(before.sourceSha256);
      const envelope = {
        schemaVersion: 1,
        sourceSha256: before.sourceSha256,
        requiredCapabilities: before.capabilities,
        payload: { command: 'run-stage' },
      };
      expect(recoveryDispatchPayload(envelope, after)).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports executable source identity without auth, accounting or business handlers', async () => {
    const prepareInvocation = vi.fn();
    const handler = vi.fn();
    const busy = { enter: vi.fn(), leave: vi.fn() };
    const result = await dispatchInvocation({
      payload: { command: 'recovery-capabilities' },
      prepareInvocation,
      handlers: { capabilities: handler },
      busy,
    });
    expect(result.body).toMatchObject({
      ok: true,
      schemaVersion: 1,
      capabilities: ['preserve-integrated-section@1', 'checked-runtime-dispatch@1'],
    });
    expect(result.body.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.body).not.toHaveProperty('env');
    expect(prepareInvocation).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(busy.enter).not.toHaveBeenCalled();
    expect(commandDefinition('recovery-capabilities').agentAuth).toBe(false);
  });

  it.each(['moved-source', 'unknown-schema', 'unsupported-capability', 'recursive-envelope'])(
    'rejects %s before any credential or handler work',
    async (scenario) => {
      const observed = deployedRecoveryCapabilities();
      const payload = {
        command: 'recovery-dispatch',
        schemaVersion: 1,
        sourceSha256: observed.sourceSha256,
        requiredCapabilities: observed.capabilities,
        payload: { command: 'run-stage', executionId: 'i1' },
      };
      if (scenario === 'moved-source') payload.sourceSha256 = 'b'.repeat(64);
      if (scenario === 'unknown-schema') payload.schemaVersion = 2;
      if (scenario === 'unsupported-capability') payload.requiredCapabilities = ['future@2'];
      if (scenario === 'recursive-envelope') payload.payload.command = 'recovery-dispatch';
      const prepareInvocation = vi.fn();
      const runStage = vi.fn();
      const result = await dispatchInvocation({
        payload,
        prepareInvocation,
        handlers: { runStage },
      });
      expect(result).toMatchObject({ statusCode: 409, body: { code: 'recovery_runtime_changed' } });
      expect(prepareInvocation).not.toHaveBeenCalled();
      expect(runStage).not.toHaveBeenCalled();
    },
  );

  it('dispatches a verified envelope through the existing credential boundary exactly once', async () => {
    const signal = deployedRecoveryCapabilities();
    const payload = { command: 'run-stage', executionId: 'i1', agentCredentialGrant: 'opaque' };
    const envelope = {
      command: 'recovery-dispatch',
      schemaVersion: 1,
      sourceSha256: signal.sourceSha256,
      requiredCapabilities: signal.capabilities,
      payload,
    };
    expect(recoveryDispatchPayload(envelope)).toEqual(payload);
    const prepareInvocation = vi.fn(async () => ({}));
    const runStage = vi.fn(async () => ({ ok: true }));
    expect(
      (await dispatchInvocation({ payload: envelope, prepareInvocation, handlers: { runStage } }))
        .body.ok,
    ).toBe(true);
    expect(prepareInvocation).toHaveBeenCalledExactlyOnceWith(payload, 'execution');
    expect(runStage).toHaveBeenCalledExactlyOnceWith(
      { command: 'run-stage', executionId: 'i1' },
      {},
    );
  });
});
