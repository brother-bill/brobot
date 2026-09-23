import type { IncomingHttpHeaders } from 'node:http';
import { bearerToken, safeEqual } from '../../common/safe-equal';

/**
 * Whether an upgrade request on `/api/ashketchum` carries the streamer
 * client's secret. The 2022 client sends it as a `token` header; the rebuilt
 * client (C1) may send `Authorization: Bearer` instead. Both are compared in
 * constant time — the old gateway used `===`.
 */
export function isAuthorizedStreamerClient(headers: IncomingHttpHeaders, secret: string): boolean {
    const legacy = headers.token;
    const presented = bearerToken(headers.authorization) ?? (Array.isArray(legacy) ? legacy[0] : legacy);
    return typeof presented === 'string' && presented.length > 0 && safeEqual(presented, secret);
}
