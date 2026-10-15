// Frozen load-meta boundary from preventive commit 324cb246.
export const loadMetaBeforeDelivery = async (store, executionId) => {
  const loaded = await store.getExecution(executionId, { consistentRead: true });
  return loaded ? { ...loaded, completionPolicyVersion: 2 } : null;
};
