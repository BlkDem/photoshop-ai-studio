import * as z from 'zod/v4';

/**
 * Canonical, transport-agnostic error taxonomy.
 *
 * Every failure that crosses a process boundary (MCP tool result, UXP bridge
 * result, orchestrator run record) is normalised into this shape so the AI
 * layer can reason about `recoverable` and decide whether to repair the plan.
 */
export const ERROR_CODES = [
  // --- connectivity / environment -----------------------------------------
  'NOT_CONNECTED',
  'PLUGIN_BUSY',
  'TIMEOUT',
  'MODAL_STATE',
  // --- documents -----------------------------------------------------------
  'NO_DOCUMENT_OPEN',
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_NOT_SAVED',
  // --- layers --------------------------------------------------------------
  'LAYER_NOT_FOUND',
  'LAYER_NOT_MOVABLE',
  'LAYER_LOCKED',
  'LAYER_IS_GROUP',
  'GROUP_NOT_FOUND',
  // --- text ----------------------------------------------------------------
  'NOT_A_TEXT_LAYER',
  'FONT_NOT_AVAILABLE',
  'INVALID_COLOR',
  // --- files ---------------------------------------------------------------
  'PATH_NOT_ALLOWED',
  /**
   * The plugin sandbox has not been granted access to the workspace folder.
   * Distinct from `PATH_NOT_ALLOWED` on purpose: nothing is wrong with the path,
   * and the fix is a button in the panel rather than a change to the plan.
   */
  'WORKSPACE_NOT_GRANTED',
  'FILE_NOT_FOUND',
  'FILE_EXISTS',
  'EXPORT_FAILED',
  'UNSUPPORTED_FORMAT',
  // --- requests ------------------------------------------------------------
  'INVALID_PARAMS',
  'UNKNOWN_TOOL',
  'UNSUPPORTED_OPERATION',
  'PLAN_INVALID',
  'STEP_FAILED',
  // --- orchestration -------------------------------------------------------
  'CANCELLED',
  'VERIFICATION_FAILED',
  'MODEL_UNAVAILABLE',
  'MODEL_ERROR',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const StudioErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  /**
   * `true`  -> the AI layer may re-plan / retry (transient or fixable state).
   * `false` -> retrying the same intent will not help; surface it to the user.
   */
  recoverable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
  /** Raw Photoshop action result code (`_obj: "error"` -> `result: -25922`). */
  photoshopCode: z.number().int().optional(),
});

export type StudioError = z.infer<typeof StudioErrorSchema>;

/** Uniform structured result envelope shared by MCP tools and the UXP bridge. */
export function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

export function fail(
  code: ErrorCode,
  message: string,
  extra: { recoverable?: boolean; details?: Record<string, unknown>; photoshopCode?: number } = {},
): { success: false; error: StudioError } {
  return {
    success: false,
    error: {
      code,
      message,
      recoverable: extra.recoverable ?? defaultRecoverable(code),
      ...(extra.details ? { details: extra.details } : {}),
      ...(extra.photoshopCode !== undefined ? { photoshopCode: extra.photoshopCode } : {}),
    },
  };
}

export type Result<T> = { success: true; data: T } | { success: false; error: StudioError };

export function isOk<T>(r: Result<T>): r is { success: true; data: T } {
  return r.success;
}

/**
 * Default recoverability per code. Used when a call site does not override it.
 * Anything caused by mutable document state is recoverable (the AI can adapt);
 * anything caused by a permanently unavailable capability is not.
 */
export function defaultRecoverable(code: ErrorCode): boolean {
  switch (code) {
    case 'NOT_CONNECTED':
    case 'PLUGIN_BUSY':
    case 'TIMEOUT':
    case 'MODAL_STATE':
    case 'NO_DOCUMENT_OPEN':
    case 'DOCUMENT_NOT_FOUND':
    case 'DOCUMENT_NOT_SAVED':
    case 'LAYER_NOT_FOUND':
    case 'GROUP_NOT_FOUND':
    case 'NOT_A_TEXT_LAYER':
    case 'FONT_NOT_AVAILABLE':
    case 'INVALID_COLOR':
    case 'FILE_EXISTS':
    // Fixable by the user, without changing the plan: grant the folder.
    case 'WORKSPACE_NOT_GRANTED':
    case 'EXPORT_FAILED':
    case 'STEP_FAILED':
    case 'VERIFICATION_FAILED':
    case 'MODEL_UNAVAILABLE':
    case 'CANCELLED':
      return true;
    case 'PATH_NOT_ALLOWED':
    case 'LAYER_LOCKED':
    case 'LAYER_NOT_MOVABLE':
    case 'UNSUPPORTED_FORMAT':
    case 'UNKNOWN_TOOL':
    case 'UNSUPPORTED_OPERATION':
    case 'MODEL_ERROR':
    case 'INTERNAL':
    case 'INVALID_PARAMS':
    case 'LAYER_IS_GROUP':
    case 'FILE_NOT_FOUND':
    case 'PLAN_INVALID':
      return false;
    default:
      return false;
  }
}

/** Error carrier used across Node services. Carries a `StudioError` payload. */
export class StudioException extends Error {
  readonly code: ErrorCode;
  readonly recoverable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly photoshopCode: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    extra: { recoverable?: boolean; details?: Record<string, unknown>; photoshopCode?: number; cause?: unknown } = {},
  ) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined);
    this.name = 'StudioException';
    this.code = code;
    this.recoverable = extra.recoverable ?? defaultRecoverable(code);
    this.details = extra.details;
    this.photoshopCode = extra.photoshopCode;
  }

  toStudioError(): StudioError {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      ...(this.details ? { details: this.details } : {}),
      ...(this.photoshopCode !== undefined ? { photoshopCode: this.photoshopCode } : {}),
    };
  }

  toResult<T>(): Result<T> {
    return { success: false, error: this.toStudioError() };
  }
}

/** Narrow an unknown thrown value into a `StudioError`. */
export function toStudioError(err: unknown): StudioError {
  if (err instanceof StudioException) return err.toStudioError();
  if (err instanceof Error) {
    return { code: 'INTERNAL', message: err.message, recoverable: false };
  }
  if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
    const maybe = err as { code?: unknown; message?: unknown; recoverable?: unknown };
    const code = typeof maybe.code === 'string' && (ERROR_CODES as readonly string[]).includes(maybe.code)
      ? (maybe.code as ErrorCode)
      : 'INTERNAL';
    return {
      code,
      message: typeof maybe.message === 'string' ? maybe.message : String(err),
      recoverable: typeof maybe.recoverable === 'boolean' ? maybe.recoverable : defaultRecoverable(code),
    };
  }
  return { code: 'INTERNAL', message: String(err), recoverable: false };
}

/** Human-readable one-liner used by the AI and the Studio UI. */
export function describeError(error: StudioError): string {
  return `${error.code}: ${error.message}${error.recoverable ? ' (recoverable)' : ''}`;
}
