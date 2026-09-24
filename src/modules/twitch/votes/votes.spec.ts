import { Subject } from 'rxjs';
import { fakeChat, memoryRegistry, viewer } from '../../../../test/bot-fakes';
import { testEnvService } from '../../../../test/helpers';
import type { StreamerGateway } from '../streamer.gateway';
import type { StreamerClientEvent, StreamerServerEvent } from '../streamer-events';
import { VoteCounter, VOTE_THRESHOLD } from './vote-counter';
import type { VoteHost, VoteKind } from './vote-counter';
import { VotesService } from './votes.service';

function host(clients = 1): VoteHost & { said: string[]; bans: [VoteKind, number][]; clients: number } {
    const state = {
        channel: 'trama',
        said: [] as string[],
        bans: [] as [VoteKind, number][],
        clients,
        say: async (text: string) => {
            state.said.push(text);
        },
        streamerClients: () => state.clients,
        sendBan: (kind: VoteKind, durationMs: number) => {
            state.bans.push([kind, durationMs]);
        },
    };
    return state;
}

describe('VoteCounter', () => {
    it('needs four distinct viewers', () => {
        expect(VOTE_THRESHOLD).toBe(4);
    });

    it('counts each viewer once, then bans at the threshold', async () => {
        const h = host();
        const vote = new VoteCounter('chatban', h);
        await vote.vote(viewer('a'));
        await vote.vote(viewer('a'));
        await vote.vote(viewer('b'));
        await vote.vote(viewer('c'));
        expect(h.bans).toEqual([]);
        await vote.vote(viewer('d'));

        expect(h.said).toEqual([
            'Your vote is 1 of 4 >:)',
            'You already voted, @a',
            'Your vote is 2 of 4 >:)',
            'Your vote is 3 of 4 >:)',
            'Your vote is 4 of 4 >:)',
            `Removing trama's "Enter" key for 5 minutes...`,
        ]);
        expect(h.bans).toEqual([['chatban', 5 * 60 * 1000]]);
        expect(vote.isCaged).toBe(true);
    });

    it('counts by Twitch id, so a renamed viewer cannot vote twice', async () => {
        const h = host();
        const vote = new VoteCounter('voiceban', h);
        await vote.vote({ id: '42', login: 'old_name' });
        await vote.vote({ id: '42', login: 'new_name' });
        expect(vote.count).toBe(1);
        expect(h.said.at(-1)).toBe('You already voted, @new_name');
    });

    it('refuses votes while the streamer is caged, until reset', async () => {
        const h = host();
        const vote = new VoteCounter('voiceban', h);
        for (const login of ['a', 'b', 'c', 'd']) await vote.vote(viewer(login));
        expect(h.said.at(-1)).toBe("Removing trama's voice for 30 seconds...");
        expect(h.bans).toEqual([['voiceban', 30_000]]);

        await vote.vote(viewer('e'));
        expect(h.said.at(-1)).toBe('trama is already caged. Wait until they are free again');

        vote.reset();
        expect(vote.isCaged).toBe(false);
        await vote.vote(viewer('e'));
        expect(h.said.at(-1)).toBe('Your vote is 1 of 4 >:)');
    });

    it('does nothing but complain while no streamer client is connected', async () => {
        const h = host(0);
        const vote = new VoteCounter('chatban', h);
        await vote.vote(viewer('a'));
        expect(h.said).toEqual(["trama is disconnected. Voting won't do sheet"]);
        expect(vote.count).toBe(0);
    });

    it('bans once when the last votes arrive together', async () => {
        const h = host();
        const vote = new VoteCounter('chatban', h);
        for (const login of ['a', 'b']) await vote.vote(viewer(login));
        await Promise.all([vote.vote(viewer('c')), vote.vote(viewer('d')), vote.vote(viewer('e'))]);
        expect(h.bans).toHaveLength(1);
    });
});

describe('VotesService', () => {
    function setup(clients = 1) {
        const { chat, said } = fakeChat();
        const sent: StreamerServerEvent[] = [];
        const gateway = {
            clientCount: clients,
            clientEvents$: new Subject<StreamerClientEvent>(),
            disconnects$: new Subject<void>(),
            broadcast: (event: StreamerServerEvent) => {
                sent.push(event);
                return 1;
            },
        };
        const registry = memoryRegistry();
        const votes = new VotesService(testEnvService(), chat, gateway as unknown as StreamerGateway, registry);
        const say = (login: string, text: string) => chat.receive({ user: viewer(login), text });
        const settle = () => new Promise(resolve => setImmediate(resolve));
        return { chat, said, sent, gateway, registry, votes, say, settle };
    }

    it('relays a chatban to the streamer client over the socket contract', async () => {
        const { said, sent, say, settle } = setup();
        for (const login of ['a', 'b', 'c', 'd']) {
            say(login, '!chatban');
            await settle();
        }
        expect(sent).toEqual([{ type: 'chatban', durationMs: 300_000 }]);
        expect(said.at(-1)).toBe(`Removing trama's "Enter" key for 5 minutes...`);
    });

    it('keeps the two votes separate', async () => {
        const { votes, say, settle } = setup();
        say('a', '!chatban');
        say('b', '!voiceban');
        await settle();
        expect(votes.chatban.count).toBe(1);
        expect(votes.voiceban.count).toBe(1);
    });

    it('frees the streamer and resets when the client reports the ban over', async () => {
        const { votes, said, gateway, say, settle } = setup();
        for (const login of ['a', 'b', 'c', 'd']) say(login, '!voiceban');
        await settle();
        expect(votes.voiceban.isCaged).toBe(true);

        gateway.clientEvents$.next({ type: 'voiceban_complete' });
        await settle();
        expect(votes.voiceban.isCaged).toBe(false);
        expect(votes.voiceban.count).toBe(0);
        expect(said.at(-1)).toBe('trama is now free. All VoiceBan votes have been reset.');
    });

    it('says something broke when the client reports an error', async () => {
        const { said, gateway, settle } = setup();
        gateway.clientEvents$.next({ type: 'chatban_complete', error: 'keyboard hook failed' });
        await settle();
        expect(said).toEqual(['Uhoh, something broke :(', 'trama is now free. All ChatBan votes have been reset.']);
    });

    it('resets both votes when the streamer client disconnects', async () => {
        const { votes, gateway, say, settle } = setup();
        say('a', '!chatban');
        say('b', '!voiceban');
        await settle();
        gateway.disconnects$.next();
        expect(votes.chatban.count).toBe(0);
        expect(votes.voiceban.count).toBe(0);
    });

    it('answers "turned off" when the command is switched off', async () => {
        const { registry, said, votes, say, settle } = setup();
        await registry.setEnabled('chatban', false, 'test');
        say('a', '!chatban');
        await settle();
        expect(said).toEqual(['!chatban is turned off']);
        expect(votes.chatban.count).toBe(0);
    });
});
