import { describe, test, expect } from 'bun:test';
import {
  substituteParams,
  substituteStepResults,
  hasUnresolvedStepRefs,
} from '../../../src/pipelines/substitution.js';

describe('substituteParams', () => {
  test('replaces all occurrences of a param', () => {
    const text = '{{param.env}} is the target {{param.env}}';
    expect(substituteParams(text, { env: 'production' })).toBe(
      'production is the target production',
    );
  });

  test('leaves unknown params as-is', () => {
    const text = 'deploy to {{param.env}} version {{param.version}}';
    expect(substituteParams(text, { env: 'staging' })).toBe(
      'deploy to staging version {{param.version}}',
    );
  });

  test('handles multiple different params in same text', () => {
    const text = '{{param.a}} and {{param.b}} and {{param.c}}';
    expect(substituteParams(text, { a: '1', b: '2', c: '3' })).toBe('1 and 2 and 3');
  });

  test('returns text unchanged when no placeholders', () => {
    expect(substituteParams('no placeholders here', { x: 'y' })).toBe('no placeholders here');
  });

  test('handles empty string', () => {
    expect(substituteParams('', { x: 'y' })).toBe('');
  });

  test('handles empty params map', () => {
    const text = '{{param.x}}';
    expect(substituteParams(text, {})).toBe('{{param.x}}');
  });
});

describe('substituteStepResults', () => {
  test('replaces known step results', () => {
    const text = 'Result of build: {{steps.build.result}}';
    expect(substituteStepResults(text, { build: 'SUCCESS' })).toBe('Result of build: SUCCESS');
  });

  test('leaves unknown step results as-is', () => {
    const text = '{{steps.build.result}} and {{steps.deploy.result}}';
    expect(substituteStepResults(text, { build: 'ok' })).toBe(
      'ok and {{steps.deploy.result}}',
    );
  });

  test('replaces multiple different step results', () => {
    const text = '{{steps.a.result}} + {{steps.b.result}}';
    expect(substituteStepResults(text, { a: 'X', b: 'Y' })).toBe('X + Y');
  });

  test('returns text unchanged when no placeholders', () => {
    expect(substituteStepResults('plain text', { a: 'x' })).toBe('plain text');
  });

  test('handles empty string', () => {
    expect(substituteStepResults('', { a: 'x' })).toBe('');
  });
});

describe('hasUnresolvedStepRefs', () => {
  test('returns true when step refs remain', () => {
    expect(hasUnresolvedStepRefs('see {{steps.build.result}}')).toBe(true);
  });

  test('returns false when no step refs', () => {
    expect(hasUnresolvedStepRefs('all resolved')).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(hasUnresolvedStepRefs('')).toBe(false);
  });

  test('returns false for param refs (not step refs)', () => {
    expect(hasUnresolvedStepRefs('{{param.env}}')).toBe(false);
  });

  test('returns true with multiple unresolved refs', () => {
    expect(hasUnresolvedStepRefs('{{steps.a.result}} {{steps.b.result}}')).toBe(true);
  });

  test('handles nested-looking braces gracefully', () => {
    // This is not a valid ref pattern, should return false
    expect(hasUnresolvedStepRefs('{{{steps.a.result}}}')).toBe(true);
  });
});
