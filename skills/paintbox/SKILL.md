---
name: paintbox
description: Make a browser game whose look is painted by small AI networks from boxes, Matrix-Game style but on any GPU — the code keeps the world as boxes, a detailed version of the world (its shapes and its materials) exists only in training, a WebGL2 path tracer renders it on the person's own machine, and four tiny painters (shape, light, surfaces, sky) learn it and paint every pixel live on a phone or a computer, the outlines included; then ship it on NotesMosaic through its checks.
metadata:
  doors: [get_rules, list_skills, read_skill, begin_bundle_upload, finish_bundle_upload, get_bundle_upload, write_game_files, check_game, playtest_game, get_playtest, play_game, certify_game, launch_game, publish_game]
  subjects: [ai-painted game, neural rendering, neural textures, neural shapes, neural sdf, learned feature textures, matrix-game, code keeps the world, boxes to painted, blockout to art, reshape outlines, path tracing, path tracer, global illumination, light baking, neural light, procedural materials, webgl2, browser game, phone game, any gpu, no nvidia, tiny network in a shader, feature grid, sky painter, time of day, glow, runes, b-roll, gameplay footage]
  proof: the same cameras rendered by the game and by the path tracer side by side, with the painted frame's error against the truth in levels out of 255 and both frame times; the shape painter's held-out distance error in millimetres; the game's rules played by a script; Chromium and WebKit booted on a desktop and as a phone upright and turned with the frame rate measured; the platform's playtest passed in both engines before anything is certified
---

# Paintbox

**Skill version:** 2.0.1
**For:** any coding agent (Claude Code, Codex, Cursor, ChatGPT) asked for a game whose look is painted by AI, in the browser, on any GPU.
**Design rule:** **The code keeps the world as boxes. The painters paint what you see, the shapes too. The detail lives only in training.**

