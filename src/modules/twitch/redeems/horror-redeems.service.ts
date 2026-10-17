import { Inject, Injectable } from '@nestjs/common';
import { BotChatService } from '../chat/bot-chat.service';
import { StreamerGateway } from '../streamer.gateway';
import type { HorrorEffect } from '../streamer-events';
import { HORROR_REWARDS, REDEMPTION_SETTLER } from './redemption';
import type { Redemption, RedemptionSettler } from './redemption';

/**
 * Horror rewards: sent to the streamer client, which hands them to the game on her machine. With no client connected
 * the redemption is refunded (nobody would see it); otherwise it is fulfilled. Whether the game itself is running is
 * the client's business (it drops the line if not); the reward copy should say "while the horror game is on".
 */
@Injectable()
export class HorrorRedeemsService {
    constructor(
        private readonly chat: BotChatService,
        private readonly streamer: StreamerGateway,
        @Inject(REDEMPTION_SETTLER) private readonly settler: RedemptionSettler,
    ) {}

    /** The effect a reward title stands for, or null when it is not a horror reward. */
    static effectOf(rewardTitle: string): HorrorEffect | null {
        return HORROR_REWARDS[rewardTitle.trim().toLowerCase()] ?? null;
    }

    async redeem(redemption: Redemption, effect: HorrorEffect): Promise<void> {
        const reached = this.streamer.broadcast({ type: 'horror', effect, user: redemption.displayName });
        if (reached <= 0) {
            await this.settler.refund(redemption);
            await this.chat.say(`/me @${redemption.login}, the streamer's horror game is not connected right now. You have been refunded`);
            return;
        }
        await this.settler.fulfill(redemption);
    }
}
