import type { RefreshingAuthProvider } from '@twurple/auth';
import { testEnvService } from '../../../../test/helpers';
import type { TwitchTokenStoreService } from '../../auth/twitch-token-store.service';
import { BotChatService } from './bot-chat.service';
import type { ChatCommand, ChatLine } from './chat-types';

/** Twurple's ChatClient, replaced: records construction, say/action, and exposes its message handler. */
const twurple = vi.hoisted(() => ({
    instances: [] as {
        options: Record<string, unknown>;
        said: [string, string][];
        acted: [string, string][];
        connected: boolean;
        emit: (channel: string, user: string, text: string, message: unknown) => void;
    }[],
}));

vi.mock('@twurple/chat', () => ({
    ChatClient: class {
        private handler: ((...args: unknown[]) => void) | null = null;
        private readonly record;

        constructor(options: Record<string, unknown>) {
            this.record = {
                options,
                said: [] as [string, string][],
                acted: [] as [string, string][],
                connected: false,
                emit: (...args: unknown[]) => this.handler?.(...args),
            };
            twurple.instances.push(this.record);
        }

        get isConnected() {
            return this.record.connected;
        }

        onMessage(handler: (...args: unknown[]) => void) {
            this.handler = handler;
        }

        // Connection-state listeners: nothing to report in a test.
        onAuthenticationSuccess() {
            return undefined;
        }
        onAuthenticationFailure() {
            return undefined;
        }
        onDisconnect() {
            return undefined;
        }

        connect() {
            this.record.connected = true;
        }

        quit() {
            this.record.connected = false;
        }

        async say(channel: string, text: string) {
            this.record.said.push([channel, text]);
        }

        async action(channel: string, text: string) {
            this.record.acted.push([channel, text]);
        }
    },
}));

function chatMessage(userId: string, userName: string, extra: Record<string, unknown> = {}) {
    return {
        userInfo: { userId, userName, displayName: userName.toUpperCase(), isBroadcaster: false, isMod: false, ...extra },
    };
}

async function started(overrides: Record<string, string> = {}, provider: unknown = {}) {
    const tokens = { createAuthProvider: vi.fn(async () => provider as RefreshingAuthProvider | null) };
    const chat = new BotChatService(
        testEnvService({ TWITCH_BOT_ENABLED: 'true', ...overrides }),
        tokens as unknown as TwitchTokenStoreService,
    );
    chat.onApplicationBootstrap();
    await vi.waitFor(() => expect(tokens.createAuthProvider).toHaveBeenCalled());
    await new Promise(resolve => setImmediate(resolve));
    return { chat, tokens };
}

describe('BotChatService', () => {
    beforeEach(() => {
        twurple.instances.length = 0;
    });

    it('joins the streamer channel with the bot token, as a moderator', async () => {
        const { chat, tokens } = await started();
        expect(tokens.createAuthProvider).toHaveBeenCalledWith('bot', ['chat']);
        expect(twurple.instances).toHaveLength(1);
        expect(twurple.instances[0].options).toMatchObject({ channels: ['trama'], isAlwaysMod: true });
        expect(chat.isConnected).toBe(true);
        chat.onModuleDestroy();
        expect(chat.isConnected).toBe(false);
    });

    it('stays offline when the bot is switched off, or has no token yet', async () => {
        const off = new BotChatService(testEnvService(), { createAuthProvider: vi.fn() } as unknown as TwitchTokenStoreService);
        off.onApplicationBootstrap();
        await started({}, null);
        expect(twurple.instances).toHaveLength(0);
    });

    it('turns chat into lines and parsed commands, ignoring its own messages', async () => {
        const { chat } = await started();
        const lines: ChatLine[] = [];
        const commands: ChatCommand[] = [];
        chat.lines$.subscribe(line => lines.push(line));
        chat.commands$.subscribe(command => commands.push(command));

        const client = twurple.instances[0];
        client.emit('#trama', 'ash', 'hello', chatMessage('1', 'Ash'));
        client.emit('#trama', 'ash', '!Pokemon swap 1 2', chatMessage('1', 'Ash', { isMod: true }));
        client.emit('#trama', 'bro_____bot', '!ping', chatMessage('2', 'bro_____bot'));

        expect(lines.map(line => line.text)).toEqual(['hello', '!Pokemon swap 1 2']);
        expect(commands).toEqual([
            {
                user: { id: '1', login: 'ash', displayName: 'ASH', isBroadcaster: false, isMod: true },
                text: '!Pokemon swap 1 2',
                command: { trigger: 'pokemon', args: ['swap', '1', '2'] },
            },
        ]);
    });

    it('says in the channel, collapsing whitespace, and sends /me as an action', async () => {
        const { chat } = await started();
        await chat.say("@ash's Level 5  Pikachu \n wins");
        await chat.say('/me A wild Eevee appeared');
        await chat.say('   ');
        expect(twurple.instances[0].said).toEqual([['trama', "@ash's Level 5 Pikachu wins"]]);
        expect(twurple.instances[0].acted).toEqual([['trama', 'A wild Eevee appeared']]);
    });

    it('drops messages quietly while offline', async () => {
        const chat = new BotChatService(testEnvService(), {} as TwitchTokenStoreService);
        await expect(chat.say('hello')).resolves.toBeUndefined();
    });
});
