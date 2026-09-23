import {
    BadGatewayException,
    Body,
    Controller,
    ForbiddenException,
    Get,
    HttpCode,
    HttpStatus,
    Logger,
    Post,
    Query,
    Req,
    Res,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { EnvService } from '../../config/env.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AuthService, WrongTwitchAccountError } from './auth.service';
import type { CurrentUserStatus } from './auth.service';
import { CurrentUser } from './guards/authenticated-user';
import type { AuthenticatedUser } from './guards/authenticated-user';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { isValidOAuthState, newOAuthState, stateCookieName, stateCookieOptions } from './oauth-state';
import { REFRESH_COOKIE, TokenService } from './token.service';
import type { TokenPair } from './token.service';
import { TwitchApiError, TwitchOAuthClient } from './twitch-oauth.client';
import type { OAuthFlow } from './twitch-oauth.client';

const callbackQuerySchema = z.object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    error: z.string().optional(),
});
type CallbackQuery = z.infer<typeof callbackQuerySchema>;

const refreshBodySchema = z.object({ refreshToken: z.string().min(1).optional() }).optional();
type RefreshBody = z.infer<typeof refreshBodySchema>;

/** Why a callback sent the browser back to the UI without success; read by the admin site. */
export type AuthErrorReason = 'access_denied' | 'invalid_state' | 'wrong_account' | 'twitch_unavailable';

class CallbackFailure extends Error {
    constructor(readonly reason: AuthErrorReason) {
        super(reason);
    }
}

/**
 * `/api/auth/twitch/*`. The start routes (`login`, `streamer`, `bot`) redirect
 * to Twitch; the callbacks redirect back to `UI_URL` — with `?auth_error=` on
 * failure — unless the client asked for JSON (`Accept: application/json`),
 * in which case they answer directly (the viewer callback with the token
 * pair). Cookies are set either way.
 */
@Controller('auth/twitch')
export class AuthController {
    private readonly logger = new Logger(AuthController.name);

    constructor(
        private readonly auth: AuthService,
        private readonly tokens: TokenService,
        private readonly twitch: TwitchOAuthClient,
        private readonly env: EnvService,
    ) {}

    // ── viewer ──────────────────────────────────────────────────────────

    @Get('login')
    login(@Res() res: Response): void {
        this.startFlow('viewer', res);
    }

    @Get('callback')
    async callback(
        @Query(new ZodValidationPipe(callbackQuerySchema)) query: CallbackQuery,
        @Req() req: Request,
        @Res() res: Response,
    ): Promise<void> {
        try {
            const code = this.checkCallback('viewer', query, req, res);
            const { tokens } = await this.auth.completeViewerLogin(code);
            this.tokens.setAuthCookies(res, tokens);
            if (wantsJson(req)) {
                res.status(HttpStatus.OK).json(tokens satisfies TokenPair);
                return;
            }
            res.redirect(this.env.get('UI_URL'));
        } catch (error) {
            this.failCallback('viewer', error, req, res);
        }
    }

    // ── streamer / bot token links ──────────────────────────────────────

    @Get('streamer')
    streamer(@Res() res: Response): void {
        this.startFlow('streamer', res);
    }

    @Get('streamer/callback')
    async streamerCallback(
        @Query(new ZodValidationPipe(callbackQuerySchema)) query: CallbackQuery,
        @Req() req: Request,
        @Res() res: Response,
    ): Promise<void> {
        await this.linkCallback('streamer', query, req, res);
    }

    @Get('bot')
    bot(@Res() res: Response): void {
        this.startFlow('bot', res);
    }

    @Get('bot/callback')
    async botCallback(
        @Query(new ZodValidationPipe(callbackQuerySchema)) query: CallbackQuery,
        @Req() req: Request,
        @Res() res: Response,
    ): Promise<void> {
        await this.linkCallback('bot', query, req, res);
    }

    // ── session ─────────────────────────────────────────────────────────

    @Get('status')
    @UseGuards(JwtAuthGuard)
    status(@CurrentUser() user: AuthenticatedUser): Promise<CurrentUserStatus> {
        return this.auth.status(user.oauthId);
    }

    /**
     * Same contract as api-time's `POST /api/auth/refresh`: a refresh token
     * in the body (bearer mode) gets the new pair back in the body; one from
     * the cookie (web) gets new cookies and an empty body, so a page script
     * never sees a token it could exfiltrate.
     */
    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    refresh(
        @Body(new ZodValidationPipe(refreshBodySchema)) body: RefreshBody,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ): Promise<TokenPair | undefined> {
        return refreshSession(this.auth, this.tokens, body, req, res);
    }

