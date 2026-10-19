// The world, owned by code: every box, every material, the beacons and the sky.
// The game and the bake (path tracer + trainer) both import this file, so the painter is trained on exactly the world it paints.

export const MAT = [
  // name,     base albedo (linear), proxy colour (the boxes view)
  ['grass',   [0.150, 0.230, 0.085], [0.42, 0.42, 0.42]],
  ['tile',    [0.500, 0.420, 0.320], [0.55, 0.55, 0.55]],
  ['sand',    [0.580, 0.460, 0.330], [0.80, 0.62, 0.42]],
  ['dark',    [0.290, 0.275, 0.265], [0.48, 0.50, 0.56]],
  ['wood',    [0.360, 0.220, 0.120], [0.66, 0.44, 0.24]],
  ['roof',    [0.500, 0.200, 0.120], [0.80, 0.36, 0.26]],
  ['plaster', [0.700, 0.660, 0.580], [0.90, 0.88, 0.80]],
  ['basalt',  [0.110, 0.110, 0.120], [0.25, 0.25, 0.28]],
  ['crystal', [0.000, 0.000, 0.000], [0.95, 0.95, 0.95]],
  ['moss',    [0.180, 0.290, 0.110], [0.40, 0.62, 0.32]],
  ['banner',  [0.450, 0.070, 0.070], [0.85, 0.20, 0.20]],
  ['bark',    [0.200, 0.130, 0.080], [0.50, 0.34, 0.20]],
  ['leaf',    [0.090, 0.200, 0.060], [0.30, 0.58, 0.28]],
  // what moving things are made of (the colour of each part is the code's: a blue tunic, an orange scarf)
  ['cloth',   [0.700, 0.700, 0.700], [0.60, 0.60, 0.60]],
  ['skin',    [0.800, 0.800, 0.800], [0.80, 0.80, 0.80]],
  ['shade',   [0.050, 0.040, 0.060], [0.10, 0.10, 0.12]],
];
export const M = Object.fromEntries(MAT.map((m, i) => [m[0], i]));

// How each material's pattern sits on a face, for the bake's detailed world and the painter alike:
//   [0, tileU, tileV]        world metres: a wall's courses run on across the boxes it is made of
//   [1, tileU, tileV, vTop]  metres from the box's own corner: one banner, one crate, one pedestal each; a top face is moved up by
//                            vTop, so the sides and the top hold different patterns in the same tile
// The pattern repeats on its tile, so a tiled feature texture can hold it exactly.
export const MAT_UV = {
  grass: [0, 4, 4], tile: [0, 4, 4], sand: [0, 4, 4], dark: [0, 4, 4], wood: [1, 4, 4, 0], roof: [0, 4, 4], plaster: [0, 4, 4],
  basalt: [1, 1.0, 1.6, 0.6], crystal: [1, 0.5, 1.8, 1.3], moss: [0, 4, 4], banner: [1, 1.0, 2.4, 0], bark: [0, 4, 4], leaf: [0, 4, 4],
  cloth: [1, 1.0, 1.0, 0], skin: [1, 0.4, 0.8, 0.4], shade: [1, 1.0, 1.6, 0],
};

// The five beacons: what the player lights. Colour is the light they give; the painter learns each one's light at unit strength.
export const BEACONS = [
  { name: 'amber', color: [1.00, 0.55, 0.20], at: [0.0, 2.15, 0.0] },
  { name: 'teal',  color: [0.20, 0.90, 0.80], at: [14.6, 7.25, -13.8] },
  { name: 'rose',  color: [1.00, 0.28, 0.55], at: [10.9, 1.45, 10.9] },
  { name: 'ice',   color: [0.45, 0.65, 1.00], at: [-11.9, 1.45, 1.0] },
  { name: 'lime',  color: [0.55, 1.00, 0.30], at: [-9.0, 1.85, -11.3] },
];
export const BEACON_POWER = 9.0;   // emitted radiance of a lit crystal (the painter's unit light is scaled by this and the colour)
export const GLOW_LIT = 0.3;       // how bright a lit crystal looks, per unit of the light it throws (bright, but its facets still show)

