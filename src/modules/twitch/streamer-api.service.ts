import { Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ApiClient } from '@twurple/api';
import { EnvService } from '../../config/env.service';
import { TwitchTokenStoreService } from '../auth/twitch-token-store.service';
import type { Redemption, RedemptionSettler } from './redeems/redemption';

/**
 * Helix calls made as the streamer (token from `twitch_streamer_auth`):
 * settling channel-point redemptions, and pausing brobot's rewards while the
 * bot is down so viewers cannot spend points on a redeem nobody will handle
 * (the old `StreamerApiService` did the same on shutdown and boot).
 */
@Injectable()
export class StreamerApiService implements RedemptionSettler, OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger(StreamerApiService.name);
    private api: ApiClient | null = null;
    private readonly streamerId: string;

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
        await this.setRewardsPaused(false);
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
