# Paintbox

**The code keeps the world as boxes. Four small AI painters paint every pixel you see, the shapes too, live, in the browser, on any
GPU.**

![The same three cameras: the boxes the code keeps, the frame the AI paints live in the browser, and the path-traced truth it learned from](media/evidence.jpg)

*Left: what the code draws. Middle: what the painters paint from it, live, in 16–23 ms a frame on a 2020 M1 MacBook: the
battlements, the arches, the round columns and the banners' tails are the shape painter's, not the code's. Right: the path-traced
truth they learned from, about a minute a frame.*

The example game is **Dusk Yard**: light the five crystals after the sun goes down; the shades drift through the stone toward you
and burn in the light. It plays in any browser with WebGL2, on a computer or a phone (measured in Chrome's and Safari's engines).

## Play it

    npm install          # Playwright, for the bake and the checks (the game itself needs nothing)
    npm run serve        # then open http://127.0.0.1:8737/game/index.html

The trained painters are in the repository (`game/*.bin`, 15.5 MB), so it plays at once. Press **1** and **2** (or the buttons at
the top) to flip between the boxes the code keeps and the painted frame.

## How it works

Matrix-Game 4.0 (Skywork, October 2026) splits a game in two. Code runs the world as flat boxes, and a 5-billion-parameter video
model, trained on box renders paired with Unreal Engine 5 renders of the same frames, redraws every frame. It runs on NVIDIA's
CUDA, and its browser demo is a video streamed from a GPU server. Paintbox makes the same split small enough for the GPU in the
player's own phone or laptop, outlines and all:

1. **The world is code** (`game/world.js`): every box, what each is made of and what it IS (its form: a wall, a tower, a column,
   an arch, a canopy, a crate, an arm), the beacons, the sun and the sky's colours through the day. The game's rules
   (`game/main.js`) work on these boxes and nothing else; the boxes view draws them.
2. **A detailed world exists only in training.** It plays the part Unreal Engine plays for Matrix-Game:
   - each form's shape as a distance field in the form's own frame (`bake/forms.js`): battlements on the walls, round arches over
     the gate and the windows, round columns with bases and capitals, corbelled towers, a hipped roof, leafy canopies, rocks,
     forked banners, framed crates, a hooded figure;
   - each material as code (`bake/truth.js`): sandstone ashlar, flagstones at their own tilts, planks with iron bands, roof tiles,
     plaster with brick showing through, glowing runes, a cloudy sky, plus the world's own wear.
3. **A path tracer renders the truth** (`bake/pt.js`, WebGL2 on your own GPU): millions of points of the detailed world, under
   the sky, the sun and each light separately, at every hour.
4. **Four painters learn it** (`bake/train*.py`, numpy):
   - **shape**: for every form, a grid of 8 learned features in its frame and one 8 → 16 → 16 → 1 network for them all; feature 0
     alone is a coarse distance the game steps by, the network places the surface itself (within a millimetre on held-out points);
   - **light**: a grid of learned numbers plus a 24 → 32 → 32 → 18 network; the light at any point from the sky and from each
     beacon at unit strength, so beacons switch on, dim and pulse for free (light adds);
   - **surfaces**: a learned 8-feature texture per material, a half-metre grid of the world's wear, and a 24 → 16 → 16 → 9 network
     that says how each point takes each light (on a shaped surface it is also told how tucked in the point is); it also paints the
     moving things' cloth, skin and smoke;
   - **sky**: a learned texture over the cloud deck plus a 16 → 16 → 16 → 3 network.
5. **The browser runs them** (`game/render.js`, `game/painter.js`, plain WebGL2, no engine, no libraries). Each frame every shaped
   box's shell is traced on the shape painter's coarse distance; at each pixel's nearest hit the shape painter places the surface
   and gives its normal, the light painter lights it, the surface painter paints it; the sky painter paints the sky. The code still
   decides where each box is, where the sun reaches, each moving part's colour, how brightly each crystal glows and where the stars
   are, and adds the camera's haze, exposure and glow.

## Make your own world

1. **The level** (`game/world.js`): add, move or remove boxes with `B(x0, y0, z0, x1, y1, z1, 'material', { form: 'wall' })`. A
   box's material names a row of `MAT` and `MAT_UV`; its form names a row of `FORMS`. The game collides with the boxes; the boxes
   view draws them. The beacons are `BEACONS`; the playable area is `PLAY`; the painters' volume is `GRID` (keep the level inside
   it).
