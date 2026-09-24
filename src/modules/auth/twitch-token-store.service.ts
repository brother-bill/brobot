import { EntityManager } from '@mikro-orm/postgresql';
import type { EntityClass } from '@mikro-orm/core';
import { Injectable, Logger } from '@nestjs/common';
import { RefreshingAuthProvider } from '@twurple/auth';
import type { AccessToken } from '@twurple/auth';
import { EnvService } from '../../config/env.service';
import { TwitchBotAuth, TwitchStreamerAuth, TwitchUser } from '../../entities';

/** Which of the two stored Twitch user tokens. */
export type TokenStoreKind = 'streamer' | 'bot';

/**
 * The two Twitch user-token stores (`twitch_streamer_auth`, `twitch_bot_auth`)
 * and the Twurple providers built on them. B2's chat client and EventSub
 * listener get their credentials from {@link createAuthProvider}; nothing
 * else should read the token tables.
 *
 * Each kind maps to exactly one table, in one place. The old
 * `upsertUserStreamerAuth` wrote a refreshed STREAMER token into the BOT
 * table (`registeredBotAuth: { upsert: … }`), so every streamer refresh
 * clobbered the bot's credentials.
 */
@Injectable()
export class TwitchTokenStoreService {
    private readonly logger = new Logger(TwitchTokenStoreService.name);

    constructor(
        private readonly em: EntityManager,
        private readonly env: EnvService,
    ) {}

    /** The Twitch account each store belongs to (and the only one allowed to fill it). */
    accountIdFor(kind: TokenStoreKind): string {
        return kind === 'bot' ? this.env.get('TWITCH_BOT_OAUTH_ID') : this.env.get('TWITCH_STREAMER_OAUTH_ID');
    }

    /** Insert or replace the stored token for `oauthId`. The user row must already exist. */
    async save(kind: TokenStoreKind, oauthId: string, token: AccessToken): Promise<void> {
        const em = this.em.fork();
        const user = await em.findOneOrFail(TwitchUser, { oauth_id: oauthId });
        const entity = entityFor(kind);
        const existing = await em.findOne(entity, { twitch_user: user });
        const values = {
            access_token: token.accessToken,
            // Twitch user tokens always carry a refresh token; keep the old one
            // rather than writing NULL if a refresh ever omits it.
            refresh_token: token.refreshToken ?? existing?.refresh_token ?? '',
            scope: [...token.scope],
            // `expiresIn: null` means "never expires"; 0 makes Twurple refresh
            // on first use instead, which is the safe reading of a missing value.
            expiry_seconds: token.expiresIn ?? 0,
            obtainment_epoch: token.obtainmentTimestamp,
        };
        if (existing) {
            em.assign(existing, values);
        } else {
            em.create(entity, { ...values, twitch_user: user });
        }
        await em.flush();
    }

    async load(kind: TokenStoreKind): Promise<{ oauthId: string; token: AccessToken } | null> {
        const oauthId = this.accountIdFor(kind);
        const row = await this.em.fork().findOne(entityFor(kind), { twitch_user: oauthId });
        if (!row) return null;
        return {
            oauthId,
            token: {
                accessToken: row.access_token,
                refreshToken: row.refresh_token,
                scope: row.scope,
                expiresIn: row.expiry_seconds,
                obtainmentTimestamp: row.obtainment_epoch,
            },
        };
    }

    /**
     * A Twurple provider holding the stored token for `kind`, which writes
     * every refresh back to the same table. Null when that account has not
     * completed its OAuth flow yet — the caller decides whether that is fatal.
     */
    async createAuthProvider(kind: TokenStoreKind, intents: string[] = []): Promise<RefreshingAuthProvider | null> {
        const stored = await this.load(kind);
        if (!stored) {
            this.logger.warn(`No ${kind} token stored yet — complete /api/auth/twitch/${kind} first`);
            return null;
        }
        const provider = new RefreshingAuthProvider({
            clientId: this.env.get('TWITCH_CLIENT_ID'),
            clientSecret: this.env.get('TWITCH_CLIENT_SECRET'),
        });
        provider.onRefresh((userId, token) => {
            this.save(kind, userId, token).catch((error: unknown) => {
                this.logger.error(`Failed to persist refreshed ${kind} token`, error instanceof Error ? error.stack : error);
            });
        });
        provider.onRefreshFailure((userId, error) => {
            this.logger.error(`Twitch refused to refresh the ${kind} token for ${userId}: ${error.message}`);
        });
        provider.addUser(stored.oauthId, stored.token, intents);
        return provider;
    }
}

/**
 * The two token tables have identical columns, so one class type describes
 * both; the switch is the single place a kind is tied to its table.
 */
function entityFor(kind: TokenStoreKind): EntityClass<TwitchBotAuth> {
    return kind === 'bot' ? TwitchBotAuth : TwitchStreamerAuth;
}
