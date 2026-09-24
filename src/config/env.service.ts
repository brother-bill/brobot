import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

/**
 * Typed access to the validated environment. Values come from the object
 * {@link parseEnv} returned (so `ALLOWED_ORIGINS` is already a `string[]` and
 * `PORT` a number), never from raw `process.env`.
 */
@Injectable()
export class EnvService {
    constructor(private readonly config: ConfigService<Env, true>) {}

    get<K extends keyof Env>(key: K): Env[K] {
        return this.config.get(key, { infer: true });
    }
}
