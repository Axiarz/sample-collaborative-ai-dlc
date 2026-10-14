import { describe, expect, it, vi } from 'vitest';
import { checkRecoveryCompatibility, recoveryRuntimeGuard } from '../recovery-compatibility.js';
import contract from '../../shared/recovery-capabilities.json' with { type: 'json' };

const runtimeArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/original-abcdefghij';
const functionArn = 'arn:aws:lambda:us-east-1:123456789012:function:orchestrator:17';
const sourceSha256 = 'a'.repeat(64);
const fixture = () => {
  const alias = { FunctionVersion: '17', RevisionId: 'alias-1' };
  const config = {
    FunctionArn: functionArn,
    Version: '17',
    State: 'Active',
    CodeSha256: 'package-hash',
  };
  const endpoint = {
    agentRuntimeArn: runtimeArn,
    name: 'original',
    status: 'READY',
    liveVersion: '7',
    targetVersion: '7',
    lastUpdatedAt: new Date('2026-01-01'),
  };
  const signal = { ok: true, ...contract, sourceSha256 };
  const input = {
    meta: { environment: { runtimeArn, runtimeEndpoint: 'original' } },
    env: {
      V2_ORCHESTRATOR_FUNCTION: 'orchestrator:live',
      AGENTCORE_RUNTIME_ARN: 'never-use-project-default',
      AWS_REGION: 'us-east-1',
      RECOVERY_ORCHESTRATOR_RELEASE: JSON.stringify({
        ...contract,
        functionArn,
        codeSha256: 'package-hash',
      }),
    },
    lambda: {
      send: vi.fn(async (command) =>
        command.constructor.name === 'GetAliasCommand' ? alias : config,
      ),
    },
    runtimeControl: { send: vi.fn(async () => ({ ...endpoint })) },
    agentcore: { send: vi.fn(async () => ({ response: [Buffer.from(JSON.stringify(signal))] })) },
  };
  return { input, alias, config, endpoint, signal };
};

