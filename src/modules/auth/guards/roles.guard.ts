import { applyDecorators, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '../../../entities';
import type { AuthenticatedRequest } from './authenticated-user';
import { JwtAuthGuard } from './jwt-auth.guard';

export const ROLES_KEY = 'brobot:roles';

/**
 * Who may use the admin endpoints. `StreamerAuth` is only ever granted to
 * `TWITCH_STREAMER_OAUTH_ID` (the streamer flow refuses anyone else), which
 * is exactly the check the old controllers hand-rolled per route; `Admin` is
 * granted by hand in the database for moderators. `BotAuth` is deliberately
 * NOT an admin role: the bot account signing in as a viewer is just a viewer.
 */
export const ADMIN_ROLES: readonly Role[] = ['StreamerAuth', 'Admin'];

/** The caller needs at least one of `roles` (read from `twitch_user.roles`). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Requires a signed-in user with one of {@link ADMIN_ROLES}. */
export const AdminOnly = () => applyDecorators(Roles(...ADMIN_ROLES), UseGuards(JwtAuthGuard, RolesGuard));

@Injectable()
export class RolesGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) {}

    canActivate(context: ExecutionContext): boolean {
        const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (!required || required.length === 0) return true;

        const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
        // RolesGuard reads what JwtAuthGuard loaded; without it there is no caller.
        if (!user) throw new UnauthorizedException();
        if (!required.some(role => user.roles.includes(role))) throw new ForbiddenException();
        return true;
    }
}
