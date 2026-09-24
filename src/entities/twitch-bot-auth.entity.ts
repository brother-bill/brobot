import { BigIntType, Entity, OneToOne, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core';
import type { Rel } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { TwitchUser } from './twitch-user.entity';

/**
 * The bot account's Twitch user token (Prisma `TwitchBotAuth`). Written by
 * the bot OAuth flow and by every Twurple refresh; read by
 * `TwitchTokenStoreService.createBotAuthProvider()`.
 */
@Entity({ tableName: 'twitch_bot_auth' })
export class TwitchBotAuth {
    [OptionalProps]?: 'id' | 'created_date' | 'updated_date' | 'scope';

    @PrimaryKey({ type: 'uuid' })
    id: string = randomUUID();

    @Property({ type: 'text' })
    access_token!: string;

    @Property({ type: 'text' })
    refresh_token!: string;

    /** Prisma `String[]` was a nullable `text[]`; B3's import writes `{}` for NULL. */
    @Property({ type: 'text[]', defaultRaw: `'{}'` })
    scope: string[] = [];

    @Property({ type: 'timestamptz', defaultRaw: 'now()' })
    created_date: Date = new Date();

    /** Seconds the access token lives from `obtainment_epoch`. 0 means "refresh before first use". */
    @Property({ type: 'integer' })
    expiry_seconds!: number;

    @OneToOne(() => TwitchUser, user => user.registered_bot_auth, {
        owner: true,
        joinColumn: 'user_oauth_id',
        unique: true,
        deleteRule: 'cascade',
        updateRule: 'cascade',
    })
    twitch_user!: Rel<TwitchUser>;

    @Property({ type: 'timestamptz', onUpdate: () => new Date() })
    updated_date: Date = new Date();

    /** Epoch milliseconds the access token was obtained at (Twurple `obtainmentTimestamp`). */
    @Property({ type: new BigIntType('number') })
    obtainment_epoch!: number;
}
