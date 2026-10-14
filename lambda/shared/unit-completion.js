// Execution truth, not provider PR state. MERGED means integrated into the
// intent branch. A deliberately omitted lane needs a recorded human decision.
import { createHash } from 'node:crypto';

export const unitPlanIdentity = (plan) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        units: plan?.units ?? [],
        sourceArtifactId: plan?.sourceArtifactId ?? null,
        producedByStageInstanceId: plan?.producedByStageInstanceId ?? null,
      }),
    )
    .digest('hex');

export const skeletonCeremonyDisabled = (stages = []) =>
  stages.find((stage) => stage.policy?.skeleton)?.policy?.skeleton === 'off';

export const skeletonCandidates = (plan) => {
  const roots = new Set(
    (plan?.units ?? []).filter((unit) => !(unit.dependsOn ?? []).length).map((unit) => unit.slug),
  );
  return [
    ...new Set([...(plan?.batches ?? []).flat(), ...(plan?.units ?? []).map((u) => u.slug)]),
  ].filter((slug) => roots.has(slug));
};

// Preserve a captured decision, including an invalid one, so approval/execution
// can explain and reject it. Only an absent decision receives a safe default.
export const effectiveSkeleton = (plan) =>
  plan?.walkingSkeleton ?? skeletonCandidates(plan)[0] ?? null;

export const skeletonProblem = (plan, skeleton = effectiveSkeleton(plan), stages = []) => {
  if (skeletonCeremonyDisabled(stages)) return null;
  const unit = plan?.units?.find((item) => item.slug === skeleton);
  if (!unit) return `Walking skeleton "${skeleton}" is not in the current unit plan.`;
  if (unit.dependsOn?.length) {
    return `Walking skeleton "${skeleton}" depends on ${unit.dependsOn.join(', ')}. It must run first, alone; select a dependency-free unit (${skeletonCandidates(plan).join(', ')}).`;
  }
  return null;
};

export const dependentClosure = (plan, slugs) => {
  const selected = new Set(slugs);
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of plan.units ?? []) {
      if (!selected.has(unit.slug) && unit.dependsOn?.some((slug) => selected.has(slug))) {
        selected.add(unit.slug);
        changed = true;
      }
    }
  }
  return [...selected];
};

export const hasUnitSkipDecision = (unit, plan) =>
  unit?.state !== 'MERGED' &&
  Boolean(unit?.completionSkip?.humanTaskId) &&
  unit.completionSkip.planIdentity === unitPlanIdentity(plan);

export const activePlanUnits = (plan, units = []) => {
  const slugs = new Set((plan?.units ?? []).map((unit) => unit.slug));
  return units.filter((unit) => slugs.has(unit.slug));
};

export const unitCompletion = (records, sectionIndexes) => {
  const plan = records.unitPlan;
  if (!plan?.units?.length) return null;
  const rows = activePlanUnits(plan, records.units);
  const sections = sectionIndexes ?? [...new Set(rows.map((unit) => unit.sectionIndex))];
  const outcomes = sections.flatMap((sectionIndex) =>
    plan.units.map((unit) => {
      const row = rows.find(
        (item) => item.slug === unit.slug && item.sectionIndex === sectionIndex,
      );
      return {
        sectionIndex,
        slug: unit.slug,
        state: row?.state ?? 'PENDING',
        integrated: row?.state === 'MERGED',
        skipped: hasUnitSkipDecision(row, plan),
      };
    }),
  );
  const unresolved = outcomes.filter((unit) => !unit.integrated && !unit.skipped);
  // Old runs recorded the choice on HUMAN, without a per-unit receipt. Keep
  // that distinction visible; never describe approved partial work as complete
  // or automatically offer to undo its decision. Superseded/older runs do not count.
  const legacyPartial =
    unresolved.length > 0 &&
    (records.humanTasks ?? []).some(
      (gate) =>
        gate.orchestratorRunId === records.meta?.orchestratorRunId &&
        Boolean(gate.orchestratorRunId) &&
        /^eg-halt-s\d/.test(gate.humanTaskId ?? '') &&
        ['approved', 'answered'].includes(gate.status) &&
        (gate.answer?.decision ?? gate.answer?.choice ?? gate.answer) === 'skip',
    );
  return {
    state: unresolved.length
      ? legacyPartial
        ? 'partial'
        : 'incomplete'
      : outcomes.some((unit) => unit.skipped)
        ? 'partial'
        : 'complete',
    total: outcomes.length,
    integrated: outcomes.filter((unit) => unit.integrated).length,
    skipped: outcomes.filter((unit) => unit.skipped).length,
    unresolved,
    legacyPartial,
  };
};