**Reading this through the NotesMosaic MCP:** any agent connects at `https://notesmosaic.com/mcp` (the steps for each app:
https://notesmosaic.com/developers/mcp). `list_skills` names this skill and `read_skill {"name": "paintbox"}` hands the whole text to
any connected agent; nothing needs installing. The platform's own rules are `get_rules {"doc": "PUBLISHING.md"}`: read them before
building and again before shipping.

**The method in the open:** https://github.com/starrandy123/paintbox holds the toolkit and a game made with it (Dusk Yard), with its
trained painters, its checks and its README. Clone it; it plays at once (`npm install`, `npm run serve`).

## 0. When this is the right tool, and when it is not

Use it when the person wants:
- a world that looks rendered, not drawn: battlements, arches, columns, canopies, stone, wood, cloth, glow, bounced light, a sky
  that changes with the hour;
- it to run on whatever GPU the player has (WebGL2, which nearly every browser has), phones included, with no server;
- the Matrix-Game idea ("code runs the game, AI paints the frame") made small: the level is a blockout of boxes, the AI paints the
  art on it.

Say plainly what it is not:
- Every painter learns ONE world. Change the level and you bake and train again (about 40 minutes on a laptop for the full loop,
  about 10 for the quick one). A form's shape is learned once for every box of that form, wherever the box stands.
- The shapes are the ones the detailed world defines (`bake/forms.js`): the painter learns them, it does not invent new ones. A box
  becomes its form's shape fitted to the box, never something its form does not describe.
- It is not the first of its kind, and is never presented as such: learned feature textures read by a small network are deferred
  neural rendering (Thies et al. 2019); a learned distance field on a feature grid with a tiny network, traced in real time, is
  neural geometric level of detail (Takikawa et al., NVIDIA, 2021); NVIDIA runs neural materials on RTX hardware (SIGGRAPH 2024);
  small networks in browser shaders have painted captured scenes on phones (MobileNeRF); learned light is radiance regression
  functions (Ren et al. 2013) and Neural Irradiance Volume (2026). Credit them when the person posts about it.

## 1. The parts

| Part | File | What it does |
|---|---|---|
| The world | `game/world.js` | every box `B(x0, y0, z0, x1, y1, z1, 'material', { form })`; the materials (`MAT`, `MAT_UV`); the forms (`FORMS`) and the frame each one reads a box through (`formCanon`); the beacons; the sun and the sky's colours by the hour; the painters' volume (`GRID`) |
| The rules | `game/main.js` | the game: input, the player, the beacons, the enemies, the HUD, the camera; it works on the boxes only |
| The detailed shapes | `bake/forms.js` | each form as a distance field in its frame: battlements, arches, columns, corbelled towers, a hipped roof, canopies, rocks, banners, crates, a hooded figure. Never shipped |
| The detailed materials | `bake/truth.js` | each material as code (albedo, height for its bumps, cavity, glow); the world's wear (`weather`); the cloudy sky. Never shipped |
| The truth | `bake/pt.js` | a WebGL2 path tracer over the shaped world (each form's truth sampled once into a 3D texture the rays read): the light at points, what a point of the detailed world sends to the eye, the sky, full reference pictures |
| The shape painter | `bake/train_shape.py` → `game/shape.bin` | for every form a grid of 8 learned features in its frame, and one 8 → 16 → 16 → 1 network: feature 0 is a coarse distance to step by, the network places the surface |
| The light painter | `bake/train.py` → `game/painter.bin` | a 3D grid of learned features plus a 24 → 32 → 32 → 18 network: the light at any point, for any normal and hour, from the sky and from each beacon at unit strength |
| The surface painter | `bake/train_surface.py` → `game/surface.bin` | a learned 8-feature texture per material, a half-metre grid of the world's wear, and a 24 → 16 → 16 → 9 network: how each point takes the light painter's light, the sun and its own glow |
| The sky painter | `bake/train_sky.py` → `game/sky.bin` | a learned texture over the cloud deck plus a 16 → 16 → 16 → 3 network |
| The runtime | `game/render.js`, `game/painter.js` | plain WebGL2: every shaped box's shell traced on the coarse distance (the nearest hit a pixel kept), then once a pixel the shape painter places the surface and its normal, and the light and surface painters paint it; the sky painter paints the sky |

What the code still decides, and says so if asked: where each box is and which form it is; where the sun's light reaches (a shadow
map of the traced shapes); each moving part's colour; how brightly each crystal glows; where the stars are; the camera's haze,
exposure and glow.

## 2. The loop

    git clone https://github.com/starrandy123/paintbox && cd paintbox
    npm install && npx playwright install chromium webkit
    npm run serve                 # play it: http://127.0.0.1:8737/game/index.html (1 and 2 flip boxes / painted)
    # change game/world.js, bake/forms.js and bake/truth.js, then:
    npm run truth                 # the detailed world, path traced, from bake/views_truth.json -> out/truth/
    npm run make:quick            # a small bake and short training: the whole loop in about 10 minutes
    npm run make                  # the real one: about 40 minutes on an M1 (the path tracer on its GPU, the trainers on its CPU)
    npm run look                  # the game and the path tracer from the same cameras, side by side, with frame times
    npm test                      # the rules, played by a script
    npm run devices               # Chromium and WebKit, desktop and phone upright/turned: boots, fps, what it holds
    npm run pack                  # out/game.zip, the build to upload

The bake and the training run on the person's own machine: a GPU for the path tracer (through a windowless browser), Python 3 with
numpy for the trainers (`PYTHON=...` picks one). Nothing is rented, and nothing leaves the machine until the upload.

## 3. Writing a world the painters can learn

**Boxes.** A level is a list of boxes, and each names what it is made of and what it IS. Keep it inside `GRID` (the painters'
volume, 40 × 10 × 40 m in the example; past it the light and the wear are the open field's). The game collides with the boxes.

**Forms.** A form is a distance field in its own frame (`bake/forms.js`), and `FORMS` in `game/world.js` says how its frame reads a
box, axis by axis (0 the box's longer horizontal side, 1 up, 2 the shorter):
- `['tile', P]`: repeats every P metres along a run (a wall's battlements), the period fitted to a whole number in the box;
- `['mirror', e, m]`: metres in from the nearer face (a wall's thickness, a column's shaft), as far as e, and up to m outside;
- `['ends', lo, hi, mLo, mHi]`: metres down from the top face or up from the bottom face (a plinth, a coping, a capital);
- `['span', N, mLo, mHi]`: the whole box stretched from N metres (a canopy, a rock, a body).
A shape may reach past its box by the margins (merlons above a wall, an arch below a lintel, roots around a trunk); the box is still
what the game collides with. What makes one learnable:
- **it is a distance**: its slope stays near 1 (divide a profile's radius by its slope's length: `revolve` does);
- **its detail is a few grid cells wide** (`cell` in `FORMS`, 1.5–16 cm): finer than that the network smooths it, and the surface
  painter's materials carry the fine relief anyway;
- **it is defined everywhere**: `atan2s`, never `atan`, about an axis (`atan(0, 0)` is not a number on some GPUs, and a grid point
  on a trunk's axis would spread it through the bake).
Look at it before anything learns it: `npm run truth`.

**Materials.** A material is a function in `bake/truth.js` returning `Surf(albedo, height, cavity, glow)`, plus a row in `MAT` and
`MAT_UV` in `game/world.js`. What makes one learnable:
- **It repeats exactly on its tile** (`MAT_UV`: `[0, tileU, tileV]` for world metres, so a wall's courses run across the boxes it is
  made of; `[1, tileU, tileV, vTop]` for metres from the box's own corner, so each banner, crate or pedestal shows the whole
  design, with its top face moved up by `vTop`). Every noise frequency times the tile must be a whole number: the helpers `tn`,
  `tf` and `tcell` take the tile and do it. On a shaped surface the pattern is read along the axis the surface faces most.
- **Its finest detail is about two texels:** the learned texture is 256 × 256 over the tile (1.6 cm on a 4 m tile).
- **The world's own wear is slow:** `weather()` (damp, moss, rain marks, grime) changes over a metre or more.

**Lights.** Beacons are box lights the light painter learns one by one at unit strength; the game scales, colours and pulses each
one for free. A box glows with its beacon when its `glow` names it (a crystal and its pedestal's runes in the example).

**Moving things** are boxes too (`dynamics()` in `game/main.js`): each part names a material (`cloth`, `skin`, `shade`), its colour
and its form (`torso`, `limb`, `head`, `wraith` in the example); the shape painter shapes it, the light painter lights it at the
pixel, the surface painter paints it.

## 4. Checks before anyone is told it works

1. **The truth, side by side** (`npm run look`, then `bake/sheet.py` for a sheet): the same cameras in the game and in the path
   tracer. The trainers print their errors at points they never trained on (the example: the shapes within 0.28 mm, the look
   within 3.6 levels out of 255 on screen).
2. **The frame time** (`look` prints it; the example paints a 960×540 frame in 16–23 ms on an M1) and the frame rate at a phone's
   size (`npm run devices`: the example 33–46 fps in both engines on the M1).
3. **The rules** (`npm test`).
4. **The platform's playtest** in Chromium and WebKit (section 5). A phone emulated on a computer is not a phone: say "phone-sized"
   until the person has played it on theirs.

Faults already met, and their fixes:
- *A frame takes 50 ms when one shader carries every path*: the GPU sizes its registers by the biggest path. Keep separate
  programs for the boxes view, the still world, the moving things, the shapes' trace and their paint.
- *A frame takes 150 ms when the shapes are traced and painted in one pass*: overlapping shells each run everything, and a network
  inside the trace makes every one of them heavy. Trace on the coarse distance alone, keep the nearest hit a pixel, then let the
  network place the surface once a pixel; keep the still world's shadow map until the sun moves.
- *Grain on shaped surfaces*: a normal taken over a millimetre or two reads the network's own error. Take it over a centimetre.
- *Specks on silhouettes*: a ray that grazes an edge comes within a centimetre on the coarse distance; drop a hit the network puts
  more than a few millimetres off the surface, and let the trace go on past a graze (a shape behind may be the one the pixel sees).
- *Streaks of sky through a face the eye sees at a slant, light lines along edges*: one step of the network's distance along the
  ray stops short of a face the ray meets at a slant (it closes on it slower than its distance says), and the hit is then dropped.
  Step by the distance over the ray's closing speed (the coarse distance's slope along the ray: three of its fetches, no network),
  but only where the coarse field slopes like a distance, and take the plain step where the slanted one leaves the ray further
  off; the last correction is always the plain distance (a correction divided by a wrong slope lands inside the stone, the normal
  turns and the pattern streaks across the face). A ray that only passes an edge (the coarse distance rounds an edge out by up to
  a cell) goes on along the shape, on the coarse distance, to what of it the ray meets behind, inside its shell. About 4 ms a
  frame on the M1.
- *A form's flat faces never taught*: a point placed on a shape whose surface is its box's own face sits on the shell's boundary;
  count the boundary as inside.
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
picture that explains the method in two seconds: the outlines change too). `npm run gameplay` records a bot playing by the game's
own rules, HUD and all (`bake/plays.json`: a route of waypoints, the lights it waits by, the enemies placed where the camera sees
them).
