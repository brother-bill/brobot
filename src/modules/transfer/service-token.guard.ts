import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { EnvService } from '../../config/env.service';
import { bearerToken, safeEqual } from '../../common/safe-equal';

/**
 * Service-to-service auth for api-time → brobot calls
 * (`/api/internal/transfer/*`, ticket B3): `Authorization: Bearer
 * $BROBOT_SERVICE_TOKEN`, compared in constant time. Never a user's session —
 * api-time proves the Pokémon's owner itself before calling (plan §2, §4).
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
    constructor(private readonly env: EnvService) {}

    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<Request>();
        const presented = bearerToken(request.headers.authorization);
        if (!presented || !safeEqual(presented, this.env.get('BROBOT_SERVICE_TOKEN'))) {
            throw new UnauthorizedException();
        }
        return true;
    }
}
