import { describe, it, expect } from 'vitest';
import { parseAgentJson } from './agent';

describe('parseAgentJson', () => {
  it('parses bare JSON', () => {
    expect(
      parseAgentJson(
        '{"extractedFields":{"nights":5},"response":"Great!","options":[],"handoff":false}'
      )
    ).toEqual({
      extractedFields: { nights: 5 },
      response: 'Great!',
      options: [],
      handoff: false,
    });
  });

  it('strips markdown fences the model was told not to emit', () => {
    const fenced = '```json\n{"response":"Hi there"}\n```';
    expect(parseAgentJson(fenced)).toEqual({ response: 'Hi there' });
  });

  it('recovers the JSON object from surrounding prose', () => {
    const messy =
      'Sure! Here is my reply:\n{"response":"Namaste!"}\nHope that helps.';
    expect(parseAgentJson(messy)).toEqual({ response: 'Namaste!' });
  });

  it('degrades to treating the whole text as the reply — never a crash', () => {
    expect(parseAgentJson('Just plain text, no JSON at all')).toEqual({
      response: 'Just plain text, no JSON at all',
    });
  });
});