// ---- what each box IS: its form ----
// The code keeps every box: the game collides with boxes, and the boxes view draws them. A box can also name the FORM it stands for.
// The bake builds that form's detailed shape there (bake/forms.js), the shape painter learns it, and the game traces the learned shape
// inside the box's shell: battlements over a wall, a round column in a square pillar, an arch under a lintel, a canopy in a cube of
// leaves. A box with no form is painted as a box.
//
// A form's shape lives in its own frame, the same for every box of that form whatever its size: the frame is the code's (GLSL_FRAME
// below), the shape in it is learned. Its axes: 0 the box's longer horizontal side, 1 up, 2 the shorter horizontal side (a moving
// part keeps its own x and z). Each axis reads the box one of four ways:
//   ['tile', P]                  along a run (a wall's length): the shape repeats every P metres, the period fitted to a whole number
//   ['mirror', e, m]             across (a wall's thickness): metres in from the nearer face, as far as e (deeper is the plain middle),
//                                and up to m outside it
//   ['ends', lo, hi, mLo, mHi]   up a wall: metres down from the top face (as far as hi), else up from the bottom face (as far as lo),
//                                and up to mLo below the box and mHi above it
//   ['span', N, mLo, mHi]        the whole box (a canopy, a rock, a body): stretched from N metres, mLo and mHi of those outside it
// cell: the shape painter's grid spacing in that frame, in metres.
export const FORMS = [
  { name: 'block' },
  { name: 'wall', cell: 0.04, axes: [['tile', 1.3], ['ends', 0.7, 0.6, 0.0, 0.85], ['mirror', 0.6, 0.14]] },
  { name: 'parapet', cell: 0.04, axes: [['tile', 1.3], ['ends', 0.2, 0.6, 0.0, 0.85], ['mirror', 0.6, 0.14]] },
  { name: 'ruin', cell: 0.05, axes: [['tile', 2.6], ['ends', 0.7, 0.9, 0.0, 0.3], ['mirror', 0.6, 0.14]] },
  { name: 'pier', cell: 0.04, axes: [['mirror', 0.3, 0.75], ['ends', 0.3, 0.95, 0.0, 0.0], ['mirror', 0.6, 0.06]] },
  { name: 'sill', cell: 0.04, axes: [['tile', 1.3], ['ends', 0.7, 0.3, 0.0, 0.05], ['mirror', 0.6, 0.14]] },
  { name: 'archtop', cell: 0.05, axes: [['mirror', 1.5, 0.0], ['ends', 1.2, 0.0, 1.55, 0.0], ['mirror', 0.6, 0.05]] },
  { name: 'post', cell: 0.04, axes: [['mirror', 0.35, 0.08], ['ends', 1.9, 0.25, 0.0, 0.0], ['mirror', 0.35, 0.08]] },
  { name: 'tower', cell: 0.05, axes: [['mirror', 0.7, 0.36], ['ends', 1.4, 1.4, 0.0, 0.0], ['mirror', 0.7, 0.36]] },
  { name: 'merlon', cell: 0.03, axes: [['mirror', 0.45, 0.05], ['ends', 0.2, 0.45, 0.0, 0.18], ['mirror', 0.45, 0.05]] },
  { name: 'column', cell: 0.03, axes: [['mirror', 0.45, 0.0], ['ends', 0.55, 0.62, 0.0, 0.0], ['mirror', 0.45, 0.0]] },
  { name: 'crystal', cell: 0.025, axes: [['mirror', 0.25, 0.08], ['ends', 0.4, 0.8, 0.0, 0.34], ['mirror', 0.25, 0.08]] },
  { name: 'canopy', cell: 0.1, axes: [['span', 3.2, 0.45, 0.45], ['span', 2.6, 0.3, 0.45], ['span', 3.2, 0.45, 0.45]] },
  { name: 'trunk', cell: 0.03, axes: [['mirror', 0.3, 0.18], ['ends', 0.75, 0.2, 0.0, 0.0], ['mirror', 0.3, 0.18]] },
  { name: 'rock', cell: 0.05, axes: [['span', 1.8, 0.12, 0.12], ['span', 0.85, 0.0, 0.14], ['span', 1.45, 0.12, 0.12]] },
  { name: 'roof', cell: 0.16, axes: [['span', 7.3, 0.0, 0.0], ['ends', 0.6, 0.0, 0.0, 1.55], ['span', 7.3, 0.0, 0.0]] },
  { name: 'banner', cell: 0.02, axes: [['span', 1.0, 0.0, 0.0], ['ends', 0.5, 0.15, 0.0, 0.06], ['span', 0.1, 0.06, 0.06]] },
  { name: 'crate', cell: 0.02, axes: [['mirror', 0.5, 0.025], ['mirror', 0.5, 0.025], ['mirror', 0.5, 0.025]] },
  { name: 'chamfer', cell: 0.02, axes: [['mirror', 0.14, 0.0], ['mirror', 0.14, 0.0], ['mirror', 0.14, 0.0]] },
  // the moving things' parts (main.js): each one's own x, y and z
  { name: 'torso', cell: 0.025, axes: [['span', 0.56, 0.04, 0.04], ['span', 0.68, 0.08, 0.03], ['span', 0.34, 0.05, 0.05]] },
  { name: 'limb', cell: 0.015, axes: [['span', 0.18, 0.02, 0.02], ['span', 0.6, 0.02, 0.02], ['span', 0.19, 0.03, 0.03]] },
  { name: 'head', cell: 0.02, axes: [['span', 0.38, 0.03, 0.03], ['span', 0.38, 0.03, 0.04], ['span', 0.38, 0.03, 0.05]] },
  { name: 'roll', cell: 0.015, axes: [['span', 0.6, 0.03, 0.03], ['span', 0.12, 0.03, 0.03], ['span', 0.38, 0.03, 0.03]] },
  { name: 'wraith', cell: 0.04, axes: [['span', 0.75, 0.15, 0.15], ['span', 1.25, 0.12, 0.12], ['span', 0.75, 0.15, 0.15]] },
  { name: 'orb', cell: 0.025, axes: [['span', 0.42, 0.1, 0.1], ['span', 0.42, 0.1, 0.1], ['span', 0.42, 0.1, 0.1]] },
];
export const FORM = Object.fromEntries(FORMS.map((f, i) => [f.name, i]));

