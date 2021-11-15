import process from 'process';
import { ChatClient } from '@twurple/chat';
import { Instance } from 'express-ws';
import { OutgoingEvents } from '../types/EventsInterface.js';

// Only implements public properties (from getter)
interface VoiceBanInterface {
    currentVoteCount: number;
    activateVoteThreshold: number;
    isListening: boolean;
}

// todo count how many times you lost to a user lichess
export class VoiceBan implements VoiceBanInterface {
    private readonly _twitchBotUsername = process.env.TWITCH_BOT_USERNAME || '';
    private readonly _activateVoteThreshold: number;
    private readonly _channel: string; // Twitch channel
    private _currentVoteCount: number;
    private _uniqueVotedUsers: Set<string>;
    private _isListening: boolean; // Is ChatBan listening for more messages?

    constructor(private _twurpleChatClient: ChatClient, private _wsInstance: Instance) {
        // Add bot so it doesn't respond to itself. This is already handled by Twurple though.
        this._uniqueVotedUsers = new Set(this._twitchBotUsername);
        this._isListening = true;
        this._currentVoteCount = 0;
        this._activateVoteThreshold = 6;
        this._channel = process.env.TWITCH_CHANNEL_LISTEN || '';
    }

    get currentVoteCount(): number {
        return this._currentVoteCount;
    }

    get activateVoteThreshold(): number {
        return this._activateVoteThreshold;
    }

    get isListening(): boolean {
        return this._isListening;
    }

    set isListening(isListening: boolean) {
        this._isListening = isListening;
    }

    _resetUniqueVotedUsers(): void {
        this._isListening = true;
        this._resetCurrentVoteCount();
        this._uniqueVotedUsers.clear();
        this._uniqueVotedUsers.add(this._twitchBotUsername);
    }

    _incrementCurrentVoteCount(): void {
        this._currentVoteCount++;
    }

    _resetCurrentVoteCount(): void {
        this._currentVoteCount = 0;
    }

    _addUniqueUser(username: string): void {
        this._uniqueVotedUsers.add(username);
    }

    _isUserUnique(username: string): boolean {
        return !this._uniqueVotedUsers.has(username);
    }

    // todo duplicate code
    getListeningClientsOnSocket(): number {
        return this._wsInstance.getWss().clients.size;
    }

    async handleMessage(username: string): Promise<void> {
        // Always have to reset ongoing events like this when client closes connection (brobotsocket)
        // Only do something if client is listening
        if (this.getListeningClientsOnSocket() > 0) {
            // If still listening for chatban messages
            if (this._isListening) {
                // If unique user
                if (this._isUserUnique(username)) {
                    this._addUniqueUser(username);
                    this._incrementCurrentVoteCount();
                    await this._twurpleChatClient.say(
                        this._channel,
                        `Your vote is ${this._currentVoteCount} of ${this._activateVoteThreshold} >:)`
                    );
                } else {
                    await this._twurpleChatClient.say(this._channel, `You already voted, ${username}`);
                }
                if (this._currentVoteCount >= this._activateVoteThreshold) {
                    this._isListening = false;
                    // Send CHATBAN event to client
                    this._wsInstance.getWss().clients.forEach(localClient => {
                        // TODO if client === trama
                        localClient.send(OutgoingEvents.VOICEBAN);
                        // void needed since we don't need to do anything after. Can't reject
                        void this._twurpleChatClient.say(
                            this._channel,
                            `Vote Requirements Met. Removing ${this._channel}'s voice for 30 seconds...`
                        );
                    });
                }
            } else {
                await this._twurpleChatClient.say(
                    this._channel,
                    'Trama is already muted. Wait until she is free again.'
                );
            }
        } else {
            await this._twurpleChatClient.say(
                this._channel,
                `${this._channel} is disconnected. This command won't do sheet`
            );
        }
    }
}