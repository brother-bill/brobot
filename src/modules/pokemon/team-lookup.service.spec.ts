import type { TwitchOAuthClient } from '../auth/twitch-oauth.client';
import type { PokemonReadService, TeamResponse } from './pokemon-read.service';
import { TEAM_CACHE_TTL_MS, TeamLookupService } from './team-lookup.service';

const TEAM: TeamResponse = { displayName: 'Viewer', pokemonTeam: { pokemon: [] } };

describe('TeamLookupService', () => {
    let getUserByLogin: ReturnType<typeof vi.fn>;
    let teamByOauthId: ReturnType<typeof vi.fn>;
    let service: TeamLookupService;

    beforeEach(() => {
        vi.useFakeTimers();
        getUserByLogin = vi.fn(async (login: string) => (login === 'viewer' ? { id: '42', login } : null));
        teamByOauthId = vi.fn(async () => TEAM);
        service = new TeamLookupService(
            { getUserByLogin } as unknown as TwitchOAuthClient,
            { teamByOauthId } as unknown as PokemonReadService,
        );
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('calls Twitch once per login per minute, case-insensitively', async () => {
        await expect(service.findByLogin('Viewer')).resolves.toEqual(TEAM);
        await expect(service.findByLogin('viewer')).resolves.toEqual(TEAM);
        expect(getUserByLogin).toHaveBeenCalledTimes(1);
        expect(getUserByLogin).toHaveBeenCalledWith('viewer');

        vi.advanceTimersByTime(TEAM_CACHE_TTL_MS + 1);
        await service.findByLogin('viewer');
        expect(getUserByLogin).toHaveBeenCalledTimes(2);
    });

    it('caches "no such user" too, so a missing login cannot be used to hammer Twitch', async () => {
        await expect(service.findByLogin('nobody')).resolves.toBeNull();
        await expect(service.findByLogin('nobody')).resolves.toBeNull();
        expect(getUserByLogin).toHaveBeenCalledTimes(1);
        expect(teamByOauthId).not.toHaveBeenCalled();
    });

    it('shares one lookup between concurrent requests for the same login', async () => {
        await Promise.all([service.findByLogin('viewer'), service.findByLogin('viewer'), service.findByLogin('VIEWER')]);
        expect(getUserByLogin).toHaveBeenCalledTimes(1);
    });

    it('does not cache a failure', async () => {
        getUserByLogin.mockRejectedValueOnce(new Error('twitch down'));
        await expect(service.findByLogin('viewer')).rejects.toThrow('twitch down');
        await expect(service.findByLogin('viewer')).resolves.toEqual(TEAM);
        expect(getUserByLogin).toHaveBeenCalledTimes(2);
    });
});
