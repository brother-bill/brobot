import { testEnvService } from '../../../test/helpers';
import type { TwitchTokenStoreService } from '../auth/twitch-token-store.service';
import { StreamerOfflineError } from './hotkeys/hotkey-helix';
import { StreamerApiService } from './streamer-api.service';

/** The parts of Twurple's ApiClient StreamerApiService touches, as mocks. */
const helix = vi.hoisted(() => ({
    streams: { createStreamMarker: vi.fn() },
    predictions: { createPrediction: vi.fn() },
    channels: { startChannelCommercial: vi.fn() },
    channelPoints: { getCustomRewards: vi.fn(async () => []), updateCustomReward: vi.fn() },
}));

vi.mock('@twurple/api', () => ({
    ApiClient: class {
        constructor() {
            return helix;
        }
    },
}));

/** A service whose streamer API client is up (the bot on, a streamer token stored). */
async function started(): Promise<StreamerApiService> {
    const tokens = { createAuthProvider: async () => ({}) } as unknown as TwitchTokenStoreService;
    const service = new StreamerApiService(testEnvService({ TWITCH_BOT_ENABLED: 'true' }), tokens);
    const ready = new Promise<void>(resolve => service.onReady(resolve));
    service.onApplicationBootstrap();
    await ready;
    return service;
}

describe('StreamerApiService hotkey calls', () => {
    it('creates a stream marker on the streamer channel, with no description', async () => {
        const service = await started();
        await service.createStreamMarker();
        expect(helix.streams.createStreamMarker).toHaveBeenCalledWith('1000', '');
    });

    it('creates the prediction with Helix field names', async () => {
        const service = await started();
        await service.createPrediction({ title: 'Will Trama Win This Game?', outcomes: ['Yes', 'No'], windowSeconds: 90 });
        expect(helix.predictions.createPrediction).toHaveBeenCalledWith('1000', {
            title: 'Will Trama Win This Game?',
            outcomes: ['Yes', 'No'],
            autoLockAfter: 90,
        });
    });

    it('starts a commercial on the streamer channel', async () => {
        const service = await started();
        await service.startCommercial(30);
        expect(helix.channels.startChannelCommercial).toHaveBeenCalledWith('1000', 30);
    });

    it('passes a Helix failure through to the caller', async () => {
        const service = await started();
        const refused = Object.assign(new Error('Encountered HTTP status code 400'), { statusCode: 400 });
        helix.predictions.createPrediction.mockRejectedValueOnce(refused);
        await expect(service.createPrediction({ title: 't', outcomes: ['a', 'b'], windowSeconds: 30 })).rejects.toBe(refused);
    });

    it('refuses every hotkey while there is no streamer API client', async () => {
        const service = new StreamerApiService(testEnvService(), {} as TwitchTokenStoreService);
        service.onApplicationBootstrap(); // TWITCH_BOT_ENABLED=false: never starts
        await expect(service.createStreamMarker()).rejects.toBeInstanceOf(StreamerOfflineError);
        await expect(service.createPrediction({ title: 't', outcomes: ['a', 'b'], windowSeconds: 30 })).rejects.toBeInstanceOf(
            StreamerOfflineError,
        );
        await expect(service.startCommercial(30)).rejects.toBeInstanceOf(StreamerOfflineError);
    });
});
