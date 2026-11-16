/**
 * `/internal/horror/mode` (`modules/twitch/horror/horror-mode.controller.ts`):
 * the SLEEP TIGHT gate, for the owner (friend-slop-1 docs/horror/TWITCH.md
 * "brobot modes"). Bearer `BROBOT_SERVICE_TOKEN`, like the other internal
 * routes, and not on the public commands list, so viewers never learn the
 * event exists.
 */
import { defineRoute } from '@singularity/http-contract';
import { z } from 'zod';
import { HORROR_MODES } from '../modules/twitch/horror/horror-mode.service';
import { BrobotError, tooManyRequests, unauthorized } from './common';
import { requires } from './security';

export const BrobotHorrorMode = z.enum(HORROR_MODES).meta({
    id: 'BrobotHorrorMode',
    description: '`off`, `rehearsal` (the owner only) or `live` (everyone in chat).',
});

export const BrobotHorrorModeResponse = z
    .strictObject({ mode: BrobotHorrorMode })
    .meta({ id: 'BrobotHorrorModeResponse', description: 'The current mode.' });

/**
 * Documentation only: the controller passes the raw body to
 * `HorrorModeService.setMode`, which parses `mode` itself and answers 400
 * with its own message.
 */
export const BrobotSetHorrorModeRequest = z
    .strictObject({ mode: BrobotHorrorMode })
    .meta({ id: 'BrobotSetHorrorModeRequest', description: 'The mode to switch to.' });

const horrorSecurity = requires('serviceToken');

export const getHorrorMode = defineRoute({
    operationId: 'getHorrorMode',
    method: 'get',
    path: '/internal/horror/mode',
    tags: ['Horror'],
    security: horrorSecurity,
    summary: 'The SLEEP TIGHT mode',
    description: 'The mode chat is gated by now, from memory: `off` when the stored mode could not be read at boot.',
    responses: {
        200: { description: 'The mode', body: BrobotHorrorModeResponse },
        401: unauthorized,
        429: tooManyRequests,
    },
});

export const setHorrorMode = defineRoute({
    operationId: 'setHorrorMode',
    method: 'post',
    path: '/internal/horror/mode',
    tags: ['Horror'],
    security: horrorSecurity,
    summary: 'Switch the SLEEP TIGHT mode',
    description: 'Stored, so it survives a restart.',
    body: BrobotSetHorrorModeRequest,
    responses: {
        200: { description: 'The new mode', body: BrobotHorrorModeResponse },
        400: { description: '`mode must be one of off, rehearsal, live`', body: BrobotError },
        401: unauthorized,
        429: tooManyRequests,
    },
});

export const horrorRoutes = [getHorrorMode, setHorrorMode] as const;
