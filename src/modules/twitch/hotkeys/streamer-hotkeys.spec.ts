import { Subject } from 'rxjs';
import { testEnvService } from '../../../../test/helpers';
import type { HotkeyRequest, StreamerGateway } from '../streamer.gateway';
import { HOTKEY_REPEAT_MS } from '../streamer-events';
import type { StreamerHotkey } from '../streamer-events';
import { hotkeyErrorText, StreamerOfflineError } from './hotkey-helix';
import type { HotkeyHelix } from './hotkey-helix';
import { AD_LENGTH_SECONDS, StreamerHotkeysService } from './streamer-hotkeys.service';

/** Twurple's HttpStatusCodeError as far as brobot reads it: the status and Helix's JSON body. */
function helixError(statusCode: number, message: string): Error & { statusCode: number; body: string } {
    const body = JSON.stringify({ error: 'Error', status: statusCode, message }, null, 2);
    return Object.assign(new Error(`Encountered HTTP status code ${statusCode}: Error\n\nURL: https://api.twitch.tv/helix/x\nMethod: POST\nBody:\n${body}`), {
        statusCode,
        body,
    });
}

function setup(overrides: Record<string, string> = {}) {
    const hotkeys$ = new Subject<HotkeyRequest>();
    const helix = {
        createStreamMarker: vi.fn<HotkeyHelix['createStreamMarker']>().mockResolvedValue(undefined),
        createPrediction: vi.fn<HotkeyHelix['createPrediction']>().mockResolvedValue(undefined),
        startCommercial: vi.fn<HotkeyHelix['startCommercial']>().mockResolvedValue(undefined),
    };
    const service = new StreamerHotkeysService(
        testEnvService(overrides),
        { hotkeys$ } as unknown as StreamerGateway,
        helix,
    );
    let clock = 1_000_000;
    service.now = () => clock;
    service.onApplicationBootstrap();

    /** Presses `hotkey` on the client; resolves with the `error` of its `_complete` answer (undefined = it worked). */
    async function press(hotkey: StreamerHotkey): Promise<string | undefined> {
        const answered = new Promise<string | undefined>(resolve => {
            hotkeys$.next({ hotkey, reply: resolve });
        });
        return answered;
    }
    return {
        helix,
        service,
        press,
        advance: (ms: number) => {
            clock += ms;
        },
    };
}

