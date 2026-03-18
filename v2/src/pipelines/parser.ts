import { parse as parseYaml } from 'yaml';
import type { PipelineDef, PipelineParamDef, PipelineStepDef, TemplateDef } from './types.js';

const VALID_RETRY_STRATEGIES = ['same', 'augmented', 'escalate'] as const;

function validateParams(params: unknown): PipelineParamDef[] {
  if (!Array.isArray(params)) {
    throw new Error('params must be an array');
  }
  for (const p of params) {
    if (typeof p !== 'object' || p === null) {
      throw new Error('each param must be an object');
    }
    if (typeof p.name !== 'string' || p.name.length === 0) {
      throw new Error('each param must have a non-empty "name" string');
    }
  }
  return params as PipelineParamDef[];
}

function validateRetryStrategy(value: unknown): 'same' | 'augmented' | 'escalate' {
  if (!VALID_RETRY_STRATEGIES.includes(value as typeof VALID_RETRY_STRATEGIES[number])) {
    throw new Error(`retryStrategy must be one of: ${VALID_RETRY_STRATEGIES.join(', ')}; got "${value}"`);
  }
  return value as 'same' | 'augmented' | 'escalate';
}

/**
 * Detect cycles in step dependencies using topological sort (Kahn's algorithm).
 * Throws if a cycle is detected.
 */
function detectCycles(steps: PipelineStepDef[]): void {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const step of steps) {
    inDegree.set(step.id, 0);
    adjacency.set(step.id, []);
  }

  for (const step of steps) {
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        adjacency.get(dep)!.push(step.id);
        inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const neighbor of adjacency.get(node)!) {
      const newDeg = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (visited !== steps.length) {
    throw new Error('pipeline contains a dependency cycle');
  }
}

export function parsePipelineDef(yamlContent: string): PipelineDef {
  const raw = parseYaml(yamlContent);
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('pipeline definition must be a YAML object');
  }

  // name
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new Error('pipeline must have a non-empty "name" string');
  }

  // steps
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new Error('pipeline must have a non-empty "steps" array');
  }

  // Validate each step and collect IDs
  const stepIds = new Set<string>();
  const steps: PipelineStepDef[] = [];

  for (let i = 0; i < raw.steps.length; i++) {
    const s = raw.steps[i];
    if (typeof s !== 'object' || s === null) {
      throw new Error(`step[${i}] must be an object`);
    }
    if (typeof s.id !== 'string' || s.id.length === 0) {
      throw new Error(`step[${i}] must have a non-empty "id" string`);
    }
    if (typeof s.prompt !== 'string' || s.prompt.length === 0) {
      throw new Error(`step[${i}] must have a non-empty "prompt" string`);
    }
    if (stepIds.has(s.id)) {
      throw new Error(`duplicate step id: "${s.id}"`);
    }
    stepIds.add(s.id);

    const step: PipelineStepDef = { id: s.id, prompt: s.prompt };

    if (s.dependsOn !== undefined) {
      if (!Array.isArray(s.dependsOn)) {
        throw new Error(`step "${s.id}" dependsOn must be an array`);
      }
      step.dependsOn = s.dependsOn as string[];
    }
    if (s.priority !== undefined) step.priority = Number(s.priority);
    if (s.timeoutMinutes !== undefined) step.timeoutMinutes = Number(s.timeoutMinutes);
    if (s.retryMax !== undefined) step.retryMax = Number(s.retryMax);
    if (s.retryStrategy !== undefined) step.retryStrategy = validateRetryStrategy(s.retryStrategy);

    steps.push(step);
  }

  // Validate dependsOn references
  for (const step of steps) {
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        if (!stepIds.has(dep)) {
          throw new Error(`step "${step.id}" depends on unknown step "${dep}"`);
        }
      }
    }
  }

  // Cycle detection
  detectCycles(steps);

  // Build result
  const result: PipelineDef = { name: raw.name, steps };
  if (typeof raw.description === 'string') result.description = raw.description;
  if (raw.params !== undefined) result.params = validateParams(raw.params);

  return result;
}

export function parseTemplateDef(yamlContent: string): TemplateDef {
  const raw = parseYaml(yamlContent);
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('template definition must be a YAML object');
  }

  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new Error('template must have a non-empty "name" string');
  }
  if (typeof raw.prompt !== 'string' || raw.prompt.length === 0) {
    throw new Error('template must have a non-empty "prompt" string');
  }

  const result: TemplateDef = { name: raw.name, prompt: raw.prompt };
  if (typeof raw.description === 'string') result.description = raw.description;
  if (raw.params !== undefined) result.params = validateParams(raw.params);
  if (raw.priority !== undefined) result.priority = Number(raw.priority);
  if (raw.timeoutMinutes !== undefined) result.timeoutMinutes = Number(raw.timeoutMinutes);
  if (raw.retryMax !== undefined) result.retryMax = Number(raw.retryMax);
  if (raw.retryStrategy !== undefined) result.retryStrategy = validateRetryStrategy(raw.retryStrategy);

  return result;
}
