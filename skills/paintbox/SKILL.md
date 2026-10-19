---
name: paintbox
description: Make a browser game whose look is painted by small AI networks from boxes, Matrix-Game style but on any GPU — the code keeps the world as boxes, a detailed version of the world exists only in training, a WebGL2 path tracer renders it on the person's own machine, and three tiny painters (light, surfaces, sky) learn it and paint every pixel live on a phone or a computer; then ship it on NotesMosaic through its checks.
metadata:
  doors: [get_rules, list_skills, read_skill, begin_bundle_upload, finish_bundle_upload, get_bundle_upload, write_game_files, check_game, playtest_game, get_playtest, play_game, certify_game, launch_game, publish_game]
  subjects: [ai-painted game, neural rendering, neural textures, learned feature textures, matrix-game, code keeps the world, boxes to painted, path tracing, path tracer, global illumination, light baking, neural light, procedural materials, webgl2, browser game, phone game, any gpu, no nvidia, tiny network in a shader, feature grid, light atlas, sky painter, time of day, glow, runes, b-roll, gameplay footage]
  proof: the same cameras rendered by the game and by the path tracer side by side, with the painted frame's error against the truth in levels out of 255 and both frame times; the game's rules played by a script; Chromium and WebKit booted on a desktop and as a phone upright and turned with the frame rate measured; the platform's playtest passed in both engines before anything is certified
---

# Paintbox

**Skill version:** 1.0.0
**For:** any coding agent (Claude Code, Codex, Cursor, ChatGPT) asked for a game whose look is painted by AI, in the browser, on any GPU.
**Design rule:** **The code keeps the world as boxes. The painters paint what you see. The detail lives only in training.**

