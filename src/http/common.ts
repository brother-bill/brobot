/**
 * The error bodies every area shares, as Nest writes them today. Nothing
 * here changes them: these describe the wire.
 */
import { doc } from '@singularity/http-contract';
import type { RouteResponse } from '@singularity/http-contract';
import { z } from 'zod';
import { TRANSFER_ERROR_CODES } from '../modules/transfer/transfer-rules';

/**
 * Nest's own exception body. `error` is the status's name, and is absent when
 * the exception was thrown without a message (`new UnauthorizedException()`
 * answers `{ statusCode: 401, message: 'Unauthorized' }`), and on a 429 from
 * the throttler.
 */
export const BrobotError = z
    .strictObject({
        statusCode: z.int().meta({ description: 'The HTTP status', example: 404 }),
        message: z
            .string()
            .meta({ description: 'What went wrong', example: 'No brobot user with that login' }),
        error: z
            .string()
            .optional()
            .meta({ description: "The status's name", example: 'Not Found' }),
    })
    .meta({ id: 'BrobotError', description: "Nest's exception body." });

/**
 * A request `ZodValidationPipe` refused (`src/common/zod-validation.pipe.ts`).
 * The pipe hands Nest the body itself, so it carries no `statusCode` or
 * `error`: `{ message: 'Validation failed', issues: [...] }`.
 */
export const BrobotValidationError = z
    .strictObject({
        statusCode: z
            .int()
            .optional()
            .meta({ description: 'Absent today: the pipe sends `message` and `issues` only' }),
        message: z
            .string()
            .meta({ description: 'Always `Validation failed`', example: 'Validation failed' }),
        error: z.string().optional().meta({ description: 'Absent today, as `statusCode`' }),
        issues: z
            .array(
                z.strictObject({
                    path: z.string().meta({
                        description:
                            "The issue's path, dot-joined; empty for a path parameter (validated on its own)",
                        example: 'pmdLevel',
                    }),
                    message: z.string().meta({ example: 'pmdLevel (or level) is required' }),
                }),
            )
            .meta({ description: 'Every issue at once' }),
    })
    .meta({
        id: 'BrobotValidationError',
        description: doc`
            A request the route's zod schema refused, with every issue. Sent
            as the pipe builds it: \`{ message: 'Validation failed', issues }\`.
        `,
    });

/**
 * A keyed refusal of `/internal/transfer` (`keyedError` in
 * `transfer.service.ts`): Nest's body plus the machine-readable `code`.
 */
export const BrobotTransferError = z
    .strictObject({
        statusCode: z.int().meta({ example: 409 }),
        error: z.string().meta({ example: 'Conflict' }),
        code: z.enum(Object.values(TRANSFER_ERROR_CODES)).meta({
            description: doc`
                Why. api-time maps 403/404 to "not found" and any 409 to
                \`brobot_refused\` with the message, so the codes are for logs
                and humans.
            `,
        }),
        message: z.string(),
    })
    .meta({ id: 'BrobotTransferError', description: 'A transfer refused, keyed by `code`.' });

// ── shared responses ────────────────────────────────────────────────────────

export const validationFailed = {
    description: 'The request failed validation',
    body: BrobotValidationError,
} as const satisfies RouteResponse;
export const unauthorized = {
    description: 'No valid credential',
    body: BrobotError,
} as const satisfies RouteResponse;
export const tooManyRequests = {
    description: 'Throttled: over 120 requests per client per minute (the global ThrottlerGuard)',
    body: BrobotError,
} as const satisfies RouteResponse;
