import { describe, expect, it } from 'vitest';
import { lookupBudget } from '../src/main/agent/agentService';

describe('Web lookups per reply', () => {
  it('a normal question gets a few good sources', () => {
    expect(lookupBudget('Is Wan2.2 free? Show me 1 or 2 videos made with it')).toEqual({ searches: 4, pages: 6 });
    expect(lookupBudget('do you think Keo can have its own video model?')).toEqual({ searches: 4, pages: 6 });
  });
  it('deep research, when the user asks for it, gets a lot more', () => {
    for (const t of ['Do a deep research on open video models', 'I need a thorough comparison of GPU clouds', 'research everything about Wan 2.2', 'give me an in-depth report'])
      expect(lookupBudget(t)).toEqual({ searches: 12, pages: 20 });
  });
});
