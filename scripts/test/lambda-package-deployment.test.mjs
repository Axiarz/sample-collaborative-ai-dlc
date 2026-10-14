import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const inspector = join(root, 'scripts/inspect-terraform-plan.mjs');
const workflow = readFileSync(join(root, '.github/workflows/deploy-demo.yml'), 'utf8');

const workflowStep = (name) => {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0];
  const run = step?.split('        run: |\n')[1];
  assert.ok(run, `Missing executable workflow step: ${name}`);
  return run.replace(/^          /gm, '');
};

const fixture = (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'aidlc packages '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of ['terraform/builds', 'terraform/.terraform/modules/lambda', 'lambda', 'tmp']) {
    mkdirSync(join(directory, path), { recursive: true });
  }
  return directory;
};

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

const runStep = (name, directory, env = {}) =>
  spawnSync('bash', ['-c', workflowStep(name)], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      AIDLC_PLAN_FILE: join(directory, 'saved.tfplan'),
      TF_ENVIRONMENT: 'prod',
      RUNNER_TEMP: join(directory, 'tmp'),
      ...env,
    },
  });

const prepareBuilder = (directory) =>
  writeFileSync(
    join(directory, 'terraform/.terraform/modules/lambda/package.py'),
    `import json, pathlib, sys
plan = json.loads(pathlib.Path(sys.argv[-1]).read_text())
if plan.get("fail"):
    sys.exit("fixture build failed")
if not plan.get("omit"):
    path = pathlib.Path(plan["filename"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"fixture archive")
`,
  );

test('workflow builds root and nested Lambda plans with duplicate basenames and spaces', (t) => {
  const directory = fixture(t);
  prepareBuilder(directory);
  const directories = [
    'builds',
    'builds/managed-environments/environment-control',
    'builds/managed-environments/environment-status',
    'builds/managed-environments/tool-control',
    'builds/managed-environments/tool-status',
    'builds/path with spaces',
  ];
  for (const path of directories) {
    writeJson(join(directory, 'terraform', path, 'same.plan.json'), {
      filename: `${path}/same.zip`,
    });
  }
  const result = runStep('Build Lambda packages', directory);
  assert.equal(result.status, 0, result.stderr);
  for (const path of directories) {
    assert.ok(existsSync(join(directory, 'terraform', path, 'same.zip')), path);
  }
});

test('workflow rejects missing plans, failed builds, and builders that omit the archive', (t) => {
  for (const plan of [null, { fail: true }, { omit: true }]) {
    const directory = fixture(t);
    prepareBuilder(directory);
    if (plan) {
      writeJson(join(directory, 'terraform/builds/nested/test.plan.json'), {
        filename: 'builds/nested/test.zip',
        ...plan,
      });
    }
    const result = runStep('Build Lambda packages', directory);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /did not generate any Lambda package plans|fixture build failed|Lambda package was not created/,
    );
  }
});

const lambda = (actions, before, after, afterUnknown = {}) => ({
  address: 'module.tools.aws_lambda_function.control',
  mode: 'managed',
  type: 'aws_lambda_function',
  change: { actions, before, after, after_unknown: afterUnknown },
});

const inspect = (directory, changes) => {
  const planPath = join(directory, 'plan.json');
  writeJson(planPath, { resource_changes: changes });
  return spawnSync(process.execPath, [inspector, planPath, '--require-lambda-packages'], {
    cwd: join(directory, 'terraform'),
    encoding: 'utf8',
  });
};

