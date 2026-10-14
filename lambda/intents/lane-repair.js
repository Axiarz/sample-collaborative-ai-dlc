import { createHash } from 'node:crypto';
import {
  activePlanUnits,
  effectiveSkeleton,
  skeletonCandidates,
  skeletonProblem,
  unitCompletion,
} from '../shared/unit-completion.js';

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

export const repairPreviewToken = (meta, records, preview) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        run: meta.orchestratorRunId ?? null,
        status: meta.status,
        updatedAt: meta.updatedAt,
        plan: records.unitPlan,
        units: records.units,
        stages: records.stages,
        preview,
      }),
    )
    .digest('hex');
