// Pipeline definition (parsed from YAML)
export interface PipelineStepDef {
  id: string;
  prompt: string;
  dependsOn?: string[]; // step IDs within the pipeline
  priority?: number;
  timeoutMinutes?: number;
  retryMax?: number;
  retryStrategy?: 'same' | 'augmented' | 'escalate';
}

export interface PipelineParamDef {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
}

export interface PipelineDef {
  name: string;
  description?: string;
  params?: PipelineParamDef[];
  steps: PipelineStepDef[];
}

// Template definition (parsed from YAML)
export interface TemplateDef {
  name: string;
  description?: string;
  params?: PipelineParamDef[];
  prompt: string;
  priority?: number;
  timeoutMinutes?: number;
  retryMax?: number;
  retryStrategy?: 'same' | 'augmented' | 'escalate';
}
