import { z } from 'zod';
/**
 * Every failure the API can report gets a stable machine-readable code. The
 * frontend switches on these to decide whether to retry, prompt the user to
 * free storage, or surface a terminal error, so they must never be reworded
 * into something the client cannot match on.
 */
export const ApiErrorCode = z.enum([
    'BAD_REQUEST',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'NOT_FOUND',
    'RATE_LIMITED',
    /** Adapter reached out to its source and the source timed out or refused. */
    'UPSTREAM_UNAVAILABLE',
    /** Source responded, but the payload did not match what the adapter expects. */
    'UPSTREAM_MALFORMED',
    /** Requested host is not on the proxy allowlist, or resolved to a private IP. */
    'ORIGIN_NOT_ALLOWED',
    /** sharp could not decode or re-encode the image. */
    'TRANSCODE_FAILED',
    'INTERNAL',
]);
export const ApiError = z.object({
    error: z.object({
        code: ApiErrorCode,
        message: z.string(),
        /** Present on RATE_LIMITED and UPSTREAM_UNAVAILABLE when a retry is sensible. */
        retryAfterMs: z.number().int().nonnegative().optional(),
    }),
});
/** HTTP status for each code, used by the Fastify error serializer. */
export const HTTP_STATUS_FOR_CODE = {
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    RATE_LIMITED: 429,
    UPSTREAM_UNAVAILABLE: 502,
    UPSTREAM_MALFORMED: 502,
    ORIGIN_NOT_ALLOWED: 403,
    TRANSCODE_FAILED: 502,
    INTERNAL: 500,
};
/**
 * Thrown by adapters and route handlers. The Fastify error handler converts
 * this into an {@link ApiError} body with the mapped status.
 */
export class AppError extends Error {
    code;
    retryAfterMs;
    constructor(code, message, retryAfterMs) {
        super(message);
        this.name = 'AppError';
        this.code = code;
        this.retryAfterMs = retryAfterMs;
    }
    get status() {
        return HTTP_STATUS_FOR_CODE[this.code];
    }
    toBody() {
        return {
            error: {
                code: this.code,
                message: this.message,
                ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
            },
        };
    }
}
