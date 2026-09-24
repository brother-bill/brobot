import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison. Both sides are hashed first so the
 * comparison takes the same time whatever their lengths — `timingSafeEqual`
 * alone throws on a length mismatch, and returning early there leaks the
 * secret's length.
 */
export function safeEqual(a: string, b: string): boolean {
    const left = createHash('sha256').update(a).digest();
    const right = createHash('sha256').update(b).digest();
    return timingSafeEqual(left, right);
}

/** The token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(header: string | string[] | undefined): string | null {
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) return null;
    const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
    return match?.[1] ?? null;
}
