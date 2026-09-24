import { CHATBAN_DURATION_MS, VOICEBAN_DURATION_MS } from '../streamer-events';

export type VoteKind = 'chatban' | 'voiceban';

/** Distinct voters needed to ban the streamer. */
export const VOTE_THRESHOLD = 4;

export const BAN_DURATION_MS: Record<VoteKind, number> = {
    chatban: CHATBAN_DURATION_MS,
    voiceban: VOICEBAN_DURATION_MS,
};

/** What a vote needs from the rest of the bot. */
export interface VoteHost {
    /** The streamer's channel name, as the chat copy names them. */
    readonly channel: string;
    say(text: string): Promise<void>;
    /** Streamer clients connected on /api/ashketchum. */
    streamerClients(): number;
    /** Sends the ban to the streamer client(s). */
    sendBan(kind: VoteKind, durationMs: number): void;
}

/**
 * One running vote (`!chatban` or `!voiceban`), with the old bot's rules and
 * copy: each viewer counts once; at {@link VOTE_THRESHOLD} votes the ban is
 * sent and the streamer is "caged" — further votes are refused — until the
 * client reports the ban over (or disconnects), which resets the count.
 *
 * Voters are counted by Twitch user id; the old bot used the login, so a
 * rename let one viewer vote twice.
 */
export class VoteCounter {
    private readonly voters = new Set<string>();
    private caged = false;

    constructor(
        readonly kind: VoteKind,
        private readonly host: VoteHost,
        readonly threshold = VOTE_THRESHOLD,
    ) {}

    get count(): number {
        return this.voters.size;
    }

    get isCaged(): boolean {
        return this.caged;
    }

    async vote(voter: { id: string; login: string }): Promise<void> {
        const { channel } = this.host;
        if (this.host.streamerClients() <= 0) {
            await this.host.say(`${channel} is disconnected. Voting won't do sheet`);
            return;
        }
        if (this.caged) {
            await this.host.say(`${channel} is already caged. Wait until they are free again`);
            return;
        }
        if (this.voters.has(voter.id)) {
            await this.host.say(`You already voted, @${voter.login}`);
            return;
        }
        // Every state change happens before the first await, so two votes
        // arriving together cannot both trip the threshold and ban twice.
        this.voters.add(voter.id);
        const count = this.count;
        const banNow = count >= this.threshold;
        if (banNow) {
            this.caged = true;
            this.host.sendBan(this.kind, BAN_DURATION_MS[this.kind]);
        }
        await this.host.say(`Your vote is ${count} of ${this.threshold} >:)`);
        if (!banNow) return;
        await this.host.say(
            this.kind === 'chatban'
                ? `Removing ${channel}'s "Enter" key for 5 minutes...`
                : `Removing ${channel}'s voice for 30 seconds...`,
        );
    }

    /** Clears the voters and frees the streamer. */
    reset(): void {
        this.voters.clear();
        this.caged = false;
    }
}
