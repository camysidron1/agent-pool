import { describe, test, expect } from 'bun:test';
import { parsePipelineDef, parseTemplateDef } from '../../../src/pipelines/parser.js';

describe('parsePipelineDef', () => {
  test('parses a valid pipeline with multiple steps and dependencies', () => {
    const yaml = `
name: deploy-pipeline
description: A multi-step deploy
params:
  - name: env
    description: Target environment
    required: true
  - name: version
    default: latest
steps:
  - id: build
    prompt: "Build the project for {{param.env}}"
    priority: 10
    timeoutMinutes: 30
  - id: test
    prompt: "Run tests"
    dependsOn: [build]
    retryMax: 2
    retryStrategy: same
  - id: deploy
    prompt: "Deploy version {{param.version}}"
    dependsOn: [build, test]
`;
    const def = parsePipelineDef(yaml);
    expect(def.name).toBe('deploy-pipeline');
    expect(def.description).toBe('A multi-step deploy');
    expect(def.params).toHaveLength(2);
    expect(def.params![0].name).toBe('env');
    expect(def.params![0].required).toBe(true);
    expect(def.params![1].default).toBe('latest');
    expect(def.steps).toHaveLength(3);
    expect(def.steps[0].priority).toBe(10);
    expect(def.steps[0].timeoutMinutes).toBe(30);
    expect(def.steps[1].dependsOn).toEqual(['build']);
    expect(def.steps[1].retryMax).toBe(2);
    expect(def.steps[1].retryStrategy).toBe('same');
    expect(def.steps[2].dependsOn).toEqual(['build', 'test']);
  });

  test('parses minimal valid pipeline', () => {
    const yaml = `
name: minimal
steps:
  - id: only
    prompt: do the thing
`;
    const def = parsePipelineDef(yaml);
    expect(def.name).toBe('minimal');
    expect(def.steps).toHaveLength(1);
    expect(def.description).toBeUndefined();
    expect(def.params).toBeUndefined();
  });

  test('throws on missing name', () => {
    const yaml = `
steps:
  - id: a
    prompt: hello
`;
    expect(() => parsePipelineDef(yaml)).toThrow('non-empty "name"');
  });

  test('throws on empty steps array', () => {
    const yaml = `
name: empty
steps: []
`;
    expect(() => parsePipelineDef(yaml)).toThrow('non-empty "steps"');
  });

  test('throws on missing steps', () => {
    const yaml = `name: no-steps`;
    expect(() => parsePipelineDef(yaml)).toThrow('non-empty "steps"');
  });

  test('throws on step missing id', () => {
    const yaml = `
name: bad
steps:
  - prompt: hello
`;
    expect(() => parsePipelineDef(yaml)).toThrow('non-empty "id"');
  });

  test('throws on step missing prompt', () => {
    const yaml = `
name: bad
steps:
  - id: a
`;
    expect(() => parsePipelineDef(yaml)).toThrow('non-empty "prompt"');
  });

  test('throws on duplicate step IDs', () => {
    const yaml = `
name: dupes
steps:
  - id: a
    prompt: first
  - id: a
    prompt: second
`;
    expect(() => parsePipelineDef(yaml)).toThrow('duplicate step id: "a"');
  });

  test('throws on invalid dependsOn reference', () => {
    const yaml = `
name: bad-ref
steps:
  - id: a
    prompt: hello
    dependsOn: [nonexistent]
`;
    expect(() => parsePipelineDef(yaml)).toThrow('depends on unknown step "nonexistent"');
  });

  test('throws on simple cycle A→B→A', () => {
    const yaml = `
name: cycle
steps:
  - id: a
    prompt: step a
    dependsOn: [b]
  - id: b
    prompt: step b
    dependsOn: [a]
`;
    expect(() => parsePipelineDef(yaml)).toThrow('dependency cycle');
  });

  test('throws on transitive cycle A→B→C→A', () => {
    const yaml = `
name: cycle3
steps:
  - id: a
    prompt: step a
    dependsOn: [c]
  - id: b
    prompt: step b
    dependsOn: [a]
  - id: c
    prompt: step c
    dependsOn: [b]
`;
    expect(() => parsePipelineDef(yaml)).toThrow('dependency cycle');
  });

  test('throws on invalid retryStrategy', () => {
    const yaml = `
name: bad-retry
steps:
  - id: a
    prompt: hello
    retryStrategy: explode
`;
    expect(() => parsePipelineDef(yaml)).toThrow('retryStrategy must be one of');
  });

  test('preserves all optional step fields', () => {
    const yaml = `
name: full
steps:
  - id: a
    prompt: do it
    priority: 5
    timeoutMinutes: 60
    retryMax: 3
    retryStrategy: escalate
`;
    const def = parsePipelineDef(yaml);
    const step = def.steps[0];
    expect(step.priority).toBe(5);
    expect(step.timeoutMinutes).toBe(60);
    expect(step.retryMax).toBe(3);
    expect(step.retryStrategy).toBe('escalate');
  });
});

describe('parseTemplateDef', () => {
  test('parses a valid template with all fields', () => {
    const yaml = `
name: code-review
description: Review a PR
params:
  - name: prUrl
    required: true
  - name: focus
    default: correctness
prompt: "Review {{param.prUrl}} focusing on {{param.focus}}"
priority: 5
timeoutMinutes: 15
retryMax: 1
retryStrategy: augmented
`;
    const def = parseTemplateDef(yaml);
    expect(def.name).toBe('code-review');
    expect(def.description).toBe('Review a PR');
    expect(def.params).toHaveLength(2);
    expect(def.prompt).toContain('{{param.prUrl}}');
    expect(def.priority).toBe(5);
    expect(def.timeoutMinutes).toBe(15);
    expect(def.retryMax).toBe(1);
    expect(def.retryStrategy).toBe('augmented');
  });

  test('parses minimal template', () => {
    const yaml = `
name: simple
prompt: just do it
`;
    const def = parseTemplateDef(yaml);
    expect(def.name).toBe('simple');
    expect(def.prompt).toBe('just do it');
    expect(def.description).toBeUndefined();
    expect(def.params).toBeUndefined();
    expect(def.priority).toBeUndefined();
  });

  test('throws on missing name', () => {
    const yaml = `prompt: hello`;
    expect(() => parseTemplateDef(yaml)).toThrow('non-empty "name"');
  });

  test('throws on missing prompt', () => {
    const yaml = `name: bad`;
    expect(() => parseTemplateDef(yaml)).toThrow('non-empty "prompt"');
  });

  test('throws on invalid retryStrategy', () => {
    const yaml = `
name: bad
prompt: hello
retryStrategy: yolo
`;
    expect(() => parseTemplateDef(yaml)).toThrow('retryStrategy must be one of');
  });
});