// a box's frame: which world axis is its axis 0 (x, or z when the box is longer along z), its half sizes in its own order, and how far
// its form reaches past it on each side (the shell the game traces inside)
export function formFrame(form, min, max, swap) {
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (swap === undefined) swap = size[2] > size[0] + 1e-6;
  const h = swap ? [size[2] / 2, size[1] / 2, size[0] / 2] : [size[0] / 2, size[1] / 2, size[2] / 2];
  const lo = [0, 0, 0], hi = [0, 0, 0], f = FORMS[form];
  if (f.axes) f.axes.forEach((a, i) => {
    if (a[0] === 'mirror') { lo[i] = hi[i] = a[2]; }
    else if (a[0] === 'ends') { lo[i] = a[3]; hi[i] = a[4]; }
    else if (a[0] === 'span') { const s = (2 * h[i]) / a[1]; lo[i] = a[2] * s; hi[i] = a[3] * s; }
  });
  return { swap, h, lo, hi };
}

// what is certainly solid in a box of each form (the bake's shadow rays stop there without tracing the form): per axis of the form's
// frame, how far in from each side, in metres (in nominal metres, scaled, along a 'span' axis). A form with none is always traced.
const INNER = {
  wall: [[0, 0], [0, 0.05], [0.05, 0.05]], parapet: [[0, 0], [0.04, 0.05], [0.05, 0.05]], ruin: [[0, 0], [0, 0.95], [0.05, 0.05]],
  pier: [[0.05, 0.05], [0, 0], [0.05, 0.05]], sill: [[0, 0], [0, 0.05], [0.05, 0.05]], archtop: [[0, 0], [0.03, 0.03], [0.05, 0.05]],
  post: [[0.07, 0.07], [0, 0.03], [0.07, 0.07]], tower: [[0.13, 0.13], [0, 0.03], [0.13, 0.13]], merlon: [[0.08, 0.08], [0, 0.06], [0.08, 0.08]],
  column: [[0.27, 0.27], [0, 0], [0.27, 0.27]], crystal: [[0.14, 0.14], [0, 0.4], [0.14, 0.14]], canopy: [[0.9, 0.9], [0.8, 0.9], [0.9, 0.9]],
  trunk: [[0.2, 0.2], [0, 0], [0.2, 0.2]], rock: [[0.5, 0.5], [0.15, 0.35], [0.45, 0.45]], roof: [[0.04, 0.04], [0.03, 0.03], [0.04, 0.04]],
  crate: [[0.035, 0.035], [0.035, 0.035], [0.035, 0.035]], chamfer: [[0.045, 0.045], [0.045, 0.045], [0.045, 0.045]],
};
export function innerOf(b) {
  const spec = INNER[FORMS[b.form].name];
  if (!b.form || !spec) return null;
  const fr = formFrame(b.form, b.min, b.max), axes = FORMS[b.form].axes;
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const k = axes[i][0] === 'span' ? (2 * fr.h[i]) / axes[i][1] : 1, w = fr.swap ? [2, 1, 0][i] : i;
    lo[w] = b.min[w] + spec[i][0] * k; hi[w] = b.max[w] - spec[i][1] * k;
    if (hi[w] <= lo[w] + 0.01) return null;
  }
  return { min: lo, max: hi };
}

// a box's shell in the world: the box and as far past it as its form reaches (a box with no form is its own shell)
export function shellOf(b) {
  if (!b.form) return { min: b.min, max: b.max, swap: 0 };
  const fr = formFrame(b.form, b.min, b.max);
  const wl = fr.swap ? [fr.lo[2], fr.lo[1], fr.lo[0]] : fr.lo, wh = fr.swap ? [fr.hi[2], fr.hi[1], fr.hi[0]] : fr.hi;
  return { min: b.min.map((v, i) => v - wl[i]), max: b.max.map((v, i) => v + wh[i]), swap: fr.swap ? 1 : 0 };
}

