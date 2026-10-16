import { z } from 'zod';
import type { ApprovalPreview, CapabilityInfo, PermissionKey } from '../../shared/domain';
import type { Settings } from '../../shared/settings';
import type { Logger } from '../logging/logger';
import type { AuditRepo } from '../repos/audit';
import { errorMessage } from '../util/errors';
import { hashInput } from '../util/hash';
import type { ToolSpec } from '../providers/types';
import { CapabilityError, type AnyCapability, type CapabilityContext } from './types';

export type ProposalOrigin = 'model' | 'user' | 'plan';

export interface CapabilityProposal {
  /** Untrusted: may come straight from model output. */
  capabilityId: unknown;
  input: unknown;
  origin: ProposalOrigin;
  correlationId: string;
}

export type Admission =
  | {
      ok: true;
      capability: AnyCapability;
      input: unknown;
      inputHash: string;
      requiresApproval: boolean;
      preview: ApprovalPreview;
    }
  | { ok: false; code: AdmissionRejection; reason: string };

export type AdmissionRejection =
  | 'unknown_capability'
  | 'not_model_visible'
  | 'invalid_input'
  | 'permission_disabled'
  | 'precondition_failed';

const PERMISSION_LABEL: Record<PermissionKey, string> = {
  'desktop.observe': 'Window observation',
  'desktop.control': 'Desktop control',
  'desktop.launch': 'Application launch',
  'vision.export': 'Screen-content export',
};

export function permissionEnabled(p: PermissionKey, s: Settings): boolean {
  switch (p) {
    case 'desktop.observe':
      return s.permissions.observationEnabled;
    case 'desktop.control':
      return s.permissions.desktopControlEnabled;
    case 'desktop.launch':
      return s.permissions.launchEnabled;
    case 'vision.export':
      // Checked per destination provider at execution time.
      return true;
  }
}

/** Model tool names cannot contain dots; map ids <-> names deterministically. */
export const toolNameFor = (id: string): string => id.replace(/\./g, '__');

/**
 * Registry + admission gateway. Implements the pipeline:
 *   proposal (untrusted) -> validate id -> bind to registered capability ->
 *   validate input (strict schema; unknown parameters rejected) ->
 *   permission + precondition checks -> admission record.
 * Admission never executes anything and never grants approval.
 */
export class CapabilityRegistry {
  private readonly caps = new Map<string, AnyCapability>();
  private readonly byToolName = new Map<string, AnyCapability>();

  constructor(
    private readonly getSettings: () => Settings,
    private readonly audit: AuditRepo,
    private readonly log: Logger,
  ) {}

  register(cap: AnyCapability): void {
    if (!/^[a-z]+(\.[a-z_]+)+$/.test(cap.id)) throw new Error(`Invalid capability id ${cap.id}`);
    if (this.caps.has(cap.id)) throw new Error(`Duplicate capability ${cap.id}`);
    if (cap.consequential && cap.approval !== 'always') {
      throw new Error(`Consequential capability ${cap.id} must require approval`);
    }
    this.caps.set(cap.id, cap);
    this.byToolName.set(toolNameFor(cap.id), cap);
  }

  get(id: string): AnyCapability | undefined {
    return this.caps.get(id);
  }

  resolveToolName(name: string): string | null {
    return this.byToolName.get(name)?.id ?? null;
  }

  availability(cap: AnyCapability, s: Settings): { available: boolean; reason: string | null } {
    for (const p of cap.permissions) {
      if (!permissionEnabled(p, s)) return { available: false, reason: `${PERMISSION_LABEL[p]} is turned off in Capabilities.` };
    }
    return { available: true, reason: null };
  }

  list(): CapabilityInfo[] {
    const s = this.getSettings();
    return [...this.caps.values()].map((c) => {
      const a = this.availability(c, s);
      return {
        id: c.id,
        version: c.version,
        title: c.title,
        description: c.description,
        risk: c.risk,
        requiresApproval: c.approval === 'always',
        consequential: c.consequential,
        idempotent: c.idempotent,
        permissions: c.permissions,
        timeoutMs: c.timeoutMs,
        maxAttempts: c.maxAttempts,
        modelVisible: c.modelVisible,
        available: a.available,
        unavailableReason: a.reason,
        inputSchema: jsonSchema(c.input),
        outputSchema: jsonSchema(c.output),
      };
    });
  }

