import type { HorrorEffect } from '../streamer-events';

/**
 * A channel-point redemption, reduced to what the handlers read. EventSub's
 * `EventSubChannelRedemptionAddEvent` is mapped onto it at the edge, so the
 * handlers (and their tests) never see a Twurple type.
 */
export interface Redemption {
    id: string;
    rewardId: string;
    rewardTitle: string;
    userId: string;
    /** Lower-case login. */
    login: string;
    displayName: string;
    /** What the viewer typed, for rewards that ask for input. */
    input: string;
}

/** The reward titles brobot acts on, exactly as the streamer's channel names them. */
export const REWARD_TITLES = {
    pokemonRoar: 'Pokemon Roar',
    pokemonLevelUp: 'Pokemon Level Up',
    pokemonCreate: 'Pokemon Create',
    enableQuacks: 'Enable Quacks',
    debsAlert: 'DEBS Alert',
} as const;

/**
 * A horror reward brobot creates on the channel (SLEEP TIGHT, friend-slop-1's horror mode). brobot owns these rewards
 * (Helix only lets an app manage rewards it created), keeps them hidden (`is_enabled: false`), and shows them only while
 * the streamer's game is connected and a run is being played (`HorrorRewardsService`). `dream` limits a reward to one
 * dream (the door rewards only exist during Night Shift).
 */
export interface HorrorRewardSpec {
    title: string;
    effect: HorrorEffect;
    cost: number;
    prompt: string;
    dream?: string;
}

export const HORROR_REWARD_SPECS: readonly HorrorRewardSpec[] = [
    { title: 'Boo', effect: 'boo', cost: 100, prompt: 'A soft ghostly boo in the dream.' },
    { title: 'Scream At Her', effect: 'scream', cost: 300, prompt: 'A scream right behind her.' },
    { title: 'Flicker The Lights', effect: 'lights', cost: 200, prompt: "The dream's lights stutter." },
    { title: 'Hijack Her Mic', effect: 'shout', cost: 500, prompt: 'The game hears a loud mic spike: anything that listens comes looking.' },
    { title: 'Freeze Her Controls', effect: 'freeze', cost: 750, prompt: 'Her controls freeze for 3 seconds.' },
    { title: 'Make Her Jump', effect: 'press', cost: 300, prompt: 'Presses her main action once.' },
    { title: 'Jumpscare', effect: 'jumpscare', cost: 1000, prompt: 'A full-screen jump scare.' },
    { title: 'Help The Sleepers', effect: 'help', cost: 250, prompt: "Help the sleepers in this dream (a lantern, a spare needle, a jar of honey...)." },
    { title: 'Mess With Them', effect: 'mess', cost: 250, prompt: 'Mess with the sleepers in this dream. Never a kill.' },
    { title: 'Slam The Left Door', effect: 'door left', cost: 400, prompt: 'Night Shift: slam (or open!) the left door.', dream: 'Night Shift' },
    { title: 'Slam The Right Door', effect: 'door right', cost: 400, prompt: 'Night Shift: slam (or open!) the right door.', dream: 'Night Shift' },
];

/**
 * Horror reward title (lower case) -> what it does in the game. The titles are matched case-insensitively.
 */
export const HORROR_REWARDS: Readonly<Record<string, HorrorEffect>> = Object.fromEntries(
    HORROR_REWARD_SPECS.map(spec => [spec.title.toLowerCase(), spec.effect]),
);

/** Injection token for whoever settles redemptions (the streamer's Helix client in production). */
export const REDEMPTION_SETTLER = Symbol('REDEMPTION_SETTLER');

/** Settles a redemption: FULFILLED keeps the points, CANCELED refunds them. */
export interface RedemptionSettler {
    fulfill(redemption: Redemption): Promise<void>;
    refund(redemption: Redemption): Promise<void>;
}