export const BOXES = [];
// mat: what the box is made of; o.form: what it is (FORMS); o.emit: the beacon whose light it throws; o.glow: the beacon it glows with
function B(x0, y0, z0, x1, y1, z1, mat, o = {}) {
  const e = o.emit ?? -1, glow = o.glow ?? e;
  BOXES.push({ min: [x0, y0, z0], max: [x1, y1, z1], m: M[mat], e, glow, form: FORM[o.form || 'block'] });
}

// ground and the courtyard floor
B(-2000, -1, -2000, 2000, 0, 2000, 'grass');   // out past the haze: from a tower the land runs to the horizon
B(-13, 0, -13, 13, 0.2, 13, 'tile');

// north wall with its gate: two posts and an arch under the parapet
B(-12.6, 0, -14.2, -2.2, 5.2, -13, 'sand', { form: 'wall' });
B(2.2, 0, -14.2, 12.6, 5.2, -13, 'sand', { form: 'wall' });
B(-2.2, 0, -14.5, -1.5, 4.4, -12.7, 'dark', { form: 'post' });
B(1.5, 0, -14.5, 2.2, 4.4, -12.7, 'dark', { form: 'post' });
B(-1.5, 3.2, -14.5, 1.5, 4.4, -12.7, 'dark', { form: 'archtop' });
B(-2.2, 4.4, -14.2, 2.2, 5.2, -13, 'sand', { form: 'parapet' });
B(-4.2, 2.2, -13.0, -3.2, 4.6, -12.9, 'banner', { form: 'banner' });
B(3.2, 2.2, -13.0, 4.2, 4.6, -12.9, 'banner', { form: 'banner' });

// west wall with three tall arched windows: a sill, piers whose springers meet over each window, a parapet
B(-14.2, 0, -12.6, -13, 1.6, 12.6, 'sand', { form: 'sill' });
B(-14.2, 4.0, -12.6, -13, 5.2, 12.6, 'sand', { form: 'parapet' });
for (const [z0, z1] of [[-12.6, -7.0], [-5.5, -0.75], [0.75, 5.5], [7.0, 12.6]]) B(-14.2, 1.6, z0, -13, 4.0, z1, 'sand', { form: 'pier' });

// east wall, ruined: the evening sun comes in over it
B(13, 0, -12.6, 14.2, 5.2, -8.0, 'sand', { form: 'wall' });
B(13, 0, -8.0, 14.2, 1.4, -4.0, 'sand', { form: 'ruin' });
B(13, 0, -4.0, 14.2, 2.6, 1.0, 'sand', { form: 'ruin' });
B(13, 0, 1.0, 14.2, 0.6, 7.0, 'sand', { form: 'ruin' });
B(13, 0, 7.0, 14.2, 5.2, 12.6, 'sand', { form: 'wall' });

// south wall with an arch
B(-12.6, 0, 13, -6.4, 5.2, 14.2, 'sand', { form: 'wall' });
B(-3.4, 0, 13, 12.6, 5.2, 14.2, 'sand', { form: 'wall' });
B(-6.4, 3.2, 13, -3.4, 4.4, 14.2, 'sand', { form: 'archtop' });
B(-6.4, 4.4, 13, -3.4, 5.2, 14.2, 'sand', { form: 'parapet' });

// corner towers (the north-east one is lower and reached by stairs)
function merlons(x0, z0, x1, z1, y, sides) {
  const s = 0.9, h = 0.8, mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const put = (x, z) => B(x - s / 2, y, z - s / 2, x + s / 2, y + h, z + s / 2, 'dark', { form: 'merlon' });
  if (sides.includes('n')) for (const x of [x0 + s / 2, mx, x1 - s / 2]) put(x, z0 + s / 2);
  if (sides.includes('s')) for (const x of [x0 + s / 2, mx, x1 - s / 2]) put(x, z1 - s / 2);
  if (sides.includes('w')) put(x0 + s / 2, mz);
  if (sides.includes('e')) put(x1 - s / 2, mz);
}
B(-16.6, 0, -16.6, -12.6, 7.5, -12.6, 'dark', { form: 'tower' }); merlons(-16.6, -16.6, -12.6, -12.6, 7.5, 'nswe');
B(-16.6, 0, 12.6, -12.6, 7.5, 16.6, 'dark', { form: 'tower' });   merlons(-16.6, 12.6, -12.6, 16.6, 7.5, 'nswe');
B(12.6, 0, 12.6, 16.6, 7.5, 16.6, 'dark', { form: 'tower' });     merlons(12.6, 12.6, 16.6, 16.6, 7.5, 'nswe');
B(12.6, 0, -16.6, 16.6, 6.0, -11.0, 'dark', { form: 'tower' });   merlons(12.6, -16.6, 16.6, -11.0, 6.0, 'ne');

