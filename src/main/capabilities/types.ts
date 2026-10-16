import type { z } from 'zod';
import type { ApprovalPreview, PermissionKey, RiskLevel } from '../../shared/domain';
import type { Settings } from '../../shared/settings';
import { KeoError } from '../util/errors';

export interface CapabilityContext {
  signal: AbortSignal;
  idempotencyKey: string;
  correlationId: string;
  conversationId: string | null;
  /** The user message that started the current turn, for provenance. */
  sourceMessageId: string | null;
  taskId: string | null;
  settings: Settings;
}

export type Dispatch = 'no' | 'yes' | 'unknown';

/**
 * Error raised by a capability. `dispatched` tells the orchestrator whether the
 * external effect may have happened, which decides between failed (safe) and
 * outcome_uncertain (needs reconciliation).
 */
export class CapabilityError extends KeoError {
  readonly retryable: boolean;
  readonly dispatched: Dispatch;
  constructor(code: string, message: string, opts: { retryable?: boolean; dispatched?: Dispatch } = {}) {
    super(code, message);
    this.retryable = opts.retryable ?? false;
    this.dispatched = opts.dispatched ?? 'no';
  }
}

export interface VerificationResult {
  verified: boolean | null; // null = could not determine
  detail: string;
}

export interface Capability<I = unknown, O = unknown> {
  id: string;
  version: string;
  title: string;
  description: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  risk: RiskLevel;
  /** 'always' = every execution needs explicit user approval. Cannot be overridden by the model. */
  approval: 'never' | 'always';
  permissions: PermissionKey[];
  /** True when execution has effects outside Keo's own database. */
  consequential: boolean;
  /** Safe to re-run with the same input (no duplicate external effects). */
  idempotent: boolean;
  timeoutMs: number;
  maxAttempts: number;
  /** Whether the model may propose this capability as a tool call. */
  modelVisible: boolean;
  /** Verification policy, surfaced in the UI. */
  verificationPolicy: string;
  /** Capability-wide prerequisite (e.g. a missing API key). Unavailable capabilities are hidden from the model. */
  unavailableReason?(settings: Settings): string | null;
  /**
   * Whether this input may run under a user-created navigation grant instead
   * of a per-action approval. Omitted = never. Sensitive actions (send,
   * delete, submit, pay, …) must return false.
   */
  grantable?(input: I): boolean;
  /** Extra admission checks (allow-lists, prerequisites). Return an error message to reject. */
  precheck?(input: I, settings: Settings): string | null;
  /** Human-readable approval preview: target, operation and material consequences. */
  preview(input: I, settings: Settings): ApprovalPreview;
  execute(input: I, ctx: CapabilityContext): Promise<O>;
  verify?(input: I, output: O, ctx: CapabilityContext): Promise<VerificationResult>;
  /** Fields safe to keep in the audit log (no free text, no screen content). */
  auditView(input: I): Record<string, unknown>;
}

export type AnyCapability = Capability<any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function defineCapability<I, O>(c: Capability<I, O>): Capability<I, O> {
  return c;
}
