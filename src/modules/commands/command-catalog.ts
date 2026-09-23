/**
 * The chat commands brobot answers, as the old admin site's "Commands" page
 * listed them (apps/brobot-admin-ui commands.component.ts) plus the ones the
 * old bot handled without listing (`!ping`, `!commands`, the `@bro_____bot`
 * AI reply). The Streamlabs section of that page is left out: those commands
 * were never brobot's.
 *
 * `name` is the stable key the bot (B2) asks {@link CommandRegistryService}
 * about; `trigger` is what a viewer types.
 */
export const COMMAND_CATEGORIES = ['pokemon', 'voting', 'fun', 'ai'] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

export interface CommandDefinition {
    readonly name: string;
    readonly trigger: string;
    readonly aliases: readonly string[];
    readonly category: CommandCategory;
    readonly description: string;
    /** State at process start. */
    readonly enabledByDefault: boolean;
}

export const COMMAND_CATALOG: readonly CommandDefinition[] = [
    {
        name: 'pokemon-battle',
        trigger: '!pokemon battle',
        aliases: [],
        category: 'pokemon',
        description: 'Start or join a 1v1 battle using your starter Pokémon in slot 1.',
        enabledByDefault: true,
    },
    {
        name: 'pokemon-teambattle',
        trigger: '!pokemon teambattle',
        aliases: [],
        category: 'pokemon',
        description: 'Start or join a 6v6 battle using every Pokémon in your six slots.',
        enabledByDefault: true,
    },
    {
        name: 'pokemon-team',
        trigger: '!pokemon team',
        aliases: [],
        category: 'pokemon',
        description: 'Get a link that shows your whole Pokémon team.',
        enabledByDefault: true,
    },
    {
        name: 'pokemon-catch',
        trigger: '!pokemon catch',
        aliases: [],
        category: 'pokemon',
        description:
            'Catch the wild Pokémon that appears every so often. You need a free slot, and you get three attempts.',
        enabledByDefault: true,
    },
    {
        name: 'pokemon-delete',
        trigger: '!pokemon delete <slot>',
        aliases: ['!pokemon remove <slot>'],
        category: 'pokemon',
        description: 'Permanently delete the Pokémon in that slot.',
        enabledByDefault: true,
    },
    {
        name: 'pokemon-swap',
        trigger: '!pokemon swap <slot> <slot>',
        aliases: ['!pokemon switch <slot> <slot>'],
        category: 'pokemon',
        description: 'Swap the Pokémon in two slots, usually to change your starter.',
        enabledByDefault: true,
    },
    {
        name: 'chatban',
        trigger: '!chatban',
        aliases: [],
        category: 'voting',
        description: 'Vote to stop the streamer pressing Enter for five minutes once enough viewers agree.',
        enabledByDefault: true,
    },
    {
        name: 'voiceban',
        trigger: '!voiceban',
        aliases: [],
        category: 'voting',
        description: "Vote to mute the streamer's microphone for 30 seconds once enough viewers agree.",
        enabledByDefault: true,
    },
    {
        name: 'dice',
        trigger: '!dice',
        aliases: [],
        category: 'fun',
        description: 'Roll a six-sided die.',
        enabledByDefault: true,
    },
    {
        name: 'rps',
        trigger: '!rps',
        aliases: [],
        category: 'fun',
        description: 'Get a rock-paper-scissors link to challenge other viewers.',
        enabledByDefault: true,
    },
    {
        name: 'chess',
        trigger: '!chess',
        aliases: [],
        category: 'fun',
        description: 'Get a Lichess link to challenge other viewers.',
        enabledByDefault: true,
    },
    {
        name: 'quack',
        trigger: '!quack',
        aliases: [],
        category: 'fun',
        description: 'Plays a duck sound on stream. Off until a channel-point redeem turns it on.',
        enabledByDefault: false,
    },
    {
        name: 'ping',
        trigger: '!ping',
        aliases: [],
        category: 'fun',
        description: 'Check that the bot is listening.',
        enabledByDefault: true,
    },
    {
        name: 'commands',
        trigger: '!commands',
        aliases: ['!command'],
        category: 'fun',
        description: 'Get a link to this list.',
        enabledByDefault: true,
    },
    {
        name: 'ai-reply',
        trigger: '@bro_____bot <message>',
        aliases: [],
        category: 'ai',
        description: 'Mention the bot and it replies.',
        enabledByDefault: true,
    },
];
