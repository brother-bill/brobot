import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { TwitchUser, TwitchUserRegistered } from '../../entities';
import type { Role } from '../../entities';
import { TokenService } from './token.service';
import type { TokenPair } from './token.service';
import { TwitchOAuthClient } from './twitch-oauth.client';
import type { HelixUser, TwitchTokenResponse } from './twitch-oauth.client';
import { TwitchTokenStoreService } from './twitch-token-store.service';
import type { TokenStoreKind } from './twitch-token-store.service';
import { VIEWER_SCOPES } from './twitch-scopes';

/** The Twitch account that finished the streamer/bot flow is not the configured one. */
export class WrongTwitchAccountError extends Error {
    constructor(
        readonly kind: TokenStoreKind,
        readonly receivedId: string,
    ) {
        super(`Twitch account ${receivedId} is not the configured ${kind} account`);
        this.name = 'WrongTwitchAccountError';
    }
}

export interface CurrentUserStatus {
    oauthId: string;
    displayName: string;
    roles: string[];
    profileImageUrl: string | null;
    scope: string[];
}

const ROLE_FOR_KIND: Record<TokenStoreKind, Role> = { streamer: 'StreamerAuth', bot: 'BotAuth' };

/**
 * The three Twitch flows, kept apart by construction:
 *
 * - **viewer** — signs a person in to brobot.live. Upserts the user and their
 *   `twitch_user_registered` profile and issues brobot's JWT pair. Stores no
 *   Twitch token.
 * - **streamer** / **bot** — links a Twitch token into its own store. Only
 *   the configured account is accepted, and the flow never touches the
 *   caller's session.
 *
 * The old app pushed all three through one passport session, so the last
 * strategy to run owned `req.user`: logging in the bot while signed in as the
 * streamer signed the browser in *as the bot*, and logging out afterwards
 * corrupted the session store (the author's own TODO in auth.controller.ts).
 */
@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);

    constructor(
        private readonly em: EntityManager,
        private readonly twitch: TwitchOAuthClient,
        private readonly tokens: TokenService,
        private readonly tokenStore: TwitchTokenStoreService,
    ) {}

    async completeViewerLogin(code: string): Promise<{ user: TwitchUser; tokens: TokenPair }> {
        const twitchToken = await this.twitch.exchangeCode('viewer', code);
        const profile = await this.twitch.getUser(twitchToken.access_token);

        const em = this.em.fork();
        const user = await this.upsertTwitchUser(em, profile);
        const registered = await em.findOne(TwitchUserRegistered, { twitch_user: user });
        const values = {
            email: profile.email ?? null,
            profile_image_url: profile.profile_image_url,
            scope: [...VIEWER_SCOPES],
            origin_date: new Date(profile.created_at),
        };
        if (registered) {
            em.assign(registered, values);
        } else {
            em.create(TwitchUserRegistered, { ...values, twitch_user: user });
        }
        await em.flush();

        this.logger.log(`Viewer ${user.display_name} (${user.oauth_id}) signed in`);
        return { user, tokens: await this.tokens.generateTokenPair(user) };
    }

    /**
     * Store the streamer's or bot's Twitch token. Throws
     * {@link WrongTwitchAccountError} — and stores nothing — when Twitch
     * returned any account other than the configured one.
     */
    async linkAccount(kind: TokenStoreKind, code: string): Promise<TwitchUser> {
        const twitchToken = await this.twitch.exchangeCode(kind, code);
        const profile = await this.twitch.getUser(twitchToken.access_token);
        if (profile.id !== this.tokenStore.accountIdFor(kind)) {
            this.logger.warn(`Refused ${kind} link from Twitch account ${profile.id} (${profile.login})`);
            throw new WrongTwitchAccountError(kind, profile.id);
        }

        const em = this.em.fork();
        const user = await this.upsertTwitchUser(em, profile);
        const role = ROLE_FOR_KIND[kind];
        if (!user.roles.includes(role)) user.roles = [...user.roles, role];
        await em.flush();

        await this.tokenStore.save(kind, user.oauth_id, toAccessToken(twitchToken));
        this.logger.log(`Linked ${kind} account ${user.display_name} (${user.oauth_id})`);
        return user;
    }

    async refresh(refreshToken: string): Promise<TokenPair> {
        const payload = await this.tokens.verifyRefreshToken(refreshToken);
        const user = await this.em.fork().findOne(TwitchUser, { oauth_id: payload.sub });
        if (!user) throw new UnauthorizedException();
        return this.tokens.generateTokenPair(user);
    }

    async status(oauthId: string): Promise<CurrentUserStatus> {
        const em = this.em.fork();
        const user = await em.findOne(TwitchUser, { oauth_id: oauthId });
        if (!user) throw new UnauthorizedException();
        const registered = await em.findOne(TwitchUserRegistered, { twitch_user: oauthId });
        return {
            oauthId: user.oauth_id,
            displayName: user.display_name,
            roles: [...user.roles],
            profileImageUrl: registered?.profile_image_url ?? null,
            scope: registered ? [...registered.scope] : [],
        };
    }

    /** Create the user, or refresh the display name of one first seen in chat. Roles are never reset. */
    private async upsertTwitchUser(em: EntityManager, profile: HelixUser): Promise<TwitchUser> {
        const existing = await em.findOne(TwitchUser, { oauth_id: profile.id });
        if (existing) {
            existing.display_name = profile.display_name;
            return existing;
        }
        return em.create(TwitchUser, { oauth_id: profile.id, display_name: profile.display_name });
    }
}

export function toAccessToken(token: TwitchTokenResponse) {
    return {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? null,
        scope: token.scope ?? [],
        expiresIn: token.expires_in,
        obtainmentTimestamp: Date.now(),
    };
}
