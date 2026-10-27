import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { EnvService } from '../../../config/env.service';
import { StreamerGateway } from '../streamer.gateway';
import type { HotkeyRequest } from '../streamer.gateway';
import { HOTKEY_REPEAT_MS } from '../streamer-events';
import type { StreamerHotkey } from '../streamer-events';
import { HOTKEY_HELIX, hotkeyErrorText } from './hotkey-helix';
import type { HotkeyHelix, PredictionSpec } from './hotkey-helix';

/** `play_ad` always asks for this long a commercial, as the old client did. */
export const AD_LENGTH_SECONDS = 30;

/**
 * The streamer client's hotkeys, back from the 2022 app: `create_marker`, `create_prediction` and `play_ad` arrive on
 * `/api/ashketchum`, each becomes one Helix call as the streamer, and the client that pressed it is answered with
 * `<hotkey>_complete` (with `error` when Twitch, or brobot, said no).
 *
 * Each hotkey runs at most once per {@link HOTKEY_REPEAT_MS}, counted from the press that ran, whatever its outcome: a
 * double press (a bouncing key, a second client) is answered with an error and makes no second call.
 */
@Injectable()
export class StreamerHotkeysService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(StreamerHotkeysService.name);
    private readonly lastRun = new Map<StreamerHotkey, number>();
    private readonly prediction: PredictionSpec;
    private subscription: Subscription | null = null;

    constructor(
        env: EnvService,
        private readonly streamer: StreamerGateway,
        @Inject(HOTKEY_HELIX) private readonly helix: HotkeyHelix,
    ) {
        this.prediction = {
            title: env.get('TWITCH_PREDICTION_TITLE'),
            outcomes: env.get('TWITCH_PREDICTION_OUTCOMES'),
            windowSeconds: env.get('TWITCH_PREDICTION_WINDOW_SECONDS'),
        };
    }

    /** The clock (a test replaces it). */
    now(): number {
        return Date.now();
    }

    onApplicationBootstrap(): void {
        this.subscription = this.streamer.hotkeys$.subscribe(request => void this.handle(request));
    }

    async handle({ hotkey, reply }: HotkeyRequest): Promise<void> {
        const now = this.now();
        const last = this.lastRun.get(hotkey);
        if (last !== undefined && now - last < HOTKEY_REPEAT_MS) {
            this.logger.log(`Hotkey ${hotkey} ignored: pressed again ${now - last} ms after the last one`);
            reply(`ignored: ${hotkey} already ran less than ${HOTKEY_REPEAT_MS / 1000} s ago`);
            return;
        }
        this.lastRun.set(hotkey, now);
        this.logger.log(`Hotkey ${hotkey} pressed`);
        try {
            const done = await this.run(hotkey);
            this.logger.log(`Hotkey ${hotkey}: ${done}`);
        } catch (error) {
            const text = hotkeyErrorText(hotkey, error);
            this.logger.warn(`Hotkey ${hotkey} failed: ${text}`);
            reply(text);
            return;
        }
        reply();
    }

    /** Makes the hotkey's Helix call; resolves with what happened, for the log. */
    private async run(hotkey: StreamerHotkey): Promise<string> {
        switch (hotkey) {
            case 'create_marker':
                await this.helix.createStreamMarker();
                return 'stream marker created';
            case 'create_prediction': {
                const { title, outcomes, windowSeconds } = this.prediction;
                await this.helix.createPrediction(this.prediction);
                return `prediction "${title}" started (${outcomes.join(' / ')}, locks after ${windowSeconds} s)`;
            }
            case 'play_ad':
                await this.helix.startCommercial(AD_LENGTH_SECONDS);
                return `${AD_LENGTH_SECONDS} s commercial started`;
        }
    }

    onModuleDestroy(): void {
        this.subscription?.unsubscribe();
    }
}
