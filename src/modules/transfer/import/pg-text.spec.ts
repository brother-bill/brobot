import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCopyField, DumpFormatError, parseCopyDump, parsePgArray } from './pg-text';

const FIXTURE = readFileSync(join(__dirname, '../../../../test/fixtures/prisma-import/old-prisma.data.sql'), 'utf8');

describe('decodeCopyField', () => {
    it.each([
        ['\\N', null],
        ['plain', 'plain'],
        ['', ''],
        ['a\\tb', 'a\tb'],
        ['line\\nbreak\\r', 'line\nbreak\r'],
        ['back\\\\slash', 'back\\slash'],
        ['\\b\\f\\v', '\b\f\v'],
        ['caf\\303\\251', 'café'],
        ['\\x41\\x42', 'AB'],
        ['\\q', 'q'],
        ['\\\\N', '\\N'],
    ])('%j → %j', (field, expected) => {
        expect(decodeCopyField(field)).toBe(expected);
    });
});

describe('parsePgArray', () => {
    it.each([
        ['{}', []],
        ['{a}', ['a']],
        ['{Viewer,StreamerAuth}', ['Viewer', 'StreamerAuth']],
        ['{"light screen",psychic}', ['light screen', 'psychic']],
        ['{"a,b","say \\"hi\\"","back\\\\slash"}', ['a,b', 'say "hi"', 'back\\slash']],
        ['{""}', ['']],
        ['{NULL,null,"NULL"}', [null, null, 'NULL']],
        ['{"line one\nline two"}', ['line one\nline two']],
    ])('%j', (literal, expected) => {
        expect(parsePgArray(literal)).toEqual(expected);
    });

    it.each(['a,b', '{{a},{b}}', '{"open}', '[1:2]={a,b}'])('refuses %j', literal => {
        expect(() => parsePgArray(literal)).toThrow();
    });
});

describe('parseCopyDump', () => {
    it('reads every old table from a pg_dump --data-only, skipping Session and Prisma bookkeeping', () => {
        const dump = parseCopyDump(FIXTURE);
        expect([...dump.tables.keys()].sort()).toEqual([
            'Pokemon',
            'PokemonBattleOutcome',
            'PokemonTeam',
            'PokemonTeamBattleOutcome',
            'TwitchBotAuth',
            'TwitchStreamerAuth',
            'TwitchUser',
            'TwitchUserRegistered',
        ]);
        expect(dump.skippedTables).toEqual(['Session', '_prisma_migrations']);
        expect(dump.tables.get('Pokemon')).toHaveLength(5);
    });

    it('keys rows by column name and decodes COPY escapes', () => {
        const users = parseCopyDump(FIXTURE).tables.get('TwitchUser') ?? [];
        expect(users.map(user => user.displayName)).toEqual([
            'Trama',
            'bro_____bot',
            'Ash\\Ketchum',
            'Misty\tWaterflower',
        ]);
        expect(users[2].roles).toBeNull();
        const [outcome] = parseCopyDump(FIXTURE).tables.get('PokemonBattleOutcome') ?? [];
        expect(parsePgArray(outcome.outcome ?? '')).toEqual([
            'Pikachu used Thunderbolt!',
            "It's super effective, wow",
            'The foe said "hi"',
            'line one\nline two',
        ]);
    });

    it('does not depend on column order', () => {
        const dump = parseCopyDump(
            'COPY public."PokemonTeam" ("updatedDate", id, "createdDate", "userOauthId") FROM stdin;\n' +
                '2023-01-01 00:00:00\t5b7d1f0e-6a51-4c1f-9d0a-0b8f3c2a4e11\t2022-01-01 00:00:00\t42\n\\.\n',
        );
        expect(dump.tables.get('PokemonTeam')).toEqual([
            {
                id: '5b7d1f0e-6a51-4c1f-9d0a-0b8f3c2a4e11',
                userOauthId: '42',
                createdDate: '2022-01-01 00:00:00',
                updatedDate: '2023-01-01 00:00:00',
            },
        ]);
    });

    it.each([
        ['a custom-format dump', 'PGDMP\u0001\u000e'],
        ['an --inserts dump', 'INSERT INTO public."TwitchUser" VALUES (\'42\');\n'],
        ['no data at all', '-- empty\n'],
        [
            'an unterminated COPY block',
            'COPY public."PokemonTeam" (id, "userOauthId", "createdDate", "updatedDate") FROM stdin;\na\tb\tc\td\n',
        ],
        [
            'a row with the wrong field count',
            'COPY public."PokemonTeam" (id, "userOauthId", "createdDate", "updatedDate") FROM stdin;\na\tb\n\\.\n',
        ],
        [
            'a table missing an old column',
            'COPY public."PokemonTeam" (id, "userOauthId") FROM stdin;\na\tb\n\\.\n',
        ],
    ])('refuses %s', (_label, text) => {
        expect(() => parseCopyDump(text)).toThrow(DumpFormatError);
    });
});
