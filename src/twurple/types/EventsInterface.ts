/* eslint-disable */
export enum IncomingEvents {
    TRAMA_CONNECTED = 'TRAMA_CONNECTED',
    CHATBAN_COMPLETE = 'CHATBAN_COMPLETE',
    VOICEBAN_COMPLETE = 'VOICEBAN_COMPLETE',
    CREATE_PREDICTION = 'CREATE_PREDICTION',
    CREATE_MARKER = 'CREATE_MARKER',
    PLAY_AD = 'PLAY_AD',
    PING = 'TRAMA_PING'
}

export enum OutgoingEvents {
    CHATBAN = 'CHATBAN',
    VOICEBAN = 'VOICEBAN',
    PONG = 'TRAMA_PONG',
    POKEMON_ROAR = 'POKEMON_ROAR'
}

export enum OutgoingErrors {}
