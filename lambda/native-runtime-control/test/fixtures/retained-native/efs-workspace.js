// Test dependency bridge only. The retained router/workspace-check bytes stay
// exact; this dependency is not exercised when checkWorkspace is injected.
export { inspectNativeEfsWorkspace } from '../../../../agentcore/native/efs-workspace.js';
