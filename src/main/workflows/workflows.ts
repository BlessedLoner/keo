import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Task } from '../../shared/domain';
import type { CapabilityDeps } from '../capabilities/builtins';
import { CapabilityError, defineCapability, type AnyCapability } from '../capabilities/types';

/** Keys that only make sense for the run they came from (windows, elements, screen positions). */
const VOLATILE = new Set(['target', 'hwnd', 'pid', 'snapshotId', 'elementId', 'x', 'y', 'inputHash', 'expectedHash', 'sourceMessageId', 'sessionId']);

export const WorkflowStep = z.object({
  capability: z.string().min(3).max(80),
  title: z.string().min(1).max(200),
  input: z.record(z.string(), z.unknown()),
  dependsOn: z.array(z.number().int().min(1)).max(10).default([]),
});
export const Workflow = z.object({
  id: z.string().regex(/^wf_[a-z0-9]{6,20}$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).default(''),
  steps: z.array(WorkflowStep).min(1).max(20),
  createdAt: z.string(),
  /** Came from an import: shown as such, never trusted more than a fresh plan. */
  imported: z.boolean().default(false),
});
export type WorkflowT = z.infer<typeof Workflow>;

function stripVolatile(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripVolatile);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !VOLATILE.has(k)).map(([k, x]) => [k, stripVolatile(x)]));
  return v;
}

/**
 * Saved procedures from completed plans. A workflow stores what was done and
 * with which inputs — never window handles, element ids, screen coordinates or
 * secrets — and replaying it means re-planning against the current screen,
 * with every step validated and approved again.
 */
export class WorkflowStore {
  constructor(private readonly file: string) {}

  list(): WorkflowT[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown[];
      return raw.map((x) => Workflow.safeParse(x)).filter((r) => r.success).map((r) => r.data);
    } catch {
      return [];
    }
  }

  private save(all: WorkflowT[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(all.slice(0, 50), null, 1));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  fromTask(task: Task, name: string): WorkflowT {
    if (task.state !== 'completed') throw new CapabilityError('not_completed', 'Only a completed task can be saved as a workflow.', { dispatched: 'no' });
    const index = new Map(task.steps.map((s, k) => [s.id, k + 1]));
    const wf: WorkflowT = Workflow.parse({
      id: `wf_${Math.random().toString(36).slice(2, 12)}`,
      name,
      description: task.title.slice(0, 300),
      steps: task.steps.map((s) => ({ capability: s.capabilityId, title: s.title, input: stripVolatile(s.input) as Record<string, unknown>, dependsOn: s.dependsOn.map((id) => index.get(id)!).filter(Boolean) })),
      createdAt: new Date().toISOString(),
    });
    this.save([wf, ...this.list().filter((w) => w.name.toLowerCase() !== name.toLowerCase())]);
    return wf;
  }

  add(wf: WorkflowT): void {
    this.save([wf, ...this.list().filter((w) => w.id !== wf.id)]);
  }

  delete(id: string): boolean {
    const all = this.list();
    const next = all.filter((w) => w.id !== id);
    this.save(next);
    return next.length !== all.length;
  }
}

export function workflowCapabilities(d: CapabilityDeps & { workflows: WorkflowStore }): AnyCapability[] {
  const list = defineCapability({
    id: 'workflows.list',
    version: '1.0.0',
    title: 'List saved workflows',
    description: 'List the workflows the user saved from earlier tasks (name, description, steps).',
    input: z.object({}).strict(),
    output: z.object({ workflows: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), steps: z.number(), imported: z.boolean() })) }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 5000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Read-only.',
    autonomy: () => ({ tier: 'routine' }),
    preview: () => ({ summary: 'List saved workflows', target: null, consequences: [], dataExport: null }),
    auditView: () => ({}),
    async execute() {
      return { workflows: d.workflows.list().map((w) => ({ id: w.id, name: w.name, description: w.description, steps: w.steps.length, imported: w.imported })) };
    },
  });

  const get = defineCapability({
    id: 'workflows.get',
    version: '1.0.0',
    title: 'Get a saved workflow',
    description:
      'Get the steps of a saved workflow to run it again. The steps are a template: windows and elements are NOT included, so first look at the current screen (desktop__list_windows / inspect), then propose the whole run with task__propose_plan, adapting inputs the user changed. Never assume the old screen still looks the same.',
    input: z.object({ id: z.string().regex(/^wf_[a-z0-9]{6,20}$/) }).strict(),
    output: z.object({ name: z.string(), steps: z.array(WorkflowStep), note: z.string() }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 5000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Read-only.',
    autonomy: () => ({ tier: 'routine' }),
    preview: () => ({ summary: 'Read a saved workflow', target: null, consequences: [], dataExport: null }),
    auditView: (i) => ({ id: i.id }),
    async execute(i) {
      const w = d.workflows.list().find((x) => x.id === i.id);
      if (!w) throw new CapabilityError('not_found', 'No saved workflow with that id.', { dispatched: 'no' });
      return { name: w.name, steps: w.steps, note: `${w.imported ? 'Imported workflow: check every step with the user. ' : ''}Resolve current windows/elements, then propose with task__propose_plan; each step is approved again.` };
    },
  });
  return [list, get];
}