  /** Tool specs for the model: only model-visible capabilities whose permissions are on. */
  toolSpecs(): ToolSpec[] {
    const s = this.getSettings();
    return [...this.caps.values()]
      .filter((c) => c.modelVisible && this.availability(c, s).available)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => ({
        name: toolNameFor(c.id),
        description: `${c.description}${c.approval === 'always' ? ' Requires explicit user approval before it runs; the user may deny it.' : ''}`,
        inputSchema: jsonSchema(c.input) as Record<string, unknown>,
      }));
  }

  admit(p: CapabilityProposal): Admission {
    const result = this.admitInner(p);
    const capId = typeof p.capabilityId === 'string' ? p.capabilityId.slice(0, 80) : null;
    if (result.ok) {
      this.audit.record({
        kind: 'capability.admission',
        decision: 'admitted',
        capabilityId: result.capability.id,
        detail: { origin: p.origin, requiresApproval: result.requiresApproval, input: result.capability.auditView(result.input) },
        correlationId: p.correlationId,
      });
      this.log.info('capability.admitted', { capabilityId: result.capability.id, origin: p.origin }, p.correlationId);
    } else {
      this.audit.record({
        kind: 'capability.admission',
        decision: `rejected:${result.code}`,
        capabilityId: capId,
        detail: { origin: p.origin, reason: result.reason },
        correlationId: p.correlationId,
      });
      this.log.warn('capability.rejected', { capabilityId: capId, origin: p.origin, code: result.code }, p.correlationId);
    }
    return result;
  }

  private admitInner(p: CapabilityProposal): Admission {
    if (typeof p.capabilityId !== 'string') return { ok: false, code: 'unknown_capability', reason: 'Capability id must be a string.' };
    const cap = this.caps.get(p.capabilityId);
    if (!cap) return { ok: false, code: 'unknown_capability', reason: `No registered capability "${p.capabilityId.slice(0, 80)}".` };
    if (p.origin !== 'user' && !cap.modelVisible) {
      return { ok: false, code: 'not_model_visible', reason: `${cap.id} can only be started by the user.` };
    }
    const parsed = cap.input.safeParse(p.input);
    if (!parsed.success) {
      return { ok: false, code: 'invalid_input', reason: formatZodError(parsed.error) };
    }
    const s = this.getSettings();
    const avail = this.availability(cap, s);
    if (!avail.available) return { ok: false, code: 'permission_disabled', reason: avail.reason ?? 'Permission disabled.' };
    const pre = cap.precheck?.(parsed.data, s) ?? null;
    if (pre) return { ok: false, code: 'precondition_failed', reason: pre };
    return {
      ok: true,
      capability: cap,
      input: parsed.data,
      inputHash: hashInput(cap.id, cap.version, parsed.data),
      requiresApproval: cap.approval === 'always',
      preview: cap.preview(parsed.data, s),
    };
  }

  /**
   * Executes an admitted capability with timeout + cancellation, validating
   * the output contract. Used directly only for non-consequential capabilities
   * that need no approval; everything else runs through the task orchestrator.
   */
  async execute(cap: AnyCapability, input: unknown, ctx: CapabilityContext): Promise<unknown> {
    const out = await withTimeout(cap.execute(input, ctx), cap.timeoutMs, ctx.signal);
    const checked = cap.output.safeParse(out);
    if (!checked.success) {
      throw new CapabilityError('invalid_output', `Capability returned output that violates its contract: ${formatZodError(checked.error)}`, {
        dispatched: cap.consequential ? 'yes' : 'no',
      });
    }
    return checked.data;
  }

  async runDirect(admission: Extract<Admission, { ok: true }>, ctx: CapabilityContext): Promise<unknown> {
    if (admission.requiresApproval || admission.capability.consequential) {
      throw new CapabilityError('approval_required', 'This capability must run as an authorized task.');
    }
    try {
      const out = await this.execute(admission.capability, admission.input, ctx);
      this.audit.record({ kind: 'capability.execution', decision: 'succeeded', capabilityId: admission.capability.id, correlationId: ctx.correlationId });
      return out;
    } catch (err) {
      this.audit.record({
        kind: 'capability.execution',
        decision: 'failed',
        capabilityId: admission.capability.id,
        detail: { error: errorMessage(err) },
        correlationId: ctx.correlationId,
      });
      throw err;
    }
  }
}

export function formatZodError(e: z.ZodError): string {
  return e.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join('.') : 'input'}: ${i.message}`)
    .join('; ');
}

export function jsonSchema(schema: z.ZodType): unknown {
  try {
    const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    delete js.$schema;
    return js;
  } catch {
    return { type: 'object' };
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new CapabilityError('cancelled', 'Cancelled before start.', { dispatched: 'no' }));
      return;
    }
    const timer = setTimeout(() => reject(new CapabilityError('timeout', `Timed out after ${ms} ms.`, { dispatched: 'unknown', retryable: true })), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CapabilityError('cancelled', 'Cancelled.', { dispatched: 'unknown' }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
