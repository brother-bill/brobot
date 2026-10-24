import { Inject, Injectable } from '@nestjs/common';
import { BotChatService } from '../chat/bot-chat.service';
import { StreamerGateway } from '../streamer.gateway';
import type { HorrorEffect } from '../streamer-events';
import { HORROR_MODE } from '../horror/horror-chat.service';
import type { HorrorModeSource } from '../horror/horror-mode.service';
import { HorrorRewardsService } from './horror-rewards.service';
import { HORROR_REWARDS, REDEMPTION_SETTLER } from './redemption';
import type { Redemption, RedemptionSettler } from './redemption';

/**
 * Horror rewards: sent to the streamer client, which hands them to the game on her machine. The rewards are only
 * visible while a SLEEP TIGHT run is being played (HorrorRewardsService); a redemption that still arrives with no
 * client connected, or after the run ended, is refunded (nobody would see it); otherwise it is fulfilled.
 */
@Injectable()
export class HorrorRedeemsService {
    constructor(
        private readonly chat: BotChatService,
        private readonly streamer: StreamerGateway,
        @Inject(REDEMPTION_SETTLER) private readonly settler: RedemptionSettler,
        private readonly rewards: HorrorRewardsService,
        @Inject(HORROR_MODE) private readonly gate: HorrorModeSource,
    ) {}

    /** The effect a reward title stands for, or null when it is not a horror reward. */
    static effectOf(rewardTitle: string): HorrorEffect | null {
        return HORROR_REWARDS[rewardTitle.trim().toLowerCase()] ?? null;
    }

    async redeem(redemption: Redemption, effect: HorrorEffect): Promise<void> {
        if (!this.rewards.isLive) {
            await this.settler.refund(redemption);
            // off / rehearsal never post in chat (the event must stay a secret until the show)
            if (this.gate.mode !== 'live') return;
            await this.chat.say(`/me @${redemption.login}, the streamer's horror night is not on right now. You have been refunded`);
            return;
        }
        const reached = this.streamer.broadcast({ type: 'horror', effect, user: redemption.displayName });
        if (reached <= 0) {
            await this.settler.refund(redemption);
            await this.chat.say(`/me @${redemption.login}, the streamer's horror game is not connected right now. You have been refunded`);
            return;
        }
        await this.settler.fulfill(redemption);
    }
}
