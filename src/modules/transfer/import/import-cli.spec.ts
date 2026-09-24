import type { EntityManager } from '@mikro-orm/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, runImportCli, UsageError } from './import-cli';
import type { CliIo } from './import-cli';
import { RecordingEntityManager } from '../../../../test/fixtures/prisma-import/recording-entity-manager';

const FIXTURE = readFileSync(join(__dirname, '../../../../test/fixtures/prisma-import/old-prisma.data.sql'), 'utf8');

function io(files: Record<string, string>, env: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const connected: string[] = [];
    const em = new RecordingEntityManager();
    const value: CliIo = {
        env,
        readFile: path => {
            if (!(path in files)) throw new Error(`ENOENT: ${path}`);
            return files[path];
        },
        connect: async url => {
            connected.push(url);
            return { em: em as unknown as EntityManager, close: async () => undefined };
        },
        out: line => out.push(line),
        err: line => err.push(line),
    };
    return { io: value, out, err, connected, em };
}

describe('parseArgs', () => {
    it('takes a dump path or --from-db, plus the two flags', () => {
        expect(parseArgs(['--', 'dump.sql', '--dry-run', '--continue'])).toEqual({
            dumpPath: 'dump.sql',
            fromDb: false,
            dryRun: true,
            continueOnFailure: true,
            help: false,
        });
        expect(parseArgs(['--from-db'])).toMatchObject({ fromDb: true, dumpPath: null });
    });

    it.each([[[]], [['a.sql', '--from-db']], [['a.sql', 'b.sql']], [['a.sql', '--force']]])(
        'refuses %j',
        argv => {
            expect(() => parseArgs(argv)).toThrow(UsageError);
        },
    );
});

describe('runImportCli', () => {
    it('--dry-run prints counts per table and connects to nothing', async () => {
        const run = io({ 'dump.sql': FIXTURE });
        expect(await runImportCli(['dump.sql', '--dry-run'], run.io)).toBe(0);
        expect(run.connected).toEqual([]);
        expect(run.out.join('\n')).toMatch(/Pokemon → pokemon\s+5\s+5\s+0/);
        expect(run.out.at(-1)).toBe('dry run: nothing written');
        expect(run.err).toContain('skipped Session');
    });

    it('exits 1 on the first row it cannot map, naming it, and writes nothing', async () => {
        const broken = FIXTURE.replace('\tpikachu\t1\t150\t', '\tpikachu\t0\t150\t');
        const run = io({ 'dump.sql': broken }, { DATABASE_URL: 'postgres://new' });
        expect(await runImportCli(['dump.sql'], run.io)).toBe(1);
        expect(run.err).toContain(
            'cannot map Pokemon row 1 (0f6f8a4e-2b1c-4d3e-8f9a-1b2c3d4e5f60): slot: 0 is outside 1..6',
        );
        expect(run.connected).toEqual([]);
    });

    it('with --continue, lists every bad row and imports the rest', async () => {
        const broken = FIXTURE.replace('\tpikachu\t1\t150\t', '\tpikachu\t0\t150\t').replace(
            '\tditto\t2\t7\tf\t1\t1\t0\t\t{transform}\t132\tPurple\t{Normal}\tN',
            '\tditto\t2\t7\tf\t1\t1\t0\t\t{transform}\t132\tPurple\t{Normal}\tX',
        );
        const dry = io({ 'dump.sql': broken });
        expect(await runImportCli(['dump.sql', '--dry-run', '--continue'], dry.io)).toBe(0);
        expect(dry.err.filter(line => line.startsWith('cannot map'))).toHaveLength(2);
        expect(dry.out.at(-1)).toBe('dry run: nothing written; 2 row(s) would be skipped');

        const real = io({ 'dump.sql': broken }, { DATABASE_URL: 'postgres://new' });
        expect(await runImportCli(['dump.sql', '--continue'], real.io)).toBe(0);
        expect(real.connected).toEqual(['postgres://new']);
        expect(real.em.upserts.find(call => call.entity === 'Pokemon')?.rows).toHaveLength(3);
    });

    it('imports into DATABASE_URL', async () => {
        const run = io({ 'dump.sql': FIXTURE }, { DATABASE_URL: 'postgres://new' });
        expect(await runImportCli(['dump.sql'], run.io)).toBe(0);
        expect(run.em.upserts).toHaveLength(8);
        expect(run.out).toContain('  pokemon: 5 → 0');
    });

    it('--from-db reads DATABASE_URL_OLD and refuses to import a database into itself', async () => {
        const same = io({}, { DATABASE_URL: 'postgres://db', DATABASE_URL_OLD: 'postgres://db' });
        expect(await runImportCli(['--from-db'], same.io)).toBe(2);
        expect(same.err[0]).toMatch(/same database/);

        const missing = io({}, { DATABASE_URL: 'postgres://new' });
        expect(await runImportCli(['--from-db'], missing.io)).toBe(2);
        expect(missing.err[0]).toMatch(/DATABASE_URL_OLD/);
    });

    it('exits 2 without DATABASE_URL (unless dry run), on an unusable dump, and on bad arguments', async () => {
        expect(await runImportCli(['dump.sql'], io({ 'dump.sql': FIXTURE }).io)).toBe(2);
        const inserts = io({ 'dump.sql': 'INSERT INTO public."TwitchUser" VALUES (1);' });
        expect(await runImportCli(['dump.sql', '--dry-run'], inserts.io)).toBe(2);
        expect(inserts.err[0]).toMatch(/^unusable dump: .*--inserts/);
        expect(await runImportCli(['--nope'], io({}).io)).toBe(2);
    });
});
