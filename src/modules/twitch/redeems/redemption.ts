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

/** Injection token for whoever settles redemptions (the streamer's Helix client in production). */
export const REDEMPTION_SETTLER = Symbol('REDEMPTION_SETTLER');

/** Settles a redemption: FULFILLED keeps the points, CANCELED refunds them. */
export interface RedemptionSettler {
    fulfill(redemption: Redemption): Promise<void>;
    refund(redemption: Redemption): Promise<void>;
}
