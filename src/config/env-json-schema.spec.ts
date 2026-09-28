import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV_KEYS } from './env.schema';
import { ENV_JSON_SCHEMA_FILE, envJsonSchema } from './env-json-schema';

describe('env.schema.json', () => {
    const committed = JSON.parse(readFileSync(join(__dirname, '../..', ENV_JSON_SCHEMA_FILE), 'utf8')) as {
        properties: Record<string, { kind?: string }>;
    };

    it('matches env.schema.ts — run `pnpm run env:schema` and commit the result', () => {
        expect(committed).toEqual(envJsonSchema());
    });

    it('carries every key with its kind', () => {
        expect(Object.keys(committed.properties).sort()).toEqual([...ENV_KEYS].sort());
        for (const name of ENV_KEYS) expect(committed.properties[name]?.kind, name).toBeDefined();
    });
});
