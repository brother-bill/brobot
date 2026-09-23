import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { bearerToken } from '../../../common/safe-equal';
import { TwitchUser } from '../../../entities';
import { ACCESS_COOKIE, TokenService } from '../token.service';
import type { AuthenticatedRequest } from './authenticated-user';

/**
 * Accepts brobot's access token from `Authorization: Bearer` (native / bearer
 * mode, checked first) or the `accessToken` cookie (web), the same order
 * api-time's JwtStrategy uses. The user row is re-read on every request, so a
 * deleted user is refused at once and roles are never older than the database.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
    constructor(
        private readonly tokens: TokenService,
        private readonly em: EntityManager,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
        const cookies = request.cookies as Record<string, string | undefined> | undefined;
        const token = bearerToken(request.headers.authorization) ?? cookies?.[ACCESS_COOKIE];
        if (!token) throw new UnauthorizedException();

        const payload = await this.tokens.verifyAccessToken(token);
        const user = await this.em.fork().findOne(TwitchUser, { oauth_id: payload.sub });
        if (!user) throw new UnauthorizedException();

        request.user = { oauthId: user.oauth_id, displayName: user.display_name, roles: [...user.roles] };
        return true;
    }
}