// stairs up to the north-east tower
for (let i = 0; i < 11; i++) B(1.6 + i, 0, -13, 2.6 + i, 0.2 + (5.8 / 11) * (i + 1), -11.6, 'sand', { form: 'chamfer' });

// the central plinth
B(-2.6, 0.2, -2.6, 2.6, 0.55, 2.6, 'dark', { form: 'chamfer' });
B(-1.7, 0.55, -1.7, 1.7, 0.9, 1.7, 'sand', { form: 'chamfer' });

// the shed in the south-east corner (its door faces the yard), under a hipped roof
B(6.0, 0, 7.0, 7.0, 3.6, 13.0, 'plaster', { form: 'chamfer' });
B(6.0, 0, 6.0, 8.6, 3.6, 7.0, 'plaster', { form: 'chamfer' });
B(10.8, 0, 6.0, 13.0, 3.6, 7.0, 'plaster', { form: 'chamfer' });
B(8.6, 2.7, 6.0, 10.8, 3.6, 7.0, 'plaster', { form: 'chamfer' });
B(5.7, 3.6, 5.7, 13.0, 4.2, 13.0, 'roof', { form: 'roof' });

// the west colonnade
for (const zc of [-9.0, -5.0, -1.0, 3.0, 7.0]) B(-10.45, 0.2, zc - 0.45, -9.55, 4.2, zc + 0.45, 'plaster', { form: 'column' });
B(-13.0, 4.2, -10.0, -9.3, 4.8, 8.0, 'wood', { form: 'chamfer' });

// the raised garden bed in the north-west
B(-12.0, 0.2, -13.0, -6.0, 0.6, -9.6, 'moss', { form: 'chamfer' });
B(-11.6, 0.6, -12.7, -10.6, 1.4, -11.7, 'leaf', { form: 'canopy' });
B(-7.4, 0.6, -12.6, -6.5, 1.2, -11.6, 'leaf', { form: 'canopy' });

// crates, rubble, benches
B(10.8, 0.2, -5.4, 11.8, 1.2, -4.4, 'wood', { form: 'crate' });
B(11.0, 1.2, -5.2, 11.8, 2.0, -4.4, 'wood', { form: 'crate' });
B(10.6, 0.2, -3.8, 11.4, 1.0, -3.0, 'wood', { form: 'crate' });
B(12.0, 0.2, 3.6, 13.0, 0.7, 4.6, 'dark', { form: 'rock' });
B(11.4, 0.2, 5.0, 12.4, 0.5, 5.8, 'dark', { form: 'rock' });
B(-8.2, 0.2, 10.8, -7.2, 1.2, 11.8, 'wood', { form: 'crate' });
B(-2.6, 0.2, 11.4, -1.8, 1.0, 12.2, 'wood', { form: 'crate' });
B(4.3, 0.2, -0.6, 5.5, 0.6, 0.6, 'sand', { form: 'chamfer' });
B(-0.6, 0.2, 4.3, 0.6, 0.6, 5.5, 'sand', { form: 'chamfer' });

// trees and rocks outside the walls
for (const [x, z] of [[-19.5, -18.5], [19.5, -4.0], [-19.0, 6.5], [18.5, 19.0], [-7.5, 19.0], [6.5, -19.0]]) {
  B(x - 0.3, 0, z - 0.3, x + 0.3, 2.5, z + 0.3, 'bark', { form: 'trunk' });
  B(x - 1.6, 2.2, z - 1.6, x + 1.6, 4.8, z + 1.6, 'leaf', { form: 'canopy' });
  B(x - 1.0, 4.8, z - 1.0, x + 1.0, 5.8, z + 1.0, 'leaf', { form: 'canopy' });
}
for (const [x, z, s] of [[-17.5, -2.0, 0.9], [17.0, 9.0, 1.1], [3.0, 18.0, 0.8], [-3.0, -18.5, 1.0]]) B(x - s, 0, z - s * 0.8, x + s, s * 0.9, z + s * 0.8, 'dark', { form: 'rock' });

