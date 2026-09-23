import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module';
import { EnvService } from './config/env.service';
import { buildOrmConfig } from './mikro-orm.config';
import { AuthModule } from './modules/auth/auth.module';
import { CommandsModule } from './modules/commands/commands.module';
import { HealthModule } from './modules/health/health.module';
import { PokemonModule } from './modules/pokemon/pokemon.module';
import { TransferModule } from './modules/transfer/transfer.module';
import { TwitchModule } from './modules/twitch/twitch.module';

/**
 * Every module brobot will ever have is registered here now (ticket B1), so
 * the tickets that run in parallel afterwards — B2 (twitch), B3 (transfer) —
 * only ever edit their own module and never collide in this file.
 */
@Module({
    imports: [
        ConfigModule,
        MikroOrmModule.forRootAsync({
            inject: [EnvService],
            useFactory: (env: EnvService) => buildOrmConfig(env.get('DATABASE_URL')),
            // Required for services to inject the driver-specific
            // EntityManager from '@mikro-orm/postgresql' (mikro-orm/nestjs#204).
            driver: PostgreSqlDriver,
        }),
        // A generous per-client default for every route; hot or expensive
        // routes tighten it with @Throttle, probes opt out with @SkipThrottle.
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
        HealthModule,
        AuthModule,
        CommandsModule,
        PokemonModule,
        TwitchModule,
        TransferModule,
    ],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
