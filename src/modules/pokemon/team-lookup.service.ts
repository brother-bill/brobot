import { Injectable } from '@nestjs/common';
import { TwitchOAuthClient } from '../auth/twitch-oauth.client';
import { PokemonReadService } from './pokemon-read.service';
import type { TeamResponse } from './pokemon-read.service';

export const TEAM_CACHE_TTL_MS = 60_000;
/** Bounds memory against a scan of random logins; oldest entries go first. */
export const TEAM_CACHE_MAX_ENTRIES = 1_000;

interface CacheEntry {
    expiresAt: number;
    value: TeamResponse | null;
}

/**
 * `GET /api/pokemon/teams?login=` resolves a Twitch login to a user id, which
 * only Twitch can do. The old endpoint called Twitch on every request with no
 * throttle (the author's TODO). Answers — including "no such user" — are now
 * cached per login for 60 s, concurrent requests for one login share a single
 * lookup, and the route is rate-limited per client on top.
 */
@Injectable()
export class TeamLookupService {
    private readonly cache = new Map<string, CacheEntry>();
    private readonly inFlight = new Map<string, Promise<TeamResponse | null>>();

    constructor(
        private readonly twitch: TwitchOAuthClient,
        private readonly pokemon: PokemonReadService,
    ) {}

    async findByLogin(rawLogin: string): Promise<TeamResponse | null> {
        const login = rawLogin.toLowerCase();
        const cached = this.cache.get(login);
        if (cached && cached.expiresAt > Date.now()) return cached.value;

        let pending = this.inFlight.get(login);
        if (!pending) {
            pending = this.lookup(login).finally(() => this.inFlight.delete(login));
            this.inFlight.set(login, pending);
        }
        return pending;
    }

    private async lookup(login: string): Promise<TeamResponse | null> {
        const user = await this.twitch.getUserByLogin(login);
        const value = user ? await this.pokemon.teamByOauthId(user.id) : null;
        this.remember(login, value);
        return value;
    }

    private remember(login: string, value: TeamResponse | null): void {
        this.cache.delete(login);
        if (this.cache.size >= TEAM_CACHE_MAX_ENTRIES) {
            const oldest = this.cache.keys().next();
            if (!oldest.done) this.cache.delete(oldest.value);
        }
        this.cache.set(login, { expiresAt: Date.now() + TEAM_CACHE_TTL_MS, value });
    }
}