// pedestals and crystals: the code keeps how brightly each one glows; the painter paints the glow
const PED = [[0, 0.9], [14.6, 6.0], [10.9, 0.2], [-11.9, 0.2], [-9.0, 0.6]];
BEACONS.forEach((b, k) => {
  const [x, y] = PED[k], z = [0, -13.8, 10.9, 1.0, -11.3][k];
  B(x - 0.5, y, z - 0.5, x + 0.5, y + 0.6, z + 0.5, 'basalt', { glow: k, form: 'chamfer' });   // its runes glow with its crystal
  B(x - 0.25, y + 0.6, z - 0.25, x + 0.25, y + 1.9, z + 0.25, 'crystal', { emit: k, form: 'crystal' });
  b.at = [x, y + 1.25, z];
});

// How each face meets the world at its four edges (u-low, u-high, v-low, v-high, in faceUV's order): 1 an outside corner (the bake's
// stone is rounded and worn there), 2 an inside corner (another box rises beyond it), 0 the surface runs on into another box.
// Faces in BOXES order: axis 0 low, 0 high, 1 low, 1 high, 2 low, 2 high.
export const UVAX = [[2, 1], [0, 2], [0, 1]];   // for a face across axis a: which world axes are its u and v
export function edgeFlags(b, a, side) {
  const [ua, va] = UVAX[a], plane = side ? b.max[a] : b.min[a], out = [];
  for (const [ax, hi] of [[ua, 0], [ua, 1], [va, 0], [va, 1]]) {
    const other = ax === ua ? va : ua, votes = [0, 0, 0];
    for (const s of [0.2, 0.5, 0.8]) {
      const p = [0, 0, 0];
      p[a] = plane; p[ax] = hi ? b.max[ax] : b.min[ax]; p[other] = b.min[other] + (b.max[other] - b.min[other]) * s;
      const above = [...p], below = [...p];
      above[ax] += hi ? 0.03 : -0.03; above[a] += side ? 0.03 : -0.03;
      below[ax] += hi ? 0.03 : -0.03; below[a] -= side ? 0.03 : -0.03;
      votes[insideAnyBox(above) ? 2 : insideAnyBox(below) ? 0 : 1]++;
    }
    out.push(votes.indexOf(Math.max(...votes)));
  }
  return out;
}

// the painter's volume: where its grid lives (outside it the light fades to a plain sky)
export const GRID = { min: [-20, -0.5, -20], max: [20, 9.5, 20], h1: 0.5, h0: 2.0, f1: 8, f0: 4 };
GRID.n1 = GRID.max.map((v, i) => Math.round((v - GRID.min[i]) / GRID.h1) + 1);
GRID.n0 = GRID.max.map((v, i) => Math.round((v - GRID.min[i]) / GRID.h0) + 1);
GRID.off = 0.25;   // the grid is read half a cell off the surface, so the two sides of a wall never share a cell

export const PLAY = { half: 18.5, spawn: [0, 0.2, 8.5] };

// ---- shared GLSL: the sky, the materials, the tone. One text for the game and the bake. ----
const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const v3 = (a) => `vec3(${a.map(f).join(', ')})`;

