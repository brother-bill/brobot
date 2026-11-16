/**
 * Resolves `@singularity/http-contract` to its TypeScript source, as
 * vitest.config.ts and tsconfig.base.json's `paths` do, so a ts-node script
 * that builds brobot's document needs no library build first. Import it before
 * anything that reaches src/http/.
 */
import Module from 'node:module';
import { resolve } from 'node:path';

const SOURCE = resolve(__dirname, '../../../libs/http-contract/src/index.ts');

interface Resolver {
    _resolveFilename(request: string, ...rest: unknown[]): string;
}

const resolver = Module as unknown as Resolver;
const original = resolver._resolveFilename.bind(resolver);
resolver._resolveFilename = (request: string, ...rest: unknown[]): string =>
    original(request === '@singularity/http-contract' ? SOURCE : request, ...rest);
