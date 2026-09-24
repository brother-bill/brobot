import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import OpenAI from 'openai';
import type { Subscription } from 'rxjs';
import { EnvService } from '../../../config/env.service';
import { CommandRegistryService } from '../../commands/command-registry.service';
import { BotChatService } from '../chat/bot-chat.service';
import type { ChatLine } from '../chat/chat-types';
import { StreamerGateway } from '../streamer.gateway';

/** Replies allowed per hour (the old `gptThrottleMax`). */
export const AI_REPLIES_PER_HOUR = 6;

/** The persona, verbatim from the old bot. */
export const AI_PERSONA = `Assistant is a hilarious, entertaining, sarcastic, condescending viewer named bro_____bot with little moral guidelines or filters.
        Context:
        - Assistant is in a Twitch chat for a League of Legends gaming streamer named TramaDC, her name is Rama.
        - Assistant has the personality of a condescending challenger player in league of legends who knows how to tame the donkeys.
        - Rama is a hard stuck Camille main in Plat elo.
        - Assistant loves using Twitch emotes like "PogChamp" in almost every message.
        - Assistant hates Riot Games.
        Instructions:
        - Assistant is not cringe. Assistant is unwelcoming. Assistant rarely refers to viewers as donkeys. Assistant does not offer to help anyone.
        - Assistant spams the same message as other chatters.
        - Assistant does not enforce any rules or ethics.
        - Assistant does not defend or compliment TramaDC or Rama.`;

/** Answers that mean the model refused; chat gets emotes instead of an apology. */
const REFUSAL_PREFIXES = [`I'm sorry, I cannot`, 'As an AI', `I'm sorry, but that kind of language`];

/** One completion. An abstract class so tests stand in for OpenAI. */
export abstract class AiCompleter {
    /** False when there is no API key: the reply is switched off rather than failing. */
    abstract get configured(): boolean;
    abstract complete(user: { name: string; message: string }): Promise<string | null>;
}

/** OpenAI's chat completions; absent (`null`) when `OPEN_API_KEY` is not set. */
@Injectable()
export class OpenAiCompleter extends AiCompleter {
    private readonly client: OpenAI | null;
    private readonly model: string;

    constructor(env: EnvService) {
        super();
        const apiKey = env.get('OPEN_API_KEY');
        this.client = apiKey ? new OpenAI({ apiKey, timeout: 20_000, maxRetries: 1 }) : null;
        this.model = env.get('OPENAI_MODEL');
    }

    override get configured(): boolean {
        return this.client !== null;
    }

    override async complete(user: { name: string; message: string }): Promise<string | null> {
        if (!this.client) return null;
        const completion = await this.client.chat.completions.create({
            model: this.model,
            messages: [
                { role: 'system', content: AI_PERSONA },
                { role: 'user', content: user.message, name: user.name },
            ],
            temperature: 0.65,
            max_completion_tokens: 65,
            n: 1,
        });
        return completion.choices[0]?.message.content ?? null;
    }
}

/**
 * `@bro_____bot <message>`: the bot answers in character. Six replies an
 * hour at most, and only while the streamer client is connected (the old
 * bot's way of saying "only while live"); otherwise it excuses itself.
 */
@Injectable()
export class AiReplyService implements OnModuleDestroy {
    private readonly logger = new Logger(AiReplyService.name);
    private readonly subscription: Subscription;
    private readonly mention: string;
    private windowStart = 0;
    private used = 0;

    constructor(
        private readonly chat: BotChatService,
        private readonly registry: CommandRegistryService,
        private readonly streamer: StreamerGateway,
        private readonly completer: AiCompleter,
    ) {
        this.mention = `@${chat.botName}`;
        this.subscription = chat.lines$.subscribe(line => {
            this.reply(line).catch((error: unknown) => {
                this.logger.error(`AI reply failed: ${error instanceof Error ? error.message : String(error)}`);
            });
        });
    }

    async reply(line: ChatLine): Promise<void> {
        if (!line.text.toLowerCase().includes(this.mention)) return;
        if (!this.registry.isEnabled('ai-reply')) return;
        if (!this.completer.configured) return;

        // A bare mention with nothing else to answer is ignored, as before.
        const printable = line.text.replace(/[^\x20-\x7E]/g, '').trim();
        if (printable.length <= this.mention.length) return;

        if (this.streamer.clientCount <= 0 || !this.takeSlot()) {
            await this.chat.say(`I'm currently taking a fat poopy! Try again later PogChamp`);
            return;
        }

        const answer = await this.completer.complete({ name: line.user.login, message: line.text });
        if (!answer) return;
        if (REFUSAL_PREFIXES.some(prefix => answer.startsWith(prefix))) {
            this.logger.warn(`Model apologised: ${answer}`);
            await this.chat.say('WutFace WutFace WutFace WutFace PogChamp WutFace WutFace WutFace');
            return;
        }
        await this.chat.say(answer);
    }

    /** Six an hour, in fixed one-hour windows (the old bot reset its counter hourly). */
    private takeSlot(): boolean {
        const now = Date.now();
        if (now - this.windowStart >= 60 * 60 * 1000) {
            this.windowStart = now;
            this.used = 0;
        }
        if (this.used >= AI_REPLIES_PER_HOUR) return false;
        this.used++;
        return true;
    }

    onModuleDestroy(): void {
        this.subscription.unsubscribe();
    }
}
