// =====================================================================
//  Handling — 6단계 총 다루기 (순수 로직)
//   · muzzleBlock: 눈 아래 총열 시작점에서 시선 방향으로 총 길이(handling.muzzle.length) 안에 줄기·대나무·바위·통나무·지형이 있으면
//     그만큼 막힘 k (0~1). 화면은 총을 들어 올리거나(raiseDeg × k) 뒤로 당기고(pullBack × k), k > blockFire 면 사격 불가.
//   · snagDelay: 총 높이 잎 소광계수 σ ≥ snag.sigma 인 빽빽한 덤불 속에서 조준을 시작하면 snag.chance 확률로 delay 초 늦어짐
// =====================================================================
import { CONFIG } from '../config.js';

/**
 * @param {import('../world/WorldQuery.js').WorldQuery} query
 * @param {{x,y,z}} start  총열 시작 (어깨·눈 아래)
 * @param {{x,y,z}} dir    시선 방향 (단위 벡터)
 * @param {number} [L]     총 길이 (m)
 * @returns {{ k: number, free: number, type: string|null }}  free = 막히기 전까지 길이 (m)
 */
export function muzzleBlock(query, start, dir, L = CONFIG.handling.muzzle.length) {
  const H = CONFIG.handling.muzzle;
  const n = Math.max(4, Math.ceil(L / 0.08));
  let free = L, type = null;
  const grid = query.circleGrid;
  for (let i = 1; i <= n; i++) {
    const t = (i / n) * L;
    const x = start.x + dir.x * t, y = start.y + dir.y * t, z = start.z + dir.z * t;
    // 지형 · 통나무·바위·논둑 윗면
    if (y < query.getTerrainHeight(x, z) + 0.02 || y < query.getSupportHeight(x, z) - 0.02) { free = t; type = 'ground'; break; }
    // 줄기·대나무·덩굴 벽 (몸을 막는 원기둥)
    const list = grid.at(x, z);
    let hit = null;
    for (let k = 0; k < list.length; k++) {
      const c = list[k];
      if (!c.tags.blocksMovement || c.r < 0.03) continue;
      if (y < c.y0 || y > c.y1) continue;
      if ((c.x - x) ** 2 + (c.z - z) ** 2 < (c.r + H.radius) ** 2) { hit = c; break; }
    }
    if (hit) { free = t; type = hit.type; break; }
  }
  // 끝에 살짝 닿으면 조금, 깊이 박힐수록 크게 (총 길이의 60% 를 지나면 최대)
  const k = Math.max(0, Math.min(1, (L - free) / (L * 0.6)));
  return { k, free, type };
}

/** 빽빽한 덤불 속 조준 시작 → 걸려서 늦어지는 시간 (s, 대개 0) */
export function snagDelay(sigma, rng) {
  const S = CONFIG.handling.snag;
  if (!(sigma >= S.sigma)) return 0;
  return rng.chance(S.chance) ? S.delay : 0;
}

/** 점 (x, y, z) 의 잎 소광계수 σ (1/m) — 체적형 식생 높이 구간 (WorldQuery 자료) */
export function foliageSigma(query, x, y, z) {
  const d = query.data;
  const edges = d.coverBandEdges, bands = d.coverBands;
  if (!edges || !bands) return 0;
  const NB = edges.length - 1;
  const h = y - query.getTerrainHeight(x, z);
  if (h < 0 || h >= edges[NB]) return 0;
  let b = 0;
  while (h >= edges[b + 1]) b++;
  return bands[query._cIdx(x, z) * NB + b] ?? 0;
}
