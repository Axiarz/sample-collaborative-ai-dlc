import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const inspector = fileURLToPath(new URL('../inspect-terraform-plan.mjs', import.meta.url));

function inspect(
  actions,
  {
    type = 'aws_efs_file_system',
    address = 'module.native_runs[0].aws_efs_file_system.runs',
    proof,
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'aidlc-efs-retention-'));
  try {
    const plan = join(directory, 'plan.json');
    writeFileSync(
      plan,
      JSON.stringify({
        resource_changes: [
          {
            address,
            type,
            change: { actions },
          },
          ...(proof
            ? [
                {
                  address: 'data.external.native_decommission[0]',
                  type: 'external',
                  change: { actions: ['read'], after: proof },
                },
              ]
            : []),
        ],
      }),
    );
    return spawnSync(process.execPath, [inspector, plan], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('rejects removing or replacing native working files even when the pilot is disabled', () => {
  for (const actions of [['delete'], ['delete', 'create'], ['create', 'delete']]) {
    const result = inspect(actions);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /aws_efs_file_system\.runs/);
  }
});

test('allows creating, updating or retaining the native filesystem', () => {
  for (const actions of [['create'], ['update'], ['no-op']]) {
    const result = inspect(actions);
    assert.equal(result.status, 0, result.stderr);
  }
});

test('native service removal requires an evaluated empty protected inventory and closed admission', () => {
  const service = {
    type: 'aws_lambda_function',
    address: 'module.native_runs[0].module.execution_worker[0].aws_lambda_function.this[0]',
  };
  for (const proof of [
    undefined,
    { result: { empty: 'true', records: '1' }, query: { admissionClosed: 'true' } },
    { result: { empty: 'true', records: '0' }, query: { admissionClosed: 'false' } },
  ])
    assert.equal(inspect(['delete'], { ...service, proof }).status, 1);
  const proof = { result: { empty: 'true', records: '0' }, query: { admissionClosed: 'true' } };
  assert.equal(inspect(['delete'], { ...service, proof }).status, 0);
  assert.equal(inspect(['delete'], { proof }).status, 1); // storage has its own guard
});
