import type { Message, Task } from '../../shared/domain';
import type { Settings } from '../../shared/settings';
import type { ConversationRepo } from '../repos/conversations';
import type { MemoryRepo } from '../repos/memory';
import type { ProjectRepo } from '../repos/projects';
import type { NeutralMessage } from '../providers/types';

export interface BuiltContext {
  messages: NeutralMessage[];
  memoryIds: string[];
  stats: { historyMessages: number; droppedMessages: number; chars: number };
}

const OUTCOME_LABEL: Record<string, string> = {
  executed: 'succeeded',
  failed: 'failed',
  rejected: 'rejected by Keo validation',
  awaiting_authorization: 'awaiting user approval',
  denied: 'denied by the user',
  uncertain: 'outcome uncertain',
  proposed: 'proposed (not executed)',
};

function renderAssistant(m: Message): string {
  let text = m.content.trim();
  const tools = m.meta.tools ?? [];
  if (tools.length) {
    const lines = tools.map((t) => `- ${t.capabilityId}: ${t.summary} → ${OUTCOME_LABEL[t.outcome] ?? t.outcome}`);
    text += `${text ? '\n\n' : ''}[Actions in this reply]\n${lines.join('\n')}`;
  }
  if (m.status === 'interrupted') text += '\n[This reply was interrupted before completion.]';
  if (m.status === 'cancelled') text += '\n[The user stopped this reply.]';
  return text;
}

/**
 * Builds a bounded model context: recent history within a character budget,
 * the top-K relevant confirmed memories, the linked project's state and any
 * unresolved tasks. The full database is never sent.
 */
export class ContextBuilder {
  constructor(
    private readonly conversations: ConversationRepo,
    private readonly memory: MemoryRepo,
    private readonly projects: ProjectRepo,
  ) {}

  build(opts: { conversationId: string; settings: Settings; unresolvedTasks: Task[]; now?: Date }): BuiltContext {
    const { settings } = opts;
    const conv = this.conversations.require(opts.conversationId);
    const recent = this.conversations
      .recentMessages(opts.conversationId, settings.agent.contextMessageLimit)
      .filter((m) => !(m.role === 'assistant' && m.status === 'error' && !m.content) && m.status !== 'streaming');

    // Walk backwards within the character budget; the latest user message is always kept.
    const budget = settings.agent.contextCharBudget;
    let used = 0;
    const kept: Message[] = [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i] as Message;
      const text = m.role === 'assistant' ? renderAssistant(m) : m.content;
      const isLatest = kept.length === 0;
      if (!isLatest && used + text.length > budget) break;
      used += Math.min(text.length, budget);
      kept.unshift(m);
    }
    const dropped = recent.length - kept.length;

    const latestUser = [...kept].reverse().find((m) => m.role === 'user');
    const query = latestUser?.content ?? '';
    const memories = this.memory.search(query, { limit: settings.agent.memoryTopK, projectId: conv.projectId });

    // Convert to alternating neutral messages.
    const out: NeutralMessage[] = [];
    const push = (role: 'user' | 'assistant', text: string) => {
      if (!text.trim()) return;
      const last = out[out.length - 1];
      if (last && last.role === role) {
        last.content.push({ type: 'text', text });
      } else {
        out.push({ role, content: [{ type: 'text', text }] });
      }
    };
    for (const m of kept) {
      if (m.role === 'user') push('user', m.content);
      else if (m.role === 'assistant') push('assistant', renderAssistant(m));
      else push('user', `[Keo application note — not typed by the user]\n${m.content}`);
    }
    while (out.length && out[0]?.role !== 'user') out.shift();

    // Per-turn Keo context, prepended to the final user message.
    const ctx: string[] = [];
    const now = opts.now ?? new Date();
    ctx.push(`Current local time: ${now.toString()}`);
    if (memories.length) {
      ctx.push(
        'Relevant user-confirmed memories (most relevant first):\n' +
          memories
            .map((r) => {
              const m = r.item;
              const when = (m.confirmedAt ?? m.createdAt).slice(0, 10);
              const how = m.provenance === 'user_authored' ? 'written by the user' : m.provenance === 'user_stated' ? 'stated by the user in chat' : 'confirmed by the user';
              const conflict = m.conflictsWith.length ? ' [CONFLICTS with another confirmed memory on the same subject]' : '';
              return `- (${m.kind}${m.subject ? `, ${m.subject}` : ''}; ${how} ${when}) ${m.content}${conflict}`;
            })
            .join('\n'),
      );
    } else {
      ctx.push('Relevant user-confirmed memories: none found for this message.');
    }
    if (conv.projectId) {
      const p = this.projects.get(conv.projectId);
      if (p) {
        const items = this.projects.items(p.id).filter((i) => i.status === 'open' || i.status === 'proposed').slice(0, 25);
        ctx.push(
          `This conversation belongs to project "${p.name}" (id ${p.id}, status ${p.status}).${p.description ? ` Description: ${p.description}` : ''}` +
            (items.length
              ? `\nOpen items:\n${items.map((i) => `- ${i.type}${i.status === 'proposed' ? ' (PROPOSED, not yet confirmed)' : ''}: ${i.content}`).join('\n')}`
              : '\nNo open items.'),
        );
      }
    }
    if (opts.unresolvedTasks.length) {
      ctx.push(
        'Unresolved tasks from this conversation:\n' +
          opts.unresolvedTasks
            .slice(0, 10)
            .map((t) => `- "${t.title}" is ${t.state.replace(/_/g, ' ')}`)
            .join('\n'),
      );
    }
    const block = `<keo_context>\n${ctx.join('\n\n')}\n</keo_context>`;
    const last = out[out.length - 1];
    if (last && last.role === 'user') last.content.unshift({ type: 'text', text: block });
    else out.push({ role: 'user', content: [{ type: 'text', text: block }] });

    return {
      messages: out,
      memoryIds: memories.map((m) => m.item.id),
      stats: { historyMessages: kept.length, droppedMessages: dropped, chars: used },
    };
  }
}
