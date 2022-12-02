import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TwitchBotAuthService } from 'src/database/services/twitch-bot-auth/twitch-bot-auth.service';
import { AccessToken, RefreshingAuthProvider } from '@twurple/auth';
import { ChatClient } from '@twurple/chat';
import { TwitchPrivateMessage } from '@twurple/chat/lib/commands/TwitchPrivateMessage';
import { Subject, Subscription } from 'rxjs';
import { StreamerGateway } from 'src/twitch/gateways/streamer/streamer.gateway';
import { CronJob, CronTime } from 'cron';
import { StreamerApiService } from 'src/twitch/services/streamer-api/streamer-api.service';
import { HelixBanUserRequest } from '@twurple/api/lib/api/helix/moderation/HelixModerationApi';
import { TwitchUserWithRegisteredBot } from 'src/database/services/twitch-user/twitch-user.service';
import { AdminUiGateway } from 'src/twitch/gateways/ui/admin-ui.gateway';
import { EventSubChannelRedemptionAddEvent } from '@twurple/eventsub';

export interface CommandStream extends MessageStream {
    command: {
        args: string[];
        msg?: string;
    };
}

export interface MessageStream {
    channel: string;
    username: string;
    message: string;
    pvtMessage: TwitchPrivateMessage;
}

@Injectable()
export class BotChatService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(BotChatService.name);

    private readonly channel: string;
    private botOauthId: string;

    private notifyChatInterval: NodeJS.Timer;
    private prizeRickRollCron: CronJob;
    private luluCount = 0;

    private commandSubscription: Subscription;
    private messageSubscription: Subscription;

    public commandStream = new Subject<CommandStream>();
    public msgStream = new Subject<MessageStream>();

    public client?: ChatClient;

    private streamerAuthId: string;

    constructor(
        private configService: ConfigService,
        private twitchBotAuthService: TwitchBotAuthService,
        // @Inject(forwardRef(() => StreamerGateway))
        private streamerGateway: StreamerGateway,
        private streamerApiService: StreamerApiService, // TODO Need another chat service for banning lulu
        // @Inject(forwardRef(() => AdminUiGateway))

        private adminUiGateway: AdminUiGateway
    ) {
        this.channel = this.configService.get('TWITCH_STREAMER_CHANNEL_LISTEN') ?? '';
        this.botOauthId = this.configService.get('TWITCH_BOT_OAUTH_ID') ?? '';
        this.streamerAuthId = this.configService.get('TWITCH_STREAMER_OAUTH_ID') ?? '';
        this.notifyChatInterval = this.createChatNotifyInterval();
        this.prizeRickRollCron = this.createPrizeRickRollCron();

        this.commandSubscription = this.commandStream.subscribe(async (stream: CommandStream) => {
            await this.handleCommand(stream);
        });
        this.messageSubscription = this.msgStream.subscribe(async (stream: MessageStream) => {
            await this.handleMessage(stream);
        });
    }

    onModuleInit(): any {
        //
    }

    onModuleDestroy(): any {
        this.commandSubscription.unsubscribe();
        this.messageSubscription.unsubscribe();
    }

    public async clientSay(msg: string) {
        if (!this.client) {
            this.logger.error('Client Not Initialized For Chat', msg);
            return;
        }
        await this.client.say(this.channel, msg);
    }

    // todo remove
    public async checkUser(obj: { pokemonLevel: number; pokemonName: string; twitchName: string; uid: string }) {
        return this.streamerApiService.client?.users.getUserById(obj.uid);
    }

    async init() {
        await this.initChatClient();
    }

    private async initChatClient() {
        const twitchUserBotAuth = await this.getTwurpleOptions(this.botOauthId);
        if (!twitchUserBotAuth) {
            this.logger.error('No Bot Auth, BotChatClient cannot be created');
            return;
        }

        const refreshingAuthProvider = this.createTwurpleRefreshingAuthProvider(twitchUserBotAuth);
        if (!refreshingAuthProvider) {
            this.logger.error('No RefreshingAuthProvider, BotChatClient cannot be created');
            return;
        }

        this.client = await this.createChatBotClientAndWaitForConnection(refreshingAuthProvider);
        this.client.onMessage((channel, username, message, pvtMessage: TwitchPrivateMessage) => {
            // this.logger.log(`@${username}: ${message}`);

            const formattedMsg = message.trim();

            if (formattedMsg.startsWith('!')) {
                const args = formattedMsg.slice(1).split(' '); // Remove ! and parse arguments after command
                const command = {
                    args,
                    msg: args.shift()?.toLowerCase() // Only get command and modify args in place to exclude command
                };
                this.commandStream.next({ channel, username, message, command, pvtMessage });
            }

            this.msgStream.next({ channel, username, message, pvtMessage });
        });
    }

    private async createChatBotClientAndWaitForConnection(authProvider: RefreshingAuthProvider): Promise<ChatClient> {
        const botChatClient = new ChatClient({
            authProvider,
            isAlwaysMod: true, // https://twurple.js.org/reference/chat/interfaces/ChatClientOptions.html#isAlwaysMod
            channels: [this.channel]
        });

        // 100 requests per 30 seconds
        this.logger.warn('Connecting To Twurple Bot Chat Client...');
        // connect just makes the WSS connection, registration logs you in
        await botChatClient.connect();

        // return botChatClient;
        // Don't return until chat client is registered and connected.
        //  TODO: Very dangerous eh? This blocks the entire app if it can't connect
        return new Promise<ChatClient>(resolve => {
            botChatClient.on(botChatClient.onRegister, () => {
                this.logger.warn('Twitch Bot Registered');
                resolve(botChatClient);
            });
        });
    }

    private createTwurpleRefreshingAuthProvider(
        twitchUserBotAuth: TwitchUserWithRegisteredBot
    ): RefreshingAuthProvider | null {
        if (!twitchUserBotAuth.registeredBotAuth) {
            this.logger.log('No Registered Bot Auth for User', twitchUserBotAuth);
            return null;
        }

        const currentAccessToken: AccessToken = {
            accessToken: twitchUserBotAuth.registeredBotAuth.accessToken,
            refreshToken: twitchUserBotAuth.registeredBotAuth.refreshToken,
            scope: twitchUserBotAuth.registeredBotAuth.scope,
            expiresIn: twitchUserBotAuth.registeredBotAuth.expirySeconds,
            obtainmentTimestamp: Number(twitchUserBotAuth.registeredBotAuth.obtainmentEpoch)
        };

        return new RefreshingAuthProvider(
            {
                clientId: this.configService.get('TWITCH_CLIENT_ID') ?? '',
                clientSecret: this.configService.get('TWITCH_CLIENT_SECRET') ?? '',
                onRefresh: async (newTokenData: AccessToken) => {
                    this.logger.warn('New Bot Access Token', newTokenData.accessToken, newTokenData.scope);
                    try {
                        const user = await this.twitchBotAuthService.upsertUserBotAuth(
                            twitchUserBotAuth.oauthId,
                            newTokenData
                        );
                        if (!user) {
                            this.logger.error('Could Not Update User Bot Auth');
                            return;
                        }
                        const botAuth = user.registeredBotAuth;
                        this.logger.warn(
                            `Success Update Twurple Options DB Bot: ${botAuth?.accessToken} - ${botAuth?.expirySeconds} - ${botAuth?.scope}`
                        );
                    } catch (err) {
                        this.logger.error('Error Upserting User Bot Auth', err);
                    }
                }
            },
            currentAccessToken
        );
    }

    private async getTwurpleOptions(oauthId: string): Promise<TwitchUserWithRegisteredBot | null> {
        try {
            const twitchUserBotAuth = await this.twitchBotAuthService.getUniqueTwitchUserWithBotAuth(oauthId);

            if (!twitchUserBotAuth) {
                this.logger.error('No User Found For Bot Auth', twitchUserBotAuth);
                return null;
            }
            if (!twitchUserBotAuth?.registeredBotAuth) {
                this.logger.error('No Registered Bot Auth for User', oauthId);
                return null;
            }

            return twitchUserBotAuth;
        } catch (err) {
            this.logger.error('Error Getting Bot Options From DB', err);
        }

        return null;
    }

    ////////////////////////////////////////////
    ////////////////////////////////////////////
    // TODO Should be in own messaging service

    private randomIntFromInterval(min: number, max: number): number {
        // min and max included
        return Math.floor(Math.random() * (max - min + 1) + min);
    }

    // todo is this working right?
    private createPrizeRickRollCron(): CronJob {
        // https://crontab.cronhub.io/ second minute hour day of month, months, day of week
        // At 11pm every 2 days, after which, becomes random time
        const cronJob = new CronJob(
            '0 0 23 */2 * *',
            () => {
                if (this.streamerGateway.getCurrentClientsOnSocket > 0) {
                    this.clientSay(`/me OFFICIAL TRAMADC PRIZE DROP ALERT?! https://tinyurl.com/tramaDCPrizeNow`);
                    this.clientSay(`/me OFFICIAL TRAMADC PRIZE DROP ALERT?! https://tinyurl.com/tramaDCPrizeNow`);
                }
                const randomHour = this.randomIntFromInterval(0, 23);
                this.logger.log('New Rick Roll Time', randomHour);
                cronJob.setTime(new CronTime(`0 0 ${randomHour} */2 * *`, 'America/New_York'));
            },
            null,
            true,
            'America/New_York'
        );
        // cronJob.start(); Only if false set for start in new CronJob({})
        return cronJob;
    }

    private createChatNotifyInterval(): NodeJS.Timer {
        const uiUrl = process.env.UI_URL || '';
        const commandsUrl = `${uiUrl}/commands`;

        return setInterval(() => {
            if (this.streamerGateway.getCurrentClientsOnSocket > 0) {
                this.clientSay(
                    `Use the commands: "!chatban" or "!voiceban", when ${this.channel} gets too emotional. Other commands can be found here: ${commandsUrl}`
                );
            }
        }, 1000 * 60 * 30); // Every 30 minutes
    }

    private async cancelRedemption(event: EventSubChannelRedemptionAddEvent) {
        await this.streamerApiService.client?.channelPoints.updateRedemptionStatusByIds(
            this.streamerAuthId,
            event.rewardId,
            [event.id],
            'CANCELED'
        );
    }
    public async enableQuacks(event: EventSubChannelRedemptionAddEvent): Promise<void> {
        try {
            if (this.canQuack) {
                await this.cancelRedemption(event);
                const username = event.userName;
                await this.clientSay(`/me @${username}, quacks are already enabled. You have been refunded`);
                return;
            }

            if (this.adminUiGateway.getCurrentClientsOnSocket <= 0) {
                await this.cancelRedemption(event);
                await this.clientSay(
                    `/me Trama is not connected to browser source, so quacks won't work. You have been refunded`
                );
                return;
            }

            this.enableQuack();
            await this.clientSay(`/me The command "!quack" has been enabled. Go get em`);
        } catch (err) {
            this.logger.error('Error Quack Redeem');
        }
    }
    public async redeemTimeoutUser(event: EventSubChannelRedemptionAddEvent): Promise<void> {
        try {
            const userToBan = event.input.trim().toLowerCase();
            if (userToBan === 'tramadc' || userToBan === 'bro_____bot') {
                await this.cancelRedemption(event);
                this.clientSay(`/me Nice try... You have been refunded`);
                return;
            }
            const userAPI = await this.streamerApiService.client?.users.getUserByName(userToBan);
            if (!userAPI) {
                await this.cancelRedemption(event);
                this.clientSay(
                    `/me Could not find user, ${userToBan}. @${event.userDisplayName
                        .trim()
                        .toLowerCase()}, you have been refunded`
                );
                return;
            }

            const userId = userAPI.id;
            const isMod = await this.streamerApiService.client?.moderation.checkUserMod(this.streamerAuthId, userId);

            const helixBan: HelixBanUserRequest = {
                duration: 180,
                reason: 'The rich have power',
                userId: userId
            };

            this.streamerApiService.client?.moderation
                .banUser(this.streamerAuthId, this.streamerAuthId, helixBan)
                .then(() => {
                    this.clientSay(`/me See you in 3 minutes, @${userToBan}`);
                    if (isMod) {
                        setTimeout(() => {
                            this.streamerApiService.client?.moderation.addModerator(this.streamerAuthId, userId);
                        }, 185000);
                    }
                })
                .catch(err => {
                    this.cancelRedemption(event);
                    this.clientSay(`/me Error Timing Out User :thinking:. You have been refunded`);
                    this.logger.error('Error Timing Out User 1', err);
                });
        } catch (err) {
            await this.cancelRedemption(event);
            this.clientSay(`/me Error Timing Out User :thinking:. You have been refunded`);
            this.logger.error('Error Timing Out User ', err);
        }
    }
    /**
     * Create and send a Rock, Paper, Scissor url for viewers
     * @param username
     * @private
     */
    private async createRPSUrl(username: string): Promise<void> {
        const randomNum = Math.floor(Math.random() * 100000); // Assign random id to url
        this.clientSay(
            `@${username} wants to play Rock Paper Scissors. https://www.rpsgame.org/room?id=turbosux${randomNum}`
        );
    }

    public reloadBrowserSource(): void {
        this.adminUiGateway.reloadBrowserSource();
    }
    canQuack = true;
    enableQuack(): void {
        this.canQuack = true;
    }
    public disableQuack(): void {
        this.canQuack = false;
    }
    private async handleCommand(stream: CommandStream) {
        if (stream.command.msg?.includes('quack')) {
            if (this.canQuack) {
                this.adminUiGateway.quack();
            }
        }
        switch (stream.command.msg) {
            case 'ping':
                this.clientSay('pong!');
                break;
            case 'dice': {
                const diceRoll = Math.floor(Math.random() * 6) + 1;
                this.clientSay(`@${stream.username} rolled a ${diceRoll}`);
                break;
            }
            case 'rps':
                await this.createRPSUrl(stream.username);
                break;
            case 'commands':
            case 'command':
                const commandsUrl = `${this.configService.get<string>('UI_URL')}/commands`;
                await this.clientSay(`Commands: ${commandsUrl}`);
                break;
        }
    }

    private async handleLulu(stream: MessageStream) {
        // Replace whitespace and parse string for lulu
        if (stream.message.toLowerCase().replace(/\s+/g, '').indexOf('lulu') !== -1) {
            switch (this.luluCount) {
                case 0:
                    this.clientSay(`/me Lulu is not allowed on this channel`);
                    this.luluCount++;
                    break;
                case 1:
                    this.clientSay(`/me Next person to say Lulu gets timed out`);
                    this.luluCount++;
                    break;
                case 2:
                    try {
                        const userId = stream.pvtMessage.userInfo.userId;
                        const isMod = await this.streamerApiService.client?.moderation.checkUserMod(
                            this.streamerAuthId,
                            userId
                        );

                        const helixBan: HelixBanUserRequest = {
                            duration: 30,
                            reason: 'lulu',
                            userId: userId
                        };
                        this.streamerApiService.client?.moderation
                            .banUser(this.streamerAuthId, this.streamerAuthId, helixBan)
                            .then(() => {
                                this.clientSay(`/me Look what you've done, @${stream.username}`);
                                if (isMod) {
                                    setTimeout(() => {
                                        this.streamerApiService.client?.moderation.addModerator(
                                            this.streamerAuthId,
                                            userId
                                        );
                                    }, 35000);
                                }
                            })
                            .catch(err => {
                                this.clientSay(`/me Error Timing Out User :thinking:`);
                                this.logger.error('Error banning user', err);
                            });
                        // this.client
                        //     ?.timeout(this.channel, stream.username, 30, 'Lulu')
                        //     .then(sum => {
                        //     })
                        //     .catch(err => {
                        //         this.logger.error('Error Lulu Ban', err);
                        //     });
                    } catch (err) {
                        this.clientSay(`/me Error Timing Out User :thinking:`);
                        this.logger.error('Error Timing Out User', err);
                    }
                    this.luluCount = 0;
                    break;
                default:
                    this.logger.error(`How did we get here? Count: ${this.luluCount}`);
                    this.luluCount = 0;
            }
        }
    }

    private async handleMessage(msgStream: MessageStream) {
        await this.handleLulu(msgStream);
    }
}
//
