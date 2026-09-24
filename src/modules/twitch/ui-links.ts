import { Injectable } from '@nestjs/common';
import { EnvService } from '../../config/env.service';

/**
 * The admin-site links the bot posts in chat, on the paths the old site used
 * (the U1 rewrite keeps or redirects them; viewers have them bookmarked).
 */
@Injectable()
export class UiLinks {
    private readonly base: string;

    constructor(env: EnvService) {
        this.base = env.get('UI_URL').replace(/\/+$/, '');
    }

    commands(): string {
        return `${this.base}/commands`;
    }

    team(login: string): string {
        return `${this.base}/pokemon/team?username=${encodeURIComponent(login.toLowerCase())}`;
    }

    battleOutcome(): string {
        return `${this.base}/pokemon/battleoutcome`;
    }
}
