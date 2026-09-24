import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

export interface LivenessResponse {
    status: 'live';
    pid: number;
    uptime: number;
}

export interface HealthResponse {
    status: 'ok';
    service: 'brobot';
    uptime: number;
    build: { sha: string; time: string };
}

/**
 * Neither endpoint touches the database, Twitch or anything else — the
 * container healthcheck restarts the process on a failure here, and a
 * database blip must not turn into a restart loop. (Same reasoning as
 * api-time's `/health/live`.) Unthrottled, because probes are frequent.
 */
@Controller('health')
@SkipThrottle()
export class HealthController {
    @Get('live')
    live(): LivenessResponse {
        return { status: 'live', pid: process.pid, uptime: Math.round(process.uptime()) };
    }

    @Get()
    health(): HealthResponse {
        return {
            status: 'ok',
            service: 'brobot',
            uptime: Math.round(process.uptime()),
            build: {
                sha: process.env.BUILD_BROBOT_SHA ?? 'unknown',
                time: process.env.BUILD_TIME ?? 'unknown',
            },
        };
    }
}
