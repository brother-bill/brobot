import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * Integration runner (same shape as api-time's): one Postgres container
 * started in globalSetup, every *.integration.spec.ts file serialised against
 * it. Needs Docker.
 */
export default defineConfig({
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
    },
    plugins: [
        // See api-time's vitest.config.ts for why this cast is needed.
        swc.vite({
            module: { type: 'es6' },
        }) as Plugin,
    ],
});
