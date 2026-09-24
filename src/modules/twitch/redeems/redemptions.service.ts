import { Injectable, Logger } from '@nestjs/common';
import { FunCommandsService } from '../fun/fun-commands.service';
import { PokemonRedeemsService } from './pokemon-redeems.service';
import { REWARD_TITLES } from './redemption';
import type { Redemption } from './redemption';

/**
 * Routes a channel-point redemption to its handler by reward title, as the
 * old EventSub callback did. Rewards brobot does not handle are left alone.
 */
@Injectable()
export class RedemptionsService {
    private readonly logger = new Logger(RedemptionsService.name);

    constructor(
        private readonly pokemon: PokemonRedeemsService,
        private readonly fun: FunCommandsService,
    ) {}

    async handle(redemption: Redemption): Promise<void> {
        this.logger.log(`@${redemption.login} redeemed ${redemption.rewardTitle}`);
        try {
            switch (redemption.rewardTitle) {
                case REWARD_TITLES.pokemonRoar:
                    return await this.pokemon.roar(redemption);
                case REWARD_TITLES.pokemonLevelUp:
                    return await this.pokemon.levelUp(redemption);
                case REWARD_TITLES.pokemonCreate:
                    return await this.pokemon.create(redemption);
                case REWARD_TITLES.enableQuacks:
                    return await this.fun.enableQuacks(redemption);
                default:
                    return;
            }
        } catch (error) {
            this.logger.error(`Redemption ${redemption.rewardTitle} failed`, error instanceof Error ? error.stack : error);
        }
    }
}
