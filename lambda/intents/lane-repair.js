import { createHash } from 'node:crypto';
import { stageInstanceId } from '../shared/v2-execution-plan.js';
import { eventTypeOf } from '../shared/v2-process-keys.js';
import {
  activePlanUnits,
  effectiveSkeleton,
  skeletonCandidates,
  skeletonProblem,
  unitCompletion,
} from '../shared/unit-completion.js';

// Longer than the intents Lambda's 120-second lifetime. A killed worker cannot
// renew this lease; its successor must still claim the exact old run atomically.
export const REPAIR_LEASE_MS = 5 * 60 * 1000;
export const pendingRepair = (meta) =>
  Boolean(
    (meta.repairPlan && meta.repairPlan.owner === meta.orchestratorRunId) ||
    meta.failureReason === 'lane_repair_in_progress',
  );
export const activeRepair = (meta, now = Date.now()) =>
  pendingRepair(meta) &&
  (meta.failureReason === 'lane_repair_in_progress' || meta.status === 'CREATED') &&
  Date.parse(meta.repairStartedAt ?? meta.updatedAt) + REPAIR_LEASE_MS > now;

// Match the orchestrator's rewind-upstream-check, including every instance of
// earlier parallel stages. Missing rows are not completed work.
export const upstreamRecoveryProblem = (meta, records, plan, fromStageId) => {
  const index = plan.stages.findIndex((stage) => stage.stageId === fromStageId);
  if (index < 0) return fromStageId;
  const namespace = plan.namespace ?? `${meta.workflowId}@${meta.workflowVersion}`;
  const rows = new Map((records.stages ?? []).map((row) => [row.stageInstanceId, row]));
  for (const stage of plan.stages.slice(0, index)) {
    const slugs =
      stage.parallelSection != null
        ? (records.unitPlan?.units ?? []).map((unit) => unit.slug)
        : [null];
    if (!slugs.length) return stage.stageId;
    for (const slug of slugs) {
      const id =
        slug === null
          ? (stage.stageInstanceId ?? stageInstanceId(namespace, stage.stageId))
          : stageInstanceId(namespace, stage.stageId, slug, stage.parallelSection);
      if (!['SUCCEEDED', 'SKIPPED'].includes(rows.get(id)?.state))
        return `${stage.stageId}${slug ? ` [unit ${slug}]` : ''}`;
    }
  }
  return null;
};

// A missing best-effort graph projection does not prove that no final PR was
// created. Success precedes the engine's final PR step; completed shared work
// and durable delivery events also require verification after an interruption.
export const finalDeliveryMayHaveRun = (meta, records, plan) => {
  const eventTypes = (records.events ?? []).map(eventTypeOf);
  if (
    records.trackerSync?.pullRequests?.length ||
    eventTypes.some((type) => ['v2.pr.opened', 'v2.pr.recorded'].includes(type))
  )
    return true;
  if (Array.isArray(meta.repos) && meta.repos.length === 0) return false;
  if (
    meta.status === 'SUCCEEDED' ||
    eventTypes.some((type) => type === 'v2.execution.succeeded' || type?.startsWith('v2.pr.'))
  )
    return true;
  const last = plan.stages.at(-1);
  return (
    last?.parallelSection == null &&
    (records.stages ?? []).some(
      (stage) =>
        stage.stageId === last?.stageId &&
        !stage.unitSlug &&
        ['SUCCEEDED', 'SKIPPED'].includes(stage.state),
    )
  );
};

