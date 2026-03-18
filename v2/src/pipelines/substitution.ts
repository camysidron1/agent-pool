/**
 * Eager substitution: replace {{param.NAME}} with provided param values.
 * Used at pipeline/template creation time.
 */
export function substituteParams(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{param\.([^}]+)\}\}/g, (_match, name: string) => {
    return name in params ? params[name] : `{{param.${name}}}`;
  });
}

/**
 * Lazy substitution: replace {{steps.STEP_ID.result}} with actual results.
 * Used at task claim time when results become available.
 */
export function substituteStepResults(text: string, results: Record<string, string>): string {
  return text.replace(/\{\{steps\.([^.}]+)\.result\}\}/g, (_match, stepId: string) => {
    return stepId in results ? results[stepId] : `{{steps.${stepId}.result}}`;
  });
}

/**
 * Check if text still contains unresolved {{steps.X.result}} references.
 */
export function hasUnresolvedStepRefs(text: string): boolean {
  return /\{\{steps\.[^.}]+\.result\}\}/.test(text);
}
