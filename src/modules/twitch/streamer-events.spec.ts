import { CHATBAN_DURATION_MS, parseStreamerClientEvent, STREAMER_SOCKET_PATH, VOICEBAN_DURATION_MS } from './streamer-events';

describe('/api/ashketchum contract', () => {
    it('keeps the path and the durations the chat copy promises', () => {
        expect(STREAMER_SOCKET_PATH).toBe('/api/ashketchum');
        expect(CHATBAN_DURATION_MS).toBe(5 * 60 * 1000);
        expect(VOICEBAN_DURATION_MS).toBe(30 * 1000);
    });

    it('parses the client frames', () => {
        expect(parseStreamerClientEvent('{"type":"chatban_complete"}')).toEqual({ type: 'chatban_complete' });
        expect(parseStreamerClientEvent('{"type":"voiceban_complete","error":"mic busy"}')).toEqual({
            type: 'voiceban_complete',
            error: 'mic busy',
        });
        expect(parseStreamerClientEvent('{"type":"pong","sentAt":12}')).toEqual({ type: 'pong', sentAt: 12 });
    });

    it('drops malformed, unknown and legacy frames', () => {
        for (const frame of [
            'not json',
            'null',
            '"chatban_complete"',
            '{"type":"chatban"}',
            '{"type":"pong"}',
            '{"event":"chatban_complete","data":null}',
        ]) {
            expect(parseStreamerClientEvent(frame)).toBeNull();
        }
    });

    it('treats an empty error as no error', () => {
        expect(parseStreamerClientEvent('{"type":"chatban_complete","error":""}')).toEqual({ type: 'chatban_complete' });
    });
});
