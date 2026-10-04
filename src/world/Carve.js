// =====================================================================
//  Carve — 5단계 임무 개활지 (야영지·강가 모래톱). 원 안의 하층 식생·어린 나무·덩굴 벽·통나무를
//   화면(인스턴스 행렬)·충돌(원기둥·지지형)·시야(체적 식생 σ)·지면(종류·스플랫·지피층)에서 함께 지운다.
//   큰 나무(교목)와 판근, 캐노피는 남긴다 (야영지는 캐노피 아래 — 위에서 안 보이게).
//   되돌리기 기록을 돌려주고 restoreCarve 로 다음 임무 전에 원래대로 (같은 맵을 여러 임무가 쓴다).
// =====================================================================
import { SURFACE } from './Surfaces.js';
import { VEG } from './WorldConstants.js';

// 지우는 인스턴스 종류 (이름 앞부분) — bigTree·outerTrees·bambooDense·rice 는 남김
const REMOVE_KINDS = /^(shrub|taro|rattan|grass|reed|sapling|treeFern|banana|bamboo\d|vineWall|palm|midTree|waterPlant|log|rock|root)/;
const CORE_KINDS = /^(log|rock|root)/;          // 통나무·바위·뿌리는 안쪽(0.85r)만
const REMOVE_CIRCLES = new Set(['midTree', 'palm', 'banana', 'bananaLeaves', 'bamboo', 'treeFern', 'treeFernCrown', 'sapling', 'saplingCrown', 'vineWall']);
const REMOVE_SUPPORTS = new Set(['log', 'rock', 'root']);
const INERT = { blocksMovement: false, visionBlock: 0, bulletBlock: 'none' };

/**
 * @param {import('./World.js').World} world
 * @param {import('../ai/NavGrid.js').NavGrid|null} nav
 * @param {Array<{x:number, z:number, r:number, kind:'camp'|'sandbar'}>} areas
 */
