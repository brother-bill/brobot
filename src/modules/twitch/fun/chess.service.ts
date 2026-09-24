import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { EnvService } from '../../../config/env.service';
import { catalogNameFor } from '../../commands/command-parser';
import { CommandRegistryService } from '../../commands/command-registry.service';
import { BotChatService } from '../chat/bot-chat.service';
import type { ChatUser } from '../chat/chat-types';

export const LICHESS_OPEN_CHALLENGE_URL = 'https://lichess.org/api/challenge/open';

/**
 * `!chess`: opens an unrated standard Lichess challenge anyone can accept and
 * posts its link. `LICHESS_AUTH_TOKEN` is sent when set; Lichess also takes
 * open challenges anonymously (at a lower rate limit), so the command works
 * without it.
 */
@Injectable()
export class ChessService implements OnModuleDestroy {
    private readonly logger = new Logger(ChessService.name);
    private readonly subscription: Subscription;

    constructor(
        private readonly env: EnvService,
        private readonly chat: BotChatService,
        private readonly registry: CommandRegistryService,
    ) {
        this.subscription = chat.commands$.subscribe(({ command, user }) => {
            if (catalogNameFor(command) !== 'chess' || !this.registry.isEnabled('chess')) return;
            void this.challenge(user);
        });
    }

    async challenge(user: ChatUser): Promise<void> {
        try {
            const url = await this.openChallenge(user.login);
            await this.chat.say(
                `@${user.login} wants to play Chess. If you hate yourself too, click the link to challenge them! ${url}`,
            );
        } catch (error) {
            this.logger.error(`Lichess challenge failed: ${error instanceof Error ? error.message : String(error)}`);
            await this.chat.say(`Uhoh, couldn't fetch Chess URL :(`);
        }
    }

    private async openChallenge(login: string): Promise<string> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
        const token = this.env.get('LICHESS_AUTH_TOKEN');
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(LICHESS_OPEN_CHALLENGE_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                rated: false,
                variant: 'standard',
                name: `The Illustrious ${login} vs Super Duper Random Pooper!`,
            }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Lichess answered ${response.status}`);
        // Lichess answers with the challenge at the top level; the 2022 API nested it under `challenge`.
        const body = (await response.json()) as { url?: unknown; challenge?: { url?: unknown } };
        const url = body.url ?? body.challenge?.url;
        if (typeof url !== 'string') throw new Error('Lichess sent no challenge URL');
        return url;
    }

    onModuleDestroy(): void {
        this.subscription.unsubscribe();
    }
}
