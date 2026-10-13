import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createNativeRuntimeServer } from './fixtures/retained-native/runtime-server.js';

const identity = {
  projectId: 'project',
  executionId: 'execution',
  bindingId: 'binding',
  attemptId: 'attempt',
  epoch: 1,
  runtimeSessionId: 'runtime-session',
};
const env = {
  NATIVE_EXECUTION_ENABLED: 'true',
  NATIVE_RUNTIME_PROJECT_ID: identity.projectId,
  NATIVE_RUNTIME_EXECUTION_ID: identity.executionId,
  NATIVE_RUNTIME_BINDING_ID: identity.bindingId,
  NATIVE_EXECUTION_ATTEMPT_ID: identity.attemptId,
  NATIVE_EXECUTION_EPOCH: '1',
  NATIVE_EXECUTION_RUNTIME_SESSION_ID: identity.runtimeSessionId,
};
describe('retained runtime protocol compatibility', () => {
  it('uses the exact retained source bytes and accepts unchanged generation-scoped status payloads', async () => {
    const provenance = JSON.parse(
      await readFile(
        new URL('./fixtures/retained-native/provenance.json', import.meta.url),
        'utf8',
      ),
    );
    for (const [name, hash] of Object.entries(provenance.sha256))
      expect(
        createHash('sha256')
          .update(await readFile(new URL(`./fixtures/retained-native/${name}`, import.meta.url)))
          .digest('hex'),
      ).toBe(hash);
    const status = vi.fn(async () => ({ ...identity, writerGeneration: 1, status: 'running' }));
    const executor = {
      start: vi.fn(),
      continue: vi.fn(),
      status,
      cancel: vi.fn(),
      isBusy: () => false,
      settle: async () => {},
    };
    const server = createNativeRuntimeServer({
      env,
      checkWorkspace: async () => ({}),
      createExecutor: async () => executor,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/invocations`, {
        method: 'POST',
        body: JSON.stringify({ command: 'native-status', ...identity, writerGeneration: 1 }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'running', writerGeneration: 1 });
      expect(status).toHaveBeenCalledTimes(1);
      const unsupported = await fetch(`http://127.0.0.1:${server.address().port}/invocations`, {
        method: 'POST',
        body: JSON.stringify({
          command: 'native-status',
          ...identity,
          writerGeneration: 1,
          after: 0,
        }),
      });
      expect(unsupported.status).toBe(400);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
