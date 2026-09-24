import type { EntityManager } from '@mikro-orm/postgresql';
import { NotFoundException } from '@nestjs/common';
import { CommandSetting } from '../../entities';
import { COMMAND_CATALOG } from './command-catalog';
import { CommandRegistryService } from './command-registry.service';

/** Just the EntityManager calls the registry makes, over an in-memory table. */
class FakeSettingsStore {
    rows: CommandSetting[] = [];
    failReads = false;
    failWrites = false;
    private pending: CommandSetting[] = [];

    fork(): this {
        return this;
    }

    async find(): Promise<CommandSetting[]> {
        if (this.failReads) throw new Error('connection refused');
        return [...this.rows];
    }

    async findOne(_entity: unknown, where: { name: string }): Promise<CommandSetting | null> {
        return this.rows.find(row => row.name === where.name) ?? null;
    }

    create(_entity: unknown, data: Partial<CommandSetting>): CommandSetting {
        const row = Object.assign(new CommandSetting(), data);
        this.pending.push(row);
        return row;
    }

    async flush(): Promise<void> {
        if (this.failWrites) {
            this.pending = [];
            throw new Error('write failed');
        }
        this.rows.push(...this.pending);
        this.pending = [];
    }
}

function setting(name: string, enabled: boolean): CommandSetting {
    return Object.assign(new CommandSetting(), { name, enabled });
}

describe('CommandRegistryService', () => {
    let store: FakeSettingsStore;
    let registry: CommandRegistryService;

    beforeEach(() => {
        store = new FakeSettingsStore();
        registry = new CommandRegistryService(store as unknown as EntityManager);
    });

    it('lists every catalogued command with its default state', () => {
        const list = registry.list();
        expect(list.map(command => command.name)).toEqual(COMMAND_CATALOG.map(command => command.name));
        expect(list.find(command => command.name === 'quack')?.enabled).toBe(false);
        expect(list.find(command => command.name === 'pokemon-battle')?.enabled).toBe(true);
    });

    it('has unique names', () => {
        const names = COMMAND_CATALOG.map(command => command.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it('switches a command off and on, and stores each switch', async () => {
        expect((await registry.setEnabled('chatban', false, 'test')).enabled).toBe(false);
        expect(registry.isEnabled('chatban')).toBe(false);
        expect(store.rows).toEqual([expect.objectContaining({ name: 'chatban', enabled: false, updated_by: 'test' })]);

        await registry.setEnabled('chatban', true, 'mod');
        expect(registry.isEnabled('chatban')).toBe(true);
        expect(store.rows).toHaveLength(1);
        expect(store.rows[0]).toMatchObject({ enabled: true, updated_by: 'mod' });
    });

    it('restores stored switches at boot, over the defaults', async () => {
        store.rows = [setting('quack', true), setting('dice', false), setting('retired-command', true)];
        await registry.onApplicationBootstrap();
        expect(registry.isEnabled('quack')).toBe(true);
        expect(registry.isEnabled('dice')).toBe(false);
        expect(registry.isEnabled('ping')).toBe(true);
        // A row for a command the catalog no longer has is ignored.
        expect(registry.list().map(command => command.name)).not.toContain('retired-command');
    });

    it('keeps the defaults when the table cannot be read', async () => {
        store.failReads = true;
        await expect(registry.load()).resolves.toBeUndefined();
        expect(registry.isEnabled('quack')).toBe(false);
    });

    it('leaves the switch unchanged when the write fails', async () => {
        store.failWrites = true;
        await expect(registry.setEnabled('dice', false, 'test')).rejects.toThrow('write failed');
        expect(registry.isEnabled('dice')).toBe(true);
    });

    it('fails closed for an unknown name and 404s when asked to toggle one', async () => {
        expect(registry.isEnabled('nope')).toBe(false);
        await expect(registry.setEnabled('nope', true, 'test')).rejects.toThrow(NotFoundException);
    });
});
