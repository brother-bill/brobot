import { COMMAND_CATALOG } from './command-catalog';
import { catalogNameFor, parseChatCommand } from './command-parser';

describe('parseChatCommand', () => {
    it('reads the trigger (lower-cased) and the arguments (as typed)', () => {
        expect(parseChatCommand('!Pokemon create Ash Pikachu 5 1')).toEqual({
            trigger: 'pokemon',
            args: ['create', 'Ash', 'Pikachu', '5', '1'],
        });
    });

    it('trims the line and ignores runs of whitespace', () => {
        expect(parseChatCommand('   !pokemon   swap  1\t2  ')).toEqual({ trigger: 'pokemon', args: ['swap', '1', '2'] });
    });

    it('is null for anything that is not a command', () => {
        expect(parseChatCommand('hello !pokemon')).toBeNull();
        expect(parseChatCommand('!')).toBeNull();
        expect(parseChatCommand('! pokemon')).toBeNull();
        expect(parseChatCommand('')).toBeNull();
    });

    it('takes a command with no arguments', () => {
        expect(parseChatCommand('!chatban')).toEqual({ trigger: 'chatban', args: [] });
    });
});

describe('catalogNameFor', () => {
    const nameOf = (text: string) => {
        const parsed = parseChatCommand(text);
        if (!parsed) throw new Error(`not a command: ${text}`);
        return catalogNameFor(parsed);
    };

    it.each([
        ['!pokemon battle', 'pokemon-battle'],
        ['!pokemon TeamBattle', 'pokemon-teambattle'],
        ['!pokemon team', 'pokemon-team'],
        ['!pokemon catch', 'pokemon-catch'],
        ['!pokemon delete 3', 'pokemon-delete'],
        ['!pokemon remove 3', 'pokemon-delete'],
        ['!pokemon swap 1 2', 'pokemon-swap'],
        ['!pokemon switch 1 2', 'pokemon-swap'],
        ['!chatban', 'chatban'],
        ['!VOICEBAN', 'voiceban'],
        ['!dice', 'dice'],
        ['!rps', 'rps'],
        ['!chess', 'chess'],
        ['!ping', 'ping'],
        ['!commands', 'commands'],
        ['!command', 'commands'],
        ['!quack', 'quack'],
        ['!quackquack', 'quack'],
    ])('%s → %s', (text, name) => {
        expect(nameOf(text)).toBe(name);
    });

    it('has no switch for bare !pokemon, the admin create, or unknown commands', () => {
        expect(nameOf('!pokemon')).toBeNull();
        expect(nameOf('!pokemon create a b 1 0')).toBeNull();
        expect(nameOf('!pokemon seduce')).toBeNull();
        expect(nameOf('!lurk')).toBeNull();
    });

    it('only ever names commands the catalog has', () => {
        const catalog = new Set(COMMAND_CATALOG.map(command => command.name));
        for (const text of ['!pokemon battle', '!pokemon teambattle', '!pokemon team', '!pokemon catch', '!pokemon delete', '!pokemon swap', '!chatban', '!voiceban', '!dice', '!rps', '!chess', '!ping', '!commands', '!quack']) {
            expect(catalog.has(nameOf(text) ?? '')).toBe(true);
        }
    });
});
