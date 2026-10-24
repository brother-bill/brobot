import { BehaviorSubject, Subject } from 'rxjs';
import type { ChatLine } from '../chat/chat-types';
import { parseStreamerClientEvent } from '../streamer-events';
import type { StreamerClientEvent, StreamerServerEvent } from '../streamer-events';
import { HorrorChatService, RULES_MIN_GAP_MS, RULES_SAME_DREAM_MS } from './horror-chat.service';
import { HORROR_MODE_ROWS, modeFromRows, parseHorrorMode } from './horror-mode.service';
import type { HorrorMode } from './horror-mode.service';
import { SLEEP_TIGHT_RULES, sleepTightRulesLine } from './sleep-tight-rules';

function line(text: string, login = 'kevin'): ChatLine {
    return { user: { id: `id-${login}`, login, displayName: login.toUpperCase(), isBroadcaster: false, isMod: false }, text };
}

function setup(mode: HorrorMode, clients = 1) {
    const lines$ = new Subject<ChatLine>();
    const clientEvents$ = new Subject<StreamerClientEvent>();
    const subject = new BehaviorSubject<HorrorMode>(mode);
    const said: string[] = [];
    const sent: StreamerServerEvent[] = [];
    const streamer = {
        clientEvents$,
        clientCount: clients,
        broadcast: (event: StreamerServerEvent) => (sent.push(event), clients),
    };
    const chat = { lines$, say: vi.fn(async (text: string) => void said.push(text)) };
    const gate = {
        get mode() {
            return subject.value;
        },
        mode$: subject.asObservable(),
    };
    const service = new HorrorChatService(streamer, chat, gate);
    let clock = 10_000_000;
    service.now = () => clock;
    service.onApplicationBootstrap();
    return {
        service,
        chat,
        said,
        sent,
        streamer,
        setMode: (next: HorrorMode) => subject.next(next),
        chatLine: (text: string, login?: string) => lines$.next(line(text, login)),
        preview: async (dream: string, name?: string) => {
            clientEvents$.next({ type: 'horror_preview', dream, ...(name ? { name } : {}) });
            await Promise.resolve();
        },
        advance: (ms: number) => (clock += ms),
    };
}

const ALL_DREAMS = Object.keys(SLEEP_TIGHT_RULES);

describe('SLEEP TIGHT gate: off and rehearsal never post in chat', () => {
    for (const mode of ['off', 'rehearsal'] as const) {
        it(`${mode}: chat lines and every dream's preview send zero chat messages`, async () => {
            const ctx = setup(mode);
            for (const text of ['!help', '!mess @bob', '!door left', '2', '!bet nobody', 'LUL', '!help']) ctx.chatLine(text);
            for (const dream of ALL_DREAMS) {
                await ctx.preview(dream);
                ctx.advance(RULES_SAME_DREAM_MS + 1);
            }
            expect(ctx.chat.say).not.toHaveBeenCalled();
            expect(ctx.said).toEqual([]);
        });
    }

    it('off forwards nothing to the game', () => {
        const ctx = setup('off');
        ctx.chatLine('!help');
        expect(ctx.sent).toEqual([]);
    });

    it('rehearsal forwards every chat line to the game, trimmed, under the display name', () => {
        const ctx = setup('rehearsal');
        ctx.chatLine('  !door   left ');
        ctx.chatLine('3', 'bob');
        expect(ctx.sent).toEqual([
            { type: 'horror_chat', user: 'KEVIN', text: '!door left' },
            { type: 'horror_chat', user: 'BOB', text: '3' },
        ]);
    });

    it('forwards nothing while no streamer client is connected', () => {
        const ctx = setup('rehearsal', 0);
        ctx.chatLine('!help');
        expect(ctx.sent).toEqual([]);
    });
});

describe('SLEEP TIGHT gate: live posts the rules, rate-limited', () => {
    it('posts the dream rules line on its preview', async () => {
        const ctx = setup('live');
        await ctx.preview('freddy', 'Night Shift');
        expect(ctx.said).toEqual([sleepTightRulesLine('freddy')]);
        expect(ctx.said[0]).toContain('Night Shift');
        expect(ctx.said[0]).toContain('!door left');
        expect(ctx.said[0]).toContain('!bet');
    });

    it('posts a dream once per retry window and keeps a gap between dreams', async () => {
        const ctx = setup('live');
        await ctx.preview('freddy');
        ctx.advance(RULES_MIN_GAP_MS + 1);
        await ctx.preview('freddy');   // a retry
        expect(ctx.said.length).toBe(1);
        await ctx.preview('slender');
        expect(ctx.said.length).toBe(2);
        await ctx.preview('bear');   // too soon after The Woods
        expect(ctx.said.length).toBe(2);
        ctx.advance(RULES_SAME_DREAM_MS);
        await ctx.preview('freddy');
        expect(ctx.said.length).toBe(3);
    });

    it('stops posting the moment the mode leaves live', async () => {
        const ctx = setup('live');
        ctx.setMode('rehearsal');
        await ctx.preview('freddy');
        expect(ctx.said).toEqual([]);
    });

    it('an unknown dream id still gets the shared rules under the game name', () => {
        expect(sleepTightRulesLine('brandnew', 'Brand New Dream')).toContain('Brand New Dream');
    });

    it('every rules line fits a Twitch message', () => {
        for (const dream of ALL_DREAMS) expect(sleepTightRulesLine(dream).length).toBeLessThan(500);
    });
});

describe('SLEEP TIGHT gate: mode storage and wire', () => {
    it('defaults to off, live wins over rehearsal', () => {
        expect(modeFromRows([])).toBe('off');
        expect(modeFromRows([{ name: HORROR_MODE_ROWS.rehearsal, enabled: true }])).toBe('rehearsal');
        expect(
            modeFromRows([
                { name: HORROR_MODE_ROWS.rehearsal, enabled: true },
                { name: HORROR_MODE_ROWS.live, enabled: true },
            ]),
        ).toBe('live');
        expect(modeFromRows([{ name: HORROR_MODE_ROWS.live, enabled: false }])).toBe('off');
    });

    it('accepts only the three modes', () => {
        expect(parseHorrorMode('rehearsal')).toBe('rehearsal');
        expect(parseHorrorMode('LIVE')).toBeNull();
        expect(parseHorrorMode(undefined)).toBeNull();
    });

    it('parses horror_preview frames', () => {
        expect(parseStreamerClientEvent('{"type":"horror_preview","dream":"freddy","name":"Night Shift"}')).toEqual({
            type: 'horror_preview',
            dream: 'freddy',
            name: 'Night Shift',
        });
        expect(parseStreamerClientEvent('{"type":"horror_preview"}')).toBeNull();
    });
});
