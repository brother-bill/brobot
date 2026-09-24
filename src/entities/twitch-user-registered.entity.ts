import { Entity, OneToOne, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core';
import type { Rel } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { TwitchUser } from './twitch-user.entity';

/**
 * A viewer who signed in to brobot.live (Prisma `TwitchUserRegistered`).
 * Holds no token: the viewer flow only needs the profile, and brobot's own
 * JWT is the session.
 */
@Entity({ tableName: 'twitch_user_registered' })
export class TwitchUserRegistered {
    [OptionalProps]?: 'id' | 'updated_date' | 'registered_date' | 'scope';

    @PrimaryKey({ type: 'uuid' })
    id: string = randomUUID();

    @OneToOne(() => TwitchUser, user => user.registered_user, {
        owner: true,
        joinColumn: 'user_oauth_id',
        unique: true,
        deleteRule: 'cascade',
        updateRule: 'cascade',
    })
    twitch_user!: Rel<TwitchUser>;

    @Property({ type: 'text', nullable: true })
    email?: string | null;

    @Property({ type: 'text' })
    profile_image_url!: string;

    /** Prisma `String[]` was a nullable `text[]`; B3's import writes `{}` for NULL. */
    @Property({ type: 'text[]', defaultRaw: `'{}'` })
    scope: string[] = [];

    @Property({ type: 'timestamptz', onUpdate: () => new Date() })
    updated_date: Date = new Date();

    /** When the Twitch account itself was created (Helix `created_at`). */
    @Property({ type: 'timestamptz' })
    origin_date!: Date;

    @Property({ type: 'timestamptz', defaultRaw: 'now()' })
    registered_date: Date = new Date();
}
