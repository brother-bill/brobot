/**
 * Writes openapi.json from the route definitions in src/http/
 * (`brobotDocument()`). Run from apps/brobot after changing a route, and
 * commit the result:
 *
 *   pnpm run openapi
 */
import './http-contract-from-source';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OPENAPI_FILE, renderBrobotOpenApi } from '../src/http/openapi-document';

const target = resolve(__dirname, '..', OPENAPI_FILE);
writeFileSync(target, renderBrobotOpenApi());
console.info(`Wrote ${target}`);
