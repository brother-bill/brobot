import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** What {@link JwtAuthGuard} attaches to `req.user`: the caller as the database knows them NOW. */
export interface AuthenticatedUser {
    oauthId: string;
    displayName: string;
    roles: string[];
}

export type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

/** `@CurrentUser() user: AuthenticatedUser` in a handler behind JwtAuthGuard. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
    return context.switchToHttp().getRequest<AuthenticatedRequest>().user;
});
