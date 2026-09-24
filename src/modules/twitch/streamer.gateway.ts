import { Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { WebSocketGateway } from '@nestjs/websockets';
import type { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { WebSocket, WebSocketServer } from 'ws';
import { EnvService } from '../../config/env.service';
import { isAuthorizedStreamerClient } from './streamer-client-auth';

export const STREAMER_SOCKET_PATH = '/api/ashketchum';
const HEARTBEAT_MS = 15_000;

type TrackedSocket = WebSocket & { isAlive?: boolean };

/**
 * The streamer client's socket (`!chatban` / `!voiceban` relays and the
 * streamer-side events). B1 wires the transport and its authentication only;
 * B2 adds the `@SubscribeMessage` handlers and the outgoing events.
 *
 * The path is absolute: WebSocket gateways do not get the `/api` prefix.
 */
@WebSocketGateway({ path: STREAMER_SOCKET_PATH })
export class StreamerGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
    private readonly logger = new Logger(StreamerGateway.name);
    private server: WebSocketServer | null = null;
    private heartbeat: NodeJS.Timeout | null = null;

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
        }, HEARTBEAT_MS);
        this.heartbeat.unref();
    }

    handleConnection(client: TrackedSocket, request: IncomingMessage): void {
        client.isAlive = true;
        client.on('pong', () => {
            client.isAlive = true;
        });
        this.logger.log(`Streamer client connected from ${clientAddress(request)} (${this.clientCount} connected)`);
    }

    handleDisconnect(): void {
        this.logger.log(`Streamer client disconnected (${this.clientCount} connected)`);
    }

    get clientCount(): number {
        return this.server?.clients.size ?? 0;
    }

    onModuleDestroy(): void {
        if (this.heartbeat) clearInterval(this.heartbeat);
        for (const client of this.server?.clients ?? []) client.terminate();
    }
}

function clientAddress(request: IncomingMessage): string {
    const forwarded = request.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    return first ?? request.socket.remoteAddress ?? 'unknown';
}
