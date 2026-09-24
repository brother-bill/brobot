import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
    test: {
        globals: true,
        root: './',
        environment: 'node',
        include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
        exclude: ['src/**/*.integration.spec.ts', 'node_modules/**', 'dist/**'],
        coverage: {
            provider: 'v8',
            reportsDirectory: './coverage',
            // `json-summary` produces coverage-summary.json — a small per-file
            // table the root `coverage:report` aggregator script reads. `text`
            // is the developer-facing terminal output. `html` is for humans
            // browsing locally. `json` is the full per-line detail (heavy;
            // kept because tools like vscode coverage extensions expect it).
            reporter: ['text', 'json', 'json-summary', 'html'],
            exclude: [
                'node_modules/',
                'dist/',
                'src/**/*.spec.ts',
                'src/**/*.test.ts',
                'src/**/*.interface.ts',
                'src/**/index.ts',
                'src/migrations/**',
                'src/seeders/**',
                'test/**',
            ],
        },
    },
    plugins: [
        // Cast across two copies of the same vite. The workspace resolves more
        // than one `less`/`sass` version, so pnpm installs several peer-hash
        // variants of vite 7.3.2; `unplugin` (behind unplugin-swc) picks up the
        // hoisted one and `vitest/config` its own. The `Plugin` types are
        // structurally identical and nominally distinct, and vite loads one
        // module at runtime — only the compiler sees two.
        swc.vite({
            module: { type: 'es6' },
        }) as Plugin,
    ],
});
