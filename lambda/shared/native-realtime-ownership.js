import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { nativeRuntimeBindingKey } from './native-runtime-binding.js';
import { executionMetaKey } from './v2-process-keys.js';

// Native graph roots are projections. Resolve the channel from protected
// records, never from a supplied project fallback or agent-written artifact.
export const resolveNativeAwareIntentProject = async ({ ddb, nativeTable, processTable, projectId, intentId, platformProject, onNative = () => {} }) => {
  if (!nativeTable) return (await platformProject()) || projectId; // retained platform deployment
  const key = nativeRuntimeBindingKey({projectId,executionId:intentId});
  const read = async (TableName, Key) => (await ddb.send(new GetCommand({TableName,Key,ConsistentRead:true}))).Item;
  const execution = await read(nativeTable,{...key,sk:'EXECUTION'});
  if (execution) {
    if (execution.scope?.projectId !== projectId || execution.scope?.executionId !== intentId || !execution.bindingId) return null;
    onNative(); return projectId;
  }
  const binding = await read(nativeTable,key);
  if (binding) {
    if (binding.projectId !== projectId || binding.executionId !== intentId || !binding.bindingId) return null;
    onNative(); return projectId;
  }
  const meta = processTable ? await read(processTable,executionMetaKey(intentId)) : null;
  if (meta) return meta.projectId === projectId && (!meta.executionBackend || meta.executionBackend === 'platform') ? projectId : null;
  // Existing graph-only platform drafts still resolve their own project.
  const graphProject = await platformProject();
  return graphProject === projectId ? projectId : null;
};

// Collaboration access (discussions, Quorum context, shared reply drafts).
// Membership comes first so a nonmember learns nothing about execution IDs.
// The protected RUNTIME binding, not the graph projection or the path, owns
// the execution; a recreated project or changed binding generation is denied.
// `membership` returns { role, membershipId, projectIdentity } or null.
const MEMBER_ROLES = new Set(['owner', 'admin', 'member']);
export const resolveNativeCollaborationAccess = async ({ ddb, nativeTable, projectId, executionId, membership }) => {
  const member = await membership();
  if (!member || !MEMBER_ROLES.has(member.role) || !member.membershipId || !member.projectIdentity) return { status: 403 };
  if (!nativeTable) return { status: 404 };
  let key;
  try { key = nativeRuntimeBindingKey({ projectId, executionId }); } catch { return { status: 404 }; }
  const read = async (Key) => (await ddb.send(new GetCommand({ TableName: nativeTable, Key, ConsistentRead: true }))).Item ?? null;
  const binding = await read(key);
  if (!binding || binding.projectId !== projectId || binding.executionId !== executionId || !binding.bindingId) return { status: 404 };
  const execution = await read({ ...key, sk: 'EXECUTION' });
  if (execution && (execution.scope?.projectId !== projectId || execution.scope?.executionId !== executionId || execution.bindingId !== binding.bindingId)) return { status: 404 };
  if (binding.projectIdentity !== member.projectIdentity) return { status: 403 };
  return { status: 200, binding, execution, member };
};
