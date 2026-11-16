/** `/health`, `/health/live` (`modules/health/health.controller.ts`). Public and unthrottled. */
import { defineRoute } from '@singularity/http-contract';
import { z } from 'zod';

export const BrobotLivenessResponse = z
    .strictObject({
        status: z.literal('live'),
        pid: z.int(),
        uptime: z.int().meta({ description: 'Seconds since the process started, rounded' }),
    })
    .meta({
        id: 'BrobotLivenessResponse',
        description: 'The process is up. Touches nothing else.',
    });

export const BrobotHealthResponse = z
    .strictObject({
        status: z.literal('ok'),
        service: z.literal('brobot'),
        uptime: z.int().meta({ description: 'Seconds since the process started, rounded' }),
        build: z.strictObject({
            sha: z.string().meta({ description: 'BUILD_BROBOT_SHA, or `unknown`' }),
            time: z.string().meta({ description: 'BUILD_TIME, or `unknown`' }),
        }),
    })
    .meta({
        id: 'BrobotHealthResponse',
        description: 'Liveness plus the build provenance. Touches no database.',
    });

export const getLiveness = defineRoute({
    operationId: 'getLiveness',
    method: 'get',
    path: '/health/live',
    tags: ['Health'],
    summary: 'Liveness probe',
    description:
        "The container healthcheck's probe: the process answers, and nothing else is checked.",
    responses: { 200: { description: 'Live', body: BrobotLivenessResponse } },
});

export const getHealth = defineRoute({
    operationId: 'getHealth',
    method: 'get',
    path: '/health',
    tags: ['Health'],
    summary: 'Health and build provenance',
    description: 'The process answers, with the commit and build time of the running image.',
    responses: { 200: { description: 'Healthy', body: BrobotHealthResponse } },
});

export const healthRoutes = [getHealth, getLiveness] as const;
