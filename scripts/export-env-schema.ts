/**
 * Writes env.schema.json from src/config/env.schema.ts. Run from apps/brobot
 * after changing the schema, and commit the result:
 *
 *   pnpm run env:schema
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ENV_JSON_SCHEMA_FILE, renderEnvJsonSchema } from '../src/config/env-json-schema';

const target = resolve(__dirname, '..', ENV_JSON_SCHEMA_FILE);
writeFileSync(target, renderEnvJsonSchema());
console.info(`Wrote ${target}`);
