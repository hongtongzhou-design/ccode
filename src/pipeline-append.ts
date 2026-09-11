import type { ProjectStepDto } from "./types";

/** 同名只在交付相容时可复用；显示名不等于步骤身份。 */
export function conflictingTemplateSteps(existing: ProjectStepDto[], incoming: ProjectStepDto[]): string[] {
  return incoming.filter((step) => {
    const previous = existing.find((s) => s.name.trim() === step.name.trim());
    return previous && step.expectedArtifacts.some((path) => !previous.expectedArtifacts.includes(path));
  }).map((s) => s.name);
}

export function renameConflictingSteps(existing: ProjectStepDto[], incoming: ProjectStepDto[], templateName: string): ProjectStepDto[] {
  const conflicts = new Set(conflictingTemplateSteps(existing, incoming));
  const names = new Set([...existing, ...incoming].map((s) => s.name));
  return incoming.map((step) => {
    if (!conflicts.has(step.name)) return step;
    const base = `${step.name}（${templateName}）`;
    let name = base;
    for (let n = 2; names.has(name); n++) name = `${base}·${n}`;
    names.add(name);
    return { ...step, name };
  });
}
