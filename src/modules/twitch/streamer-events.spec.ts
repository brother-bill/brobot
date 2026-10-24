import { parseStreamerClientEvent } from './streamer-events';

describe('/api/ashketchum contract', () => {
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

    it('parses the horror run frames', () => {
        expect(parseStreamerClientEvent('{"type":"horror_run","live":true,"dream":"Night Shift"}')).toEqual({ type: 'horror_run', live: true, dream: 'Night Shift' });
        expect(parseStreamerClientEvent('{"type":"horror_run","live":false,"dream":""}')).toEqual({ type: 'horror_run', live: false });
        expect(parseStreamerClientEvent('{"type":"horror_run","live":"yes"}')).toBeNull();
    });
});
