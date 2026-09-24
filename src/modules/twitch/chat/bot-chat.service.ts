import { Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ChatClient } from '@twurple/chat';
import type { ChatMessage } from '@twurple/chat';
import { Subject } from 'rxjs';
import { EnvService } from '../../../config/env.service';
import { TwitchTokenStoreService } from '../../auth/twitch-token-store.service';
import { parseChatCommand } from '../../commands/command-parser';
import type { ChatCommand, ChatLine, ChatSay } from './chat-types';

/**
 * The bot account's connection to the streamer's chat (Twurple chat, bot
 * token from `twitch_bot_auth`), and the two streams every handler reads:
 * {@link lines$} for every message and {@link commands$} for the ones that
 * parse as `!command`.
 *
 * It connects in the background once the app has booted. The old bot awaited
 * the chat registration inside a provider factory, so a Twitch outage kept
 * the whole API from starting; now the API serves regardless and chat joins
 * when it can (Twurple reconnects on its own).
 */
@Injectable()
export class BotChatService implements ChatSay, OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(BotChatService.name);
    private client: ChatClient | null = null;
    private readonly channel: string;
    private readonly botLogin: string;

    readonly lines$ = new Subject<ChatLine>();
    readonly commands$ = new Subject<ChatCommand>();

    constructor(
        private readonly env: EnvService,
        private readonly tokens: TwitchTokenStoreService,
    ) {
        this.channel = env.get('TWITCH_STREAMER_CHANNEL_LISTEN');
        this.botLogin = env.get('TWITCH_BOT_USERNAME').toLowerCase();
    }

    onApplicationBootstrap(): void {
        if (!this.env.get('TWITCH_BOT_ENABLED')) {
            this.logger.log('TWITCH_BOT_ENABLED=false — chat stays offline');
            return;
        }
        this.connect().catch((error: unknown) => {
            this.logger.error('Could not start the chat client', error instanceof Error ? error.stack : error);
        });
    }

    /** The bot's own login, lower-case (`@bro_____bot` mentions). */
    get botName(): string {
        return this.botLogin;
    }

    get isConnected(): boolean {
        return this.client?.isConnected ?? false;
    }

    private async connect(): Promise<void> {
        const authProvider = await this.tokens.createAuthProvider('bot', ['chat']);
        if (!authProvider) return;

        const client = new ChatClient({
            authProvider,
            channels: [this.channel],
            // The bot is a moderator in the channel: Twitch allows it 100 messages per 30 s.
            isAlwaysMod: true,
        });
        client.onMessage((_channel: string, _user: string, text: string, message: ChatMessage) => {
            const info = message.userInfo;
            this.receive({
                user: {
                    id: info.userId,
                    login: info.userName.toLowerCase(),
                    displayName: info.displayName,
                    isBroadcaster: info.isBroadcaster,
                    isMod: info.isMod,
                },
                text,
            });
        });
        client.onAuthenticationSuccess(() => this.logger.log(`Chat connected as ${this.botLogin} in #${this.channel}`));
        client.onAuthenticationFailure((text, retryCount) =>
            this.logger.error(`Chat authentication failed (attempt ${retryCount}): ${text}`),
        );
        client.onDisconnect((manually, reason) => {
            if (!manually) this.logger.warn(`Chat disconnected: ${reason?.message ?? 'no reason given'}`);
        });
        this.client = client;
        client.connect();
    }

    /** Feeds one chat line to the handlers. Public so tests can drive the bot without Twitch. */
    receive(line: ChatLine): void {
        if (line.user.login === this.botLogin) return;
        this.lines$.next(line);
        const command = parseChatCommand(line.text);
        if (command) this.commands$.next({ ...line, command });
    }

    /**
     * Says `text` in the streamer's channel. Never throws: a message that
     * cannot be sent is logged and dropped, as chat is best-effort.
     *
     * Runs of whitespace are collapsed (the old copy has double spaces where
     * an optional word like the shiny banner is empty, and a newline IRC
     * cannot carry). A leading `/me ` is sent as an action — Twitch no longer
     * runs slash commands typed through IRC.
     */
    async say(text: string): Promise<void> {
        const message = text.replace(/\s+/g, ' ').trim();
        if (!message) return;
        if (!this.client) {
            this.logger.warn(`Chat is offline; not sent: ${message}`);
            return;
        }
        try {
            if (message.startsWith('/me ')) await this.client.action(this.channel, message.slice(4));
            else await this.client.say(this.channel, message);
        } catch (error) {
            this.logger.error(`Could not send to chat: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    onModuleDestroy(): void {
        this.client?.quit();
        this.client = null;
        this.lines$.complete();
        this.commands$.complete();
    }
}
