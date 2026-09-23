import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { EntityManager } from '@mikro-orm/postgresql';
import { TwitchUser } from '../../../entities';
import { FakeEntityManager, testEnvService } from '../../../../test/helpers';
import { TokenService } from '../token.service';
import type { AuthenticatedRequest } from './authenticated-user';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ADMIN_ROLES, ROLES_KEY, RolesGuard } from './roles.guard';

function contextFor(request: Partial<AuthenticatedRequest>, handler: () => void = () => undefined): ExecutionContext {
    return {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => handler,
        getClass: () => class {},
    } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
    const env = testEnvService();
    const tokens = new TokenService(new JwtService({}), env);
    let em: FakeEntityManager;
    let guard: JwtAuthGuard;

    beforeEach(() => {
        em = new FakeEntityManager();
        em.insert(TwitchUser, { oauth_id: '42', display_name: 'Viewer', roles: ['Viewer', 'Admin'] });
        guard = new JwtAuthGuard(tokens, em as unknown as EntityManager);
    });

    it('accepts a Bearer access token and attaches the user with roles from the database', async () => {
        const { accessToken } = await tokens.generateTokenPair({ oauth_id: '42', display_name: 'Viewer' });
        const request: Partial<AuthenticatedRequest> = { headers: { authorization: `Bearer ${accessToken}` } };

        await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
        expect(request.user).toEqual({ oauthId: '42', displayName: 'Viewer', roles: ['Viewer', 'Admin'] });
    });

    it('falls back to the accessToken cookie', async () => {
        const { accessToken } = await tokens.generateTokenPair({ oauth_id: '42', display_name: 'Viewer' });
        const request = { headers: {}, cookies: { accessToken } } as Partial<AuthenticatedRequest>;
        await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    });

    it('refuses no token, a garbage token and a refresh token', async () => {
        const { refreshToken } = await tokens.generateTokenPair({ oauth_id: '42', display_name: 'Viewer' });
        for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: `Bearer ${refreshToken}` }]) {
            await expect(guard.canActivate(contextFor({ headers }))).rejects.toBeInstanceOf(UnauthorizedException);
        }
    });

    it('refuses a valid token whose user no longer exists', async () => {
        const { accessToken } = await tokens.generateTokenPair({ oauth_id: '999', display_name: 'Gone' });
        await expect(
            guard.canActivate(contextFor({ headers: { authorization: `Bearer ${accessToken}` } })),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('refuses a token signed with another secret', async () => {
        const forged = await new JwtService({}).signAsync(
            { sub: '42', name: 'Viewer', typ: 'access' },
            { secret: 'x'.repeat(40) },
        );
        await expect(
            guard.canActivate(contextFor({ headers: { authorization: `Bearer ${forged}` } })),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });
});

describe('RolesGuard', () => {
    const reflector = new Reflector();
    const guard = new RolesGuard(reflector);

    function handlerRequiring(roles: string[] | undefined) {
        const handler = () => undefined;
        if (roles) Reflect.defineMetadata(ROLES_KEY, roles, handler);
        return handler;
    }

    it('lets anything through when the route declares no roles', () => {
        expect(guard.canActivate(contextFor({}, handlerRequiring(undefined)))).toBe(true);
    });

    it('admits a caller holding any one of the required roles', () => {
        const request = { user: { oauthId: '1', displayName: 'x', roles: ['Viewer', 'Admin'] } };
        expect(guard.canActivate(contextFor(request, handlerRequiring([...ADMIN_ROLES])))).toBe(true);
    });

    it('treats StreamerAuth as admin but not BotAuth', () => {
        const streamer = { user: { oauthId: '1', displayName: 'x', roles: ['Viewer', 'StreamerAuth'] } };
        const bot = { user: { oauthId: '2', displayName: 'b', roles: ['Viewer', 'BotAuth'] } };
        expect(guard.canActivate(contextFor(streamer, handlerRequiring([...ADMIN_ROLES])))).toBe(true);
        expect(() => guard.canActivate(contextFor(bot, handlerRequiring([...ADMIN_ROLES])))).toThrow(
            ForbiddenException,
        );
    });

    it('is 403 for a signed-in viewer and 401 when no guard authenticated the request', () => {
        const viewer = { user: { oauthId: '1', displayName: 'x', roles: ['Viewer'] } };
        expect(() => guard.canActivate(contextFor(viewer, handlerRequiring(['Admin'])))).toThrow(ForbiddenException);
        expect(() => guard.canActivate(contextFor({}, handlerRequiring(['Admin'])))).toThrow(UnauthorizedException);
    });
});
