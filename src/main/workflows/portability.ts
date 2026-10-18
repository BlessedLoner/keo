import { z } from 'zod';
import type { Services } from '../services';
import { KeoError } from '../util/errors';
import { Workflow, WorkflowStep } from './workflows';

const Bundle = z.object({
  format: z.literal('keo-export'),
  version: z.literal(1),
  projects: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        description: z.string().max(2000).default(''),
        status: z.enum(['active', 'paused', 'done', 'archived']).default('active'),
        items: z.array(z.object({ type: z.enum(['objective', 'decision', 'blocker', 'question', 'progress']), content: z.string().trim().min(1).max(2000), status: z.string().optional() })).max(500).default([]),
      }),
    )
    .max(200)
    .default([]),
  workflows: z.array(z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(300).default(''), steps: z.array(WorkflowStep).min(1).max(20) })).max(50).default([]),
});

/**
 * Imports a Keo export: projects (with their items, as written by the user)
 * and workflows. Everything is validated first; imported workflows are marked
 * as imported (Keo re-plans and asks for approval as for any task), and
 * workflow steps must name capabilities this Keo actually has.
 */
export function importBundle(s: Services, json: string): { projects: number; workflows: number; skipped: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new KeoError('invalid_input', 'That file is not a Keo export.');
  }
  const b = Bundle.safeParse(raw);
  if (!b.success) throw new KeoError('invalid_input', 'That file is not a valid Keo export.');
  let projects = 0;
  let workflows = 0;
  let skipped = 0;
  for (const p of b.data.projects) {
    const name = s.projects.findByName(p.name) ? `${p.name} (imported)` : p.name;
    const created = s.projects.create(name, p.description);
    if (p.status !== 'active') s.projects.update(created.id, { status: p.status });
    for (const it of p.items) s.projects.addItem({ projectId: created.id, type: it.type, content: it.content, status: 'open', provenance: 'user_authored' });
    projects++;
  }
  const known = new Set(s.registry.list().map((c) => c.id));
  for (const w of b.data.workflows) {
    if (!w.steps.every((st) => known.has(st.capability))) {
      skipped++;
      continue;
    }
    s.workflows.add(Workflow.parse({ id: `wf_${Math.random().toString(36).slice(2, 12)}`, name: w.name, description: w.description, steps: w.steps, createdAt: new Date().toISOString(), imported: true }));
    workflows++;
  }
  s.audit.record({ kind: 'data.import', decision: 'imported', detail: { projects, workflows, skipped } });
  return { projects, workflows, skipped };
}
