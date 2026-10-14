import { randomUUID } from 'node:crypto';
import { GetAliasCommand, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeEndpointCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { resolveRuntimeTarget } from '../shared/runtime-target.js';
import contract from '../shared/recovery-capabilities.json' with { type: 'json' };

const control = new BedrockAgentCoreControlClient({ maxAttempts: 2 });
const requiredCapabilities = contract.capabilities;
const supported = (signal) =>
  signal?.schemaVersion === 1 &&
  Array.isArray(signal.capabilities) &&
  requiredCapabilities.every((capability) => signal.capabilities.includes(capability));
const issue = (status, reason, message) => ({ status, reason, message });
const readFailure = (error) =>
  issue(
    'unverified',
    error?.name === 'AccessDeniedException' || error?.name === 'AccessDenied'
      ? 'access_denied'
      : 'unavailable',
    error?.name === 'AccessDeniedException' || error?.name === 'AccessDenied'
      ? 'An administrator must allow the recovery compatibility reads, then refresh this preview.'
      : 'Compatibility could not be verified. Refresh this preview when the service is available.',
  );

// No cache: every preview and confirmation observes the real targets. The
// deployment attestation is generated from the published Lambda package hash,
// never from an app version, alias name, timestamp or operator-set feature flag.
export const checkRecoveryCompatibility = async ({
  meta,
  lambda,
  agentcore,
  runtimeControl = control,
  env = process.env,
}) => {
  const options = { abortSignal: AbortSignal.timeout(15_000) };
  let orchestrator;
  let orchestratorRuntimeFallback;
  try {
    const configuredTarget = env.V2_ORCHESTRATOR_FUNCTION || '';
    const match = configuredTarget.match(/^(.*):([^:]+)$/);
    if (!match || match[2] === '$LATEST') {
      orchestrator = issue(
        'unverified',
        'unqualified_target',
        'An administrator must configure a published recovery release, then refresh this preview.',
      );
    } else {
      const [, functionName, qualifier] = match;
      let version = qualifier;
      let aliasRevision = null;
      if (!/^[1-9]\d*$/.test(qualifier)) {
        const alias = await lambda.send(
          new GetAliasCommand({ FunctionName: functionName, Name: qualifier }),
          options,
        );
        if (Object.keys(alias.RoutingConfig?.AdditionalVersionWeights ?? {}).length) {
          throw new Error('Weighted recovery target');
        }
        version = alias.FunctionVersion;
        aliasRevision = alias.RevisionId;
      }
      if (!/^[1-9]\d*$/.test(version)) throw new Error('Unresolved version');
      const actual = await lambda.send(
        new GetFunctionConfigurationCommand({ FunctionName: functionName, Qualifier: version }),
        options,
      );
      orchestratorRuntimeFallback = actual.Environment?.Variables?.AGENTCORE_RUNTIME_ARN;
      const functionArn = actual.FunctionArn?.replace(/:[^:]+$/, `:${version}`);
      const attestation = JSON.parse(env.RECOVERY_ORCHESTRATOR_RELEASE || 'null');
      const identity = {
        configuredTarget,
        functionArn,
        version,
        codeSha256: actual.CodeSha256,
        aliasRevision,
      };
      if (
        !actual.FunctionArn?.endsWith(`:${version}`) ||
        actual.Version !== version ||
        actual.State !== 'Active' ||
        !actual.CodeSha256
      ) {
        throw new Error('Release not active');
      }
      orchestrator = {
        ...identity,
        ...(supported(attestation) &&
        attestation.functionArn === functionArn &&
        attestation.codeSha256 === actual.CodeSha256
          ? { status: 'supported' }
          : issue(
              'update-required',
              'release_not_attested',
              'An administrator must deploy the recovery update to the configured launch target, then refresh this preview.',
            )),
      };
    }
  } catch (error) {
    orchestrator = readFailure(error);
  }

  let runtime;
  try {
    const target = resolveRuntimeTarget(meta, env.AGENTCORE_RUNTIME_ARN);
    if (
      !resolveRuntimeTarget(meta).agentRuntimeArn &&
      (!orchestratorRuntimeFallback || orchestratorRuntimeFallback !== target.agentRuntimeArn)
    ) {
      throw new Error('Legacy runtime fallback is not the verified launch target');
    }
    const match = target.agentRuntimeArn.match(
      /^arn:[^:]+:bedrock-agentcore:([^:]+):\d{12}:runtime\/([^/]+)$/,
    );
    // The existing invoke clients are regional. Never probe a different Region
    // and claim that the actual invocation path will use that observation.
    if (!match || (env.AWS_REGION && match[1] !== env.AWS_REGION))
      throw new Error('Runtime target unavailable');
    const input = { agentRuntimeId: match[2], endpointName: target.qualifier || 'DEFAULT' };
    const readEndpoint = async () => {
      const endpoint = await runtimeControl.send(
        new GetAgentRuntimeEndpointCommand(input),
        options,
      );
      if (
        endpoint.status !== 'READY' ||
        !/^[1-9]\d*$/.test(endpoint.liveVersion) ||
        (endpoint.targetVersion && endpoint.targetVersion !== endpoint.liveVersion) ||
        endpoint.agentRuntimeArn !== target.agentRuntimeArn ||
        endpoint.name !== input.endpointName ||
        !endpoint.lastUpdatedAt
      )
        throw new Error('Runtime endpoint not ready');
      return {
        agentRuntimeArn: target.agentRuntimeArn,
        qualifier: input.endpointName,
        version: endpoint.liveVersion,
        revision: new Date(endpoint.lastUpdatedAt).toISOString(),
      };
    };
    const before = await readEndpoint();
    // A unique metadata-only session avoids observing a warm business session's
    // retired image. Old runtimes reject this unknown command without doing work.
    const result = await agentcore.send(
      new InvokeAgentRuntimeCommand({
        ...target,
        runtimeSessionId: `recovery-check-${randomUUID()}`,
        contentType: 'application/json',
        accept: 'application/json',
        payload: Buffer.from(JSON.stringify({ command: 'recovery-capabilities' })),
      }),
      options,
    );
    let text = '';
    if (!result?.response) throw new Error('Empty capability response');
    for await (const chunk of result.response) {
      text += Buffer.from(chunk).toString('utf8');
      if (text.length > 16_384) throw new Error('Oversized capability response');
    }
    const signal = JSON.parse(text);
    const after = await readEndpoint();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Runtime endpoint moved');
    runtime = {
      ...after,
      ...(signal.ok === true && supported(signal) && /^[a-f0-9]{64}$/.test(signal.sourceSha256)
        ? { status: 'supported', sourceSha256: signal.sourceSha256 }
        : issue(
            'update-required',
            'runtime_not_supported',
            'The environment captured by this intent needs the recovery update. Ask an administrator to update that environment, then refresh this preview.',
          )),
    };
  } catch (error) {
    runtime = readFailure(error);
  }
  const status = [orchestrator, runtime].some((item) => item.status === 'unverified')
    ? 'unverified'
    : [orchestrator, runtime].every((item) => item.status === 'supported')
      ? 'supported'
      : 'update-required';
  return { schemaVersion: 1, requiredCapabilities, status, orchestrator, runtime };
};

export const recoveryRuntimeGuard = (compatibility) => ({
  schemaVersion: 1,
  sourceSha256: compatibility.runtime.sourceSha256,
  requiredCapabilities: compatibility.requiredCapabilities,
  agentRuntimeArn: compatibility.runtime.agentRuntimeArn,
  qualifier: compatibility.runtime.qualifier,
});
