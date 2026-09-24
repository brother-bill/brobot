import { fakeChat, memoryRegistry, ScriptedRandom, viewer } from '../../../../test/bot-fakes';
import { testEnvService } from '../../../../test/helpers';
import type { OverlayGateway } from '../overlay.gateway';
import type { OverlayEvent } from '../overlay-events';
import type { RedemptionSettler } from '../redeems/redemption';
import type { StreamerGateway } from '../streamer.gateway';
import { UiLinks } from '../ui-links';
import { AI_REPLIES_PER_HOUR, AiCompleter, AiReplyService } from './ai-reply.service';
import { ChessService, LICHESS_OPEN_CHALLENGE_URL } from './chess.service';
import { FunCommandsService } from './fun-commands.service';

const settle = () => new Promise(resolve => setImmediate(resolve));

describe('FunCommandsService', () => {
    function setup(rolls: number[] = []) {
        const { chat, said } = fakeChat();
        const shown: OverlayEvent[] = [];
        const registry = memoryRegistry();
        new FunCommandsService(
            testEnvService(),
            chat,
            registry,
            new ScriptedRandom(rolls),
            new UiLinks(testEnvService()),
            { clientCount: 1, broadcast: (event: OverlayEvent) => shown.push(event) } as unknown as OverlayGateway,
            { clientCount: 1 } as unknown as StreamerGateway,
            {} as RedemptionSettler,
        );
        const type = async (text: string) => {
            chat.receive({ user: viewer('ash'), text });
            await settle();
        };
        return { said, shown, registry, type };
    }

    it('answers the small commands with the old copy', async () => {
        const ctx = setup([4, 1234]);
        await ctx.type('!ping');
        await ctx.type('!dice');
        await ctx.type('!rps');
        await ctx.type('!commands');
        await ctx.type('!command');
        expect(ctx.said).toEqual([
            'pong!',
            '@ash rolled a 4',
            '@ash wants to play Rock Paper Scissors. https://www.rpsgame.org/room?id=turbosux1234',
            'Commands: https://brobot.test/commands',
            'Commands: https://brobot.test/commands',
        ]);
    });

    it('quacks on the overlay only once quacks are switched on', async () => {
        const ctx = setup();
        await ctx.type('!quack');
        expect(ctx.shown).toEqual([]);
        await ctx.registry.setEnabled('quack', true, 'test');
        await ctx.type('!quackquack');
        expect(ctx.shown).toEqual([{ type: 'quack' }]);
    });

    it('ignores a switched-off command', async () => {
        const ctx = setup();
        await ctx.registry.setEnabled('ping', false, 'test');
        await ctx.type('!ping');
        expect(ctx.said).toEqual([]);
    });
});

describe('ChessService', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function setup(response: () => Response, env: Record<string, string> = {}) {
        const { chat, said } = fakeChat();
        const calls: [string, RequestInit | undefined][] = [];
        vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
            calls.push([url, init]);
            return response();
        });
        new ChessService(testEnvService(env), chat, memoryRegistry());
        return { chat, said, calls };
    }

    it('opens an unrated Lichess challenge and posts its link', async () => {
        const ctx = setup(() => Response.json({ id: 'abc', url: 'https://lichess.org/abc' }), { LICHESS_AUTH_TOKEN: 'lip_x' });
        ctx.chat.receive({ user: viewer('ash'), text: '!chess' });
        await vi.waitFor(() => expect(ctx.said).toHaveLength(1));
        expect(ctx.said[0]).toBe(
            '@ash wants to play Chess. If you hate yourself too, click the link to challenge them! https://lichess.org/abc',
        );
        const [url, init] = ctx.calls[0];
        expect(url).toBe(LICHESS_OPEN_CHALLENGE_URL);
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer lip_x');
        expect(JSON.parse(init?.body as string)).toMatchObject({ rated: false, variant: 'standard' });
    });

    it('works without a token, and apologises when Lichess fails', async () => {
        const ctx = setup(() => new Response('nope', { status: 429 }));
        ctx.chat.receive({ user: viewer('ash'), text: '!chess' });
        await vi.waitFor(() => expect(ctx.said).toHaveLength(1));
        expect((ctx.calls[0][1]?.headers as Record<string, string>).Authorization).toBeUndefined();
        expect(ctx.said[0]).toBe(`Uhoh, couldn't fetch Chess URL :(`);
    });
});

describe('AiReplyService', () => {
    class FakeCompleter extends AiCompleter {
        answer: string | null = 'PogChamp donkey';
        asked: { name: string; message: string }[] = [];
        configured = true;

        async complete(user: { name: string; message: string }): Promise<string | null> {
            this.asked.push(user);
            return this.answer;
        }
    }

    function setup(streamerClients = 1) {
        const { chat, said } = fakeChat();
        const completer = new FakeCompleter();
        const service = new AiReplyService(
            chat,
            memoryRegistry(),
            { clientCount: streamerClients } as unknown as StreamerGateway,
            completer,
        );
        const line = (text: string) => service.reply({ user: viewer('ash'), text });
        return { said, completer, line };
    }

    afterEach(() => {
        vi.useRealTimers();
    });

    it('answers a mention in character', async () => {
        const ctx = setup();
        await ctx.line('@bro_____bot who wins worlds?');
        expect(ctx.completer.asked).toEqual([{ name: 'ash', message: '@bro_____bot who wins worlds?' }]);
        expect(ctx.said).toEqual(['PogChamp donkey']);
    });

    it('ignores lines without a mention, and a bare mention', async () => {
        const ctx = setup();
        await ctx.line('hello chat');
        await ctx.line('@bro_____bot ');
        expect(ctx.completer.asked).toEqual([]);
        expect(ctx.said).toEqual([]);
    });

    it('replaces an apology with emotes', async () => {
        const ctx = setup();
        ctx.completer.answer = "I'm sorry, I cannot do that";
        await ctx.line('@bro_____bot say something rude');
        expect(ctx.said).toEqual(['WutFace WutFace WutFace WutFace PogChamp WutFace WutFace WutFace']);
    });

    it('takes six an hour, and none while the streamer is away', async () => {
        vi.useFakeTimers();
        const ctx = setup();
        for (let i = 0; i <= AI_REPLIES_PER_HOUR; i++) await ctx.line(`@bro_____bot question ${i}`);
        expect(ctx.completer.asked).toHaveLength(AI_REPLIES_PER_HOUR);
        expect(ctx.said.at(-1)).toBe("I'm currently taking a fat poopy! Try again later PogChamp");

        vi.advanceTimersByTime(60 * 60 * 1000);
        await ctx.line('@bro_____bot again');
        expect(ctx.completer.asked).toHaveLength(AI_REPLIES_PER_HOUR + 1);

        const offline = setup(0);
        await offline.line('@bro_____bot anyone?');
        expect(offline.completer.asked).toEqual([]);
        expect(offline.said).toEqual(["I'm currently taking a fat poopy! Try again later PogChamp"]);
    });

    it('is silent without an API key', async () => {
        const ctx = setup();
        ctx.completer.configured = false;
        await ctx.line('@bro_____bot hi');
        expect(ctx.said).toEqual([]);
    });
});
