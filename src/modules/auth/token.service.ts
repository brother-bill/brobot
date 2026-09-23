import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { CookieOptions, Response } from 'express';
import { EnvService } from '../../config/env.service';

/** The same shape api-time's `AuthService.generateTokenPair` returns, so libs/ngx-auth works unchanged. */
export interface TokenPair {
    accessToken: string;
    refreshToken: string;
}

type TokenType = 'access' | 'refresh';

export interface BrobotJwtPayload {
    /** Twitch user id (`twitch_user.oauth_id`). */
    sub: string;
    name: string;
    typ: TokenType;
}

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export const ACCESS_COOKIE = 'accessToken';
export const REFRESH_COOKIE = 'refreshToken';

/**
 * brobot's session: a stateless JWT pair, replacing express-session and its
 * Postgres store. Access and refresh tokens use different secrets AND carry a
 * `typ` claim, so neither can stand in for the other even if the secrets were
 * ever configured equal (config validation refuses that too).
 */
@Injectable()
export class TokenService {
    private readonly logger = new Logger(TokenService.name);

    constructor(
        private readonly jwt: JwtService,
        private readonly env: EnvService,
    ) {}

    async generateTokenPair(user: { oauth_id: string; display_name: string }): Promise<TokenPair> {
        const base = { sub: user.oauth_id, name: user.display_name };
        const [accessToken, refreshToken] = await Promise.all([
            this.jwt.signAsync(
                { ...base, typ: 'access' },
                { secret: this.env.get('JWT_ACCESS_SECRET'), expiresIn: ACCESS_TOKEN_TTL_SECONDS },
            ),
            this.jwt.signAsync(
                { ...base, typ: 'refresh' },
                { secret: this.env.get('JWT_REFRESH_SECRET'), expiresIn: REFRESH_TOKEN_TTL_SECONDS },
            ),
        ]);
        return { accessToken, refreshToken };
    }

    verifyAccessToken(token: string): Promise<BrobotJwtPayload> {
        return this.verify(token, 'access');
    }

    verifyRefreshToken(token: string): Promise<BrobotJwtPayload> {
        return this.verify(token, 'refresh');
    }

    setAuthCookies(res: Response, tokens: TokenPair): void {
        res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...this.cookieOptions(), maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000 });
        res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
            ...this.cookieOptions(),
            maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
        });
    }

    clearAuthCookies(res: Response): void {
        res.clearCookie(ACCESS_COOKIE, this.cookieOptions());
        res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
    }

    /** Host-only (no Domain attribute), exactly like api-time's cookies. */
    private cookieOptions(): CookieOptions {
        return { httpOnly: true, secure: true, sameSite: 'strict', path: '/' };
    }

    private async verify(token: string, typ: TokenType): Promise<BrobotJwtPayload> {
        const secret = this.env.get(typ === 'access' ? 'JWT_ACCESS_SECRET' : 'JWT_REFRESH_SECRET');
        let payload: Partial<BrobotJwtPayload>;
        try {
            payload = await this.jwt.verifyAsync<BrobotJwtPayload>(token, { secret });
        } catch (error) {
            // Expired / malformed tokens are ordinary user states, not faults.
            const message = error instanceof Error ? error.message : String(error);
            this.logger.debug(`Rejected ${typ} token: ${message}`);
            throw new UnauthorizedException();
        }
        if (payload.typ !== typ || typeof payload.sub !== 'string' || payload.sub.length === 0) {
            throw new UnauthorizedException();
        }
        return { sub: payload.sub, name: payload.name ?? '', typ };
    }
}
