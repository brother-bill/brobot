/**
 * The old Prisma database, table by table, exactly as its only migration
 * created it (`git show 02854fb:prisma/migrations/20221130130640_init/migration.sql`
 * in this repository; `schema.prisma` at the same commit agrees). Prisma
 * quoted every identifier, so tables are PascalCase and columns camelCase.
 *
 * Listed parents first: the import writes in this order so every foreign key
 * already has its target. `Session` is deliberately absent — sessions are JWTs
 * now and are not imported.
 */
export const OLD_TABLES = {
    TwitchUser: ['oauthId', 'displayName', 'createdDate', 'roles', 'updatedDate'],
    TwitchUserRegistered: [
        'id',
        'userOauthId',
        'email',
        'profileImageUrl',
        'scope',
        'updatedDate',
        'originDate',
        'registeredDate',
    ],
    TwitchBotAuth: [
        'id',
        'accessToken',
        'refreshToken',
        'scope',
        'createdDate',
        'expirySeconds',
        'userOauthId',
        'updatedDate',
        'obtainmentEpoch',
    ],
    TwitchStreamerAuth: [
        'id',
        'accessToken',
        'refreshToken',
        'scope',
        'createdDate',
        'expirySeconds',
        'userOauthId',
        'updatedDate',
        'obtainmentEpoch',
    ],
    PokemonTeam: ['id', 'userOauthId', 'createdDate', 'updatedDate'],
    Pokemon: [
        'id',
        'name',
        'nameId',
        'slot',
        'level',
        'shiny',
        'wins',
        'losses',
        'draws',
        'item',
        'moves',
        'dexNum',
        'color',
        'types',
        'gender',
        'nature',
        'ability',
        'teamId',
        'userOauthId',
        'createdDate',
        'updatedDate',
    ],
    PokemonBattleOutcome: ['id', 'updatedDate', 'outcome'],
    PokemonTeamBattleOutcome: ['id', 'updatedDate', 'outcome'],
} as const;

export type OldTable = keyof typeof OLD_TABLES;
export const OLD_TABLE_NAMES = Object.keys(OLD_TABLES) as OldTable[];

/** Tables a full dump of the old database also holds, which the import skips on purpose. */
export const IGNORED_OLD_TABLES = ['Session', '_prisma_migrations'] as const;

/**
 * One old row with every value as Postgres prints it (`COPY` text form, or
 * `column::text`): `null` for SQL NULL, otherwise the text. Both import
 * sources produce this, so the mappers have exactly one input format.
 */
export type RawRow = Partial<Record<string, string | null>>;

export function isOldTable(name: string): name is OldTable {
    return Object.prototype.hasOwnProperty.call(OLD_TABLES, name);
}