export function carveAreas(world, nav, areas) {
  const d = world.data, q = world.query, inst = world.instanced;
  const rec = { areas: areas.slice(), inst: [], circles: [], supports: [], cells: [], bands: [], splatDirty: false };
  for (const a of areas) {
    const r2 = a.r * a.r, core2 = (a.r * 0.85) ** 2;
    // 1) 인스턴스: 행렬을 0 으로 (그려지지 않음) — 원래 값을 기억
    for (const k of inst.kinds) {
      if (!REMOVE_KINDS.test(k.name)) continue;
      const lim = CORE_KINDS.test(k.name) ? core2 : r2;
      for (const ch of k.chunks) {
        if (Math.abs(ch.cx - a.x) > a.r + inst.chunkSize || Math.abs(ch.cz - a.z) > a.r + inst.chunkSize) continue;
        for (let i = 0; i < ch.count; i++) {
          const dx = ch.pos[i * 3] - a.x, dz = ch.pos[i * 3 + 2] - a.z;
          if (dx * dx + dz * dz > lim) continue;
          if (ch.matrices[i * 16 + 15] === 0) continue;     // 이미 지움 (겹친 원)
          rec.inst.push({ ch, i, m: ch.matrices.slice(i * 16, i * 16 + 16) });
          ch.matrices.fill(0, i * 16, i * 16 + 16);
        }
      }
    }
    // 2) 원기둥 충돌체: 어린 나무·야자·바나나·덩굴 벽 등은 막지도 가리지도 않게
    const seen = new Set();
    q.circleGrid.forEachNear(a.x, a.z, a.r, (c) => {
      if (seen.has(c) || !REMOVE_CIRCLES.has(c.type) || c._carved) return;
      seen.add(c);
      if ((c.x - a.x) ** 2 + (c.z - a.z) ** 2 > r2) return;
      rec.circles.push({ c, tags: c.tags });
      c.tags = INERT;
      c._carved = true;
    });
    // 3) 지지형: 통나무·바위·뿌리 (안쪽)
    const sup = new Set();
    q.supportGrid.forEachNear(a.x, a.z, a.r, (s) => {
      if (sup.has(s) || !REMOVE_SUPPORTS.has(s.type)) return;
      sup.add(s);
      const cx = s.kind === 'capsule' ? (s.ax + s.bx) / 2 : s.cx, cz = s.kind === 'capsule' ? (s.az + s.bz) / 2 : s.cz;
      if ((cx - a.x) ** 2 + (cz - a.z) ** 2 > core2) return;
      rec.supports.push(s);
    });
    for (const s of rec.supports) if (!s._carved) { q.removeSupport(s); s._carved = true; }
    // 4) 지면 (0.5m 칸): 야영지 = 다져진 흙, 모래톱 = 젖은 모래흙 (물 칸은 그대로). 지피층 없음, 스플랫은 흙길 쪽으로
    const sR = d.sRes, i0 = Math.max(0, Math.floor((a.x - a.r + d.half) / sR)), i1 = Math.min(d.sN - 1, Math.floor((a.x + a.r + d.half) / sR));
    const j0 = Math.max(0, Math.floor((a.z - a.r + d.half) / sR)), j1 = Math.min(d.sN - 1, Math.floor((a.z + a.r + d.half) / sR));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = -d.half + (i + 0.5) * sR, z = -d.half + (j + 0.5) * sR;
        const dd = Math.hypot(x - a.x, z - a.z);
        if (dd > a.r) continue;
        const c = j * d.sN + i;
        if (d.waterLevel[c] > -1000 && a.kind === 'sandbar') continue;
        const edge = Math.min(1, (a.r - dd) / (a.r * 0.25));            // 가장자리는 부드럽게
        rec.cells.push({ c, surface: d.surface[c], veg: d.vegKind[c], sp: [d.splat[c * 4], d.splat[c * 4 + 1], d.splat[c * 4 + 2], d.splat[c * 4 + 3]] });
        if (edge > 0.35) {
          d.surface[c] = a.kind === 'sandbar' ? SURFACE.WET_EARTH : SURFACE.PACKED_DIRT;
          d.vegKind[c] = VEG.NONE;
        }
        const S = d.splat;
        S[c * 4] = Math.round(S[c * 4] * (1 - edge) + (a.kind === 'sandbar' ? 40 : 18) * edge);
        S[c * 4 + 1] = Math.round(S[c * 4 + 1] * (1 - edge) + (a.kind === 'sandbar' ? 150 : 215) * edge);
        S[c * 4 + 2] = Math.round(S[c * 4 + 2] * (1 - edge) + (a.kind === 'sandbar' ? 200 : 70) * edge);
        S[c * 4 + 3] = Math.round(S[c * 4 + 3] * (1 - edge));
        rec.splatDirty = true;
      }
    }
    // 5) 체적 식생 (1m 칸): σ 0 — 시야·은폐 계산이 개활지를 트인 곳으로 본다
    const NB = d.coverBandEdges.length - 1;
    for (let j = Math.max(0, Math.floor(a.z - a.r + d.half)); j <= Math.min(d.cN - 1, Math.floor(a.z + a.r + d.half)); j++) {
      for (let i = Math.max(0, Math.floor(a.x - a.r + d.half)); i <= Math.min(d.cN - 1, Math.floor(a.x + a.r + d.half)); i++) {
        const x = -d.half + i + 0.5, z = -d.half + j + 0.5;
        if (Math.hypot(x - a.x, z - a.z) > a.r * 0.95) continue;
        const k = j * d.cN + i;
        rec.bands.push({ k, h: d.coverHeight[k], b: Array.from(d.coverBands.subarray(k * NB, k * NB + NB)) });
        d.coverHeight[k] = 0;
        d.coverBands.fill(0, k * NB, k * NB + NB);
      }
    }
    nav?.rebuildRegion(a.x, a.z, a.r + 4);
  }
  _refresh(world, rec);
  return rec;
}

/** 되돌리기 (역순) */
export function restoreCarve(world, nav, rec) {
  if (!rec) return;
  const d = world.data, q = world.query;
  for (let n = rec.inst.length - 1; n >= 0; n--) {
    const e = rec.inst[n];
    e.ch.matrices.set(e.m, e.i * 16);
  }
  for (const e of rec.circles) { e.c.tags = e.tags; e.c._carved = false; }
  for (const s of rec.supports) if (s._carved) { q.addSupport(s); s._carved = false; }
  for (let n = rec.cells.length - 1; n >= 0; n--) {
    const e = rec.cells[n];
    d.surface[e.c] = e.surface; d.vegKind[e.c] = e.veg;
    for (let k = 0; k < 4; k++) d.splat[e.c * 4 + k] = e.sp[k];
  }
  const NB = d.coverBandEdges.length - 1;
  for (let n = rec.bands.length - 1; n >= 0; n--) {
    const e = rec.bands[n];
    d.coverHeight[e.k] = e.h;
    d.coverBands.set(e.b, e.k * NB);
  }
  for (const a of rec.areas) nav?.rebuildRegion(a.x, a.z, a.r + 4);
  _refresh(world, rec);
}

function _refresh(world, rec) {
  world.instanced.lastPos.set(1e9, 0, 0);          // 다음 update 에서 청크 다시 복사
  const gc = world.groundCover;
  if (gc) { gc.cells.clear(); gc.center.i = 1e9; gc._dirty = true; }
  if (rec.splatDirty) {
    const sp = world.terrainMaterial?.userData?.splat;
    if (sp) sp.needsUpdate = true;
  }
}