// Narrow extension of lane repair: terminal executions with unfinished active
// plan work. Rewind deliberately resets integrated lanes and is not equivalent.
export const incompleteSectionRepair = (meta, records, plan) => {
  if (!['SUCCEEDED', 'FAILED'].includes(meta.status) || !records.unitPlan?.units?.length)
    return null;
  const sections = [
    ...new Set(
      plan.stages
        .filter((stage) => stage.parallelSection != null)
        .map((stage) => Number(stage.parallelSection)),
    ),
  ];
  if (
    sections.length &&
    activePlanUnits(records.unitPlan, records.units).some((unit) => unit.sectionIndex == null)
  ) {
    return {
      error:
        'Legacy unit records have no section mapping. Review that mapping before recovery so integrated work is preserved.',
    };
  }
  const completion = unitCompletion({ ...records, meta }, sections);
  if (completion?.state !== 'incomplete') return null;
  const incompleteSections = [...new Set(completion.unresolved.map((unit) => unit.sectionIndex))];
  if (incompleteSections.length !== 1) {
    return {
      error:
        'Recovery requires one incomplete parallel section. Review the execution plan before continuing.',
    };
  }
  const sectionIndex = incompleteSections[0];
  const sectionStages = plan.stages.filter(
    (stage) => Number(stage.parallelSection) === sectionIndex,
  );
  const fromStageId = sectionStages[0].stageId;
  const upstream = upstreamRecoveryProblem(meta, records, plan, fromStageId);
  if (upstream)
    return {
      error: `Complete or retry upstream stage ${upstream} before recovering this section.`,
      code: 'rewind_upstream_incomplete',
    };
  const rerunSharedStages = plan.stages
    .slice(plan.stages.indexOf(sectionStages[0]))
    .filter((stage) => stage.parallelSection == null)
    .map((stage) => stage.stageId);
  const units = activePlanUnits(records.unitPlan, records.units).filter(
    (unit) => Number(unit.sectionIndex) === sectionIndex,
  );
  const problem = skeletonProblem(records.unitPlan, undefined, sectionStages);
  return {
    kind: 'incomplete-section',
    sectionIndex,
    fromStageId,
    laneSlugs: completion.unresolved.map((unit) => unit.slug),
    preservedSlugs: units.filter((unit) => unit.state === 'MERGED').map((unit) => unit.slug),
    rerunSharedStages,
    skeletonProblem: problem,
    skeletonCandidates: problem ? skeletonCandidates(records.unitPlan) : [],
    walkingSkeleton: effectiveSkeleton(records.unitPlan),
    branch: meta.branch,
    approvals: problem
      ? 'Confirm a dependency-free walking skeleton. Review that increment again, then choose construction autonomy. Normal stage and batch approvals still apply.'
      : 'Existing approved choices are preserved. Normal stage, skeleton and batch approvals still apply to unfinished work.',
  };
};

export const repairPreviewToken = (meta, records, preview) => {
  const orphaned = preview.kind === 'orphaned-lanes';
  const pendingStages = new Set(
    (records.humanTasks ?? [])
      .filter((gate) => gate.status === 'pending')
      .map((gate) => gate.stageInstanceId),
  );
  const repairable = new Set([
    'READY',
    'RUNNING',
    'PR_DRAFT',
    'RECONCILING',
    'PR_READY',
    'ADDRESSING_FEEDBACK',
    'MERGING',
    'FAILED',
    'BLOCKED',
  ]);
  return createHash('sha256')
    .update(
      JSON.stringify({
        run: meta.orchestratorRunId ?? null,
        status: orphaned && ['RUNNING', 'WAITING'].includes(meta.status) ? 'ACTIVE' : meta.status,
        ...(orphaned ? {} : { updatedAt: meta.updatedAt }),
        plan: records.unitPlan,
        units: orphaned
          ? (records.units ?? [])
              .filter((unit) => Number(unit.sectionIndex) === preview.sectionIndex)
              .map((unit) => ({
                slug: unit.slug,
                sectionIndex: unit.sectionIndex,
                branch: unit.branch,
                state: repairable.has(unit.state) ? 'repairable' : unit.state,
                completionSkip: unit.completionSkip,
              }))
          : records.units,
        // Output, metrics and completed sibling stages do not change which orphaned
        // waits are being repaired. Callback/attempt identity and new human gates do.
        stages: orphaned
          ? (records.stages ?? [])
              .filter(
                (stage) =>
                  stage.unitSlug &&
                  stage.state === 'WAITING_FOR_HUMAN' &&
                  !pendingStages.has(stage.stageInstanceId),
              )
              .map((stage) => ({
                stageInstanceId: stage.stageInstanceId,
                attempt: stage.attempt,
                stageCallbackId: stage.stageCallbackId,
              }))
          : records.stages,
        preview,
      }),
    )
    .digest('hex');
};
