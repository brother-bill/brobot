import tseslint from 'typescript-eslint';
import baseConfig from '../../eslint.config.mjs';

export default tseslint.config(
    ...baseConfig,

    {
        files: ['**/*.ts'],
        rules: {
            '@typescript-eslint/interface-name-prefix': 'off',
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
