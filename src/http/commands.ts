/** `/commands` (`modules/commands/commands.controller.ts`): the admin site's commands page. */
import { defineRoute } from '@singularity/http-contract';
import { z } from 'zod';
import { COMMAND_CATEGORIES } from '../modules/commands/command-catalog';
import { BrobotError, tooManyRequests, unauthorized, validationFailed } from './common';
import { userSession } from './security';

export const BrobotCommand = z
    .strictObject({
        name: z
            .string()
            .meta({
                description: 'The command id the switch is stored under',
                example: 'pokemon-teambattle',
            }),
        trigger: z
            .string()
            .meta({ description: 'What chat types', example: '!pokemon teambattle' }),
        aliases: z.array(z.string()),
        category: z.enum(COMMAND_CATEGORIES),
        description: z.string(),
        enabled: z
            .boolean()
            .meta({
                description:
                    'Switched on: stored, or the catalog default when nobody has flipped it',
            }),
    })
    .meta({ id: 'BrobotCommand', description: 'A chat command and its switch (`CommandState`).' });

export const BrobotSetCommandEnabledRequest = z
    .strictObject({
        name: z.string().min(1).max(64).meta({ description: "A command's `name`" }),
        enabled: z.boolean(),
    })
    .meta({ id: 'BrobotSetCommandEnabledRequest', description: 'Switch one command on or off.' });

export const listCommands = defineRoute({
    operationId: 'listCommands',
    method: 'get',
    path: '/commands',
    tags: ['Commands'],
    summary: 'Every chat command and whether it is on',
    description: 'Public: the commands page needs no sign-in. Read from memory, not the database.',
    responses: {
        200: { description: 'The catalog, in its order', body: z.array(BrobotCommand) },
        429: tooManyRequests,
    },
});

export const setCommandEnabled = defineRoute({
    operationId: 'setCommandEnabled',
    method: 'post',
    path: '/commands',
    tags: ['Commands'],
    security: userSession,
    summary: 'Switch a command on or off (admin)',
    description: 'For `StreamerAuth` or `Admin`. The switch is stored and survives a restart.',
    body: BrobotSetCommandEnabledRequest,
    responses: {
        201: { description: 'The command as it now is', body: BrobotCommand },
        400: validationFailed,
        401: unauthorized,
        403: {
            description: 'Signed in, but neither `StreamerAuth` nor `Admin`',
            body: BrobotError,
        },
        404: { description: 'No command with that name', body: BrobotError },
        429: tooManyRequests,
    },
});

export const commandsRoutes = [listCommands, setCommandEnabled] as const;
