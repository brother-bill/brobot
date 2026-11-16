import { Body, Controller, Get, Post } from '@nestjs/common';
import type { RouteInput, RouteResult } from '@singularity/http-contract';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { routes } from '../../http';
import { CurrentUser } from '../auth/guards/authenticated-user';
import type { AuthenticatedUser } from '../auth/guards/authenticated-user';
import { AdminOnly } from '../auth/guards/roles.guard';
import { CommandRegistryService } from './command-registry.service';

/**
 * The admin site's commands page. Reading the list is public (it was a public
 * page); switching a command on or off is admin-only, like the old
 * `POST /api/disableQuack`, and the switch is stored.
 */
@Controller('commands')
export class CommandsController {
    constructor(private readonly registry: CommandRegistryService) {}

    @Get()
    list(): RouteResult<typeof routes.listCommands> {
        return this.registry.list();
    }

    @Post()
    @AdminOnly()
    setEnabled(
        @Body(new ZodValidationPipe(routes.setCommandEnabled.body)) body: RouteInput<typeof routes.setCommandEnabled>['body'],
        @CurrentUser() user: AuthenticatedUser,
    ): Promise<RouteResult<typeof routes.setCommandEnabled>> {
        return this.registry.setEnabled(body.name, body.enabled, `${user.displayName} (${user.oauthId})`);
    }
}
