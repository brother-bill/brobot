/**
 * The `/api/admin-ui` wire contract: what brobot pushes to the stream overlay
 * (the admin site's browser source, ticket U1). Self-contained so the overlay
 * can copy it, like `streamer-events.ts`.
 *
 * The socket is receive-only and unauthenticated, as it was in 2022: an OBS
 * browser source cannot send headers, and nothing on it is private — the
 * same Pokémon are on the public leaderboard. Frames from the overlay are
 * ignored. Every frame is one JSON object with a `type`; unknown types must
 * be ignored.
 */

export const OVERLAY_SOCKET_PATH = '/api/admin-ui';

/** A viewer's `Pokemon Roar` redeem: show their starter on stream and play its cry. */
export interface PokemonRoarEvent {
    type: 'pokemon_roar';
    /** Who redeemed it (chat login). */
    login: string;
    pokemon: {
        name: string;
        /** `@pkmn` id, e.g. `pikachu` — the sprite/cry key. */
        nameId: string;
        dexNum: number;
        level: number;
        shiny: boolean;
        gender: string;
        color: string;
    };
}

/** Somebody typed `!quack` while quacks are enabled: play the duck. */
export interface QuackEvent {
    type: 'quack';
}

export type OverlayEvent = PokemonRoarEvent | QuackEvent;
