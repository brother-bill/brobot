import { EntityManager } from '@mikro-orm/postgresql';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { BehaviorSubject } from 'rxjs';
import type { Observable } from 'rxjs';
import { CommandSetting } from '../../../entities';

/**
 * The SLEEP TIGHT (friend-slop-1's horror mode) Twitch gate. Default `off`.
 *
 * - `off`: brobot does nothing for the horror game.
 * - `rehearsal`: brobot forwards the channel's chat lines to the streamer's game (through the streamer client), so a
 *   test run plays against real chat. It never posts in chat and never creates, enables or shows a channel-point
 *   reward (rewards a previous `live` left visible are hidden). A stray redemption is refunded without a chat line.
 * - `live` (the Halloween show): as rehearsal, plus the horror rewards appear during a run and a short rules line is
 *   posted to chat when a dream's preview screen appears.
 */
export const HORROR_MODES = ['off', 'rehearsal', 'live'] as const;
export type HorrorMode = (typeof HORROR_MODES)[number];

/** What the horror services read; {@link HorrorModeService} is the real one (tests pass a plain object). */
export interface HorrorModeSource {
    readonly mode: HorrorMode;
    readonly mode$: Observable<HorrorMode>;
}

/**
 * The mode is stored in `command_setting` as two rows that are not chat commands (so the public commands list never
 * shows them): `horror-mode-live` on = live, else `horror-mode-rehearsal` on = rehearsal, else off. No row = off.
 */
export const HORROR_MODE_ROWS = { rehearsal: 'horror-mode-rehearsal', live: 'horror-mode-live' } as const;

export function modeFromRows(rows: readonly Pick<CommandSetting, 'name' | 'enabled'>[]): HorrorMode {
    const on = (name: string) => rows.some(row => row.name === name && row.enabled);
    if (on(HORROR_MODE_ROWS.live)) return 'live';
    if (on(HORROR_MODE_ROWS.rehearsal)) return 'rehearsal';
    return 'off';
}

export function parseHorrorMode(value: unknown): HorrorMode | null {
    return typeof value === 'string' && (HORROR_MODES as readonly string[]).includes(value) ? (value as HorrorMode) : null;
}

/**
 * Holds the gate in memory (read on every chat line), loaded at boot. A database that cannot be read leaves it `off`.
 * Switched by `POST /api/internal/horror/mode` (docs: friend-slop-1 docs/horror/TWITCH.md "brobot modes").
 */
@Injectable()
export class HorrorModeService implements HorrorModeSource, OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(HorrorModeService.name);
    private readonly subject = new BehaviorSubject<HorrorMode>('off');
    readonly mode$: Observable<HorrorMode> = this.subject.asObservable();

    constructor(private readonly em: EntityManager) {}

    get mode(): HorrorMode {
        return this.subject.value;
    }

    async onApplicationBootstrap(): Promise<void> {
        try {
            const rows = await this.em.fork().find(CommandSetting, { name: { $in: Object.values(HORROR_MODE_ROWS) } });
            this.apply(modeFromRows(rows), 'stored');
        } catch (error) {
            this.logger.warn(`Could not read the SLEEP TIGHT mode, staying off: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** Persists first, so a failed write leaves the mode where it was. */
    async setMode(value: unknown, actor: string): Promise<HorrorMode> {
        const mode = parseHorrorMode(value);
        if (!mode) throw new BadRequestException(`mode must be one of ${HORROR_MODES.join(', ')}`);
        const em = this.em.fork();
        for (const [rowMode, name] of Object.entries(HORROR_MODE_ROWS)) {
            const enabled = rowMode === mode;
            const existing = await em.findOne(CommandSetting, { name });
            if (existing) {
                existing.enabled = enabled;
                existing.updated_by = actor;
            } else {
                em.create(CommandSetting, { name, enabled, updated_by: actor });
            }
        }
        await em.flush();
        this.apply(mode, actor);
        return mode;
    }

    private apply(mode: HorrorMode, by: string): void {
        this.logger.log(`SLEEP TIGHT mode: ${mode} (${by})`);
        if (mode !== this.subject.value) this.subject.next(mode);
    }

    onModuleDestroy(): void {
        this.subject.complete();
    }
}