describe('the streamer client hotkeys', () => {
    it('create_marker marks the stream and answers without an error', async () => {
        const { helix, press } = setup();
        await expect(press('create_marker')).resolves.toBeUndefined();
        expect(helix.createStreamMarker).toHaveBeenCalledTimes(1);
        expect(helix.createPrediction).not.toHaveBeenCalled();
        expect(helix.startCommercial).not.toHaveBeenCalled();
    });

    it('create_prediction starts the default prediction: Yes / No, locked after 90 s', async () => {
        const { helix, press } = setup();
        await expect(press('create_prediction')).resolves.toBeUndefined();
        expect(helix.createPrediction).toHaveBeenCalledWith({
            title: 'Will Trama Win This Game?',
            outcomes: ['Yes', 'No'],
            windowSeconds: 90,
        });
    });

    it('create_prediction takes its title, outcomes and window from the env', async () => {
        const { helix, press } = setup({
            TWITCH_PREDICTION_TITLE: 'Top 4?',
            TWITCH_PREDICTION_OUTCOMES: 'Top 4,Bottom 4',
            TWITCH_PREDICTION_WINDOW_SECONDS: '300',
        });
        await press('create_prediction');
        expect(helix.createPrediction).toHaveBeenCalledWith({ title: 'Top 4?', outcomes: ['Top 4', 'Bottom 4'], windowSeconds: 300 });
    });

    it('play_ad starts a 30 s commercial', async () => {
        const { helix, press } = setup();
        await expect(press('play_ad')).resolves.toBeUndefined();
        expect(AD_LENGTH_SECONDS).toBe(30);
        expect(helix.startCommercial).toHaveBeenCalledWith(30);
    });

    it('runs each hotkey once per 5 s, and answers the repeat with an error', async () => {
        const { helix, press, advance } = setup();
        await press('create_marker');
        advance(HOTKEY_REPEAT_MS - 1);
        await expect(press('create_marker')).resolves.toBe('ignored: create_marker already ran less than 5 s ago');
        expect(helix.createStreamMarker).toHaveBeenCalledTimes(1);

        // per hotkey: the others are not held by it
        await expect(press('play_ad')).resolves.toBeUndefined();
        expect(helix.startCommercial).toHaveBeenCalledTimes(1);

        // the window counts from the press that ran, not from the ignored one
        advance(1);
        await expect(press('create_marker')).resolves.toBeUndefined();
        expect(helix.createStreamMarker).toHaveBeenCalledTimes(2);
    });

    it('holds a failed hotkey for the window too, so a bouncing key does not ask Twitch twice', async () => {
        const { helix, press, advance } = setup();
        helix.createStreamMarker.mockRejectedValueOnce(helixError(404, 'user is not live'));
        await expect(press('create_marker')).resolves.toBe('not live');
        await expect(press('create_marker')).resolves.toMatch(/^ignored:/);
        advance(HOTKEY_REPEAT_MS);
        await expect(press('create_marker')).resolves.toBeUndefined();
        expect(helix.createStreamMarker).toHaveBeenCalledTimes(2);
    });

    it('a press while the first is still with Twitch is ignored', async () => {
        const { helix, press } = setup();
        let finish: () => void = () => undefined;
        helix.createPrediction.mockImplementationOnce(() => new Promise<void>(resolve => (finish = resolve)));
        const first = press('create_prediction');
        await expect(press('create_prediction')).resolves.toMatch(/^ignored:/);
        finish();
        await expect(first).resolves.toBeUndefined();
        expect(helix.createPrediction).toHaveBeenCalledTimes(1);
    });

    describe('error replies', () => {
        it.each<[StreamerHotkey, unknown, string]>([
            ['create_marker', new StreamerOfflineError(), 'the streamer account is not linked, or the bot is switched off'],
            ['create_marker', helixError(404, 'The user in the user_id query parameter is not streaming live.'), 'not live'],
            ['create_marker', helixError(404, ''), 'not live'],
            ['create_prediction', helixError(400, 'prediction event already active'), 'a prediction is already running'],
            ['play_ad', helixError(400, 'To start a commercial, the broadcaster must be streaming live.'), 'not live'],
            ['play_ad', helixError(429, 'The broadcaster may not run another commercial until the cooldown period expires.'), "a commercial ran too recently (Twitch's cooldown)"],
            ['play_ad', helixError(401, 'Missing scope: channel:edit:commercial'), 'missing scope channel:edit:commercial: link the streamer account again'],
            [
                'play_ad',
                new Error('This token does not have any of the requested scopes (channel:edit:commercial) and can not be upgraded.\nIf you need new scopes, please reauthorize.'),
                'missing scope channel:edit:commercial: link the streamer account again',
            ],
            ['create_marker', helixError(401, 'Invalid OAuth token'), 'Twitch refused the streamer token: link the streamer account again'],
            ['create_prediction', helixError(403, 'The broadcaster is not a partner or affiliate.'), 'Twitch said 403: The broadcaster is not a partner or affiliate.'],
            ['create_marker', helixError(500, ''), 'Twitch answered HTTP 500'],
            ['create_marker', helixError(503, 'x'.repeat(300)), `Twitch said 503: ${'x'.repeat(142)}…`],
            ['play_ad', new Error('getaddrinfo ENOTFOUND api.twitch.tv'), 'getaddrinfo ENOTFOUND api.twitch.tv'],
        ])('%s, %s → "%s"', (hotkey, error, text) => {
            expect(hotkeyErrorText(hotkey, error)).toBe(text);
        });

        it('answers the client with the error when Helix refuses', async () => {
            const { helix, press } = setup();
            helix.createPrediction.mockRejectedValueOnce(helixError(400, 'prediction event already active'));
            await expect(press('create_prediction')).resolves.toBe('a prediction is already running');
            helix.startCommercial.mockRejectedValueOnce(new StreamerOfflineError());
            await expect(press('play_ad')).resolves.toBe('the streamer account is not linked, or the bot is switched off');
        });

        it("reads Helix's message, not Twurple's wrapping around it", () => {
            const error = helixError(400, 'Bad title');
            error.message = `Encountered HTTP status code 400: Bad Request (the stream is offline)\n${error.message}`;
            expect(hotkeyErrorText('create_prediction', error)).toBe('Twitch said 400: Bad title');
        });
    });

    it('stops listening when the module is destroyed', async () => {
        const { helix, service, press } = setup();
        service.onModuleDestroy();
        let answered = false;
        void press('create_marker').then(() => (answered = true));
        await Promise.resolve();
        expect(answered).toBe(false);
        expect(helix.createStreamMarker).not.toHaveBeenCalled();
    });
});
