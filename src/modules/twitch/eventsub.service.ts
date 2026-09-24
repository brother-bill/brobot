import { Injectable, Logger } from '@nestjs/common';
import { ApiClient } from '@twurple/api';
import { AppTokenAuthProvider } from '@twurple/auth';
import { EventSubMiddleware } from '@twurple/eventsub-http';
import type { Express } from 'express';
import { EnvService } from '../../config/env.service';
import { BotChatService } from './chat/bot-chat.service';
import { RedemptionsService } from './redeems/redemptions.service';

/**
 * Twurple types its router against express-serve-static-core 5; the app runs
 * express 4. The runtime calls it makes (`router.post(path, handler)`) are
 * the same in both.
 */
type EventSubRouter = Parameters<EventSubMiddleware['apply']>[0];

/** Where Twitch posts EventSub notifications: `https://$DOMAIN/twitch/…` (outside the `/api` prefix, as before). */
export const EVENTSUB_PATH_PREFIX = '/twitch';

/**
 * EventSub over webhooks, mounted on the API's own Express app (Twurple's
 * `EventSubMiddleware`), behind `TWITCH_EVENTSUB_ENABLED`. `main.ts` calls
 * {@link apply} before the app listens — the middleware must see the raw
 * request body, so it has to sit ahead of Nest's JSON parser, which Nest
 * installs when the app initialises — and {@link subscribe} once it listens.
 * That is the order the old main.ts used.
 *
 * Subscribed: channel-point redemptions (the Pokémon rewards and `Enable
 * Quacks`) and incoming raids (a shout-out). Webhook subscriptions use an app
 * token; Twitch checks the streamer's own grant (`channel:read:redemptions`,
 * from the streamer OAuth flow) when it creates them.
 */
@Injectable()
export class EventSubService {
    private readonly logger = new Logger(EventSubService.name);
    private middleware: EventSubMiddleware | null = null;

    constructor(
        private readonly env: EnvService,
        private readonly redemptions: RedemptionsService,
        private readonly chat: BotChatService,
    ) {}

    get enabled(): boolean {
        return this.env.get('TWITCH_EVENTSUB_ENABLED');
    }

    /** Mounts the webhook routes on `app`. A no-op unless EventSub is enabled. */
    apply(app: Express): void {
        if (!this.enabled) {
            this.logger.log('TWITCH_EVENTSUB_ENABLED=false — no EventSub (channel-point redeems and raids are not received)');
            return;
        }
        const apiClient = new ApiClient({
            authProvider: new AppTokenAuthProvider(this.env.get('TWITCH_CLIENT_ID'), this.env.get('TWITCH_CLIENT_SECRET')),
        });
        this.middleware = new EventSubMiddleware({
            apiClient,
            hostName: this.env.get('DOMAIN'),
            pathPrefix: EVENTSUB_PATH_PREFIX,
            // Changing the secret orphans every existing subscription (Twitch signs with the old one).
            secret: this.env.get('EVENT_SUB_SECRET'),
            strictHostCheck: true,
        });
        this.middleware.apply(app as unknown as EventSubRouter);
        this.logger.log(`EventSub webhook mounted at https://${this.env.get('DOMAIN')}${EVENTSUB_PATH_PREFIX}`);
    }

    /** Marks the middleware ready and subscribes. Call after the server listens. */
    async subscribe(): Promise<void> {
        const middleware = this.middleware;
        if (!middleware) return;
        await middleware.markAsReady();

        middleware.onSubscriptionCreateSuccess(subscription => this.logger.log(`EventSub subscribed: ${subscription.id}`));
        middleware.onSubscriptionCreateFailure((subscription, error) =>
            this.logger.error(`EventSub subscription ${subscription.id} failed: ${error.message}`),
        );
        middleware.onRevoke((subscription, status) =>
            this.logger.warn(`Twitch revoked EventSub subscription ${subscription.id}: ${status}`),
        );

        const streamerId = this.env.get('TWITCH_STREAMER_OAUTH_ID');
        middleware.onChannelRedemptionAdd(streamerId, event => {
            void this.redemptions.handle({
                id: event.id,
                rewardId: event.rewardId,
                rewardTitle: event.rewardTitle,
                userId: event.userId,
                login: event.userName.toLowerCase(),
                displayName: event.userDisplayName,
                input: event.input,
            });
        });
        middleware.onChannelRaidTo(streamerId, event => {
            const raider = event.raidingBroadcasterName;
            void this.chat.say(`Check out the MAGNIFICENT ${raider} at twitch.tv/${raider} . So cool!`);
        });
    }
}
