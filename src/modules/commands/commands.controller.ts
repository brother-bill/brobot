import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../auth/guards/authenticated-user';
import type { AuthenticatedUser } from '../auth/guards/authenticated-user';
import { AdminOnly } from '../auth/guards/roles.guard';
import { CommandRegistryService } from './command-registry.service';
import type { CommandState } from './command-registry.service';

const setEnabledSchema = z.object({
    name: z.string().min(1),
    enabled: z.boolean(),
});

/**
 * The admin site's commands page. Reading the list is public (it was a public
 * page); switching a command on or off is admin-only, like the old
 * `POST /api/disableQuack`.
 */
@Controller('commands')
export class CommandsController {
    constructor(private readonly registry: CommandRegistryService) {}

    @Get()
    list(): CommandState[] {
        return this.registry.list();
    }

    @Post()
    @AdminOnly()
    setEnabled(
        @Body(new ZodValidationPipe(setEnabledSchema)) body: z.infer<typeof setEnabledSchema>,
        @CurrentUser() user: AuthenticatedUser,
    ): CommandState {
        return this.registry.setEnabled(body.name, body.enabled, `${user.displayName} (${user.oauthId})`);
    }
}
