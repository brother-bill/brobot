/**
 * Writes apps/brobot/.env from the config store's brobot/dev bundle. Run from
 * apps/brobot, with your dev token in the environment (never as an argument):
 *
 *   read -rs BROBOT_CONFIG_TOKEN && export BROBOT_CONFIG_TOKEN   # paste cfg_…
 *   pnpm run config:pull-dev
 *
 * The logic is in src/config/config-pull-dev.ts.
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pullDevConfig } from '../src/config/config-pull-dev';

const envFile = resolve(__dirname, '..', '.env');
const exampleFile = resolve(__dirname, '..', '.env.example');

void pullDevConfig(
    {
        env: process.env,
        fetch: (url, init) => fetch(url, init),
        readFile: path => (existsSync(path) ? readFileSync(path, 'utf8') : null),
        replaceEnvFile: content => {
            if (existsSync(envFile)) copyFileSync(envFile, `${envFile}.prev`);
            const temp = `${envFile}.tmp`;
            writeFileSync(temp, content, { mode: 0o600 });
            renameSync(temp, envFile);
        },
        out: line => console.info(line),
        err: line => console.error(line),
    },
    { envFile, exampleFile },
).then(
    code => {
        process.exitCode = code;
    },
    (error: unknown) => {
        console.error(`config:pull-dev: ${(error as Error).message}`);
        process.exitCode = 1;
    },
);
