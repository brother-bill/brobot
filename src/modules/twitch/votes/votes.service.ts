import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { EnvService } from '../../../config/env.service';
import { catalogNameFor } from '../../commands/command-parser';
import { CommandRegistryService } from '../../commands/command-registry.service';
import { BotChatService } from '../chat/bot-chat.service';
import type { ChatCommand } from '../chat/chat-types';
import { StreamerGateway } from '../streamer.gateway';
import type { StreamerClientEvent } from '../streamer-events';
import { VoteCounter } from './vote-counter';
import type { VoteHost, VoteKind } from './vote-counter';

/**
 * `!chatban` and `!voiceban`: one {@link VoteCounter} each, fed from chat,
 * relayed to the streamer client over `/api/ashketchum`, and reset when the
 * client reports the ban over or goes away.
 */
@Injectable()
export class VotesService implements OnModuleDestroy {
    private readonly logger = new Logger(VotesService.name);
    private readonly subscription = new Subscription();
    private readonly channel: string;
    readonly chatban: VoteCounter;
    readonly voiceban: VoteCounter;

    constructor(
        env: EnvService,
        private readonly chat: BotChatService,
        private readonly gateway: StreamerGateway,
        private readonly registry: CommandRegistryService,
    ) {
        this.channel = env.get('TWITCH_STREAMER_CHANNEL_LISTEN');
        const host: VoteHost = {
            channel: this.channel,
            say: text => chat.say(text),
            streamerClients: () => gateway.clientCount,
            sendBan: (kind, durationMs) => {
                const reached = gateway.broadcast({ type: kind, durationMs });
                this.logger.log(`Sent ${kind} to ${reached} streamer client(s)`);
            },
        };
        this.chatban = new VoteCounter('chatban', host);
        this.voiceban = new VoteCounter('voiceban', host);

        this.subscription.add(chat.commands$.subscribe(command => void this.onCommand(command)));
        this.subscription.add(gateway.clientEvents$.subscribe(event => void this.onClientEvent(event)));
        this.subscription.add(
            gateway.disconnects$.subscribe(() => {
                this.chatban.reset();
                this.voiceban.reset();
            }),
        );
    }

    counter(kind: VoteKind): VoteCounter {
        return kind === 'chatban' ? this.chatban : this.voiceban;
    }

    private async onCommand({ command, user }: ChatCommand): Promise<void> {
        const name = catalogNameFor(command);
        if (name !== 'chatban' && name !== 'voiceban') return;
        try {
            if (!this.registry.isEnabled(name)) {
                await this.chat.say(`!${name} is turned off`);
                return;
            }
            await this.counter(name).vote(user);
        } catch (error) {
            this.logger.error(`!${name} failed`, error instanceof Error ? error.stack : error);
        }
    }

    private async onClientEvent(event: StreamerClientEvent): Promise<void> {
        if (event.type === 'pong') return;
        const kind: VoteKind = event.type === 'chatban_complete' ? 'chatban' : 'voiceban';
        this.counter(kind).reset();
        if (event.error) {
            this.logger.warn(`Streamer client reported a failed ${kind}: ${event.error}`);
            await this.chat.say('Uhoh, something broke :(');
        }
        await this.chat.say(
            `${this.channel} is now free. All ${kind === 'chatban' ? 'ChatBan' : 'VoiceBan'} votes have been reset.`,
        );
    }

    onModuleDestroy(): void {
        this.subscription.unsubscribe();
    }
}
