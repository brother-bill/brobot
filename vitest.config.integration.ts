import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vitest/config';
import swc from 'unplugin-swc';
import { vitestWorkers } from '../../config/test-workers.mjs';

/**
 * Integration runner (same shape as api-time's): one Postgres container
 * started in globalSetup, every *.integration.spec.ts file serialised against
 * it. Needs Docker.
 */
export default defineConfig({
    resolve: {
        // @singularity/http-contract from its source, as `paths` in
        // tsconfig.base.json does for the typecheck, so the specs need no
        // library build first (`nest build` reads its dist: tsconfig.build.json).
        alias: [
            {
                find: /^@singularity\/http-contract$/,
                replacement: fileURLToPath(new URL('../../libs/http-contract/src/index.ts', import.meta.url)),
            },
        ],
    },
    test: {
        globals: true,
        root: './',
        environment: 'node',
        include: ['src/**/*.integration.spec.ts'],
        globalSetup: ['./test/integration/global-setup.ts'],
        testTimeout: 30000,
        hookTimeout: 60000,
        pool: 'forks',
        fileParallelism: false,
        maxWorkers: vitestWorkers({ serial: true }),
    },
    plugins: [
        // See api-time's vitest.config.ts for why this cast is needed.
        swc.vite({
            module: { type: 'es6' },
        }) as Plugin,
    ],
});
