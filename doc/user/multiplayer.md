# Multiplayer

[← Back to index](README.md)

Play a campaign as a coop team, 2-4 players, in real time. There's no deathmatch or PvP mode yet — everyone on a session is on the same side, fighting the same enemies.

**On the hosted build at [codeenstein3d.mcdope.org](https://codeenstein3d.mcdope.org) this is already set up.** If you're running your own local copy, the **Multiplayer** tab won't appear at all until the build is pointed at a signaling server — that address is baked in when the dev server starts, not read at runtime, so there's no in-app setting for it. See [Multiplayer Server Deployment](../dev/multiplayer-deployment.md) for standing one up.

## Hosting a session

1. Load a workspace the same way you would for single-player — a GitHub repo or the Demos campaign (a locally-picked folder can't be hosted, see [Privacy](privacy.md)).

   Only the host needs the workspace. Everyone else receives the finished level
   from the host over the connection — nobody else downloads the repo, and nobody
   else re-builds the level from it. That means it doesn't matter if your friends
   couldn't load that repo themselves, or if GitHub returned a
   [partial file listing](troubleshooting.md#a-big-github-repo-loaded-but-it-seems-incomplete)
   for a very large one: you all play exactly the campaign the host has, however
   long or short that turned out to be.

2. Open the **Multiplayer** tab, then the **Host** sub-tab.
3. Pick how many players you want (2-4) from the **Max players** dropdown, optionally give the session a display name, and click **Create Session**.
4. Share the short code your browser shows you with whoever you want to play with — it's just letters and digits, easy to read out loud or paste into a chat.
5. As each friend joins with that code, they connect automatically — you don't need to generate a new code or do anything between joins. A live "N/max players connected" line shows who's in so far.
6. Click **Start Session** whenever you're ready — you don't have to wait for every slot to fill; the game starts with however many players have joined at that moment.

## Joining a session

Open the **Multiplayer** tab, then the **Join** sub-tab, type in the code you were given, and click **Join**. If you don't have a code, **Browse Lobby** lists any sessions their hosts have chosen to make public.

## What's different in multiplayer

- **No cheat codes.** IDDQD/IDCLIP/IDKFA-style cheats are disabled entirely for a multiplayer run.
- **No highscores or replays.** A multiplayer run doesn't get recorded to the Highscores board and can't be watched back afterward — those stay single-player features.
- **A shared scoreboard instead.** When the session ends, everyone sees a comparison screen with each player's score and kill count, rather than an individual highscore entry.
- **Elite enemies scale with your team size.** The more players in the session, the tougher Elite enemies get (more HP, more damage) — a solo Elite fight doesn't get any harder, but a 4-player one does.
- **Loot is shared.** Anything an Elite or regular enemy drops is visible to the whole team on the minimap and automap, not just whoever's standing next to it.

## If you can't connect

Multiplayer connects your browsers directly to each other (peer-to-peer). On most
networks that just works, but some strict setups — mobile/carrier networks,
locked-down office or hotel Wi-Fi — block that kind of direct link, and a join can
get stuck on "Establishing connection…". If the person running the signaling
server has also set up a relay, the game uses it automatically to get through
those networks — there's nothing to configure on your side. Without a relay,
either the host or the joiner switching to a less restrictive network (e.g. off a
corporate VPN, or a different Wi-Fi) is usually enough.

For everything else that can go wrong — an expired code, "someone else already
joined", a greyed-out Host tab — see
[Troubleshooting § Multiplayer](troubleshooting.md#multiplayer).

## Disconnects and level transitions

If a player's connection drops, the rest of the session waits a short grace period in case it reconnects, then continues without them — their score up to that point is kept, just marked as disconnected on the end-of-run scoreboard. When any player reaches the level's exit tile, a short countdown starts for the rest of the team to catch up before everyone advances together to the next level — but only once every enemy in the exit's own room is dead; standing on the tile does nothing at all before that.

The end-of-run scoreboard's score and kill counts are cumulative for the whole session, not just the last level — they keep adding up across every level transition, the same way your live in-run score already does.
