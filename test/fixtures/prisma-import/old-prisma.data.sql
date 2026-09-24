--
-- PostgreSQL database dump
--

-- Dumped from database version 14.4
-- Dumped by pg_dump version 16.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: Pokemon; Type: TABLE DATA; Schema: public; Owner: brobot
--

COPY public."Pokemon" (id, name, "nameId", slot, level, shiny, wins, losses, draws, item, moves, "dexNum", color, types, gender, nature, ability, "teamId", "userOauthId", "createdDate", "updatedDate") FROM stdin;
0f6f8a4e-2b1c-4d3e-8f9a-1b2c3d4e5f60	Pikachu	pikachu	1	150	t	31	4	2	Light Ball	{thunderbolt,quickattack,irontail,volttackle}	25	Yellow	{Electric}	F	Jolly	Static	5b7d1f0e-6a51-4c1f-9d0a-0b8f3c2a4e11	42	2022-11-30 13:06:40.123	2023-04-01 09:15:00.5
1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c80	Bulbasaur	bulbasaur	2	12	f	0	0	0		\N	1	Green	{Grass,Poison}	M	Modest	Overgrow	5b7d1f0e-6a51-4c1f-9d0a-0b8f3c2a4e11	42	2022-12-02 10:00:00	2022-12-02 10:00:00
2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d91	Ditto	ditto	2	7	f	1	1	0		{transform}	132	Purple	{Normal}	N	Hardy	Limber	5b7d1f0e-6a51-4c1f-9d0a-0b8f3c2a4e11	42	2022-12-03 11:00:00	2022-12-03 11:00:00
3C4D5E6F-7A8B-4C3D-8E4F-5A6B7C8D9EA2	Mr. Mime	mrmime	1	33	f	5	6	1		{psychic,barrier,"light screen"}	122	Pink	{Psychic}	M	Timid	Soundproof	8e2c4a90-1f3b-4d6e-a7c8-9b0d1e2f3a44	77	2022-12-10 20:30:00.001	2023-01-10 20:30:00.001
4d5e6f7a-8b9c-4d4e-9f5a-6b7c8d9eafb3	Farfetch'd	farfetchd	3	20	t	2	0	0	Stick	{}	83	Brown	{Normal,Flying}	M	Brave	Keen Eye	\N	77	2022-12-11 08:00:00	2022-12-11 08:00:00
\.


--
-- Data for Name: PokemonBattleOutcome; Type: TABLE DATA; Schema: public; Owner: brobot
--

COPY public."PokemonBattleOutcome" (id, "updatedDate", outcome) FROM stdin;
9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d	2023-05-01 22:00:00	{"Pikachu used Thunderbolt!","It's super effective, wow","The foe said \\"hi\\"","line one\nline two"}
\.


--
-- Data for Name: PokemonTeam; Type: TABLE DATA; Schema: public; Owner: brobot
--

COPY public."PokemonTeam" (id, "userOauthId", "createdDate", "updatedDate") FROM stdin;
5b7d1f0e-6a51-4c1f-9d0a-0b8f3c2a4e11	42	2022-11-30 13:06:40.100	2023-04-01 09:15:00
8e2c4a90-1f3b-4d6e-a7c8-9b0d1e2f3a44	77	2022-12-10 20:29:59	2022-12-10 20:29:59
\.


--
-- Data for Name: PokemonTeamBattleOutcome; Type: TABLE DATA; Schema: public; Owner: brobot
--

COPY public."PokemonTeamBattleOutcome" (id, "updatedDate", outcome) FROM stdin;
7c6d5e4f-3a2b-4c1d-9e0f-8a7b6c5d4e3f	2023-05-02 21:00:00	{}
\.


--
-- Data for Name: Session; Type: TABLE DATA; Schema: public; Owner: brobot
--

COPY public."Session" (id, sid, data, "expiresAt") FROM stdin;
sess-1	sid-abc	{"cookie":{"originalMaxAge":null}}	2023-05-03 00:00:00
\.


--
-- Data for Name: TwitchBotAuth; Type: TABLE DATA; Schema: public; Owner: brobot
--

COPY public."TwitchBotAuth" (id, "accessToken", "refreshToken", scope, "createdDate", "expirySeconds", "userOauthId", "updatedDate", "obtainmentEpoch") FROM stdin;
b0b0b0b0-1111-4222-8333-444455556666	bot-access	bot-refresh	{chat:read,chat:edit,channel:moderate}	2022-11-30 12:00:00	14400	2000	2023-05-03 03:00:00	1683082800123
\.


--
-- Data for Name: TwitchStreamerAuth; Type: TABLE DATA; Schema: public; Owner: brobot
--

COPY public."TwitchStreamerAuth" (id, "accessToken", "refreshToken", scope, "createdDate", "expirySeconds", "userOauthId", "updatedDate", "obtainmentEpoch") FROM stdin;
5e5e5e5e-1111-4222-8333-444455556666	streamer-access	streamer-refresh	\N	2022-11-30 12:05:00	14400	1000	2023-05-03 03:05:00	1683083100456
\.


--
-- Data for Name: TwitchUser; Type: TABLE DATA; Schema: public; Owner: brobot
--

COPY public."TwitchUser" ("oauthId", "displayName", "createdDate", roles, "updatedDate") FROM stdin;
1000	Trama	2022-11-30 12:00:00	{Viewer,StreamerAuth}	2023-05-03 03:05:00
2000	bro_____bot	2022-11-30 12:00:00	{Viewer,BotAuth}	2023-05-03 03:00:00
42	Ash\\Ketchum	2022-11-30 13:00:00	\N	2023-04-01 09:15:00
77	Misty\tWaterflower	2022-12-10 20:00:00	{Viewer}	2022-12-10 20:00:00
\.


--
-- Data for Name: TwitchUserRegistered; Type: TABLE DATA; Schema: public; Owner: brobot
--

COPY public."TwitchUserRegistered" (id, "userOauthId", email, "profileImageUrl", scope, "updatedDate", "originDate", "registeredDate") FROM stdin;
c1c1c1c1-2222-4333-8444-555566667777	42	\N	https://static-cdn.jtvnw.net/ash.png	{user:read:email}	2023-01-01 00:00:00	2016-01-02 03:04:05	2022-12-01 00:00:00
\.


--
-- Data for Name: _prisma_migrations; Type: TABLE DATA; Schema: public; Owner: brobot
--

COPY public."_prisma_migrations" (id, checksum, finished_at, migration_name, logs, started_at, applied_steps_count) FROM stdin;
d7e1a0a2-0000-4000-8000-000000000001	abc123	2022-11-30 13:06:40.5+00	20221130130640_init	\N	2022-11-30 13:06:40.1+00	1
\.


--
-- PostgreSQL database dump complete
--