**Reading this through the NotesMosaic MCP:** any agent connects at `https://notesmosaic.com/mcp` (the steps for each app:
https://notesmosaic.com/developers/mcp). `list_skills` names this skill and `read_skill {"name": "paintbox"}` hands the whole text to
any connected agent; nothing needs installing. The platform's own rules are `get_rules {"doc": "PUBLISHING.md"}`: read them before
building and again before shipping.

**The method in the open:** https://github.com/starrandy123/paintbox holds the toolkit and a game made with it (Dusk Yard), with its
trained painters, its checks and its README. Clone it; it plays at once (`npm install`, `npm run serve`).

## 0. When this is the right tool, and when it is not

Use it when the person wants:
- a world that looks rendered, not drawn: stone, wood, cloth, glow, bounced light, a sky that changes with the hour;
- it to run on whatever GPU the player has (WebGL2, which nearly every browser has), phones included, with no server;
- the Matrix-Game idea ("code runs the game, AI paints the frame") made small.

Say plainly what it is not:
- Every painter learns ONE world. Change the level and you bake and train again (about half an hour on a laptop).
- It paints the surfaces of the boxes and the sky. The outlines stay boxes; it cannot grow a tree out of a cube's silhouette.
- It is not the first of its kind, and is never presented as such: learned feature textures read by a small network are deferred
  neural rendering (Thies et al. 2019); NVIDIA runs neural materials on RTX hardware (SIGGRAPH 2024); small networks in browser
  shaders have painted captured scenes on phones (MobileNeRF); learned light is radiance regression functions (Ren et al. 2013)
  and Neural Irradiance Volume (2026). Credit them when the person posts about it.

## 1. The parts

| Part | File | What it does |
|---|---|---|
| The world | `game/world.js` | every box `B(x0, y0, z0, x1, y1, z1, 'material')`; the materials (`MAT`, `MAT_UV`); the beacons; the sun and the sky's colours by the hour; the painters' volume (`GRID`) |
| The rules | `game/main.js` | the game: input, the player, the beacons, the enemies, the HUD, the camera; it works on the boxes only |
| The detailed world | `bake/truth.js` | each material as code (albedo, height for its bumps, cavity, glow); the world's wear (`weather`); the cloudy sky. Never shipped |
| The truth | `bake/pt.js` | a WebGL2 path tracer: the light at points (sky, sun, each beacon), what a point of the detailed world sends to the eye, the sky, and full reference pictures |
| The light painter | `bake/train.py` → `game/painter.bin` | a 3D grid of learned features plus a 24 → 32 → 32 → 18 network: the light at any point, for any normal and hour, from the sky and from each beacon at unit strength |
| The surface painter | `bake/train_surface.py` → `game/surface.bin` | a learned 8-feature texture per material, a half-metre grid of the world's wear, and a 20 → 16 → 16 → 9 network: how each point takes the light painter's light, the sun and its own glow |
| The sky painter | `bake/train_sky.py` → `game/sky.bin` | a learned texture over the cloud deck plus a 16 → 16 → 16 → 3 network |
| The runtime | `game/render.js`, `game/painter.js` | plain WebGL2: the light atlas repainted every frame, the surface painter at every pixel, the sky painter at every sky pixel |

What the code still decides, and says so if asked: the boxes' outlines; where the sun's light reaches (a shadow map); each moving
part's colour; how brightly each crystal glows; where the stars are; the camera's haze, exposure and glow.

## 2. The loop

    git clone https://github.com/starrandy123/paintbox && cd paintbox
    npm install && npx playwright install chromium webkit
    npm run serve                 # play it: http://127.0.0.1:8737/game/index.html (1 and 2 flip boxes / painted)
    # change game/world.js and bake/truth.js, then:
    npm run truth                 # the detailed world, path traced, from bake/views_truth.json -> out/truth/
    npm run make:quick            # a small bake and short training: the whole loop in about 5 minutes
    npm run make                  # the real one: about 6 minutes of baking on an M1's GPU, 21 of training on its CPU
    npm run look                  # the game and the path tracer from the same cameras, side by side, with frame times
    npm test                      # the rules, played by a script
    npm run devices               # Chromium and WebKit, desktop and phone upright/turned: boots, fps, what it holds
    npm run pack                  # out/game.zip, the build to upload

The bake and the training run on the person's own machine: a GPU for the path tracer (through a windowless browser), Python 3 with
numpy for the trainers (`PYTHON=...` picks one). Nothing is rented, and nothing leaves the machine until the upload.

## 3. Writing a world the painters can learn

**Boxes.** A level is a list of boxes. Keep it inside `GRID` (the painters' volume, 40 × 10 × 40 m in the example; past it the
light and the wear are the open field's). Each face's four edges are classified automatically (an outside corner is rounded and
worn in the detailed world; an inside corner gathers grime), and the painters are told how near each edge a point is, so corners
can be painted even though they are flat in the boxes.

**Materials.** A material is a function in `bake/truth.js` returning `Surf(albedo, height, cavity, glow)`, plus a row in `MAT` and
`MAT_UV` in `game/world.js`. What makes one learnable:
- **It repeats exactly on its tile** (`MAT_UV`: `[0, tileU, tileV]` for world metres, so a wall's courses run across the boxes it is
  made of; `[1, tileU, tileV, vTop]` for metres from the box's own corner, so each banner, crate or pedestal shows the whole
  design, with its top face moved up by `vTop`). Every noise frequency times the tile must be a whole number: the helpers `tn`,
  `tf` and `tcell` take the tile and do it.
- **Its finest detail is about two texels:** the learned texture is 256 × 256 over the tile (1.6 cm on a 4 m tile). Thinner
  lines blur.
- **The world's own wear is slow:** `weather()` (damp, moss, rain marks, grime) changes over a metre or more, because the wear grid
  is half a metre.
- **Look before training:** `npm run truth`. A material that looks wrong in the truth will be learned wrong.

**Lights.** Beacons are box lights the light painter learns one by one at unit strength; the game scales, colours and pulses each
one for free. A box glows with its beacon when its `glow` names it (a crystal and its pedestal's runes in the example).

**Moving things** are boxes too (`dynamics()` in `game/main.js`): each part names a material (`cloth`, `skin`, `shade`) and its
colour; the surface painter paints the material, the light painter lights it at the pixel.

## 4. Checks before anyone is told it works

1. **The truth, side by side** (`npm run look`, then `bake/sheet.py` for a sheet): the same cameras in the game and in the path
   tracer. The trainer also prints the error at points it never trained on (the example: 3.3 levels out of 255 on screen).
2. **The frame time** (`look` prints it; the example paints a 960×540 frame in 3.5–4.0 ms on an M1) and the frame rate on a phone's
   screen (`npm run devices`).
3. **The rules** (`npm test`).
4. **The platform's playtest** in Chromium and WebKit (section 5). A phone emulated on a computer is not a phone: say "phone-sized"
   until the person has played it on theirs.

Faults already met, and their fixes:
- *A frame takes 50 ms when one shader carries every path*: the GPU sizes its registers by the biggest path. Keep separate
  programs for the boxes view, the still world and the moving things.
- *Grain on a bright material in close-up*: the training points were noisy or few. More light paths a point, more points on that
  material (`BOOST` in `pt.js`).
- *Streaks on surfaces far away*: the GPU averages feature texels the network never saw. The game blends a surface whose pattern is
  under a pixel toward its material's average look (`bake/far_response.py`, written by the trainer).
- *Streaks at the horizon*: the land must reach the haze and the sky painter must not be read below the horizon.

## 5. Shipping on NotesMosaic

1. Read `get_rules {"doc": "PUBLISHING.md"}`.
2. Write `game/rights.json` for the person's own game: theirs, made with this toolkit (MIT), with what was searched (PUBLISHING.md
   §5b). Dusk Yard's file is an example, not theirs.
3. `npm run pack`, then `begin_bundle_upload` with the zip's exact `size_bytes` (and `game_id` for a new version of a game they
   already have). PUT the zip to the `put_url` with its headers, then `finish_bundle_upload`.
4. `playtest_game` with engines `["chromium", "webkit"]` from a terminal, and run its `run_it_here` lines; or omit engines in a chat
   app, where the run happens in the tool's panel. Then `get_playtest` for the measurements and pictures. Fix what it says would
   fail.
5. `play_game` gives the person the newest version to play (in a terminal, its `play_link` opens on their phone).
6. Public is the person's word: `certify_game` → `launch_game` → `publish_game`, each when the person asks.

## 6. Footage

`npm run broll` records the camera moves in `bake/shots.json` frame by frame (a wipe between the boxes and the painted frame is the
picture that explains the method in two seconds). `npm run gameplay` records a bot playing by the game's own rules, HUD and all
(`bake/plays.json`: a route of waypoints, the lights it waits by, the enemies placed where the camera sees them).
