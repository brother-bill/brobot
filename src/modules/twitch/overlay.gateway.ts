import { Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { WebSocketGateway } from '@nestjs/websockets';
import type { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { WebSocket, WebSocketServer } from 'ws';
import { clientAddress } from './client-address';
import { OVERLAY_SOCKET_PATH } from './overlay-events';
import type { OverlayEvent } from './overlay-events';

const HEARTBEAT_MS = 15_000;

type TrackedSocket = WebSocket & { isAlive?: boolean };

/**
 * The stream overlay's socket (the old `AdminUiGateway`): Pokémon roars and
 * quacks go out to every connected browser source. See `overlay-events.ts`
 * for why it has no secret.
 */
@WebSocketGateway({ path: OVERLAY_SOCKET_PATH })
export class OverlayGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
    private readonly logger = new Logger(OverlayGateway.name);
    private server: WebSocketServer | null = null;
    private heartbeat: NodeJS.Timeout | null = null;

    afterInit(server: WebSocketServer): void {
        this.server = server;
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
        this.logger.log(`Overlay connected from ${clientAddress(request)} (${this.clientCount} connected)`);
    }

    handleDisconnect(): void {
        this.logger.log(`Overlay disconnected (${this.clientCount} connected)`);
    }

    get clientCount(): number {
        return this.server?.clients.size ?? 0;
    }

    /** Sends `event` to every connected overlay; returns how many it reached. */
    broadcast(event: OverlayEvent): number {
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
    }
}
