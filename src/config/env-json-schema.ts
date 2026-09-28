import { z } from 'zod';
import { envRegistry, envSchema } from './env.schema';

/** Path of the committed export, relative to the brobot root. */
export const ENV_JSON_SCHEMA_FILE = 'env.schema.json';

/**
 * `env.schema.ts` as JSON Schema, with each key's kind, requiredBy, default
 * and description carried over from the registry — the format api-time's
 * config store reads (`config:import --schema`, `POST /admin/config/brobot/sync-schema`).
 * env-json-schema.spec.ts fails when the committed file and this disagree.
 *
 * `io: 'input'` describes what an env file holds, before the transforms.
 */
export function envJsonSchema(): Record<string, unknown> {
    return {
        ...z.toJSONSchema(envSchema, { metadata: envRegistry, io: 'input' }),
        title: 'brobot environment',
        description:
            'Generated from apps/brobot/src/config/env.schema.ts by `pnpm run env:schema`. Do not edit by hand.',
    };
}

export function renderEnvJsonSchema(): string {
    return `${JSON.stringify(envJsonSchema(), null, 4)}\n`;
}
