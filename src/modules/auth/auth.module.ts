import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController, AuthRefreshAliasController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { TokenService } from './token.service';
import { TwitchOAuthClient } from './twitch-oauth.client';
import { TwitchTokenStoreService } from './twitch-token-store.service';

/**
 * Exports what the other modules need: the guards (every admin route), the
 * token store (B2's chat + EventSub credentials) and the Twitch client
 * (public user lookups).
 */
@Module({
    // Secrets are passed per call (access vs refresh), as api-time does.
    imports: [JwtModule.register({})],
    controllers: [AuthController, AuthRefreshAliasController],
    providers: [AuthService, TokenService, TwitchOAuthClient, TwitchTokenStoreService, JwtAuthGuard, RolesGuard],
    exports: [TokenService, TwitchOAuthClient, TwitchTokenStoreService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
