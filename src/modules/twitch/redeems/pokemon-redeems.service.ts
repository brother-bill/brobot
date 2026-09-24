import { Inject, Injectable, Logger } from '@nestjs/common';
import { isAwayInPmd, PokemonAwayError } from '../../pokemon/exclusivity';
import { POKE_ROAR_ACTIONS } from '../../pokemon/poke-info';
import { PokemonFactory } from '../../pokemon/pokemon-factory';
import { PokemonWriteService } from '../../pokemon/pokemon-write.service';
import { Random } from '../../pokemon/random';
import { parseSlot, TeamRuleError } from '../../pokemon/team-rules';
import { BotChatService } from '../chat/bot-chat.service';
import { OverlayGateway } from '../overlay.gateway';
import { REDEMPTION_SETTLER } from './redemption';
import type { Redemption, RedemptionSettler } from './redemption';

const SHINY_BANNER = 'PogChamp ****SHINY**** PogChamp';

/**
 * The three Pokémon channel-point rewards. A redeem that cannot be honoured
 * is refunded (CANCELED) with the old bot's chat line; only a successful
 * level-up is marked FULFILLED — create and roar were left in the
 * streamer's queue before, and still are.
 */
@Injectable()
export class PokemonRedeemsService {
    private readonly logger = new Logger(PokemonRedeemsService.name);

    constructor(
        private readonly chat: BotChatService,
        private readonly pokemon: PokemonWriteService,
        private readonly factory: PokemonFactory,
        private readonly random: Random,
        private readonly overlay: OverlayGateway,
        @Inject(REDEMPTION_SETTLER) private readonly settler: RedemptionSettler,
    ) {}

    /** `Pokemon Create`: a random level-1 Pokémon in the slot the viewer typed, replacing what was there. */
    async create(redemption: Redemption): Promise<void> {
        const { login } = redemption;
        const slot = parseSlot(redemption.input.trim());
        if (slot === null) {
            return this.refund(redemption, `@${login}, please enter a slot number between 1 and 6. You have been refunded`);
        }

        const fresh = await this.factory.randomFromDex();
        if (fresh.moves.length === 0) {
            this.logger.error(`Pokemon found with no moves: ${fresh.name}`);
            return this.refund(redemption, `@${login}, your pokemon ${fresh.name} has no moves. You have been refunded`);
        }

        try {
            await this.pokemon.createInSlot({ oauthId: redemption.userId, displayName: redemption.displayName }, fresh, slot);
        } catch (error) {
            if (error instanceof PokemonAwayError) {
                return this.refund(redemption, `@${login}, ${error.message}. You have been refunded`);
            }
            if (error instanceof TeamRuleError) return this.refund(redemption, `${error.message}. You have been refunded`);
            this.logger.error(`Create redeem failed for ${login} (slot ${slot})`, error instanceof Error ? error.stack : error);
            return this.refund(redemption, `@${login} failed to update/create pokemon in slot ${slot}. You have been refunded`);
        }
        await this.chat.say(
            `/me @${login}'s Level 1 ${fresh.shiny ? SHINY_BANNER : ''} ${fresh.name} roared ${this.random.pick(POKE_ROAR_ACTIONS)}`,
        );
    }

    /** `Pokemon Level Up`: +1 level for the starter. Points are kept only when it worked. */
    async levelUp(redemption: Redemption): Promise<void> {
        const { login } = redemption;
        try {
            const starter = await this.pokemon.levelUpStarter(redemption.userId);
            await this.chat.say(`@${login}'s ${starter.name} leveled up to ${starter.level}!`);
            await this.settler.fulfill(redemption);
        } catch (error) {
            if (error instanceof TeamRuleError || error instanceof PokemonAwayError) {
                return this.refund(redemption, `@${login}, ${error.message}. You will be automatically refunded`);
            }
            this.logger.error(`Level-up redeem failed for ${login}`, error instanceof Error ? error.stack : error);
            await this.refund(
                redemption,
                `@${login}, something went wrong leveling up your pokemon. You will be automatically refunded`,
            );
        }
    }

    /** `Pokemon Roar`: the starter appears on the stream overlay. */
    async roar(redemption: Redemption): Promise<void> {
        const { login } = redemption;
        try {
            const starter = await this.pokemon.starter(redemption.userId);
            if (!starter) return await this.refund(redemption, `@${login} you have no starter pokemon. You have been refunded`);
            if (isAwayInPmd(starter)) {
                const away = new PokemonAwayError(starter, 'roar');
                return await this.refund(redemption, `@${login}, ${away.message}. You have been refunded`);
            }
            if (this.overlay.clientCount <= 0) {
                this.logger.warn('Streamer not connected to the overlay while roaring');
                return await this.refund(redemption, 'Streamer not connected to browser source. You will be refunded');
            }
            this.overlay.broadcast({
                type: 'pokemon_roar',
                login,
                pokemon: {
                    name: starter.name,
                    nameId: starter.name_id,
                    dexNum: starter.dex_num,
                    level: starter.level,
                    shiny: starter.shiny,
                    gender: starter.gender,
                    color: starter.color,
                },
            });
        } catch (error) {
            this.logger.error(`Roar redeem failed for ${login}`, error instanceof Error ? error.stack : error);
            await this.refund(redemption, `@${login}: Unable to find a pokemon in Slot 1. You have been refunded`);
        }
    }

    private async refund(redemption: Redemption, message: string): Promise<void> {
        await this.chat.say(message);
        await this.settler.refund(redemption);
    }
}
