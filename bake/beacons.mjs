// How each crystal looks and how much light it throws, exactly as the game sets them (main.js draw(), at clock 0, nothing charging).
import { BEACONS, BEACON_POWER, GLOW_LIT } from '../game/world.js';
export function beaconState(lit, t) {
  const awake = t >= 0.595, light = [], glow = [];
  BEACONS.forEach((b, k) => {
    const lvl = lit[k] * BEACON_POWER * (1 + 0.05 * Math.sin(k * 1.7));
    const idle = lit[k] ? 0 : (awake ? 1.2 + 0.9 * Math.sin(k) : 0.35);
    light.push(...b.color.map((c) => c * lvl));
    glow.push(...b.color.map((c) => c * (lvl * GLOW_LIT + idle) + 0.04));
  });
  return { light, glow };
}