export const GLSL_COMMON = `
const float PI = 3.14159265359;
float sunElev(float t) { return mix(30.0, -20.0, t); }
vec3 sunDir(float t) {
  float e = radians(sunElev(t));
  vec3 h = normalize(vec3(0.9, 0.0, 0.38));
  return normalize(vec3(h.x * cos(e), sin(e), h.z * cos(e)));
}
vec3 sunIrr(float t) {
  float e = sunElev(t);
  float vis = smoothstep(-0.5, 3.5, e);
  vec3 c = mix(vec3(1.0, 0.33, 0.09), vec3(1.0, 0.82, 0.62), smoothstep(2.0, 24.0, e));
  return c * vis * mix(1.7, 3.2, smoothstep(2.0, 20.0, e));
}
vec3 key5(float t, vec3 a, vec3 b, vec3 c, vec3 d, vec3 e) {
  if (t < 0.35) return mix(a, b, smoothstep(0.0, 0.35, t));
  if (t < 0.59) return mix(b, c, smoothstep(0.35, 0.59, t));
  if (t < 0.78) return mix(c, d, smoothstep(0.59, 0.78, t));
  return mix(d, e, smoothstep(0.78, 1.0, t));
}
vec3 skyZenith(float t)  { return key5(t, vec3(0.13, 0.25, 0.52), vec3(0.10, 0.17, 0.40), vec3(0.055, 0.075, 0.21), vec3(0.014, 0.018, 0.055), vec3(0.005, 0.007, 0.020)); }
vec3 skyHorizon(float t) { return key5(t, vec3(0.42, 0.46, 0.52), vec3(0.60, 0.50, 0.38), vec3(0.78, 0.38, 0.21), vec3(0.11, 0.055, 0.085), vec3(0.008, 0.009, 0.018)); }
vec3 skyGlow(float t)    { return key5(t, vec3(0.10, 0.06, 0.02), vec3(0.45, 0.24, 0.08), vec3(0.95, 0.42, 0.16), vec3(0.20, 0.06, 0.05), vec3(0.0)); }
vec3 skyRadiance(vec3 d, float t) {
  if (d.y < 0.0) return skyHorizon(t) * vec3(0.10, 0.11, 0.09);
  vec3 col = mix(skyHorizon(t), skyZenith(t), pow(d.y, 0.42));
  vec3 s = sunDir(t);
  vec3 hs = normalize(vec3(s.x, 0.0, s.z));
  vec3 hd = normalize(vec3(d.x, 0.0, d.z) + vec3(1e-5));
  col += skyGlow(t) * pow(max(dot(hd, hs), 0.0), 5.0) * exp(-d.y * 6.0);
  return col;
}
float exposureAt(float t) { return mix(1.0, 3.4, smoothstep(0.45, 0.92, t)); }
vec3 tonemap(vec3 x) {
  x *= 0.8;
  x = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  return pow(x, vec3(1.0 / 2.2));
}
vec3 applyFog(vec3 col, vec3 ro, vec3 p, float t) {
  vec3 d = p - ro;
  float dist = length(d);
  vec3 fc = skyRadiance(normalize(vec3(d.x, 0.04, d.z)), t);
  return mix(col, fc, 1.0 - exp(-dist * 0.0085));
}

const vec3 MAT_ALBEDO[${MAT.length}] = vec3[${MAT.length}](${MAT.map((m) => v3(m[1])).join(', ')});
const vec3 MAT_PROXY[${MAT.length}] = vec3[${MAT.length}](${MAT.map((m) => v3(m[2])).join(', ')});

uint hashu(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x ^ v.y ^ v.z;
}
float hash3(vec3 p) { return float(hashu(uvec3(ivec3(floor(p)) + 4096))) * (1.0 / 4294967295.0); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// the axis a surface faces most along (x before y before z on a tie, as the trainers' argmax reads it): a box's face, or a shaped
// surface at any slope
int domAxis(vec3 n) { vec3 a = abs(n); return (a.x >= a.y && a.x >= a.z) ? 0 : (a.y >= a.z ? 1 : 2); }
vec2 faceUV(vec3 p, vec3 n) { int k = domAxis(n); return k == 0 ? p.zy : (k == 2 ? p.xy : p.xz); }
// the face's own directions: T along u, B along v (faceUV's order)
void faceTB(vec3 n, out vec3 T, out vec3 B) {
  int k = domAxis(n);
  if (k == 0) { T = vec3(0, 0, 1); B = vec3(0, 1, 0); }
  else if (k == 2) { T = vec3(1, 0, 0); B = vec3(0, 1, 0); }
  else { T = vec3(1, 0, 0); B = vec3(0, 0, 1); }
}
const vec4 MAT_UV[${MAT.length}] = vec4[${MAT.length}](${MAT.map((m) => { const u = MAT_UV[m[0]]; return `vec4(${f(u[0])}, ${f(u[1])}, ${f(u[2])}, ${f(u[3] || 0)})`; }).join(', ')});
// where a material's pattern is at a point (see MAT_UV)
vec2 matUV(int m, vec3 p, vec3 n, vec3 bmin) {
  vec4 mu = MAT_UV[m];
  if (mu.x < 0.5) return faceUV(p, n);
  vec2 uv = faceUV(p - bmin, n);
  if (domAxis(n) == 1) uv.y += mu.w;
  return uv;
}
// ---- a form's frame (FORMS): where a point of a box is in the frame its form's shape lives in. The bake's truth and the game's shape
// painter both read the shape through this, so the painter learns the shape exactly where the game will ask for it. ----
const float NO_BAND = 9.0;
const vec4 FORM_A[${FORMS.length * 3}] = vec4[${FORMS.length * 3}](${FORMS.flatMap((fm) => (fm.axes || [['mirror', 0, 0], ['mirror', 0, 0], ['mirror', 0, 0]]).map((a) => { const k = { tile: 0, mirror: 1, ends: 2, span: 3 }[a[0]]; return `vec4(${f(k)}, ${f(a[1])}, ${f(a[2] || 0)}, ${f(a[3] || 0)})`; })).join(', ')});
const vec4 FORM_B[${FORMS.length * 3}] = vec4[${FORMS.length * 3}](${FORMS.flatMap((fm) => (fm.axes || [0, 0, 0]).map((a) => `vec4(${f(Array.isArray(a) && a[0] === 'ends' ? a[4] : 0)}, 0.0, 0.0, 0.0)`)).join(', ')});
// one axis: x from the box's centre, h its half size; k is lowered where the frame squeezes distance (a shape's distance times k is
// never longer than the real one, so the trace never steps through it)
float formAxis(int i, float x, float h, inout float k) {
  vec4 A = FORM_A[i];
  int mode = int(A.x + 0.5);
  if (mode == 0) { float L = 2.0 * h, n = max(1.0, floor(L / A.y + 0.5)), pf = L / n; k = min(k, pf / A.y); return mod(x + h, pf) * (A.y / pf); }
  if (mode == 1) return clamp(h - abs(x), -A.z, A.y);
  if (mode == 2) {
    float dlo = x + h, dhi = h - x;
    if (dhi < A.z) return A.w + A.y + A.z - max(dhi, -FORM_B[i].x);
    if (dlo < A.y) return A.w + max(dlo, -A.w);
    return A.w + A.y;
  }
  float s = 2.0 * h / A.y; k = min(k, s); return (x + h) / s;
}
vec3 formCanon(int f, vec3 x, vec3 h, out float k) {
  k = 1.0;
  return vec3(formAxis(f * 3, x.x, h.x, k), formAxis(f * 3 + 1, x.y, h.y, k), formAxis(f * 3 + 2, x.z, h.z, k));
}
// the form's own reading of its 'ends' axis: metres down from the top face and up from the bottom face (NO_BAND where it is not near
// that face)
vec2 formEnds(int f, int a, float c) {
  vec4 A = FORM_A[f * 3 + a];
  float j = A.w + A.y;
  return c > j ? vec2(j + A.z - c, NO_BAND) : (c < j ? vec2(NO_BAND, c - A.w) : vec2(NO_BAND));
}
// what the painter is told about the face's edges at a point: the nearest outside corner across u and across v (signed by side, over
// the last 6 cm), how near an inside corner is (half a metre) and how near any outside corner is (30 cm)
vec4 edgeFeatures(vec2 uv, vec2 lo, vec2 hi, vec4 fl) {
  vec4 d = vec4(uv.x - lo.x, hi.x - uv.x, uv.y - lo.y, hi.y - uv.y);
  vec4 r6 = 1.0 - clamp(d / 0.06, 0.0, 1.0), r30 = 1.0 - clamp(d / 0.3, 0.0, 1.0), r50 = 1.0 - clamp(d / 0.5, 0.0, 1.0);
  vec4 cx = vec4(equal(fl, vec4(1.0))), cc = vec4(equal(fl, vec4(2.0)));
  return vec4(r6.y * cx.y - r6.x * cx.x, r6.w * cx.w - r6.z * cx.z, max(max(r50.x * cc.x, r50.y * cc.y), max(r50.z * cc.z, r50.w * cc.w)),
              max(max(r30.x * cx.x, r30.y * cx.y), max(r30.z * cx.z, r30.w * cx.w)));
}
// facts the code keeps about the sky: where the stars are, where the sun's disk is
float starMask(vec3 d) {
  if (d.y <= 0.0) return 0.0;
  vec3 c = d * 140.0, f = fract(c) - 0.5;
  return step(0.9965, hash3(floor(c) + 17.0)) * smoothstep(0.32, 0.12, length(f)) * smoothstep(0.0, 0.15, d.y);   // a point of light in its cell
}
float sunDisk(vec3 d, float t) { return smoothstep(0.99975, 0.99985, dot(d, sunDir(t))); }
`;

