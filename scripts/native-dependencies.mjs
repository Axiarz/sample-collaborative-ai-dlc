#!/usr/bin/env node
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { nativeDependencyInventory, assertNativeRemoval } from './lib/native-dependencies.mjs';

// Read-only operator/preflight tool. No runtime objects or pins are modified.
const terraform = process.argv.includes('--terraform');
const input = terraform
  ? JSON.parse(readFileSync(0, 'utf8'))
  : {
      table: process.argv[2],
    };
if (!input.table) throw new Error('Usage: native-dependencies.mjs <native-control-table>');
// Verify the deployed command alias, not just desired Terraform booleans. Wait
// out admitted HTTP invocations before scanning, then recheck the same version.
if (terraform) {
  const lambda = new LambdaClient({});
  const request = { FunctionName: `${input.table}-authority:commands` };
  try {
    const before = await lambda.send(new GetFunctionConfigurationCommand(request));
    const closed = (config) =>
      config.Environment?.Variables?.NATIVE_EXECUTION_ADMISSION_ENABLED === 'false' &&
      config.Environment?.Variables?.NATIVE_PREPARATION_ADMISSION_ENABLED === 'false';
    if (!closed(before) || before.Timeout > 60)
      throw new Error('Deploy admission shutdown before decommissioning');
    await delay((before.Timeout + 1) * 1000);
    const after = await lambda.send(new GetFunctionConfigurationCommand(request));
    if (!closed(after) || before.Version !== after.Version)
      throw new Error('Admission deployment changed during drain');
  } catch (error) {
    if (error.name !== 'ResourceNotFoundException') throw error;
  }
}
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const rows = [];
let ExclusiveStartKey;
try {
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: input.table,
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    rows.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
} catch (error) {
  if (error.name !== 'ResourceNotFoundException') throw error;
}
const inventory = nativeDependencyInventory(rows);
if (terraform) {
  assertNativeRemoval(inventory, {
    admissionClosed: input.admissionClosed === 'true',
    entireService: true,
    dependencies: [],
  });
  console.log(JSON.stringify({ empty: 'true', records: String(inventory.records) }));
} else console.log(JSON.stringify(inventory, null, 2));
