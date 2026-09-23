import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { RAW_TEST_ENV, testEnvService } from '../../../test/helpers';
import { isAuthorizedStreamerClient } from '../twitch/streamer-client-auth';
import { ServiceTokenGuard } from './service-token.guard';

function contextWith(authorization?: string): ExecutionContext {
    return {
        switchToHttp: () => ({ getRequest: () => ({ headers: authorization ? { authorization } : {} }) }),
    } as unknown as ExecutionContext;
}

describe('ServiceTokenGuard', () => {
    const guard = new ServiceTokenGuard(testEnvService());
    const token = RAW_TEST_ENV.BROBOT_SERVICE_TOKEN;

    it('admits `Authorization: Bearer $BROBOT_SERVICE_TOKEN`', () => {
        expect(guard.canActivate(contextWith(`Bearer ${token}`))).toBe(true);
        expect(guard.canActivate(contextWith(`bearer ${token}`))).toBe(true);
    });

    it.each([
        ['no header', undefined],
        ['the wrong token', 'Bearer wrong-token'],
        ['a prefix of the token', `Bearer ${token.slice(0, -1)}`],
        ['the token without the Bearer scheme', token],
        ['an empty bearer', 'Bearer '],
    ])('refuses %s', (_label, header) => {
        expect(() => guard.canActivate(contextWith(header))).toThrow(UnauthorizedException);
    });
});

describe('isAuthorizedStreamerClient', () => {
    const secret = RAW_TEST_ENV.WS_SECRET;

    it('accepts the legacy `token` header and a Bearer header', () => {
        expect(isAuthorizedStreamerClient({ token: secret }, secret)).toBe(true);
        expect(isAuthorizedStreamerClient({ authorization: `Bearer ${secret}` }, secret)).toBe(true);
    });

    it('refuses a missing, empty or wrong secret', () => {
        expect(isAuthorizedStreamerClient({}, secret)).toBe(false);
        expect(isAuthorizedStreamerClient({ token: '' }, secret)).toBe(false);
        expect(isAuthorizedStreamerClient({ token: 'nope' }, secret)).toBe(false);
        expect(isAuthorizedStreamerClient({ authorization: 'Bearer nope' }, secret)).toBe(false);
    });
});
