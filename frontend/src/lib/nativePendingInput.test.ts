import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  nativeAnswerText,
  nativePendingInput,
  nativeSelectionPayload,
} from './nativePendingInput';

// Same vectors as lambda/shared/test/native-pending-input.test.js: the
// controller rejects a reply whose text differs from its own rendering.
const gate = nativePendingInput({
  schemaVersion: 1,
  kind: 'approval',
  source: 'engine-gate',
  stage: 'requirements-analysis',
  questions: [
    {
      id: 'q1',
      prompt: 'Proceed?',
      header: 'Approval',
      multiSelect: false,
      options: [
        { label: 'Approve', description: null },
        { label: 'Request Changes', description: null },
      ],
    },
  ],
});
const batch = nativePendingInput({
  schemaVersion: 1,
  kind: 'choice',
  source: 'rendered-question',
  stage: null,
  questions: [
    {
      id: 'q1',
      prompt: 'Which platforms?',
      header: 'Platforms',
      multiSelect: true,
      options: [
        { label: 'Web', description: null },
        { label: 'Mobile', description: null },
        { label: 'Desktop', description: null },
      ],
    },
    {
      id: 'q2',
      prompt: 'Difficulty curve?\nPick one.',
      header: null,
      multiSelect: false,
      options: [
        { label: 'Gentle', description: null },
        { label: 'Steep', description: null },
      ],
    },
  ],
});

describe('native answer rendering parity', () => {
  it('matches the controller rendering', () => {
    expect(nativeAnswerText(gate, { answers: [{ selectedOptions: [0] }] })).toBe('Approve');
    expect(
      nativeAnswerText(gate, {
        answers: [{ selectedOptions: [1], freeText: 'Add offline support.' }],
      }),
    ).toBe('Request Changes\n\nAdd offline support.');
    expect(
      nativeAnswerText(batch, {
        answers: [{ selectedOptions: [2, 0] }, { selectedOptions: [1], freeText: 'but forgiving' }],
      }),
    ).toBe('1. Platforms: Web, Desktop\n2. Difficulty curve?: Steep — but forgiving');
  });
  it('omits blank free text from the submitted selection', () => {
    expect(
      nativeSelectionPayload({ answers: [{ selectedOptions: [0], freeText: '   ' }] }),
    ).toEqual({ answers: [{ selectedOptions: [0] }] });
  });
  it('canonicalizes like the server (sorted keys, nulls kept)', () => {
    expect(canonicalJson({ b: null, a: [{ y: 1, x: 'q' }] })).toBe(
      '{"a":[{"x":"q","y":1}],"b":null}',
    );
  });
  it('rejects malformed presented questions', () => {
    expect(() => nativePendingInput({ ...gate, kind: 'vote' })).toThrow();
    expect(() => nativePendingInput({ ...gate, questions: [] })).toThrow();
  });
  it('accepts up to sixteen options, like the server', () => {
    const choice = (count: number) => ({
      ...batch,
      questions: [
        {
          ...batch.questions[1],
          id: 'q1',
          options: Array.from({ length: count }, (_, index) => ({
            label: `plan-${index}`,
            description: null,
          })),
        },
      ],
    });
    expect(nativePendingInput(choice(12)).questions[0].options).toHaveLength(12);
    expect(nativePendingInput(choice(16)).questions[0].options).toHaveLength(16);
    expect(() => nativePendingInput(choice(17))).toThrow();
  });
});
