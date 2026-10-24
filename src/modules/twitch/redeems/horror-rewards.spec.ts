import { BehaviorSubject, Subject } from 'rxjs';
import type { HorrorMode, HorrorModeSource } from '../horror/horror-mode.service';
import type { StreamerGateway } from '../streamer.gateway';
import type { StreamerClientEvent } from '../streamer-events';
import { HORROR_RUN_STALE_MS, HorrorRewardsService } from './horror-rewards.service';
import type { HorrorRewardApi, ManagedReward } from './horror-rewards.service';
import { HORROR_REWARD_SPECS } from './redemption';
import type { HorrorRewardSpec } from './redemption';

/** The channel's rewards as Helix would hold them, plus a log of the writes. */
class FakeRewardApi implements HorrorRewardApi {
    rewards: ManagedReward[] = [];
    writes: string[] = [];
    ready = true;
    private readyCallbacks: (() => void)[] = [];
    private nextId = 1;

    async listManaged(): Promise<ManagedReward[] | null> {
        return this.ready ? this.rewards.map(r => ({ ...r })) : null;
    }
    async create(spec: HorrorRewardSpec, isEnabled: boolean): Promise<ManagedReward> {
        const reward = { id: `r${this.nextId++}`, title: spec.title, isEnabled, isPaused: false };
        this.rewards.push(reward);
        this.writes.push(`create ${spec.title}`);
        return reward;
    }
    async update(id: string, change: { isEnabled: boolean; isPaused: boolean }): Promise<void> {
        const reward = this.rewards.find(r => r.id === id);
        if (!reward) throw new Error(`no reward ${id}`);
        Object.assign(reward, change);
        this.writes.push(`${change.isEnabled ? 'enable' : 'hide'} ${reward.title}`);
    }
    onReady(callback: () => void): void {
        if (this.ready) callback();
        else this.readyCallbacks.push(callback);
    }
    becomeReady(): void {
        this.ready = true;
        for (const callback of this.readyCallbacks.splice(0)) callback();
    }
    enabled(): string[] {
        return this.rewards.filter(r => r.isEnabled).map(r => r.title);
    }
}

/** The mode gate as a plain object a test can switch. */
export function fakeGate(initial: HorrorMode): HorrorModeSource & { set(mode: HorrorMode): void } {
    const subject = new BehaviorSubject<HorrorMode>(initial);
    return {
        get mode() {
            return subject.value;
        },
        mode$: subject.asObservable(),
        set: (mode: HorrorMode) => subject.next(mode),
    };
}

function setup(api = new FakeRewardApi(), mode: HorrorMode = 'live') {
    const clientEvents$ = new Subject<StreamerClientEvent>();
    const disconnects$ = new Subject<void>();
    const gateway = { clientEvents$, disconnects$, clientCount: 1 };
    const gate = fakeGate(mode);
    const service = new HorrorRewardsService(gateway as unknown as StreamerGateway, api, gate);
    let clock = 1_000_000;
    service.now = () => clock;
    service.onApplicationBootstrap();
    return {
        api,
        service,
        gateway,
        gate,
        run: async (live: boolean, dream?: string) => {
            clientEvents$.next({ type: 'horror_run', live, ...(dream ? { dream } : {}) });
            await service.sync();
        },
        disconnect: async (left: number) => {
            gateway.clientCount = left;
            disconnects$.next();
            await service.sync();
        },
        advance: (ms: number) => (clock += ms),
    };
}

const ALL_BUT_DOORS = HORROR_REWARD_SPECS.filter(s => !s.dream).map(s => s.title);

afterEach(() => vi.restoreAllMocks());

