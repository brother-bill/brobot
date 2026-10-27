import { Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ApiClient } from '@twurple/api';
import { EnvService } from '../../config/env.service';
import { TwitchTokenStoreService } from '../auth/twitch-token-store.service';
import type { HotkeyHelix, PredictionSpec } from './hotkeys/hotkey-helix';
import { StreamerOfflineError } from './hotkeys/hotkey-helix';
import type { HorrorRewardApi, ManagedReward } from './redeems/horror-rewards.service';
import type { HorrorRewardSpec, Redemption, RedemptionSettler } from './redeems/redemption';

/**
 * Helix calls made as the streamer (token from `twitch_streamer_auth`):
 * settling channel-point redemptions, pausing brobot's rewards while the
 * bot is down so viewers cannot spend points on a redeem nobody will handle
 * (the old `StreamerApiService` did the same on shutdown and boot), and the
 * streamer client's hotkeys (marker, prediction, commercial).
 */
@Injectable()
export class StreamerApiService
    implements RedemptionSettler, HorrorRewardApi, HotkeyHelix, OnApplicationBootstrap, OnApplicationShutdown
{
    private readonly logger = new Logger(StreamerApiService.name);
    private api: ApiClient | null = null;
    private readonly streamerId: string;
    private readonly readyCallbacks: (() => void)[] = [];

    constructor(
        private readonly env: EnvService,
        private readonly tokens: TwitchTokenStoreService,
    ) {
        this.streamerId = env.get('TWITCH_STREAMER_OAUTH_ID');
    }

    onApplicationBootstrap(): void {
        if (!this.env.get('TWITCH_BOT_ENABLED')) return;
        this.start().catch((error: unknown) => {
            this.logger.error('Could not start the streamer API client', error instanceof Error ? error.stack : error);
        });
    }

    private async start(): Promise<void> {
        const authProvider = await this.tokens.createAuthProvider('streamer');
        if (!authProvider) return;
        this.api = new ApiClient({ authProvider });
        try {
            await this.setRewardsPaused(false);
        } catch (error) {
            // Typically a channel that is not affiliate/partner, or a token without the redemption scopes.
            this.logger.error(`Could not resume channel-point rewards: ${error instanceof Error ? error.message : String(error)}`);
        }
        for (const callback of this.readyCallbacks.splice(0)) callback();
    }

    // ── the horror rewards (HorrorRewardsService decides; these are the Helix calls) ──

    onReady(callback: () => void): void {
        if (this.api) callback();
        else this.readyCallbacks.push(callback);
    }

    async listManaged(): Promise<ManagedReward[] | null> {
        if (!this.api) return null;
        const rewards = await this.api.channelPoints.getCustomRewards(this.streamerId, true);
        return rewards.map(reward => ({ id: reward.id, title: reward.title, isEnabled: reward.isEnabled, isPaused: reward.isPaused }));
    }

    async create(spec: HorrorRewardSpec, isEnabled: boolean): Promise<ManagedReward> {
        if (!this.api) throw new Error('no streamer API client');
        const reward = await this.api.channelPoints.createCustomReward(this.streamerId, {
            title: spec.title,
            cost: spec.cost,
            prompt: spec.prompt,
            isEnabled,
            backgroundColor: '#5B2A86',
        });
        this.logger.log(`Created the horror reward "${spec.title}"`);
        return { id: reward.id, title: reward.title, isEnabled: reward.isEnabled, isPaused: reward.isPaused };
    }

    async update(id: string, change: { isEnabled: boolean; isPaused: boolean }): Promise<void> {
        if (!this.api) return;
        await this.api.channelPoints.updateCustomReward(this.streamerId, id, change);
        // one line per Helix write, so a rehearsal can prove from the logs that none happened
        this.logger.log(`Horror reward ${id} ${change.isEnabled ? 'shown' : 'hidden'}${change.isPaused ? ' (paused)' : ''}`);
    }

    // ── the streamer client's hotkeys (StreamerHotkeysService decides; these are the Helix calls) ──

    async createStreamMarker(): Promise<void> {
        await this.hotkeyApi().streams.createStreamMarker(this.streamerId, '');
    }

    async createPrediction(spec: PredictionSpec): Promise<void> {
        await this.hotkeyApi().predictions.createPrediction(this.streamerId, {
            title: spec.title,
            outcomes: spec.outcomes,
            autoLockAfter: spec.windowSeconds,
        });
    }

    async startCommercial(lengthSeconds: 30): Promise<void> {
        await this.hotkeyApi().channels.startChannelCommercial(this.streamerId, lengthSeconds);
    }

    private hotkeyApi(): ApiClient {
        if (!this.api) throw new StreamerOfflineError();
        return this.api;
    }

    async fulfill(redemption: Redemption): Promise<void> {
        await this.settle(redemption, 'FULFILLED');
    }

    async refund(redemption: Redemption): Promise<void> {
        await this.settle(redemption, 'CANCELED');
    }

    /**
     * Pauses or resumes every reward this Twitch application created on the
     * channel (Helix only lets an app manage its own rewards).
     */
    async setRewardsPaused(isPaused: boolean): Promise<void> {
        const api = this.api;
        if (!api) return;
        const rewards = await api.channelPoints.getCustomRewards(this.streamerId, true);
        for (const reward of rewards) {
            try {
                await api.channelPoints.updateCustomReward(this.streamerId, reward.id, { isPaused });
            } catch (error) {
                this.logger.error(
                    `Could not ${isPaused ? 'pause' : 'resume'} reward "${reward.title}": ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        this.logger.log(`${isPaused ? 'Paused' : 'Resumed'} ${rewards.length} channel-point rewards`);
    }

    async onApplicationShutdown(): Promise<void> {
        try {
            await this.setRewardsPaused(true);
        } catch (error) {
            this.logger.error(`Could not pause rewards on shutdown: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async settle(redemption: Redemption, status: 'FULFILLED' | 'CANCELED'): Promise<void> {
        if (!this.api) {
            this.logger.warn(`No streamer API client; redemption ${redemption.id} stays unfulfilled`);
            return;
        }
        try {
            await this.api.channelPoints.updateRedemptionStatusByIds(
                this.streamerId,
                redemption.rewardId,
                [redemption.id],
                status,
            );
        } catch (error) {
            this.logger.error(
                `Could not mark redemption ${redemption.id} ${status}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}
