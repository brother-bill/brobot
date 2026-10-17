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
} as const;

/**
 * Horror rewards (the streamer's SLEEP TIGHT nights): reward title -> what it does in the game. The titles are matched
 * case-insensitively, so the streamer can create them as she likes them capitalised.
 */
export const HORROR_REWARDS: Readonly<Record<string, HorrorEffect>> = {
    'boo': 'boo',
    'scream at her': 'scream',
    'flicker the lights': 'lights',
    'hijack her mic': 'shout',
    'freeze her controls': 'freeze',
    'make her jump': 'press',
    'jumpscare': 'jumpscare',
};

/** Injection token for whoever settles redemptions (the streamer's Helix client in production). */
export const REDEMPTION_SETTLER = Symbol('REDEMPTION_SETTLER');

/** Settles a redemption: FULFILLED keeps the points, CANCELED refunds them. */
export interface RedemptionSettler {
    fulfill(redemption: Redemption): Promise<void>;
    refund(redemption: Redemption): Promise<void>;
}
