import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { Observable, Subscription } from 'rxjs';
import type { ChatLine, ChatSay } from '../chat/chat-types';
import type { StreamerClientEvent, StreamerServerEvent } from '../streamer-events';
import type { HorrorModeSource } from './horror-mode.service';
import { sleepTightRulesLine } from './sleep-tight-rules';

/** What this service needs from the streamer socket ({@link StreamerGateway} in production). */
export interface HorrorStreamer {
    readonly clientEvents$: Observable<StreamerClientEvent>;
    readonly clientCount: number;
    broadcast(event: StreamerServerEvent): number;
}

/** What this service needs from chat ({@link BotChatService} in production). */
export interface HorrorChat extends ChatSay {
    readonly lines$: Observable<ChatLine>;
}

export const HORROR_STREAMER = Symbol('HORROR_STREAMER');
export const HORROR_CHAT = Symbol('HORROR_CHAT');
export const HORROR_MODE = Symbol('HORROR_MODE');

/** The same dream's rules are posted at most once in this long (a retry shows its preview again). */
export const RULES_SAME_DREAM_MS = 10 * 60_000;
/** And no two rules lines closer than this (dreams skipped in a row). */
export const RULES_MIN_GAP_MS = 45_000;

/**
 * SLEEP TIGHT's chat side, behind the mode gate:
 *
 * - `rehearsal` and `live`: every chat line (not the bot's own) goes to the connected streamer clients as
 *   `horror_chat`, and on to the game, so a test run plays against the real channel's chat.
 * - `live` only: when the game shows a dream's preview (`horror_preview`), the dream's rules line is posted to chat,
 *   rate-limited ({@link RULES_SAME_DREAM_MS}, {@link RULES_MIN_GAP_MS}).
 * - `off`: nothing. This service never posts outside `live`.
 */
@Injectable()
export class HorrorChatService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(HorrorChatService.name);
    private readonly subscriptions: Subscription[] = [];
    private readonly postedAt = new Map<string, number>();
    private lastPost = -Infinity;
    private forwarded = 0;

    constructor(
        @Inject(HORROR_STREAMER) private readonly streamer: HorrorStreamer,
        @Inject(HORROR_CHAT) private readonly chat: HorrorChat,
        @Inject(HORROR_MODE) private readonly gate: HorrorModeSource,
    ) {}

    /** The clock (a test replaces it). */
    now(): number {
        return Date.now();
    }

    onApplicationBootstrap(): void {
        this.subscriptions.push(
            this.chat.lines$.subscribe(line => this.forward(line)),
            this.streamer.clientEvents$.subscribe(event => {
                if (event.type === 'horror_preview') void this.preview(event.dream, event.name);
            }),
        );
    }

    /** Hands one chat line to the game (rehearsal / live, a streamer client connected). */
    forward(line: ChatLine): void {
        if (this.gate.mode === 'off' || this.streamer.clientCount <= 0) return;
        const text = line.text.replace(/\s+/g, ' ').trim().slice(0, 300);
        if (!text) return;
        this.streamer.broadcast({ type: 'horror_chat', user: line.user.displayName || line.user.login, text });
        if (++this.forwarded % 100 === 1) this.logger.log(`SLEEP TIGHT (${this.gate.mode}): forwarding chat to the game (${this.forwarded} lines so far)`);
    }

    /** The game showed a dream's preview: its rules line, in live mode only. */
    async preview(dream: string, name?: string): Promise<void> {
        const mode = this.gate.mode;
        if (mode === 'off') return;
        if (mode !== 'live') {
            this.logger.log(`SLEEP TIGHT rehearsal: preview of ${dream}; rules line NOT posted (rehearsal never posts)`);
            return;
        }
        const now = this.now();
        const key = dream.trim().toLowerCase();
        const last = this.postedAt.get(key);
        if ((last !== undefined && now - last < RULES_SAME_DREAM_MS) || now - this.lastPost < RULES_MIN_GAP_MS) {
            this.logger.log(`SLEEP TIGHT live: rules for ${dream} skipped (rate limit)`);
            return;
        }
        this.postedAt.set(key, now);
        this.lastPost = now;
        this.logger.log(`SLEEP TIGHT live: posting the rules for ${dream}`);
        await this.chat.say(sleepTightRulesLine(key, name));
    }

    onModuleDestroy(): void {
        for (const subscription of this.subscriptions) subscription.unsubscribe();
    }
}
