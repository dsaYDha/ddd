import { CONFIG, SURFACE_KEYS } from '../config.js';

// 지면 종류 ID (Uint8 격자에 저장되는 값). 순서는 config.surfaces 키 순서와 같다.
export const SURFACE = Object.freeze({
  PACKED_DIRT: 0,
  LEAF_LITTER: 1,
  WET_EARTH: 2,
  SHALLOW_MUD: 3,
  DEEP_MUD: 4,
  PADDY: 5,
  SHALLOW_WATER: 6,
  DEEP_WATER: 7,
  BRUSH: 8,
});

export const SURFACE_COUNT = SURFACE_KEYS.length;

export function surfaceKey(id) {
  return SURFACE_KEYS[id];
}

/** config 값을 매번 읽는다 → 런타임에 콘솔에서 CONFIG를 고쳐도 바로 반영 */
export function surfaceProps(id) {
  return CONFIG.surfaces[SURFACE_KEYS[id]];
}

export function surfaceLabel(id) {
  return CONFIG.surfaces[SURFACE_KEYS[id]].label;
}

export const isMud = (id) => id === SURFACE.SHALLOW_MUD || id === SURFACE.DEEP_MUD || id === SURFACE.PADDY;
export const isWater = (id) => id === SURFACE.SHALLOW_WATER || id === SURFACE.DEEP_WATER;