describe('Horror rewards: shown only while a SLEEP TIGHT run is played', () => {
    it('creates nothing and shows nothing before a run', async () => {
        const ctx = setup();
        await ctx.service.sync();
        expect(ctx.api.rewards).toEqual([]);
        expect(ctx.service.isLive).toBe(false);
    });

    it('creates and enables the rewards when a run starts, the door rewards only during Night Shift', async () => {
        const ctx = setup();
        await ctx.run(true, 'Too Many Cats');
        expect(ctx.service.isLive).toBe(true);
        expect(ctx.api.enabled().sort()).toEqual([...ALL_BUT_DOORS].sort());
        await ctx.run(true, 'Night Shift');
        expect(ctx.api.enabled()).toContain('Slam The Left Door');
        expect(ctx.api.enabled()).toContain('Slam The Right Door');
        await ctx.run(true, 'The Woods');
        expect(ctx.api.enabled()).not.toContain('Slam The Left Door');
    });

    it('hides every reward when the run ends', async () => {
        const ctx = setup();
        await ctx.run(true, 'Lights Out');
        await ctx.run(false);
        expect(ctx.api.enabled()).toEqual([]);
        expect(ctx.service.isLive).toBe(false);
    });

    it('hides them when the last streamer client disconnects, not while another is still there', async () => {
        const ctx = setup();
        await ctx.run(true, 'Lights Out');
        await ctx.disconnect(1);
        expect(ctx.api.enabled().length).toBeGreaterThan(0);
        await ctx.disconnect(0);
        expect(ctx.api.enabled()).toEqual([]);
    });

    it('hides them when the game goes quiet (a crashed game), and a heartbeat keeps them up', async () => {
        const ctx = setup();
        await ctx.run(true, 'Lights Out');
        ctx.advance(HORROR_RUN_STALE_MS - 1000);
        await ctx.run(true, 'Lights Out');   // the game's 30 s repeat
        ctx.advance(HORROR_RUN_STALE_MS - 1000);
        await ctx.service.checkStale();
        expect(ctx.api.enabled().length).toBeGreaterThan(0);
        ctx.advance(5000);
        await ctx.service.checkStale();
        expect(ctx.api.enabled()).toEqual([]);
    });

    it('hides rewards left visible (or paused) by a previous brobot as soon as the API client is ready', async () => {
        const api = new FakeRewardApi();
        api.ready = false;
        api.rewards = [
            { id: 'a', title: 'Boo', isEnabled: true, isPaused: false },
            { id: 'b', title: 'jumpscare', isEnabled: false, isPaused: true },
            { id: 'c', title: 'Pokemon Roar', isEnabled: true, isPaused: false },
        ];
        const ctx = setup(api);
        api.becomeReady();
        await ctx.service.sync();
        expect(api.rewards.find(r => r.id === 'a')).toMatchObject({ isEnabled: false });
        expect(api.rewards.find(r => r.id === 'b')).toMatchObject({ isEnabled: false, isPaused: false });
        expect(api.rewards.find(r => r.id === 'c')).toMatchObject({ isEnabled: true });   // not a horror reward
    });

    it('hides them on shutdown', async () => {
        const ctx = setup();
        await ctx.run(true, 'Lights Out');
        await ctx.service.onApplicationShutdown();
        expect(ctx.api.enabled()).toEqual([]);
    });

    it('writes only what changed, and survives a Helix error', async () => {
        const ctx = setup();
        await ctx.run(true, 'Lights Out');
        const writes = ctx.api.writes.length;
        await ctx.service.sync();
        expect(ctx.api.writes.length).toBe(writes);
        vi.spyOn(ctx.api, 'update').mockRejectedValueOnce(new Error('503'));
        await ctx.run(false);
        await ctx.run(false);
        await ctx.service.sync();
        expect(ctx.api.enabled()).toEqual([]);
    });
});

describe('Horror rewards: the SLEEP TIGHT mode gate', () => {
    const DREAMS = ['Lights Out', 'Night Shift', 'The Woods', 'Too Many Cats'];

    for (const mode of ['off', 'rehearsal'] as const) {
        it(`${mode}: a whole run (every dream, heartbeats, disconnect, shutdown) makes zero create/update calls`, async () => {
            const ctx = setup(new FakeRewardApi(), mode);
            const create = vi.spyOn(ctx.api, 'create');
            const update = vi.spyOn(ctx.api, 'update');
            for (const dream of DREAMS) {
                await ctx.run(true, dream);
                await ctx.run(true, dream);
            }
            expect(ctx.service.isLive).toBe(false);   // so a redemption is refunded
            await ctx.run(false);
            await ctx.disconnect(0);
            await ctx.service.onApplicationShutdown();
            expect(create).not.toHaveBeenCalled();
            expect(update).not.toHaveBeenCalled();
            expect(ctx.api.rewards).toEqual([]);
        });

        it(`${mode}: existing hidden (even paused) rewards are left alone`, async () => {
            const api = new FakeRewardApi();
            api.rewards = [
                { id: 'a', title: 'Boo', isEnabled: false, isPaused: false },
                { id: 'b', title: 'Jumpscare', isEnabled: false, isPaused: true },
            ];
            const ctx = setup(api, mode);
            await ctx.run(true, 'Night Shift');
            expect(api.writes).toEqual([]);
        });
    }

    it('switching live -> rehearsal mid-run hides what live showed, and shows nothing again', async () => {
        const ctx = setup(new FakeRewardApi(), 'live');
        await ctx.run(true, 'Night Shift');
        expect(ctx.api.enabled().length).toBeGreaterThan(0);
        ctx.gate.set('rehearsal');
        await ctx.service.sync();
        expect(ctx.api.enabled()).toEqual([]);
        const writes = ctx.api.writes.length;
        await ctx.run(true, 'The Woods');
        expect(ctx.api.writes.length).toBe(writes);
    });

    it('switching rehearsal -> live during a run shows the rewards at once', async () => {
        const ctx = setup(new FakeRewardApi(), 'rehearsal');
        await ctx.run(true, 'Lights Out');
        expect(ctx.api.rewards).toEqual([]);
        ctx.gate.set('live');
        await ctx.service.sync();
        expect(ctx.api.enabled().sort()).toEqual([...ALL_BUT_DOORS].sort());
        expect(ctx.service.isLive).toBe(true);
    });
});
