import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * CORS from the validated ALLOWED_ORIGINS list (never `['']` — config
 * validation refuses an empty list). A refused origin is answered with no
 * `Access-Control-Allow-Origin` header rather than an error, as api-time does:
 * refusing is the absence of a grant, not a 500.
 */
export function corsOptions(allowedOrigins: readonly string[]): CorsOptions {
    return {
        origin: (origin, callback) => {
            // No Origin header: curl, server-to-server (api-time), the streamer client.
            if (!origin) {
                callback(null, true);
                return;
            }
            callback(null, allowedOrigins.includes(origin));
        },
        credentials: true,
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    };
}
