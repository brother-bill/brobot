import type { IncomingMessage } from 'node:http';

/** The caller's address for logs: nginx's X-Forwarded-For first hop, else the socket peer. */
export function clientAddress(request: IncomingMessage): string {
    const forwarded = request.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    return first ?? request.socket.remoteAddress ?? 'unknown';
}
