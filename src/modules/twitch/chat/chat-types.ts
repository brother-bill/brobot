import type { ParsedCommand } from '../../commands/command-parser';

/** Who said something in chat. */
export interface ChatUser {
    /** Twitch user id — the key every table uses. */
    id: string;
    /** Lower-case login; the name the old bot addressed people by (`@login`). */
    login: string;
    displayName: string;
    isBroadcaster: boolean;
    isMod: boolean;
}

/** Any chat line. */
export interface ChatLine {
    user: ChatUser;
    text: string;
}

/** A chat line that parsed as a `!command`. */
export interface ChatCommand extends ChatLine {
    command: ParsedCommand;
}

/** What the handlers need from the chat connection. {@link BotChatService} is the real one. */
export interface ChatSay {
    say(text: string): Promise<void>;
}
