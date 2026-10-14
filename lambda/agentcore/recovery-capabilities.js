import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import contract from '../shared/recovery-capabilities.json' with { type: 'json' };

// Fingerprint the executable source actually present in this container, including
// shared helpers. No environment, credentials, workspace, CLI or model discovery.
// Managed images inherit these same protected source directories.
export const runtimeRecoveryCapabilities = (root = new URL('../', import.meta.url)) => {
  const hash = createHash('sha256');
  const walk = (directory) => {
    for (const entry of readdirSync(new URL(directory, root), { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name, 'en'),
    )) {
      if (['node_modules', 'test'].includes(entry.name) || entry.name.startsWith('.')) continue;
      const path = `${directory}${entry.name}`;
      if (entry.isDirectory()) walk(`${path}/`);
      else if (entry.isFile() && /\.(js|json)$/.test(entry.name)) {
        hash
          .update(path)
          .update('\0')
          .update(readFileSync(join(fileURLToPath(root), path)));
      }
    }
  };
  walk('agentcore/');
  walk('shared/');
  return { ...contract, sourceSha256: hash.digest('hex') };
};

let cached;
export const deployedRecoveryCapabilities = () => (cached ??= runtimeRecoveryCapabilities());

export const recoveryDispatchPayload = (envelope, observed = deployedRecoveryCapabilities()) => {
  if (
    envelope?.schemaVersion !== 1 ||
    envelope.sourceSha256 !== observed.sourceSha256 ||
    !Array.isArray(envelope.requiredCapabilities) ||
    !envelope.requiredCapabilities.length ||
    !envelope.requiredCapabilities.every((capability) =>
      observed.capabilities.includes(capability),
    ) ||
    !envelope.payload?.command ||
    ['recovery-dispatch', 'recovery-capabilities'].includes(envelope.payload.command)
  ) {
    return null;
  }
  return envelope.payload;
};
