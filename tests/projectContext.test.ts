import { describe, expect, it } from 'vitest';
import { ContextBuilder } from '../src/main/agent/contextBuilder';
import { openDatabase } from '../src/main/db/database';
import { ConversationRepo } from '../src/main/repos/conversations';
import { MemoryRepo } from '../src/main/repos/memory';
import { ProjectRepo } from '../src/main/repos/projects';
import { defaultSettings } from '../src/shared/settings';

/** A chat in a project knows what was said and wanted in the project's other chats. */
describe('project context', () => {
  const setup = () => {
    const db = openDatabase(':memory:');
    const conversations = new ConversationRepo(db);
    const projects = new ProjectRepo(db);
    const ctx = new ContextBuilder(conversations, new MemoryRepo(db), projects);
    return { conversations, projects, ctx };
  };
  const text = (built: ReturnType<ContextBuilder['build']>) => JSON.stringify(built.messages);

  it('includes the other chats of the project (titles and what the user asked), not chats outside it', () => {
    const t = setup();
    const p = t.projects.create('JL brand website');
    const earlier = t.conversations.create('Homepage hero', p.id);
    t.conversations.addMessage({ conversationId: earlier.id, role: 'user', content: 'Make the hero black with one gold accent', status: 'complete' });
    const outside = t.conversations.create('Groceries', null);
    t.conversations.addMessage({ conversationId: outside.id, role: 'user', content: 'Buy oat milk', status: 'complete' });
    const now = t.conversations.create('New chat', p.id);
    t.conversations.addMessage({ conversationId: now.id, role: 'user', content: 'Carry on with the site', status: 'complete' });

    const out = text(t.ctx.build({ conversationId: now.id, settings: defaultSettings(), unresolvedTasks: [] }));
    expect(out).toContain('Earlier conversations in this project');
    expect(out).toContain('Homepage hero');
    expect(out).toContain('one gold accent');
    expect(out).not.toContain('oat milk');
  });

  it('adds what was made in the project, and nothing for a chat outside any project', () => {
    const t = setup();
    const p = t.projects.create('Bakery');
    t.ctx.projectWork = (id) => (id === p.id ? 'Made in this project: build "Sunrise Bakery" (website, id bd_abc123).' : null);
    const c = t.conversations.create('Chat', p.id);
    t.conversations.addMessage({ conversationId: c.id, role: 'user', content: 'Add a menu page', status: 'complete' });
    expect(text(t.ctx.build({ conversationId: c.id, settings: defaultSettings(), unresolvedTasks: [] }))).toContain('Sunrise Bakery');

    const loose = t.conversations.create('Loose', null);
    t.conversations.addMessage({ conversationId: loose.id, role: 'user', content: 'Hello', status: 'complete' });
    expect(text(t.ctx.build({ conversationId: loose.id, settings: defaultSettings(), unresolvedTasks: [] }))).not.toContain('Earlier conversations');
  });
});
