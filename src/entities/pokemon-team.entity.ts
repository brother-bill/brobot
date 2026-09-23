import { Collection, Entity, OneToMany, OneToOne, OptionalProps, PrimaryKey, Property } from '@mikro-orm/core';
import type { Rel } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { Pokemon } from './pokemon.entity';
import { TwitchUser } from './twitch-user.entity';

/** One team per Twitch user, six slots (Prisma `PokemonTeam`). */
@Entity({ tableName: 'pokemon_team' })
export class PokemonTeam {
    [OptionalProps]?: 'id' | 'created_date' | 'updated_date';

    @PrimaryKey({ type: 'uuid' })
    id: string = randomUUID();

    @OneToOne(() => TwitchUser, user => user.pokemon_team, {
        owner: true,
        joinColumn: 'user_oauth_id',
        unique: true,
        deleteRule: 'cascade',
        updateRule: 'cascade',
    })
    twitch_user!: Rel<TwitchUser>;

    @Property({ type: 'timestamptz', defaultRaw: 'now()' })
    created_date: Date = new Date();

    @Property({ type: 'timestamptz', onUpdate: () => new Date() })
    updated_date: Date = new Date();

    @OneToMany(() => Pokemon, pokemon => pokemon.team)
    pokemon = new Collection<Pokemon>(this);
}
