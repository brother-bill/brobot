import { isHotkeyEvent, parseStreamerClientEvent } from './streamer-events';

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

    it('parses the hotkey frames, ignoring anything else in them', () => {
        expect(parseStreamerClientEvent('{"type":"create_marker"}')).toEqual({ type: 'create_marker' });
        expect(parseStreamerClientEvent('{"type":"create_prediction","title":"ignored"}')).toEqual({ type: 'create_prediction' });
        expect(parseStreamerClientEvent('{"type":"play_ad","length":180}')).toEqual({ type: 'play_ad' });
        // the 2022 client's Nest frame is not the contract
        expect(parseStreamerClientEvent('{"event":"play_ad","data":null}')).toBeNull();
        expect(parseStreamerClientEvent('{"type":"create_marker_complete"}')).toBeNull();
    });

    it('tells the hotkeys from the other client frames', () => {
        expect(isHotkeyEvent({ type: 'create_marker' })).toBe(true);
        expect(isHotkeyEvent({ type: 'play_ad' })).toBe(true);
        expect(isHotkeyEvent({ type: 'chatban_complete' })).toBe(false);
        expect(isHotkeyEvent({ type: 'pong', sentAt: 1 })).toBe(false);
    });
});
