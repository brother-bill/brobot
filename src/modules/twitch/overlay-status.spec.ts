import type { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { RAW_TEST_ENV, testEnvService } from '../../../test/helpers';
import { EnvService } from '../../config/env.service';
import { OVERLAY_SOCKET_PATH } from './overlay-events';
import { OverlayGateway } from './overlay.gateway';
import type { OverlayStatusEvent } from './streamer-events';
import { STREAMER_SOCKET_PATH, StreamerGateway } from './streamer.gateway';

/**
 * The streamer client is told how many stream overlays are connected, over real sockets: the count comes from ws's own
 * client set, so the order in which ws and Nest see a close matters.
 */
describe('overlay_status on /api/ashketchum', () => {
    let app: INestApplication;
    let baseUrl: string;
    const sockets: WebSocket[] = [];

    beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [StreamerGateway, OverlayGateway, { provide: EnvService, useValue: testEnvService() }],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        app.useWebSocketAdapter(new WsAdapter(app));
        await app.listen(0, '127.0.0.1');
        baseUrl = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    });

    afterEach(async () => {
        for (const socket of sockets.splice(0)) socket.terminate();
        await app.close();
    });

    /** A streamer client that keeps every `overlay_status` it is sent, in order. */
    async function streamerClient(): Promise<{ statuses: number[]; next(): Promise<number> }> {
        const socket = new WebSocket(`${baseUrl}${STREAMER_SOCKET_PATH}`, {
            headers: { Authorization: `Bearer ${RAW_TEST_ENV.WS_SECRET}` },
        });
        sockets.push(socket);
        const statuses: number[] = [];
        let waiting: ((connected: number) => void) | null = null;
        socket.on('message', data => {
            const frame = JSON.parse(String(data)) as OverlayStatusEvent | { type: string };
            if (frame.type !== 'overlay_status') return;
            const { connected } = frame as OverlayStatusEvent;
            statuses.push(connected);
            waiting?.(connected);
            waiting = null;
        });
        let seen = 0;
        const next = () =>
            new Promise<number>(resolve => {
                if (statuses.length > seen) {
                    resolve(statuses[seen++]);
                    return;
                }
                waiting = connected => {
                    seen++;
                    resolve(connected);
                };
            });
        await new Promise((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        return { statuses, next };
    }

    async function overlay(): Promise<WebSocket> {
        const socket = new WebSocket(`${baseUrl}${OVERLAY_SOCKET_PATH}`);
        sockets.push(socket);
        await new Promise((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        return socket;
    }

    it('tells a newly connected streamer client the current count', async () => {
        const client = await streamerClient();
        await expect(client.next()).resolves.toBe(0);

        await overlay();
        await overlay();
        const late = await streamerClient();
        await expect(late.next()).resolves.toBe(2);
    });

    it('sends the count when an overlay connects', async () => {
        const client = await streamerClient();
        await expect(client.next()).resolves.toBe(0);

        await overlay();
        await expect(client.next()).resolves.toBe(1);
        await overlay();
        await expect(client.next()).resolves.toBe(2);
    });

    it('sends the count when an overlay disconnects', async () => {
        const client = await streamerClient();
        await expect(client.next()).resolves.toBe(0);
        const source = await overlay();
        await expect(client.next()).resolves.toBe(1);

        source.close();
        await expect(client.next()).resolves.toBe(0);
        expect(client.statuses).toEqual([0, 1, 0]);
    });

    it('reaches every connected streamer client', async () => {
        const first = await streamerClient();
        const second = await streamerClient();
        await expect(first.next()).resolves.toBe(0);
        await expect(second.next()).resolves.toBe(0);

        await overlay();
        await expect(Promise.all([first.next(), second.next()])).resolves.toEqual([1, 1]);
    });
});