describe('preservation recovery compatibility', () => {
  it('verifies a published package and the original endpoint through metadata-only work', async () => {
    const { input } = fixture();
    const result = await checkRecoveryCompatibility(input);
    expect(result.status).toBe('supported');
    expect(result.orchestrator).toMatchObject({
      functionArn,
      version: '17',
      codeSha256: 'package-hash',
    });
    expect(result.runtime).toMatchObject({
      agentRuntimeArn: runtimeArn,
      qualifier: 'original',
      version: '7',
      sourceSha256,
    });
    expect(input.lambda.send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      'GetAliasCommand',
      'GetFunctionConfigurationCommand',
    ]);
    const invoke = input.agentcore.send.mock.calls[0][0].input;
    expect(invoke).toMatchObject({ agentRuntimeArn: runtimeArn, qualifier: 'original' });
    expect(JSON.parse(Buffer.from(invoke.payload))).toEqual({ command: 'recovery-capabilities' });
    expect(recoveryRuntimeGuard(result)).toEqual({
      schemaVersion: 1,
      sourceSha256,
      requiredCapabilities: contract.capabilities,
      agentRuntimeArn: runtimeArn,
      qualifier: 'original',
    });
  });

  it('resolves numeric launch targets without consulting an alias and defaults only the original endpoint', async () => {
    const { input, endpoint } = fixture();
    input.env.V2_ORCHESTRATOR_FUNCTION = functionArn;
    delete input.meta.environment.runtimeEndpoint;
    endpoint.name = 'DEFAULT';
    expect((await checkRecoveryCompatibility(input)).status).toBe('supported');
    expect(input.lambda.send).toHaveBeenCalledTimes(1);
    expect(input.agentcore.send.mock.calls[0][0].input.qualifier).toBeUndefined();
  });

  it('verifies legacy fallback against the actual immutable orchestrator configuration', async () => {
    const { input, config, endpoint } = fixture();
    input.meta = {};
    input.env.AGENTCORE_RUNTIME_ARN = runtimeArn;
    config.Environment = {
      Variables: { AGENTCORE_RUNTIME_ARN: runtimeArn, SECRET: 'never-return' },
    };
    endpoint.name = 'DEFAULT';
    const result = await checkRecoveryCompatibility(input);
    expect(result.status).toBe('supported');
    expect(JSON.stringify(result)).not.toContain('never-return');
    config.Environment.Variables.AGENTCORE_RUNTIME_ARN = `${runtimeArn}-different`;
    expect((await checkRecoveryCompatibility(input)).status).toBe('unverified');
  });

  it.each([
    [
      'older runtime',
      (f) => {
        f.signal.capabilities = [];
      },
      'update-required',
    ],
    [
      'future runtime schema',
      (f) => {
        f.signal.schemaVersion = 2;
      },
      'update-required',
    ],
    [
      'missing runtime signal',
      (f) => {
        delete f.signal.sourceSha256;
      },
      'update-required',
    ],
    [
      'old dispatcher',
      (f) => {
        f.signal.ok = false;
        f.signal.error = 'unknown command';
      },
      'update-required',
    ],
    [
      'unattested package',
      (f) => {
        f.config.CodeSha256 = 'another-package';
      },
      'update-required',
    ],
    [
      'unattested version',
      (f) => {
        f.input.env.RECOVERY_ORCHESTRATOR_RELEASE = '{}';
      },
      'update-required',
    ],
    [
      'weighted alias',
      (f) => {
        f.alias.RoutingConfig = { AdditionalVersionWeights: { 16: 0.1 } };
      },
      'unverified',
    ],
    [
      'unqualified function',
      (f) => {
        f.input.env.V2_ORCHESTRATOR_FUNCTION = 'orchestrator';
      },
      'unverified',
    ],
    [
      'endpoint rollout',
      (f) => {
        f.endpoint.targetVersion = '8';
      },
      'unverified',
    ],
    [
      'failed endpoint',
      (f) => {
        f.endpoint.status = 'UPDATE_FAILED';
      },
      'unverified',
    ],
    [
      'wrong region',
      (f) => {
        f.input.env.AWS_REGION = 'eu-west-1';
      },
      'unverified',
    ],
    [
      'absent runtime pin and fallback',
      (f) => {
        f.input.meta = {};
        delete f.input.env.AGENTCORE_RUNTIME_ARN;
      },
      'unverified',
    ],
  ])('blocks %s', async (_name, change, status) => {
    const f = fixture();
    change(f);
    expect((await checkRecoveryCompatibility(f.input)).status).toBe(status);
  });

  it.each(['lambda', 'runtimeControl', 'agentcore'])(
    'fails closed on %s access denial without exposing errors or secrets',
    async (client) => {
      const { input } = fixture();
      input[client].send.mockRejectedValue(
        Object.assign(new Error('sensitive error detail'), { name: 'AccessDeniedException' }),
      );
      const result = await checkRecoveryCompatibility(input);
      expect(result.status).toBe('unverified');
      expect(JSON.stringify(result)).toContain('access_denied');
      expect(JSON.stringify(result)).not.toContain('sensitive error detail');
    },
  );

  it('detects endpoint movement during the probe and read outages', async () => {
    const { input, endpoint } = fixture();
    input.runtimeControl.send
      .mockResolvedValueOnce({ ...endpoint })
      .mockResolvedValue({ ...endpoint, liveVersion: '8', targetVersion: '8' });
    expect((await checkRecoveryCompatibility(input)).status).toBe('unverified');
    input.runtimeControl.send.mockRejectedValue(new Error('outage'));
    expect((await checkRecoveryCompatibility(input)).status).toBe('unverified');
  });

  it('does not reuse cached observations after an alias or runtime source moves', async () => {
    const f = fixture();
    const first = await checkRecoveryCompatibility(f.input);
    f.alias.RevisionId = 'alias-2';
    f.signal.sourceSha256 = 'b'.repeat(64);
    const second = await checkRecoveryCompatibility(f.input);
    expect(first).not.toEqual(second);
    expect(f.input.agentcore.send).toHaveBeenCalledTimes(2);
    expect(f.input.agentcore.send.mock.calls[0][0].input.runtimeSessionId).not.toBe(
      f.input.agentcore.send.mock.calls[1][0].input.runtimeSessionId,
    );
  });
});
