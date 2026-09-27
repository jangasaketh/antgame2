# Formica — the deep burrow

A 3D browser game. You are a fire ant working down through five floors of a
living ant burrow, feeding as you go, with the colony trying to kill you.

No build step, no bundler, no external assets. Three.js is vendored, the ant
and the soil are generated in code, and the soundtrack is synthesised at
runtime — so the whole thing works offline and the repo stays small.

## Run it

Every file sits in one folder. Serve it and open the address it prints:

```bash
npx serve .                  # Node
python -m http.server 8000   # Windows
py -m http.server 8000       # Windows, launcher
python3 -m http.server 8000  # macOS / Linux
```

Or push all the files to a GitHub repo root and turn on Pages
(**Settings → Pages → Deploy from a branch → main / (root)**).

## Controls

| Key | Action |
| --- | --- |
| W A S D | Move · Shift to run, Space to jump |
| Mouse | Aim. Left click sprays formic acid |
| 1 / 2 | Acid, or mandibles — far more damage, but you must close in |
| E | Drink from a honeypot ant, or pick up and set down brood |
| C | Call nestmates, once you have the gland |
| Q | Hold to follow the scent trail when you are lost |
| Esc | Pause · M mutes · R restarts from a death screen |

## It is a burrow, not a maze

There are no wall blocks anywhere. The colony is generated as two smooth
surfaces over the same ground: the floor you stand on, and how much air there
is above it. Solid earth is simply where that gap closes. So a wall is the
place where the ceiling curves down to meet the floor, and everything is
rounded, uneven and dug-looking.

That gives the things a real nest has:

- **Chambers of wildly different size**, from 19 to 36 units across and 7 to
  17 high, joined by tunnels 5 to 11 wide. Some are cathedrals; some you have
  to squeeze through, and the HUD says so when you do.
- **Hills rising out of the floor** inside the chambers. They are cover, they
  are high ground in a fight, and when the water comes they are islands.
- **Landmarks instead of a map.** Each chamber is dressed differently — brood
  rooms, the granary, the larder where the honeypot ants hang, fungus gardens,
  refuse heaps — and its name flashes up as you walk in. That is how you
  navigate, because the way down is not marked until you find it.

The shaft down sits in the chamber furthest from where you enter, two to six
tunnels away, and the minimap only fills in where you have actually been. When
you are properly lost, hold **Q** and a trail of scent motes drifts off toward
whatever you need next. It runs on a meter, so it is a hint, not a compass.

## What the reference films are in here

**Honeypot ants.** Repletes hang in the larder chambers with their gasters
swollen into translucent amber beads. Walk up and press **E** to drink —
trophallaxis — and the bead visibly empties. Two drinks each, and it is by far
the best healing in the game.

**Brood carrying.** Larvae lie in rows in the brood chambers. Pick one up with
**E** and carry it to the shaft for three crop. While it is in your mandibles
you cannot spray acid, so it is a real decision, not free money.

**Cooperative transport.** On the blocked floor, cave-ins have sealed the only
tunnel into the exit chamber. One ant cannot shift stone. Find the recruitment
gland first, then press **C** to call nestmates: they arrive, greet you with an
antennal tap, and a crew of three or more hauls the plug apart while you hold
the tunnel. They fight alongside you until they wander off.

**Rafting.** Fallen leaves lie around the cistern floors. When the monsoon
water comes up they come loose and float, and you can ride one — it drifts on
the current and carries you with it. The alternative is climbing a hill, or
swimming and drowning.

**Scale.** Straight from the Empire of the Ants developer talk: the point of
playing something a few millimetres long is that ordinary objects become
enormous. Grit is boulders, a leaf is a boat, roots hang through the chambers
like columns.

**Pheromones as powers**, also from that talk, is the scent trail and the
recruitment call.

## The floors

| # | Floor | What is down there |
| - | ----- | ------------------ |
| 1 | Entrance galleries | Black scouts. Room to learn the acid |
| 2 | Cistern galleries | The flood, and the leaves you ride out on |
| 3 | The blocked deep | Stone plugs. Find the gland, then call for help |
| 4 | Fungus deeps | Majors between the combs, and the roof coming down |
| 5 | The queen's vault | Water, cave-ins, majors, and a clock |

## Music

There are no audio files. `audio.js` runs a small synthesiser: a breathing
drone, a bass pulse, hand drums, and a sparse modal motif, all through a
generated convolution reverb so it sounds like it is happening inside a hole in
the ground. It is adaptive — the drums and the tempo come up when something is
hunting you and fall away when you lose it — and each floor plays in a
different key.

## Files

```
index.html        page, HUD markup, importmap
styles.css        HUD and screens
config.js         every tunable number
terrain.js        the burrow generator: chambers, tunnels, hills, pathing
world.js          soil meshes, chamber dressing, lighting, level management
models.js         the ant and everything else, generated in code
entities.js       player, enemies, nestmates, repletes, brood, plugs, rafts
hazards.js        flood and cave-in
audio.js          the synthesised adaptive score
game.js           renderer, camera, input, combat, level flow, HUD
three.module.js   three.js r160 (MIT, licence in LICENSE-three.txt)
```

## Tuning

Nearly everything lives in `config.js`.

- **Chambers too small or too tight:** `roomMin`, `roomMax`, `height`,
  `tunnelMin`, `tunnelMax` per level.
- **More hills:** `hills`. More ways round: `loops`.
- **Combat too hard:** raise `WEAPONS.acid.damage` or `PLAYER.maxHealth`.
- **The flood:** its timing is in `hazards.js`, its depth follows the tallest
  hill on the floor so there is always somewhere to climb.
- **Hauling crews:** `RECRUIT.hauling` is how many ants a plug needs,
  `haulTime` how long it takes.
- **New enemy:** add to `ENEMY_TYPES`, list it in a level's `enemies`.
- **New floor:** append to `LEVELS`. Burrow, shaft, lighting, dressing and
  spawns all generate from it.

The colony comes from the seed in `game.js` (`new World(this.scene, 20260927)`),
so everyone gets the same five floors. Pass `Date.now()` for a fresh burrow
every run.
