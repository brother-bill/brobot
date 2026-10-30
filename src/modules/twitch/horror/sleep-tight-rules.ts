/**
 * SLEEP TIGHT rules lines: what brobot posts to chat (only in `live` mode) when a dream's preview screen appears.
 * THE ONE PLACE TO EDIT THEM. Keys are the game's dream ids (friend-slop-1 `HorrorNames` rows, sent as
 * `{"type":"preview","dream":"<id>"}`); the friend-slop-1 doc docs/horror/TWITCH.md has the full per-dream table.
 *
 * `special` is the dream's own chat trick, or '' when it has none. The shared part (help/mess/votes/bets) is
 * {@link SLEEP_TIGHT_COMMON}. A line stays under Twitch's 500 characters (a spec checks).
 */
export interface SleepTightDreamRules {
    /** The dream's title as the game shows it. */
    name: string;
    /** What `!help` does here, short. */
    help: string;
    /** What `!mess` does here, short. */
    mess: string;
    /** The dream's own command(s), or ''. */
    special: string;
}

// Short on purpose (owner, 2026-10-30): the cooldowns, @name aiming and the 1-4 votes are not explained up front; the vote panel
// says what to type on screen, and a spammer is told at that point.
export const SLEEP_TIGHT_COMMON = 'Bet on who goes down first: !bet <name>';

export const SLEEP_TIGHT_RULES: Readonly<Record<string, SleepTightDreamRules>> = {
    neverending: { name: 'Wake Up', help: 'a sugar rush', mess: 'glued shoes or a shove', special: '' },
    stars: { name: 'Stars at Dawn', help: 'patches a shield', mess: 'space goo on the windshield', special: '' },
    promos: { name: 'Master Promos', help: 'ganks Darius', mess: 'feeds Darius a kill', special: '' },
    cookie: { name: 'The Umbrella', help: 'a spare needle', mess: 'a warning shot', special: '' },
    lobster: { name: 'Market Price', help: 'a better escape from the pot', mess: 'hotter water', special: '' },
    cats: { name: 'Too Many Cats', help: 'patches a scratch', mess: 'a tomato on the screen', special: '' },
    vaping: { name: 'You Got Caught', help: 'trips the thing', mess: 'gives the thing a second wind', special: '' },
    chickens: { name: 'Free Range', help: 'winds the farmer', mess: 'messes with a chicken', special: '!farmer <name> sends the farmer after that chicken' },
    babies: { name: 'Baby Battle Boxing', help: 'a bottle', mess: 'a shove', special: '' },
    gary: { name: 'Your Favourite Pet Abandons You', help: 'calls Gary back for 3 s', mess: 'glued shoes', special: '' },
    slender: { name: 'The Woods', help: 'a lantern', mess: 'summons him', special: '!slender <name> sends him to that sleeper' },
    mummy: { name: 'The Curse of the Sad Mummy', help: 'pep-talks Amumu', mess: 'reminds Amumu nobody loves him', special: '' },
    library: { name: 'Get Shushed', help: 'drops a book far away', mess: 'knocks a book off next to someone', special: '' },
    puppets: { name: 'The Puppet Show', help: 'forgives a strike', mess: 'a tomato', special: '!point left / up / right whispers where the puppet points' },
    bear: { name: 'Bear Country', help: 'a jar of honey', mess: 'the bear roars', special: '' },
    saw: { name: 'I Want To Play A Game', help: 'a sugar rush', mess: 'flicks the lights', special: '' },
    freddy: {
        name: 'Night Shift',
        help: 'a torch or a spare battery',
        mess: 'nudges an animatronic closer',
        special: '!door left / !door right slams a door, !move bonnie / chica / foxy / freddy creeps one a room closer',
    },
    carrot: { name: 'Family Dinner', help: 'talks the hand out of its pick', mess: 'points the hand at someone else', special: '' },
    bee: { name: 'The Spelling Bee', help: 'whispers the first letter', mess: 'blows their nose mid-word', special: '' },
    deep: { name: 'The Deep', help: 'a burst for the swimmer', mess: 'ink on the swimmer\'s screen', special: '' },
    gauntlet: { name: 'The Gauntlet', help: 'patches up the runner', mess: 'mud in the runner\'s eyes', special: '' },
    naruto: { name: 'Friendship no Jutsu', help: 'hypes the Narutos', mess: 'hypes Sasuke', special: '' },
    leesin: { name: 'Master Yourself', help: 'tickles the Teemos', mess: 'a decoy Teemo laugh', special: '' },
    convict: { name: 'Fast & Felonious', help: 'nitro for the convict', mess: 'nitro for the cops', special: '' },
    rumbling: { name: 'The Rumbling', help: 'spurs a cow on', mess: 'feeds the titan', special: '' },
    ds: { name: 'Lights Out', help: 'the kettle (mom is busy a moment)', mess: 'a creaky floorboard', special: '' },
};

/** The chat line for a dream (an unknown id gets the shared rules under the name the game sent). */
export function sleepTightRulesLine(dreamId: string, gameName?: string): string {
    const key = dreamId.trim().toLowerCase();
    const rules: SleepTightDreamRules | undefined = Object.hasOwn(SLEEP_TIGHT_RULES, key) ? SLEEP_TIGHT_RULES[key] : undefined;
    const fallback = gameName?.trim() ?? '';
    const parts = [`SLEEP TIGHT: ${rules ? rules.name : fallback.length > 0 ? fallback : 'the next dream'}.`];
    if (rules) {
        parts.push(`!help = ${rules.help}, !mess = ${rules.mess}.`);
        if (rules.special) parts.push(`${rules.special}.`);
    }
    parts.push(`${SLEEP_TIGHT_COMMON}.`);
    return `/me ${parts.join(' ')}`;
}