2. **The shapes** (`bake/forms.js`): a form is a distance field in its own frame, which the code fits to every box of that form
   (`FORMS` in `game/world.js`). Each axis of the frame reads the box one way:
   - `['tile', P]` repeats every P metres along a run (a wall's battlements), the period fitted to a whole number in the box;
   - `['mirror', e, m]` is metres in from the nearer face (a wall's thickness, a column's round shaft), as far as e, m outside;
   - `['ends', lo, hi, mLo, mHi]` is metres down from the top face or up from the bottom one (a plinth, a coping, a capital);
   - `['span', N, mLo, mHi]` stretches the whole box from N metres (a canopy, a rock, a body).
   A shape may reach past its box by the margins (merlons over a wall, an arch under a lintel, roots around a trunk); the box is
   still what the game collides with. Keep a field's slope near 1 (it is a distance), and use `atan2s`, never `atan`, about an axis.
3. **The look** (`bake/truth.js`): a material is a function of its pattern coordinates that returns its albedo, its height (for
   the bumps), its cavity and its glow (`Surf`). Rules a painter can learn:
   - a pattern repeats exactly on its material's tile (`MAT_UV`), so every noise frequency times the tile is a whole number (the
     helpers `tn`, `tf` and `tcell` take care of it when you pass the tile);
   - detail finer than the texture's texel (tile ÷ 256: 1.6 cm on a 4 m tile) blurs;
   - the world's own wear (`weather()`) changes slowly, over a metre or more;
   - on a shaped surface the pattern is read along the axis the surface faces most.
4. **Look at the detailed world before anything learns it:** `npm run truth` path-traces it from the cameras in
   `bake/views_truth.json` into `out/truth/`.
5. **Bake and train:** `npm run make:quick` (about 10 minutes) checks the whole loop; `npm run make` is the real one (about 40
   minutes on an M1: the path tracer on its GPU, the trainers on its CPU). Python 3 with numpy (`PYTHON=...` to choose one).
6. **Check it:**
   - `npm run look` renders the same cameras in the game and in the path tracer, side by side, with each frame's time;
   - `npm test` plays the rules;
   - `npm run devices` boots it in Chromium and WebKit, on a desktop and as a phone held upright and turned, and measures the
     frame rate.
7. **Ship it:** `npm run pack` zips the game (`out/game.zip`). To put it on NotesMosaic, where it plays on any phone or computer
   with no download, connect your AI to the NotesMosaic MCP (https://notesmosaic.com/developers/mcp) and have it read the skill:
   `read_skill {"name": "paintbox"}`. It uploads the build, writes its rights declaration and runs the platform's playtest in
   Chromium and WebKit. The game goes public only when you say so.

Your own rules live in `game/main.js` (the rules, the input, the camera, the HUD). Footage: `npm run broll` records the camera
moves in `bake/shots.json`; `npm run gameplay` records a bot playing by the rules (`bake/plays.json`), the HUD and all.

## Numbers (measured on a 2020 13" MacBook Pro, Apple M1, 8 GB)

| | |
|---|---|
| What the painters learned | 14,333,483 numbers, 15.5 MB (4,303 network weights; the rest are feature grids and textures) |
| How close to the path tracer | the shapes within 0.28 mm of the true surface, the look within 3.6 levels out of 255 on screen, on average, at points they never trained on |
| One 960×540 frame | 16–23 ms painted (three cameras), against 46–73 s path-traced at 128 paths a pixel |
| In a browser | 31–46 fps in Chrome's and Safari's engines, at a desktop's 1280×800 and a phone's 775×1677, upright and turned (on the M1; a real phone is not measured yet) |
| Making it | about 40 minutes: path tracing the shaped world on the GPU, then training the four painters on the CPU |

## What it is not

- It isn't Matrix-Game's model, and it doesn't do what that model does. Both learn one scene; theirs redraws the whole frame like a
  video. Ours learns the detailed world's shapes and look in 3D around the code's boxes and traces them: the game still runs on
  boxes, and a box becomes only what its form describes.
- Change the world and you bake again.
- It isn't the first of its kind. Learned feature textures read by a small network are deferred neural rendering (Thies et al.
  2019); a learned distance field on a feature grid with a tiny network, traced in real time, is neural geometric level of detail
  (Takikawa et al., NVIDIA, CVPR 2021); NVIDIA's real-time neural appearance models (SIGGRAPH 2024) run them on RTX tensor hardware; small networks in browser
  shaders have painted captured scenes on phones (SNeRG, MobileNeRF, MERF, SMERF); learned light is radiance regression functions
  (Ren et al. 2013) and Neural Irradiance Volume (2026). Paintbox puts those methods under a game whose rules are code, in plain
  WebGL2, on whatever GPU the player has.

## License

MIT. The game, the detailed world and the trained painters are all made here; nothing in it is anyone else's.
