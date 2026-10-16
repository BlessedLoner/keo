import { afterEach, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('memory provenance and lifecycle', () => {
  it('keeps model inferences as proposals until the user confirms', () => {
    h = makeHarness();
    const m = h.services.memory;
    expect(() => m.create({ kind: 'fact', content: 'User lives in Oslo', status: 'confirmed', provenance: 'model_inferred' })).toThrow(/confirmed by the user/);
    const p = m.create({ kind: 'fact', content: 'User lives in Oslo', status: 'proposed', provenance: 'model_inferred', sourceExcerpt: 'I moved to Oslo' });
    expect(m.search('Oslo', { limit: 5 })).toHaveLength(0); // proposals are never retrieved as facts
    const c = m.confirm(p.id);
    expect(c.status).toBe('confirmed');
    expect(c.provenance).toBe('user_confirmed');
    expect(c.confirmedAt).not.toBeNull();
    expect(m.search('where does the user live oslo', { limit: 5 })[0]?.item.id).toBe(p.id);
  });

  it('records the source message and survives deletion of the source conversation', () => {
    h = makeHarness();
    const s = h.services;
    const conv = s.conversations.create();
    const msg = s.conversations.addMessage({ conversationId: conv.id, role: 'user', content: 'My dog is called Rex', status: 'complete' });
    const mem = s.memory.create({ kind: 'fact', content: 'Dog is called Rex', status: 'confirmed', provenance: 'user_authored', sourceConversationId: conv.id, sourceMessageId: msg.id, sourceExcerpt: msg.content });
    expect(mem.sourceMessageId).toBe(msg.id);
    s.conversations.delete(conv.id);
    const after = s.memory.get(mem.id)!;
    expect(after.sourceConversationId).toBeNull();
    expect(after.sourceMessageId).toBeNull();
    expect(after.sourceExcerpt).toBe('My dog is called Rex');
  });

  it('detects conflicts by subject and resolves them only on user request', () => {
    h = makeHarness();
    const m = h.services.memory;
    const a = m.create({ kind: 'fact', subject: 'User.Timezone', content: 'UTC+1', status: 'confirmed', provenance: 'user_authored' });
    const b = m.create({ kind: 'fact', subject: 'user.timezone', content: 'UTC-5', status: 'confirmed', provenance: 'user_authored' });
    expect(m.get(a.id)!.conflictsWith).toEqual([b.id]);
    expect(m.get(b.id)!.status).toBe('confirmed'); // nothing replaced automatically
    m.supersede(b.id, a.id);
    expect(m.get(a.id)!.status).toBe('superseded');
    expect(m.get(a.id)!.supersededBy).toBe(b.id);
    expect(m.get(b.id)!.conflictsWith).toEqual([]);
  });

  it('versions corrections and supports deletion', () => {
    h = makeHarness();
    const m = h.services.memory;
    const x = m.create({ kind: 'preference', content: 'Likes tea', status: 'confirmed', provenance: 'user_authored' });
    const y = m.update(x.id, 'Likes green tea', undefined);
    expect(y.version).toBe(2);
    expect(m.revisions(x.id)[0]?.content).toBe('Likes tea');
    expect(m.delete(x.id)).toBe(true);
    expect(m.get(x.id)).toBeNull();
    expect(m.revisions(x.id)).toEqual([]);
  });

  it('refuses to store credentials', () => {
    h = makeHarness();
    expect(() => h.services.memory.create({ kind: 'fact', content: 'my key is sk-ant-api03-abcdefghijklmnop', status: 'confirmed', provenance: 'user_authored' })).toThrow(/secret/);
    expect(() => h.services.memory.create({ kind: 'fact', content: 'password: hunter2', status: 'confirmed', provenance: 'user_authored' })).toThrow(/secret/);
  });

  it('bounds retrieval and ranks relevant items first', () => {
    h = makeHarness();
    const m = h.services.memory;
    for (let i = 0; i < 40; i++) m.create({ kind: 'fact', content: `Unrelated fact number ${i} about gardening`, status: 'confirmed', provenance: 'user_authored' });
    const target = m.create({ kind: 'fact', content: 'The quarterly report is due on Friday', status: 'confirmed', provenance: 'user_authored' });
    const r = m.search('when is the quarterly report due?', { limit: 5 });
    expect(r.length).toBeLessThanOrEqual(5);
    expect(r[0]?.item.id).toBe(target.id);
  });
});

describe('projects', () => {
  it('keeps model-proposed items as proposals and records acceptance', () => {
    h = makeHarness();
    const p = h.services.projects.create('Website');
    expect(() => h.services.projects.addItem({ projectId: p.id, type: 'decision', content: 'Use React', status: 'open', provenance: 'model_inferred' })).toThrow();
    const it1 = h.services.projects.addItem({ projectId: p.id, type: 'decision', content: 'Use React', status: 'proposed', provenance: 'model_inferred' });
    const acc = h.services.projects.setItemStatus(it1.id, 'open');
    expect(acc.provenance).toBe('user_confirmed');
    expect(h.services.projects.get(p.id)?.openItemCount).toBe(1);
    expect(() => h.services.projects.create('website')).toThrow(/already exists/);
  });
});
