import { Inject, Injectable, Logger } from '@nestjs/common';
import { profanity } from '@2toad/profanity';
import { BotChatService } from '../chat/bot-chat.service';
import { OverlayGateway } from '../overlay.gateway';
import { REDEMPTION_SETTLER } from './redemption';
import type { Redemption, RedemptionSettler } from './redemption';

/** The longest alert the overlay is sent, after censoring. */
export const DEBS_ALERT_MAX_CHARS = 500;
/** At most this many alerts per rolling window, across all viewers. */
export const DEBS_ALERT_LIMIT = 5;
export const DEBS_ALERT_WINDOW_MS = 60_000;

/**
 * `DEBS Alert`: the viewer's message appears on stream like a news alert. The
 * text is censored before it leaves brobot. The 2022 overlay refunded past five
 * queued alerts by writing back on its socket; that socket is receive-only now,
 * so the limit is kept here instead. A sent alert is FULFILLED.
 */
@Injectable()
export class DebsAlertService {
    private readonly logger = new Logger(DebsAlertService.name);
    /** When each alert of the current window was sent. */
    private sentAt: number[] = [];

    constructor(
        private readonly chat: BotChatService,
        private readonly overlay: OverlayGateway,
        @Inject(REDEMPTION_SETTLER) private readonly settler: RedemptionSettler,
    ) {}

    /** The clock (a test replaces it). */
    now(): number {
        return Date.now();
    }

    /** Censored, trimmed, one line, at most {@link DEBS_ALERT_MAX_CHARS} characters. */
    static messageOf(input: string): string {
        const line = profanity.censor(input).replace(/\s*[\r\n]+\s*/g, ' ').trim();
        return Array.from(line).slice(0, DEBS_ALERT_MAX_CHARS).join('').trim();
    }

    async redeem(redemption: Redemption): Promise<void> {
        const { login } = redemption;
        if (this.overlay.clientCount <= 0) return this.notConnected(redemption);

        const now = this.now();
        this.sentAt = this.sentAt.filter(at => now - at < DEBS_ALERT_WINDOW_MS);
        if (this.sentAt.length >= DEBS_ALERT_LIMIT) {
            return this.refund(redemption, `/me @${login}, too many alerts queued, try again in a minute. You have been refunded`);
        }

        const message = DebsAlertService.messageOf(redemption.input);
        const reached = this.overlay.broadcast({ type: 'debs_alert', login, displayName: redemption.displayName, message });
        if (reached <= 0) return this.notConnected(redemption);
        this.sentAt.push(now);
        this.logger.log(`DEBS Alert from ${login} (${message.length} chars) sent to ${reached} overlays`);
        await this.settler.fulfill(redemption);
    }

    private async notConnected(redemption: Redemption): Promise<void> {
        this.logger.warn('Streamer not connected to the overlay while sending a DEBS Alert');
        await this.refund(redemption, `/me @${redemption.login}, streamer not connected to browser source. You will be refunded`);
    }

    private async refund(redemption: Redemption, message: string): Promise<void> {
        await this.chat.say(message);
        await this.settler.refund(redemption);
    }
}
