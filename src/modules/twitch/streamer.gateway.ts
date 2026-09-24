import { Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { WebSocketGateway } from '@nestjs/websockets';
import type { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import { Subject } from 'rxjs';
import type { RawData, WebSocket, WebSocketServer } from 'ws';
import { EnvService } from '../../config/env.service';
import { clientAddress } from './client-address';
import { isAuthorizedStreamerClient } from './streamer-client-auth';
import { parseStreamerClientEvent, STREAMER_SOCKET_PATH } from './streamer-events';
import type { StreamerClientEvent, StreamerServerEvent } from './streamer-events';

export { STREAMER_SOCKET_PATH } from './streamer-events';

const HEARTBEAT_MS = 15_000;

type TrackedSocket = WebSocket & { isAlive?: boolean };

/**
 * The streamer client's socket: `!chatban` / `!voiceban` go out, "the ban is
 * over" comes back. The frames are {@link StreamerServerEvent} and
 * {@link StreamerClientEvent} (`streamer-events.ts`, the contract C1 copies).
 *
 * This class is transport only. The votes subscribe to {@link clientEvents$}
 * and {@link disconnects$}, so the gateway depends on nothing in the bot.
 *
 * The path is absolute: WebSocket gateways do not get the `/api` prefix.
 */
@WebSocketGateway({ path: STREAMER_SOCKET_PATH })
export class StreamerGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
    private readonly logger = new Logger(StreamerGateway.name);
    private server: WebSocketServer | null = null;
    private heartbeat: NodeJS.Timeout | null = null;

    /** Every well-formed frame a streamer client sends. */
    readonly clientEvents$ = new Subject<StreamerClientEvent>();
    /** Fires whenever a streamer client goes away (the votes reset, as before). */
    readonly disconnects$ = new Subject<void>();

    constructor(private readonly env: EnvService) {}

    afterInit(server: WebSocketServer): void {
        this.server = server;
        const secret = this.env.get('WS_SECRET');
        // Refuse at the HTTP upgrade, before a socket exists. The gateway
        // options are evaluated at import time and cannot see injected config,
        // so the check is installed here; ws reads `options.verifyClient` on
        // every upgrade.
        server.options.verifyClient = (info, done) => {
            if (isAuthorizedStreamerClient(info.req.headers, secret)) {
                done(true);
                return;
            }
            this.logger.warn(`Refused unauthenticated streamer socket from ${clientAddress(info.req)}`);
            done(false, 401, 'Unauthorized');
        };

        this.heartbeat = setInterval(() => {
            for (const client of server.clients as Set<TrackedSocket>) {
                if (client.isAlive === false) {
                    client.terminate();
                    continue;
                }
                client.isAlive = false;
                client.ping();
            }
            this.broadcast({ type: 'ping', sentAt: Date.now() });
        }, HEARTBEAT_MS);
        this.heartbeat.unref();
    }

    handleConnection(client: TrackedSocket, request: IncomingMessage): void {
        client.isAlive = true;
        client.on('pong', () => {
            client.isAlive = true;
        });
        client.on('message', (data: RawData, isBinary: boolean) => {
            if (isBinary) return;
            const event = parseStreamerClientEvent(rawText(data));
            if (!event) {
                this.logger.warn('Ignored a malformed or unknown frame from the streamer client');
                return;
            }
            this.clientEvents$.next(event);
        });
        this.logger.log(`Streamer client connected from ${clientAddress(request)} (${this.clientCount} connected)`);
    }

    handleDisconnect(): void {
        this.logger.log(`Streamer client disconnected (${this.clientCount} connected)`);
        this.disconnects$.next();
    }

    get clientCount(): number {
        return this.server?.clients.size ?? 0;
    }

    /** Sends `event` to every connected streamer client; returns how many it reached. */
    broadcast(event: StreamerServerEvent): number {
        const frame = JSON.stringify(event);
        let sent = 0;
        for (const client of this.server?.clients ?? []) {
            if (client.readyState !== client.OPEN) continue;
            client.send(frame);
            sent++;
        }
        return sent;
    }

    onModuleDestroy(): void {
        if (this.heartbeat) clearInterval(this.heartbeat);
        for (const client of this.server?.clients ?? []) client.terminate();
        this.clientEvents$.complete();
        this.disconnects$.complete();
    }
}

function rawText(data: RawData): string {
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    return data.toString('utf8');
}
