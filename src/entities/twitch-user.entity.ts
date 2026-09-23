import { Collection, Entity, OneToMany, OneToOne, OptionalProps, PrimaryKey, PrimaryKeyProp, Property } from '@mikro-orm/core';
import type { Rel } from '@mikro-orm/core';
import { Pokemon } from './pokemon.entity';
import { PokemonTeam } from './pokemon-team.entity';
import { TwitchBotAuth } from './twitch-bot-auth.entity';
import { TwitchStreamerAuth } from './twitch-streamer-auth.entity';
import { TwitchUserRegistered } from './twitch-user-registered.entity';

/**
 * Roles stored in `twitch_user.roles`. `Viewer` is every row's default;
 * `StreamerAuth` / `BotAuth` are granted by completing the streamer / bot
 * OAuth flow (which only the configured account can); `Admin` is granted by
 * hand in the database for moderators who should reach the admin endpoints.
 */
export const ROLES = ['Viewer', 'StreamerAuth', 'BotAuth', 'Admin'] as const;
export type Role = (typeof ROLES)[number];

/**
 * A Twitch account brobot has seen — in chat, through a redeem, or at login.
 * The primary key is the Twitch user id (Prisma `oauthId`), kept as the key so
 * the B3 import is a column map and every foreign key survives unchanged.
 */
@Entity({ tableName: 'twitch_user' })
export class TwitchUser {
    [PrimaryKeyProp]?: 'oauth_id';
    [OptionalProps]?: 'created_date' | 'updated_date' | 'roles';

    @PrimaryKey({ type: 'text' })
    oauth_id!: string;

    @Property({ type: 'text' })
    display_name!: string;

    @Property({ type: 'timestamptz', defaultRaw: 'now()' })
    created_date: Date = new Date();

    @Property({ type: 'text[]', defaultRaw: `'{Viewer}'` })
    roles: string[] = ['Viewer'];

    @Property({ type: 'timestamptz', onUpdate: () => new Date() })
    updated_date: Date = new Date();

    @OneToMany(() => Pokemon, pokemon => pokemon.twitch_user)
    pokemon = new Collection<Pokemon>(this);

    @OneToOne(() => PokemonTeam, team => team.twitch_user, { nullable: true })
    pokemon_team?: Rel<PokemonTeam> | null;

    @OneToOne(() => TwitchBotAuth, auth => auth.twitch_user, { nullable: true })
    registered_bot_auth?: Rel<TwitchBotAuth> | null;

    @OneToOne(() => TwitchStreamerAuth, auth => auth.twitch_user, { nullable: true })
    registered_streamer_auth?: Rel<TwitchStreamerAuth> | null;

    @OneToOne(() => TwitchUserRegistered, registered => registered.twitch_user, { nullable: true })
    registered_user?: Rel<TwitchUserRegistered> | null;
}