    /** Stateless: clears the cookies. An access token already issued lives out its 15 minutes. */
    @Post('logout')
    @HttpCode(HttpStatus.NO_CONTENT)
    logout(@Res({ passthrough: true }) res: Response): void {
        this.tokens.clearAuthCookies(res);
    }

    // ── helpers ─────────────────────────────────────────────────────────

    private startFlow(flow: OAuthFlow, res: Response): void {
        const state = newOAuthState();
        res.cookie(stateCookieName(flow), state, stateCookieOptions());
        res.redirect(this.twitch.authorizeUrl(flow, state));
    }

    /** Validates the callback and consumes the state cookie. Returns the code. */
    private checkCallback(flow: OAuthFlow, query: CallbackQuery, req: Request, res: Response): string {
        const cookies = req.cookies as Record<string, string | undefined> | undefined;
        const expected = cookies?.[stateCookieName(flow)];
        res.clearCookie(stateCookieName(flow), { ...stateCookieOptions(), maxAge: undefined });

        if (query.error) throw new CallbackFailure('access_denied');
        if (!isValidOAuthState(expected, query.state)) throw new CallbackFailure('invalid_state');
        if (!query.code) throw new CallbackFailure('invalid_state');
        return query.code;
    }

    private async linkCallback(kind: 'streamer' | 'bot', query: CallbackQuery, req: Request, res: Response) {
        try {
            const code = this.checkCallback(kind, query, req, res);
            await this.auth.linkAccount(kind, code);
            if (wantsJson(req)) {
                res.status(HttpStatus.OK).json({ linked: kind });
                return;
            }
            res.redirect(withParam(this.env.get('UI_URL'), 'linked', kind));
        } catch (error) {
            this.failCallback(kind, error, req, res);
        }
    }

    private failCallback(flow: OAuthFlow, error: unknown, req: Request, res: Response): void {
        const reason = toReason(error);
        if (reason === 'twitch_unavailable' && !(error instanceof TwitchApiError)) {
            // Not a Twitch refusal: a bug or a database failure. Log it loudly.
            this.logger.error(`${flow} callback failed`, error instanceof Error ? error.stack : error);
        }
        if (wantsJson(req)) {
            const exception =
                reason === 'wrong_account'
                    ? new ForbiddenException(reason)
                    : reason === 'twitch_unavailable'
                      ? new BadGatewayException(reason)
                      : new UnauthorizedException(reason);
            res.status(exception.getStatus()).json(exception.getResponse());
            return;
        }
        res.redirect(withParam(this.env.get('UI_URL'), 'auth_error', reason));
    }
}

/**
 * `POST /api/auth/refresh` — an alias of `/api/auth/twitch/refresh`.
 *
 * libs/ngx-auth's interceptor retries any 401 through a refresh, and skips
 * that retry only for URLs containing `/auth/refresh`. `/auth/twitch/refresh`
 * does not match, so a refresh that itself 401s would be retried forever.
 * Serving the path the interceptor already recognises keeps it unchanged.
 */
@Controller('auth')
export class AuthRefreshAliasController {
    constructor(
        private readonly auth: AuthService,
        private readonly tokens: TokenService,
    ) {}

    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    refresh(
        @Body(new ZodValidationPipe(refreshBodySchema)) body: RefreshBody,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ): Promise<TokenPair | undefined> {
        return refreshSession(this.auth, this.tokens, body, req, res);
    }
}

async function refreshSession(
    auth: AuthService,
    tokens: TokenService,
    body: RefreshBody,
    req: Request,
    res: Response,
): Promise<TokenPair | undefined> {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const fromBody = body?.refreshToken;
    const refreshToken = fromBody ?? cookies?.[REFRESH_COOKIE];
    if (!refreshToken) throw new UnauthorizedException('No refresh token provided');

    let pair: TokenPair;
    try {
        pair = await auth.refresh(refreshToken);
    } catch {
        tokens.clearAuthCookies(res);
        throw new UnauthorizedException();
    }
    if (fromBody) return pair;
    tokens.setAuthCookies(res, pair);
    return undefined;
}

function toReason(error: unknown): AuthErrorReason {
    if (error instanceof CallbackFailure) return error.reason;
    if (error instanceof WrongTwitchAccountError) return 'wrong_account';
    // A code Twitch refuses to exchange (reused, expired) is a 400 from the
    // token endpoint: the browser should simply start again.
    if (error instanceof TwitchApiError && error.status >= 400 && error.status < 500) return 'invalid_state';
    return 'twitch_unavailable';
}

function wantsJson(req: Request): boolean {
    return req.accepts(['html', 'json']) === 'json';
}

function withParam(base: string, key: string, value: string): string {
    const url = new URL(base);
    url.searchParams.set(key, value);
    return url.toString();
}
