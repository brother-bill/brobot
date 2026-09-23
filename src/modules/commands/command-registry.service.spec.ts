import { NotFoundException } from '@nestjs/common';
import { COMMAND_CATALOG } from './command-catalog';
import { CommandRegistryService } from './command-registry.service';

describe('CommandRegistryService', () => {
    let registry: CommandRegistryService;

    beforeEach(() => {
        registry = new CommandRegistryService();
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

    it('switches a command off and on', () => {
        expect(registry.setEnabled('chatban', false, 'test').enabled).toBe(false);
        expect(registry.isEnabled('chatban')).toBe(false);
        registry.setEnabled('chatban', true, 'test');
        expect(registry.isEnabled('chatban')).toBe(true);
    });

    it('fails closed for an unknown name and 404s when asked to toggle one', () => {
        expect(registry.isEnabled('nope')).toBe(false);
        expect(() => registry.setEnabled('nope', true, 'test')).toThrow(NotFoundException);
    });
});
