import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { parseEnv } from './env.schema';
import { EnvService } from './env.service';

/**
 * Loads `.env` (local dev only — production injects real environment) and
 * validates it with {@link parseEnv}. A validation failure throws while the
 * module graph is being built, so the process exits before it listens.
 */
@Global()
@Module({
    imports: [
        NestConfigModule.forRoot({
            isGlobal: true,
            cache: true,
            ignoreEnvFile: process.env.NODE_ENV === 'production',
            validate: parseEnv,
        }),
    ],
    providers: [EnvService],
    exports: [EnvService],
})
export class ConfigModule {}
