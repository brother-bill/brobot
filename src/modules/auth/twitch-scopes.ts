/**
 * OAuth scopes per flow, copied verbatim from the old
 * `src/auth/strategies/index.ts` so the tokens the new flows mint can do
 * exactly what the old ones could — no more, no less. Change them only
 * together with the code in B2 that needs the new scope.
 *
 * `user_read` is Twitch's legacy (v5-era) profile scope. It was still being
 * accepted when the old app last ran; if Twitch ever rejects it, the
 * authorize redirect fails with `invalid_scope` and this is the line to
 * change (its Helix equivalent is `user:read:email`).
 */

/** Bot account: chat + the moderation it performs in chat. */
export const BOT_SCOPES = [
    'user_read',
    'chat:read',
    'chat:edit',
    'channel:edit:commercial',
    'channel:moderate',
] as const;

/** Streamer account: markers, predictions, bans, polls, channel points, mods. */
export const STREAMER_SCOPES = [
    'user_read',
    'chat:read',
    'channel:manage:broadcast',
    'channel:manage:predictions',
    'moderator:manage:banned_users',
    'channel:manage:polls',
    'channel:read:redemptions',
    'channel:manage:redemptions',
    'moderation:read',
    'channel:manage:moderators',
] as const;

/** Viewers signing in to the admin site: profile only. */
export const VIEWER_SCOPES = ['user_read'] as const;
