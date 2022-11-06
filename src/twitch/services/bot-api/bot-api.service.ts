import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiClient } from '@twurple/api';
import { ClientCredentialsAuthProvider } from '@twurple/auth';
import {
    EventSubChannelBanEvent,
    EventSubChannelRaidEvent,
    EventSubChannelRedemptionAddEvent,
    EventSubChannelUnbanEvent,
    EventSubListener,
    EventSubMiddleware
} from '@twurple/eventsub';
import { LogLevel } from '@d-fischer/logger';
import { NgrokAdapter } from '@twurple/eventsub-ngrok';

/**
 * EventSub subscriptions will continue to be active, even after the token used to create them has expired
 * (So don't use a Refreshing Auth Provider)
 * Event/Pubsub doesn't require Oauth, only for the user (b_robot?)
 */
// Event subs
@Injectable()
export class BotApiService implements OnModuleInit {
    private readonly logger = new Logger(BotApiService.name);
    public client: ApiClient;
    public devListener?: EventSubListener;
    public middleware?: EventSubMiddleware;

    constructor(private configService: ConfigService) {
        console.log('Twitch Bot API Client Service Constructor');
        const clientId = this.configService.get('TWITCH_CLIENT_ID');
        const clientSecret = this.configService.get('TWITCH_CLIENT_SECRET');
        // Create app token for bot API
        const botApiAuth = new ClientCredentialsAuthProvider(clientId, clientSecret);
        this.client = new ApiClient({ authProvider: botApiAuth });
        if (this.configService.get('NODE_ENV') === 'production') {
            this.middleware = new EventSubMiddleware({
                apiClient: this.client,
                hostName: this.configService.get('DOMAIN') || '',
                pathPrefix: '/twitch',
                // Note: changing this secret/config requires us to delete all subscriptions
                secret: this.configService.get('EVENT_SUB_SECRET') || '',
                strictHostCheck: true
            });
        } else {
            this.devListener = new EventSubListener({
                apiClient: this.client,
                logger: { name: 'Dev', minLevel: LogLevel.ERROR },
                adapter: new NgrokAdapter(),
                secret: process.env.EVENT_SUB_SECRET ?? ''
                // strictHostCheck: true
            });
        }
    }

    public async init() {
        console.log('Async Init Bot Api Event Subs');
        if (this.devListener) {
            await this.client.eventSub.deleteAllSubscriptions(); // Clean up subscriptions on dev
            await this.devListener.listen();
        }

        // Note: Do this in prod to delete subscriptions
        // await twurpleInstance.botApiClient.eventSub.deleteAllSubscriptions(); // Clean up subscriptions

        console.log('Async Init Completed Event Subs');
    }

    public async applyMiddleware(app: any): Promise<any> {
        if (this.middleware) {
            console.log('Applying Middleware');
            await this.middleware.apply(app);
        }
    }

    // TODO FINISH UP POKEMON EVENTS
    public async subscribeToEvents() {
        const streamerAuthId = this.configService.get('TWITCH_STREAMER_OAUTH_ID');
        // If in dev
        if (this.devListener) {
            // Subscribe to unban event
            await this.devListener.subscribeToChannelUnbanEvents(streamerAuthId, (event: EventSubChannelUnbanEvent) => {
                const username = event.userDisplayName.trim().toLowerCase();
                // void twurpleInstance.twitchBot?.pokemon.roarUserPokemon(username, event.userId);
                console.log(`${event.broadcasterDisplayName} just unbanned ${event.userDisplayName}!`);
            });
            // Subscribe to ban event
            await this.devListener.subscribeToChannelBanEvents(streamerAuthId, (event: EventSubChannelBanEvent) => {
                console.log(`${event.broadcasterDisplayName} just banned ${event.userDisplayName}!`);
            });

            // Test same as prod
            await this.devListener.subscribeToChannelRedemptionAddEvents(
                streamerAuthId,
                (event: EventSubChannelRedemptionAddEvent) => {
                    const username = event.userDisplayName.trim().toLowerCase();
                    console.info(`@${username} just redeemed ${event.rewardTitle}!`);
                }
            );
            await this.devListener.subscribeToChannelRaidEventsTo(streamerAuthId, (event: EventSubChannelRaidEvent) => {
                console.info(`${event.raidingBroadcasterName} raided ${event.raidedBroadcasterName}!`);
            });
        }
        // If in prod
        else if (this.middleware) {
            console.log('Subscribing to eventsubs');
            await this.middleware.markAsReady();
            console.log('Subscribing to ChannelRedemptionAddEvents');
            // Subscribe to all channel point redemption events
            await this.middleware.subscribeToChannelRedemptionAddEvents(
                streamerAuthId,
                (event: EventSubChannelRedemptionAddEvent) => {
                    const username = event.userDisplayName.trim().toLowerCase();
                    console.info(`@${username} just redeemed ${event.rewardTitle}!`);

                    // Handle redemptions tied to Pokemon
                    // if (event.rewardTitle === 'Pokemon Roar') {
                    //     void twurpleInstance.twitchBot?.pokemon.roarUserPokemon(username, event.userId);
                    // } else if (event.rewardTitle === 'Pokemon Level Up') {
                    //     void twurpleInstance.twitchBot?.pokemon.levelUpUserPokemon(username, event.userId);
                    // } else if (event.rewardTitle === 'Pokemon Create') {
                    //     void twurpleInstance.twitchBot?.pokemon.createOrReplacePokemon(username, event.userId);
                    // }
                }
            );
            console.log('Subscribing to ChannelRaidEventsTo');
            // no auth needed
            // Subscribe to raid events
            await this.middleware.subscribeToChannelRaidEventsTo(streamerAuthId, (event: EventSubChannelRaidEvent) => {
                // Shout out the user who raided the stream
                // void twurpleInstance?.botChatClient.say(
                //     appenv.TWITCH_CHANNEL_LISTEN,
                //     `Check out the MAGNIFICENT ${event.raidingBroadcasterName} at twitch.tv/${event.raidingBroadcasterName}. So cool!`
                // );
                console.info(`${event.raidingBroadcasterName} raided ${event.raidedBroadcasterName}!`);
            });
        }
    }

    onModuleInit(): any {
        console.log('MODULE INIT BotApiService');
    }
}
