/**
 * ProblemDetails (RFC 9457) shared error envelope + converters.
 *   - Consumed by IPC, CLI and HTTP API boundaries (same error everywhere).
 *   - Zod errors are materialised into `.errors[]` with `{ path, message, code }`.
 */
import { z } from 'zod';

export const ProblemDetailsSchema = z
  .object({
    type: z
      .string()
      .url()
      .default('about:blank')
      .describe('URI identifying the problem type'),
    title: z.string().min(1).describe('Short, human-readable summary'),
    status: z
      .number()
      .int()
      .min(100)
      .max(599)
      .describe('HTTP-style status code (also used for IPC status)'),
    detail: z.string().default(''),
    instance: z.string().optional(),
    trace_id: z.string().optional().describe('Correlation id (audit)'),
    errors: z
      .array(
        z.object({
          path: z.array(z.union([z.string(), z.number()])),
          message: z.string(),
          code: z.string().optional(),
        }),
      )
      .default([]),
  })
  .strict();
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

/**
 * Convert any thrown value into a ProblemDetails payload.
 * ZodErrors get their `.issues[]` mapped into the errors[] array with
 * paths preserved so renderers / CLI can highlight the offending field.
 */
export function toProblemDetails(
  err: unknown,
  ctx: Partial<Pick<ProblemDetails, 'status' | 'instance' | 'trace_id' | 'type'>> = {},
): ProblemDetails {
  if (err instanceof z.ZodError) {
    return {
      type: ctx.type ?? 'about:blank',
      title: 'Validation Error',
      status: ctx.status ?? 400,
      detail: err.issues.length === 1 ? err.issues[0]!.message : `${err.issues.length} validation error(s)`,
      instance: ctx.instance,
      trace_id: ctx.trace_id,
      errors: err.issues.map((i) => ({
        path: [...i.path],
        message: i.message,
        code: i.code,
      })),
    };
  }
  const status = ctx.status ?? 500;
  const message = err instanceof Error ? err.message : String(err);
  return {
    type: ctx.type ?? 'about:blank',
    title: err instanceof Error && err.name ? err.name : 'Error',
    status,
    detail: message,
    instance: ctx.instance,
    trace_id: ctx.trace_id,
    errors: [],
  };
}

/**
 * Wrap a z.SafeParseError into ProblemDetails (utility for handlers that
 * already called safeParse and want to avoid re-throwing).
 */
export function safeParseErrorToPD<T>(
  r: z.SafeParseError<T>,
  ctx: Partial<Pick<ProblemDetails, 'status' | 'instance' | 'trace_id'>> = {},
): ProblemDetails {
  return toProblemDetails(new z.ZodError(r.error.issues), ctx);
}

/** Standard problem type URIs used by FMB. */
export const ProblemTypes = {
  VALIDATION: 'https://fmb.dev/problems/validation',
  NOT_FOUND: 'https://fmb.dev/problems/not-found',
  CONFLICT: 'https://fmb.dev/problems/conflict',
  PERMISSION: 'https://fmb.dev/problems/permission-denied',
  PLUGIN: 'https://fmb.dev/problems/plugin-error',
  WORKFLOW: 'https://fmb.dev/problems/workflow-error',
  INTERNAL: 'https://fmb.dev/problems/internal',
} as const;
