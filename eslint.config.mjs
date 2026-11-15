import tseslint from 'typescript-eslint';
import baseConfig from '../../eslint.config.mjs';

export default tseslint.config(
    ...baseConfig,

    // Keep deprecated APIs out of brobot: zod 4's zod 3 spellings
    // (`z.string().uuid()`, ...), MikroORM's `getMigrator()`, and so on. No
    // allow-list: nothing here needs one. The rule does not see a deprecated
    // key in an object literal, so `{ message }` -> `{ error }` in zod params
    // is still by hand. Typed rule, so only on the files the base config
    // type-checks.
    {
        files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
        rules: {
            '@typescript-eslint/no-deprecated': 'error',
        },
    },

    // Same relaxation api-time applies to test code.
    {
        files: [
            '**/*.spec.ts',
            '**/vitest.config.ts',
            '**/vitest.config.integration.ts',
            'test/**/*.ts',
        ],
        rules: {
            '@typescript-eslint/prefer-nullish-coalescing': 'off',
            '@typescript-eslint/no-unnecessary-condition': 'off',
        },
    },
);