// a form's frame as the shape painter's grid covers it: per axis the span of the frame [lo, hi], its grid points, whether it wraps
export function formDomain(form) {
  const fm = FORMS[form];
  return fm.axes.map((a) => {
    let lo, hi, wrap = false;
    if (a[0] === 'tile') { lo = 0; hi = a[1]; wrap = true; }
    else if (a[0] === 'mirror') { lo = -a[2]; hi = a[1]; }
    else if (a[0] === 'ends') { lo = 0; hi = a[3] + a[1] + a[2] + a[4]; }
    else { lo = -a[2]; hi = a[1] + a[3]; }
    const n = wrap ? Math.max(2, Math.round((hi - lo) / fm.cell)) : Math.max(2, Math.round((hi - lo) / fm.cell) + 1);
    return { lo, hi, wrap, n };
  });
}

// ---- small JS helpers the game rules use ----
export function sunElevDeg(t) { return 30 - 50 * t; }
export function boxContains(b, p, pad = 0) {
  return p[0] > b.min[0] - pad && p[0] < b.max[0] + pad && p[1] > b.min[1] - pad && p[1] < b.max[1] + pad && p[2] > b.min[2] - pad && p[2] < b.max[2] + pad;
}
export function insideAnyBox(p, pad = 0) { for (const b of BOXES) if (boxContains(b, p, pad)) return true; return false; }