test('archive check permits remote sources and updates that do not upload local code', (t) => {
  const directory = fixture(t);
  writeFileSync(join(directory, 'terraform/builds/ready.zip'), 'archive');
  const old = { filename: 'builds/unavailable.zip', timeout: 3, source_code_hash: 'unchanged' };
  const result = inspect(directory, [
    lambda(['create'], null, { filename: 'builds/ready.zip' }),
    lambda(['no-op'], old, old),
    lambda(['delete'], old, null),
    lambda(['update'], old, { ...old, timeout: 30 }),
    lambda(
      ['update'],
      { ...old, architectures: ['arm64'] },
      { ...old, architectures: ['arm64'], timeout: 30 },
      { architectures: [false] },
    ),
    lambda(['create'], null, { filename: null, s3_bucket: 'packages', s3_key: 'code.zip' }),
    lambda(['create'], null, { filename: null, package_type: 'Image', image_uri: 'image:tag' }),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed \(1 local archives\)/);
});

test('archive check requires local packages for creates, replacements and code updates', (t) => {
  const directory = fixture(t);
  const before = { filename: 'builds/old.zip' };
  const cases = [
    lambda(['create'], null, before),
    lambda(['delete', 'create'], before, before),
    lambda(['create', 'delete'], before, before),
    lambda(['update'], before, { filename: 'builds/new.zip' }),
    ...['source_code_hash', 'code_sha256', 'source_kms_key_arn', 'architectures'].map((key) =>
      lambda(['update'], { ...before, [key]: 'old' }, { ...before, [key]: 'new' }),
    ),
    lambda(['update'], before, before, { source_code_hash: true }),
    lambda(['update'], before, before, { architectures: [true] }),
  ];
  for (const resource of cases) {
    const result = inspect(directory, [resource]);
    assert.equal(result.status, 1, JSON.stringify(resource));
    assert.match(result.stderr, /required local Lambda packages are unavailable/);
  }
});

test('archive check refuses unresolved filenames, empty archives and directories', (t) => {
  const directory = fixture(t);
  writeFileSync(join(directory, 'terraform/builds/empty.zip'), '');
  for (const filename of ['builds/empty.zip', 'builds']) {
    const result = inspect(directory, [lambda(['create'], null, { filename })]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /empty or not a file/);
  }
  const result = inspect(directory, [lambda(['create'], null, {}, { filename: true })]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /filename is not known/);
});

test('archive check retains the protected-resource destruction guard', (t) => {
  const directory = fixture(t);
  const result = inspect(directory, [
    {
      type: 'aws_dynamodb_table',
      address: 'aws_dynamodb_table.executions',
      change: { actions: ['delete'] },
    },
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /protected persistent resources would be destroyed/);
});

test('apply checks the final plan and stops before deployment when its archive is missing', (t) => {
  const directory = fixture(t);
  mkdirSync(join(directory, 'scripts'));
  mkdirSync(join(directory, 'bin'));
  copyFileSync(inspector, join(directory, 'scripts/inspect-terraform-plan.mjs'));
  writeFileSync(
    join(directory, 'scripts/deploy-terraform.sh'),
    '#!/bin/bash\ntouch "$RUNNER_TEMP/applied"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(directory, 'bin/terraform'),
    '#!/bin/bash\nset -eu\n[[ "$1" == -chdir=terraform && "$2" == show && "$3" == -json && "$4" == "$AIDLC_PLAN_FILE" ]]\ncat "$MOCK_PLAN_JSON"\n',
    { mode: 0o755 },
  );
  const finalPlan = join(directory, 'final-plan.json');
  writeJson(finalPlan, {
    resource_changes: [
      lambda(['update'], { filename: 'builds/draft.zip' }, { filename: 'builds/final.zip' }),
    ],
  });
  writeFileSync(join(directory, 'terraform/builds/draft.zip'), 'draft archive');
  const env = {
    PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
    MOCK_PLAN_JSON: finalPlan,
  };
  const missing = runStep('Apply infrastructure', directory, env);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /builds\/final\.zip/);
  assert.deepEqual(readdirSync(join(directory, 'tmp')), []);

  writeFileSync(join(directory, 'terraform/builds/final.zip'), 'final archive');
  const ready = runStep('Apply infrastructure', directory, env);
  assert.equal(ready.status, 0, ready.stderr);
  assert.deepEqual(readdirSync(join(directory, 'tmp')), ['applied']);
});
