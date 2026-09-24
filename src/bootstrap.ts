import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { EnvService } from './config/env.service';
import { corsOptions } from './common/cors';

export const GLOBAL_PREFIX = 'api';

/**
 * Everything `main.ts` does to the app before it listens, split out so a test
 * can build the same HTTP surface.
 */
export function configureApp(app: NestExpressApplication): void {
    const env = app.get(EnvService);

    app.useWebSocketAdapter(new WsAdapter(app));
    app.setGlobalPrefix(GLOBAL_PREFIX);

    // nginx sits in front on the compose network. Trust only private-range
    // hops, so `req.ip` (the throttler's key) is the address nginx reports
    // rather than whatever a client writes into X-Forwarded-For.
    app.set('trust proxy', 'loopback, linklocal, uniquelocal');

    app.use(helmet());
    app.use(cookieParser());
    app.enableCors(corsOptions(env.get('ALLOWED_ORIGINS')));
    app.enableShutdownHooks();
}
