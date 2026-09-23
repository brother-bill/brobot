import { randomBytes } from 'node:crypto';
import type { CookieOptions } from 'express';
import type { OAuthFlow } from './twitch-oauth.client';
import { safeEqual } from '../../common/safe-equal';

/**
 * CSRF protection for the OAuth callbacks: a random `state` is stored in an
 * httpOnly cookie before the redirect to Twitch and must come back unchanged.
 * One cookie per flow, so starting the bot flow in one tab cannot invalidate
 * a viewer login in another.
 */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function stateCookieName(flow: OAuthFlow): string {
    return `brobot_oauth_${flow}`;
}

export function newOAuthState(): string {
    return randomBytes(32).toString('base64url');
}

export function stateCookieOptions(): CookieOptions {
    return {
        httpOnly: true,
        secure: true,
        // Lax, not Strict: the callback is a top-level navigation arriving
        // from id.twitch.tv, and a Strict cookie would not be sent with it.
        sameSite: 'lax',
        maxAge: OAUTH_STATE_TTL_MS,
        path: '/api/auth/twitch',
    };
}

/** True only when both are present and identical. */
export function isValidOAuthState(expected: unknown, received: unknown): boolean {
    if (typeof expected !== 'string' || typeof received !== 'string') return false;
    if (expected.length === 0) return false;
    return safeEqual(expected, received);
}
