import { MikroORM } from '@mikro-orm/postgresql';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp, GLOBAL_PREFIX } from './bootstrap';
import { EnvService } from './config/env.service';
import { EventSubService } from './modules/twitch/eventsub.service';

async function bootstrap(): Promise<void> {
    const logger = new Logger('Bootstrap');
    // Env validation runs while the module graph is built, so a missing
    // variable fails here — before migrations, before listening.
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
    configureApp(app);
    const env = app.get(EnvService);

    // Where the old main.ts applied Twurple's EventSub middleware: on the
    // Express instance before the app listens (behind TWITCH_EVENTSUB_ENABLED
    // now, instead of NODE_ENV=production), subscribing once it does.
    const eventSub = app.get(EventSubService);
    eventSub.apply(app.getHttpAdapter().getInstance());

    if (env.get('RUN_MIGRATIONS')) {
        const applied = await app.get(MikroORM).getMigrator().up();
        logger.log(`Migrations applied: ${applied.length === 0 ? 'none pending' : applied.map(m => m.name).join(', ')}`);
    } else {
        logger.log('RUN_MIGRATIONS=false — skipping migrations');
    }

    const port = env.get('PORT');
    await app.listen(port, '0.0.0.0');

    // Fail inside nginx's 30 s proxy timeout rather than after it (api-time's reasoning).
    const server = app.getHttpServer();
    server.requestTimeout = 25_000;
    server.headersTimeout = 26_000;

    logger.log(`brobot listening on :${port}/${GLOBAL_PREFIX}`);

    // A failed subscription must not take the API down with it.
    try {
        await eventSub.subscribe();
    } catch (error) {
        logger.error('EventSub subscription failed', error instanceof Error ? error.stack : error);
    }
}

bootstrap().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
