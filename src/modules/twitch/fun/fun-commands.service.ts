import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { EnvService } from '../../../config/env.service';
import { catalogNameFor } from '../../commands/command-parser';
import { CommandRegistryService } from '../../commands/command-registry.service';
import { Random } from '../../pokemon/random';
import { BotChatService } from '../chat/bot-chat.service';
import type { ChatCommand } from '../chat/chat-types';
import { OverlayGateway } from '../overlay.gateway';
import { REDEMPTION_SETTLER } from '../redeems/redemption';
import type { Redemption, RedemptionSettler } from '../redeems/redemption';
import { StreamerGateway } from '../streamer.gateway';
import { UiLinks } from '../ui-links';

/** How often chat is reminded of the commands, while the streamer client is connected. */
export const COMMANDS_NOTICE_EVERY_MS = 30 * 60 * 1000;

/**
 * The small commands — `!ping`, `!dice`, `!rps`, `!commands`, `!quack` — the
 * half-hourly reminder, and the `Enable Quacks` redeem that switches
 * `!quack` on.
 */
@Injectable()
export class FunCommandsService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(FunCommandsService.name);
    private readonly subscription: Subscription;
    private notice: NodeJS.Timeout | null = null;
    private readonly channel: string;

    constructor(
        private readonly env: EnvService,
        private readonly chat: BotChatService,
        private readonly registry: CommandRegistryService,
        private readonly random: Random,
        private readonly links: UiLinks,
        private readonly overlay: OverlayGateway,
        private readonly streamer: StreamerGateway,
        @Inject(REDEMPTION_SETTLER) private readonly settler: RedemptionSettler,
    ) {
        this.channel = env.get('TWITCH_STREAMER_CHANNEL_LISTEN');
        this.subscription = chat.commands$.subscribe(command => {
            this.handle(command).catch((error: unknown) => {
                this.logger.error(`"${command.text}" failed`, error instanceof Error ? error.stack : error);
            });
        });
    }

    onApplicationBootstrap(): void {
        if (!this.env.get('TWITCH_BOT_ENABLED')) return;
        this.notice = setInterval(() => {
            if (this.streamer.clientCount <= 0) return;
            void this.chat.say(
                `Use the commands: "!chatban" or "!voiceban", when ${this.channel} gets too emotional. !pokemon, !quack, and more can be found here: ${this.links.commands()}`,
            );
        }, COMMANDS_NOTICE_EVERY_MS);
        this.notice.unref();
    }

    async handle({ command, user }: ChatCommand): Promise<void> {
        const name = catalogNameFor(command);
        if (!name || !this.registry.isEnabled(name)) return;
        switch (name) {
            case 'ping':
                return this.chat.say('pong!');
            case 'dice':
                return this.chat.say(`@${user.login} rolled a ${this.random.int(1, 6)}`);
            case 'rps':
                return this.chat.say(
                    `@${user.login} wants to play Rock Paper Scissors. https://www.rpsgame.org/room?id=turbosux${this.random.int(0, 99_999)}`,
                );
            case 'commands':
                return this.chat.say(`Commands: ${this.links.commands()}`);
            case 'quack':
                this.overlay.broadcast({ type: 'quack' });
                return;
            default:
                return;
        }
    }

    /** `Enable Quacks`: turns `!quack` on (it stays on until an admin turns it off). */
    async enableQuacks(redemption: Redemption): Promise<void> {
        if (this.registry.isEnabled('quack')) {
            await this.settler.refund(redemption);
            await this.chat.say(`/me @${redemption.login}, quacks are already enabled. You have been refunded`);
            return;
        }
        if (this.overlay.clientCount <= 0) {
            await this.settler.refund(redemption);
            await this.chat.say(
                `/me ${this.channel} is not connected to browser source, so quacks won't work. You have been refunded`,
            );
            return;
        }
        await this.registry.setEnabled('quack', true, `channel-point redeem by ${redemption.login}`);
        await this.chat.say('/me The command "!quack" has been enabled. Go get em');
    }

    onModuleDestroy(): void {
        this.subscription.unsubscribe();
        if (this.notice) clearInterval(this.notice);
    }
}
