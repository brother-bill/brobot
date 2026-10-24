import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { StreamerGateway } from '../streamer.gateway';
import { HORROR_REWARD_SPECS } from './redemption';
import type { HorrorRewardSpec } from './redemption';

/** A channel-point reward this Twitch application manages, as far as the horror rewards care. */
export interface ManagedReward {
    id: string;
    title: string;
    isEnabled: boolean;
    isPaused: boolean;
}

/** The Helix calls the horror rewards need (the streamer's API client in production). */
export interface HorrorRewardApi {
    /** Rewards this application created on the channel; null while the API client is not ready. */
    listManaged(): Promise<ManagedReward[] | null>;
    create(spec: HorrorRewardSpec, isEnabled: boolean): Promise<ManagedReward>;
    update(id: string, change: { isEnabled: boolean; isPaused: boolean }): Promise<void>;
    /** Fires once the API client is ready (the first sync hides the rewards after a restart). */
    onReady(callback: () => void): void;
}

export const HORROR_REWARD_API = Symbol('HORROR_REWARD_API');

/** A live run with no word from the game for this long is treated as over (a crashed game, a stuck client). */
export const HORROR_RUN_STALE_MS = 90_000;

/**
 * Shows the SLEEP TIGHT channel-point rewards only while they can do something: the streamer's game is connected
 * (through the streamer client) AND a run is being played. Viewers never see them otherwise, so nothing is spoiled
 * before the game is ready.
 *
 * - The game tells the client `{"type":"run","state":"start"|"end","dream":...}`; the client sends `horror_run`.
 * - Live: brobot creates any missing horror reward, enables them (`is_enabled`, unpaused); a reward tied to one dream
 *   (the door rewards: Night Shift) is enabled only during that dream.
 * - Hidden (`is_enabled: false`): when the run ends, the last streamer client disconnects, the game goes quiet for
 *   {@link HORROR_RUN_STALE_MS}, brobot starts (whatever state it died in) or shuts down.
 *
 * Syncs run one at a time; each one reads the rewards and only writes the ones that differ.
 */
@Injectable()
export class HorrorRewardsService implements OnApplicationBootstrap, OnApplicationShutdown, OnModuleDestroy {
    private readonly logger = new Logger(HorrorRewardsService.name);
    private live = false;
    private dream = '';
    private lastWord = 0;
    private chain: Promise<void> = Promise.resolve();
    private watchdog: NodeJS.Timeout | null = null;
    private readonly subscriptions: Subscription[] = [];

    constructor(
        private readonly streamer: StreamerGateway,
        @Inject(HORROR_REWARD_API) private readonly api: HorrorRewardApi,
    ) {}

    /** The clock (a test replaces it). */
    now(): number {
        return Date.now();
    }

    onApplicationBootstrap(): void {
        this.subscriptions.push(
            this.streamer.clientEvents$.subscribe(event => {
                if (event.type === 'horror_run') void this.setRun(event.live, event.dream ?? '');
            }),
            this.streamer.disconnects$.subscribe(() => {
                if (this.streamer.clientCount <= 0) void this.setRun(false, '');
            }),
        );
        // default hidden: whatever the rewards were when brobot last stopped
        this.api.onReady(() => void this.sync());
        this.watchdog = setInterval(() => void this.checkStale(), 15_000);
        this.watchdog.unref();
    }

    /** True while a run is being played (the horror redemptions are refunded otherwise). */
    get isLive(): boolean {
        return this.live;
    }

    /** The game's word on the run (through the streamer client). */
    setRun(live: boolean, dream: string): Promise<void> {
        this.lastWord = this.now();
        const changed = live !== this.live || (live && dream !== this.dream);
        this.live = live;
        this.dream = live ? dream : '';
        if (!changed) return this.chain;
        this.logger.log(live ? `SLEEP TIGHT run on${dream ? ` (${dream})` : ''}: showing the horror rewards` : 'SLEEP TIGHT run over: hiding the horror rewards');
        return this.sync();
    }

    checkStale(): Promise<void> {
        if (this.live && this.now() - this.lastWord > HORROR_RUN_STALE_MS) {
            this.logger.warn('No word from the horror game for a while: hiding the horror rewards');
            return this.setRun(false, '');
        }
        return this.chain;
    }

    /** Brings the channel's horror rewards in line with the run's state (queued behind any sync in flight). */
    sync(): Promise<void> {
        this.chain = this.chain.then(() => this.syncNow()).catch((error: unknown) => {
            this.logger.error(`Could not update the horror rewards: ${error instanceof Error ? error.message : String(error)}`);
        });
        return this.chain;
    }

    private async syncNow(): Promise<void> {
        const rewards = await this.api.listManaged();
        if (!rewards) return;
        const byTitle = new Map(rewards.map(reward => [reward.title.trim().toLowerCase(), reward]));
        for (const spec of HORROR_REWARD_SPECS) {
            const want = this.live && (!spec.dream || spec.dream.toLowerCase() === this.dream.toLowerCase());
            const reward = byTitle.get(spec.title.toLowerCase());
            if (!reward) {
                // created only when it is about to be shown (a reward this app did not make cannot be managed: the
                // streamer deletes any hand-made one with the same title first)
                if (want) await this.api.create(spec, true);
                continue;
            }
            if (reward.isEnabled === want && !reward.isPaused) continue;
            await this.api.update(reward.id, { isEnabled: want, isPaused: false });
        }
    }

    async onApplicationShutdown(): Promise<void> {
        this.live = false;
        this.dream = '';
        await this.sync();
    }

    onModuleDestroy(): void {
        if (this.watchdog) clearInterval(this.watchdog);
        for (const subscription of this.subscriptions) subscription.unsubscribe();
    }
}
