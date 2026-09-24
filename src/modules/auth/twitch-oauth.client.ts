import { Injectable, Logger } from '@nestjs/common';
import { EnvService } from '../../config/env.service';
import { BOT_SCOPES, STREAMER_SCOPES, VIEWER_SCOPES } from './twitch-scopes';

export type OAuthFlow = 'viewer' | 'streamer' | 'bot';

export const TWITCH_AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
export const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
export const HELIX_USERS_URL = 'https://api.twitch.tv/helix/users';

const REQUEST_TIMEOUT_MS = 10_000;

/** `POST /oauth2/token` (authorization_code or client_credentials). */
export interface TwitchTokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string[];
    token_type: string;
}

/** One row of Helix `GET /users`. */
export interface HelixUser {
    id: string;
    login: string;
    display_name: string;
    profile_image_url: string;
    created_at: string;
    email?: string;
}

/** Twitch answered, but not with what we asked for. `status` 0 means it never answered. */
export class TwitchApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = 'TwitchApiError';
    }
}

/**
 * The Twitch half of the three OAuth code flows, on plain `fetch` — the
 * replacement for `passport-twitch-new`, which is unmaintained and was what
 * kept the old app on Node 16.
 *
 * Also holds an app access token (client credentials) for public lookups
 * such as login → user id, so the admin site's team search does not borrow
 * the streamer's user token the way the old endpoint did.
 */
@Injectable()
export class TwitchOAuthClient {
    private readonly logger = new Logger(TwitchOAuthClient.name);
    private appToken: { value: string; expiresAt: number } | null = null;
    private appTokenInFlight: Promise<string> | null = null;

    constructor(private readonly env: EnvService) {}

    authorizeUrl(flow: OAuthFlow, state: string): string {
        const url = new URL(TWITCH_AUTHORIZE_URL);
        url.searchParams.set('client_id', this.env.get('TWITCH_CLIENT_ID'));
        url.searchParams.set('redirect_uri', this.redirectUri(flow));
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', scopesFor(flow).join(' '));
        url.searchParams.set('state', state);
        // The streamer and bot flows are completed by one person switching
        // between two Twitch accounts. Without force_verify Twitch silently
        // reuses whichever account the browser is signed in to, which is how
        // the wrong account's token ends up offered to the wrong flow.
        if (flow !== 'viewer') url.searchParams.set('force_verify', 'true');
        return url.toString();
    }

    async exchangeCode(flow: OAuthFlow, code: string): Promise<TwitchTokenResponse> {
        const body = new URLSearchParams({
            client_id: this.env.get('TWITCH_CLIENT_ID'),
            client_secret: this.env.get('TWITCH_CLIENT_SECRET'),
            code,
            grant_type: 'authorization_code',
            redirect_uri: this.redirectUri(flow),
        });
        const token = await this.request<TwitchTokenResponse>(TWITCH_TOKEN_URL, { method: 'POST', body });
        if (!token.access_token) {
            throw new TwitchApiError('Twitch token response had no access_token', 502);
        }
        return token;
    }

    /** The account a user token belongs to. */
    async getUser(accessToken: string): Promise<HelixUser> {
        const users = await this.helixUsers(accessToken);
        if (users.length === 0) throw new TwitchApiError('Helix returned no user for this token', 502);
        return users[0];
    }

    /** Resolve a login to its account, or null if Twitch has no such user. */
    async getUserByLogin(login: string): Promise<HelixUser | null> {
        const url = new URL(HELIX_USERS_URL);
        url.searchParams.set('login', login);
        const users = await this.helixUsers(await this.getAppAccessToken(), url);
        return users.length > 0 ? users[0] : null;
    }

    private async helixUsers(accessToken: string, url: URL = new URL(HELIX_USERS_URL)): Promise<HelixUser[]> {
        const response = await this.request<{ data?: HelixUser[] }>(url.toString(), {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Client-Id': this.env.get('TWITCH_CLIENT_ID'),
            },
        });
        return response.data ?? [];
    }

    private async getAppAccessToken(): Promise<string> {
        if (this.appToken && Date.now() < this.appToken.expiresAt) return this.appToken.value;
        this.appTokenInFlight ??= this.fetchAppAccessToken().finally(() => {
            this.appTokenInFlight = null;
        });
        return this.appTokenInFlight;
    }

    private async fetchAppAccessToken(): Promise<string> {
        const body = new URLSearchParams({
            client_id: this.env.get('TWITCH_CLIENT_ID'),
            client_secret: this.env.get('TWITCH_CLIENT_SECRET'),
            grant_type: 'client_credentials',
        });
        const token = await this.request<TwitchTokenResponse>(TWITCH_TOKEN_URL, { method: 'POST', body });
        // Renew a minute early so a lookup never races the expiry.
        this.appToken = { value: token.access_token, expiresAt: Date.now() + (token.expires_in - 60) * 1000 };
        return token.access_token;
    }

    private redirectUri(flow: OAuthFlow): string {
        switch (flow) {
            case 'viewer':
                return this.env.get('TWITCH_CALLBACK_URL_USER');
            case 'streamer':
                return this.env.get('TWITCH_CALLBACK_URL_STREAMER');
            case 'bot':
                return this.env.get('TWITCH_CALLBACK_URL_BOT');
        }
    }

    private async request<T>(url: string, init: RequestInit): Promise<T> {
        let response: Response;
        try {
            response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new TwitchApiError(`Twitch request failed: ${message}`, 0);
        }
        if (!response.ok) {
            // The body is Twitch's own error text; it never contains our secret.
            const detail = await response.text().catch(() => '');
            this.logger.warn(`Twitch ${new URL(url).pathname} answered ${response.status}: ${detail.slice(0, 200)}`);
            throw new TwitchApiError(`Twitch answered ${response.status}`, response.status);
        }
        return (await response.json()) as T;
    }
}

export function scopesFor(flow: OAuthFlow): readonly string[] {
    switch (flow) {
        case 'viewer':
            return VIEWER_SCOPES;
        case 'streamer':
            return STREAMER_SCOPES;
        case 'bot':
            return BOT_SCOPES;
    }
}
