// 식생·장애물 배치 (순수 데이터) + 캐노피·은폐·차폐(AO) 격자
// 층 구조: 교목층(판근 큰 나무, 리아나) / 아교목층(야자·대나무·나무고사리·어린 나무)
//         / 관목층(덤불·토란잎·야생 바나나·등나무·코끼리풀) / 지피층(렌더러가 플레이어 주변에 동적으로 생성)
// 모든 배치 오브젝트에는 config.objects 의 태그가 붙는다.
import { CONFIG } from '../config.js';
import { lerp, smoothstep } from '../core/math.js';
import { SURFACE } from './Surfaces.js';
import { LAYOUT, riverCenterZ } from './MapLayout.js';
import { BIG_TREE_VARIANTS, finRidge } from './TreeVariants.js';
import { NO_WATER, VEG } from './WorldConstants.js';

const TAU = Math.PI * 2;

export function placeFlora(ctx) {
  const {
    data, rng, half, start, streams, trails, paddy,
    heightAt, slopeAt, surfAt, waterAt, trailDistAt, vegAt, lowAt, streamDistAt, swampQ, occ, jitterGrid,
  } = ctx;
  const P = data.placements;
  const circles = data.circles;
  const supports = data.supports;
  const T = CONFIG.objects;
  const VC = CONFIG.vegetation;
  const R = LAYOUT.river;
  const beltX = LAYOUT.bambooBelt.xStart;
  const free = (x, z, r) => !occ.any(x, z, r);
  const inBounds = (x, z, m = 4) => Math.abs(x) < half - m && Math.abs(z) < half - m;
  const outsideCliff = (x, z) => z > -half + LAYOUT.cliff.width + 2 && x > -half + LAYOUT.cliff.width + 2;
  const forest = (s) => s === SURFACE.GROUND_COVER || s === SURFACE.SHRUB || s === SURFACE.LEAF_LITTER || s === SURFACE.WET_EARTH || s === SURFACE.BRUSH;
  const solid = (s) => forest(s) || s === SURFACE.PACKED_DIRT;
  const startDist = (x, z) => Math.hypot(x - start.x, z - start.z);
  const moistAt = (x, z) => {
    const v = vegAt(x, z);
    return v === VEG.BANK || v === VEG.REED || lowAt(x, z) > 0.55 || streamDistAt(x, z) < 22;
  };
  // 트인 곳(늪·논·강)의 가장자리 띠: 빛이 들어 덤불·어린 나무가 벽처럼 빽빽함 (0~1)
  const edgeK = (x, z) => {
    let k = 0;
    const q = swampQ(x, z);
    if (q > 1.12 && q < 2.0) k = Math.max(k, 1 - Math.abs(q - 1.42) / 0.58);
    const pd = paddy.signedDistance(x, z);
    if (pd > 1.8 && pd < 13) k = Math.max(k, 1 - Math.abs(pd - 6.5) / 6.5);
    const rd = Math.abs(z - riverCenterZ(x)) - R.halfWidth;
    if (rd > 2.5 && rd < 15) k = Math.max(k, 1 - Math.abs(rd - 8) / 7.5);
    return Math.max(0, Math.min(1, k * 1.4));
  };

  // 줄기 밑동 주변은 밟히고 그늘져 낙엽만 (지피식물·덤불 → 낙엽)
  const markLitter = (cx, cz, rad) => {
    const { sN, sRes } = data;
    const i0 = Math.max(0, Math.floor((cx - rad + half) / sRes)), i1 = Math.min(sN - 1, Math.floor((cx + rad + half) / sRes));
    const j0 = Math.max(0, Math.floor((cz - rad + half) / sRes)), j1 = Math.min(sN - 1, Math.floor((cz + rad + half) / sRes));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = -half + (i + 0.5) * sRes, z = -half + (j + 0.5) * sRes;
        if ((x - cx) ** 2 + (z - cz) ** 2 > rad * rad) continue;
        const c = j * sN + i;
        const s = data.surface[c];
        if (s !== SURFACE.GROUND_COVER && s !== SURFACE.SHRUB) continue;
        data.surface[c] = SURFACE.LEAF_LITTER;
        data.vegKind[c] = VEG.LITTER;
        data.splat[c * 4 + 3] = Math.min(data.splat[c * 4 + 3], 70);
      }
    }
  };

  /** 판근 나무 하나 (큰 나무·중층 나무 공용): 줄기 충돌 원기둥 + 판근 지지 캡슐 */
  const addTree = (list, type, r, x, z, variant, scale) => {
    const V = BIG_TREE_VARIANTS[variant];
    const trunkR = V.trunkR * scale;
    const colR = trunkR * 1.22;
    const tilt = [r.range(-0.04, 0.04), r.range(-0.04, 0.04)];
    const height = V.height * scale;
    // 기울기로 옮겨진 수관 중심 (렌더링 trsMatrix 의 'YXZ' 회전과 같은 계산)
    const rot = r.range(0, TAU);
    const lx = -Math.sin(tilt[1]) * height, lz = Math.sin(tilt[0]) * Math.cos(tilt[1]) * height;
    const tree = {
      x, z, y: heightAt(x, z) - 0.2, rot, variant, scale, height, trunkR, crownR: V.crownR * scale, tilt, rank: r.float(),
      crownX: x + lx * Math.cos(rot) + lz * Math.sin(rot), crownZ: z - lx * Math.sin(rot) + lz * Math.cos(rot),
    };
      list.push(tree);
      occ.add(x, z, colR);
      circles.push({ x, z, r: colR, y0: tree.y - 1, y1: tree.y + height, type, tags: T[type] });
      // 판근 — 렌더링과 같은 형태의 낮은 지지형 장애물 (끝으로 갈수록 낮아짐)
      const cr = Math.cos(rot), sr = Math.sin(rot);
      // 능선을 두 토막 캡슐로 근사 (위가 오목한 판근 모양을 따라감)
      for (const f of V.fins) {
        const fx = Math.cos(f.a), fz = Math.sin(f.a);
        const wx = fx * cr + fz * sr, wz = -fx * sr + fz * cr;
        const capR = (f.thick * 0.5 + 0.03) * scale;
        const pt = (s) => {
          const q = finRidge(f, V.trunkR, s);
          return [x + wx * q.r * scale, z + wz * q.r * scale, tree.y + q.y * scale - capR * 0.7];
        };
        const [ax, az, ay] = pt(0.12), [mx, mz, my] = pt(0.42);
        const [bx, bz] = pt(1);
        const by = Math.min(heightAt(bx, bz) - 0.05, pt(1)[2]);
        supports.push({ kind: 'capsule', type: 'root', tags: T.root, fin: true, ax, az, ay, bx: mx, bz: mz, by: my, r: capR });
        supports.push({ kind: 'capsule', type: 'root', tags: T.root, fin: true, ax: mx, az: mz, ay: my, bx, bz, by, r: capR });
      }
      return tree;
  };

  // ---------------------------------------------------------------
  // 교목층: 판근 달린 큰 나무
  // ---------------------------------------------------------------
  P.bigTree = [];
  {
    const r = rng.fork(1);
    jitterGrid(r, half, 9.6, (x, z) => {
      if (!inBounds(x, z, 3) || !outsideCliff(x, z) || x > beltX - 2) return;
      const s = surfAt(x, z);
      if (!forest(s) || vegAt(x, z) === VEG.GRASS) return;
      if (trailDistAt(x, z) < 3.5 || startDist(x, z) < 7) return;
      if (paddy.signedDistance(x, z) < 6 || swampQ(x, z) < 1.25 || waterAt(x, z) !== NO_WATER) return;
      if (slopeAt(x, z) > 36) return;
      if (!r.chance(lerp(0.9, 0.42, lowAt(x, z)))) return;
      const variant = r.int(0, BIG_TREE_VARIANTS.length - 1);
      const V = BIG_TREE_VARIANTS[variant];
      let scale = r.range(0.78, V.maxScale);
      if (V.height * scale > 40) scale = 40 / V.height;
      const trunkR = V.trunkR * scale;
      const colR = trunkR * 1.22;
      if (!free(x, z, colR + 1.6)) return;
      addTree(P.bigTree, 'bigTree', r, x, z, variant, scale);
      markLitter(x, z, trunkR + 0.8);
    });
  }

  // ---------------------------------------------------------------
  // 중층 나무 (9~18m): 큰 나무 줄기 사이를 메우는 아교목 — 트인 곳에서 봐도 숲이 벽처럼 겹쳐 보이게
  // ---------------------------------------------------------------
  P.midTree = [];
  {
    const r = rng.fork(21);
    jitterGrid(r, half, VC.midTreeSpacing, (x, z) => {
      if (!inBounds(x, z, 3) || !outsideCliff(x, z) || x > beltX - 2) return;
      const s = surfAt(x, z);
      if (!forest(s) || vegAt(x, z) === VEG.GRASS) return;
      if (trailDistAt(x, z) < 2.8 || startDist(x, z) < 6) return;
      if (paddy.signedDistance(x, z) < 3 || swampQ(x, z) < 1.2 || waterAt(x, z) !== NO_WATER) return;
      if (slopeAt(x, z) > 38) return;
      if (!r.chance(lerp(0.55, 0.35, lowAt(x, z)) + 0.35 * edgeK(x, z))) return;
      const variant = r.int(0, BIG_TREE_VARIANTS.length - 1);
      const V = BIG_TREE_VARIANTS[variant];
      const scale = r.range(9, 18) / V.height;
      if (!free(x, z, V.trunkR * scale * 1.22 + 0.9)) return;
      addTree(P.midTree, 'midTree', r, x, z, variant, scale);
    });
  }

  // --- 드러난 큰 뿌리 (사면·개울 둑에 더 많이)
  P.root = [];
  {
    const r = rng.fork(2);
    for (const tree of P.bigTree) {
      const sl = slopeAt(tree.x, tree.z);
      if (!r.chance(0.6 + sl / 60)) continue;
      const n = r.int(1, sl > 15 ? 4 : 3);
      for (let k = 0; k < n; k++) {
        const a = r.range(0, TAU);
        const big = r.chance(0.2);
        const rad = big ? r.range(0.3, 0.37) : r.range(0.1, 0.24);
        const len = r.range(2.5, 6.5);
        const ax = tree.x + Math.cos(a) * (tree.trunkR + 0.2), az = tree.z + Math.sin(a) * (tree.trunkR + 0.2);
        const bx = ax + Math.cos(a + r.range(-0.4, 0.4)) * len, bz = az + Math.sin(a + r.range(-0.4, 0.4)) * len;
        if (waterAt(bx, bz) !== NO_WATER || trailDistAt(bx, bz) < 0.8) continue;
        const ay = heightAt(ax, az) + rad * 0.25, by = heightAt(bx, bz) - rad * 0.5;
        const sup = { kind: 'capsule', type: 'root', tags: T.root, ax, az, ay, bx, bz, by, r: rad };
        supports.push(sup);
        P.root.push(sup);
      }
    }
  }

  // --- 쓰러진 통나무 (반쯤 묻힘, 일부는 버섯·이끼)
  P.log = [];
  {
    const r = rng.fork(3);
    const addLog = (cx, cz, angle, len, rad, forced = false) => {
      const dx = Math.cos(angle) * len / 2, dz = Math.sin(angle) * len / 2;
      const ax = cx - dx, az = cz - dz, bx = cx + dx, bz = cz + dz;
      if (!forced) {
        for (let k = 0; k <= 4; k++) {
          const px = lerp(ax, bx, k / 4), pz = lerp(az, bz, k / 4);
          if (!inBounds(px, pz, 6) || waterAt(px, pz) !== NO_WATER || paddy.signedDistance(px, pz) < 2) return false;
          if (trailDistAt(px, pz) < 1.5 || occ.any(px, pz, rad + 0.2)) return false;
          if (surfAt(px, pz) === SURFACE.DEEP_MUD) return false;
        }
        if (Math.abs(heightAt(ax, az) - heightAt(bx, bz)) > len * 0.4) return false;
        // 가운데가 뜨거나 묻히지 않게
        if (Math.abs(heightAt(cx, cz) - (heightAt(ax, az) + heightAt(bx, bz)) / 2) > rad * 0.6) return false;
      }
      let ay = heightAt(ax, az) + rad * 0.62, by = heightAt(bx, bz) + rad * 0.62;
      if (forced) {
        // 오솔길을 가로지르는 통나무: 오솔길 중앙 높이에 맞춤
        const c = heightAt(cx, cz) + rad * 0.72;
        ay = Math.max(c, Math.min(ay + rad * 0.1, c + 0.25));
        by = Math.max(c, Math.min(by + rad * 0.1, c + 0.25));
      }
      const log = { kind: 'capsule', type: 'log', tags: T.log, ax, az, ay, bx, bz, by, r: rad, rot: r.range(0, TAU), variant: r.int(0, 2) };
      supports.push(log);
      P.log.push(log);
      return true;
    };
    // 시작 지점 오솔길을 가로막는 통나무 (점프 테스트용)
    const t1 = trails[0];
    {
      const s = 13;
      const [px, pz] = t1.line.pointAt(s);
      const [qx, qz] = t1.line.pointAt(s + 1);
      addLog(px, pz, Math.atan2(qz - pz, qx - px) + Math.PI / 2 + 0.2, 5, 0.36, true);
    }
    {
      const t4 = trails[3];
      const [px, pz] = t4.line.pointAt(26);
      const [qx, qz] = t4.line.pointAt(27);
      addLog(px, pz, Math.atan2(qz - pz, qx - px) + Math.PI / 2 - 0.3, 5, 0.3, true);
    }
    let tries = 0;
    while (P.log.length < 160 && tries++ < 4500) {
      const x = r.range(-half + 30, half - 30), z = r.range(-half + 30, half - 32);
      if (!solid(surfAt(x, z)) || slopeAt(x, z) > 24) continue;
      const rad = r.chance(0.3) ? r.range(0.18, 0.26) : r.range(0.28, 0.5);
      addLog(x, z, r.range(0, Math.PI), r.range(4, 11), rad);
    }
  }

  // --- 바위 (개울 속·둑, 사면)
  P.rock = [];
  {
    const r = rng.fork(4);
    const addRock = (x, z, size, inWater = false) => {
      const rx = size * r.range(0.8, 1.25), rz = size * r.range(0.7, 1.1), ry = size * r.range(0.45, 0.8);
      if (occ.any(x, z, Math.max(rx, rz) * 0.8)) return;
      const y = heightAt(x, z) - ry * (inWater ? 0.25 : 0.38);
      const rock = { kind: 'ellipsoid', type: 'rock', tags: T.rock, cx: x, cy: y, cz: z, rx, ry, rz, yaw: r.range(0, TAU), variant: r.int(0, 3), seed: r.int(0, 1e6) };
      supports.push(rock);
      P.rock.push(rock);
    };
    for (const st of streams) {
      for (let s = 10; s < st.line.length - 15; s += r.range(4, 11)) {
        if (st.fords.some((f) => Math.abs(f - s) < 9)) continue;
        const [px, pz] = st.line.pointAt(s);
        if (st.name === 'west' && swampQ(px, pz) < 1.6) continue;
        const off = r.range(-st.w[Math.round(s)] - 2, st.w[Math.round(s)] + 2);
        const [qx, qz] = st.line.pointAt(s + 1);
        addRock(px - (qz - pz) * off, pz + (qx - px) * off, r.range(0.35, 1.3), true);
      }
    }
    let tries = 0;
    while (P.rock.length < 300 && tries++ < 5000) {
      const x = r.range(-half + 25, half - 25), z = r.range(-half + 25, half - 30);
      if (!solid(surfAt(x, z)) || trailDistAt(x, z) < 1.6 || paddy.signedDistance(x, z) < 3) continue;
      if (!r.chance(0.25 + slopeAt(x, z) / 30)) continue;
      addRock(x, z, r.chance(0.15) ? r.range(1.2, 2.4) : r.range(0.25, 0.9));
    }
  }

  // ---------------------------------------------------------------
  // 아교목층
  // ---------------------------------------------------------------
  // --- 야자수
  P.palm = [];
  {
    const r = rng.fork(5);
    jitterGrid(r, half, 7.5, (x, z) => {
      if (!inBounds(x, z, 5) || !outsideCliff(x, z) || x > beltX - 2) return;
      const s = surfAt(x, z);
      if (!(forest(s) || s === SURFACE.SHALLOW_MUD)) return;
      if (trailDistAt(x, z) < 2 || waterAt(x, z) !== NO_WATER) return;
      const q = swampQ(x, z), psd = paddy.signedDistance(x, z);
      if (psd < 2.5) return;
      const sd = streamDistAt(x, z);
      let p = 0.08;
      if (q > 1.0 && q < 2.1) p = 0.55;
      else if (psd < 16) p = 0.42;
      else if (sd < 14) p = 0.32;
      p = Math.max(p, 0.45 * edgeK(x, z));
      if (!r.chance(p) || !free(x, z, 1.4)) return;
      const palm = { x, z, y: heightAt(x, z), rot: r.range(0, TAU), height: r.range(6, 11.5), lean: r.range(0.03, 0.22), variant: r.int(0, 1), rank: r.float() };
      P.palm.push(palm);
      occ.add(x, z, 0.25);
      circles.push({ x, z, r: 0.22, y0: palm.y - 0.5, y1: palm.y + palm.height, type: 'palm', tags: T.palm });
    });
  }

  // --- 바나나 (논가·저지대 + 숲 틈의 야생 바나나)
  P.banana = [];
  {
    const r = rng.fork(6);
    jitterGrid(r, half, 6, (x, z) => {
      if (!inBounds(x, z, 6) || !outsideCliff(x, z) || x > beltX - 2) return;
      const psd = paddy.signedDistance(x, z);
      const low = lowAt(x, z);
      let p = 0.06;
      if (psd > 2.5 && psd < 15) p = 0.5;
      else if (low > 0.6) p = 0.14;
      if (trailDistAt(x, z) < 3.5 && low > 0.4) p += 0.15;
      if (!r.chance(p)) return;
      const n = r.int(2, 4);
      for (let k = 0; k < n; k++) {
        const bx = x + r.range(-1.6, 1.6), bz = z + r.range(-1.6, 1.6);
        const s = surfAt(bx, bz);
        if (!forest(s) || trailDistAt(bx, bz) < 1.6 || waterAt(bx, bz) !== NO_WATER) continue;
        if (paddy.signedDistance(bx, bz) < 2.2 || !free(bx, bz, 0.7)) continue;
        const b = { x: bx, z: bz, y: heightAt(bx, bz), rot: r.range(0, TAU), height: r.range(2.4, 4.2), variant: r.int(0, 1), rank: r.float() };
        P.banana.push(b);
        occ.add(bx, bz, 0.2);
        circles.push({ x: bx, z: bz, r: 0.14, y0: b.y - 0.3, y1: b.y + b.height, type: 'banana', tags: T.banana });
        // 늘어진 큰 잎 (시야만 가림)
        circles.push({ x: bx, z: bz, r: 1.3, y0: b.y + b.height - 1.7, y1: b.y + b.height + 0.6, type: 'bananaLeaves', tags: T.bananaLeaves });
      }
    });
  }

  // --- 대나무 군락 (밀집 대나무: 통과 불가)
  P.bamboo = [];
  {
    const r = rng.fork(7);
    const groves = LAYOUT.bambooGroves.map((g) => ({ ...g }));
    for (const st of streams) {
      for (let s = 20; s < st.line.length - 20; s += r.range(16, 30)) {
        if (!r.chance(0.55)) continue;
        if (st.fords.some((f) => Math.abs(f - s) < 14)) continue;
        const [px, pz] = st.line.pointAt(s);
        const [qx, qz] = st.line.pointAt(s + 1);
        const off = r.sign() * (st.w[Math.round(s)] + st.bankW[Math.round(s)] + r.range(3, 8));
        groves.push({ x: px - (qz - pz) * off, z: pz + (qx - px) * off, r: r.range(4, 7) });
      }
    }
    for (let k = 0; k < 14; k++) groves.push({ x: r.range(-160, 150), z: r.range(-160, 150), r: r.range(4, 7.5) });
    for (const g of groves) {
      const n = Math.round(g.r * 0.9) + r.int(1, 3);
      for (let k = 0; k < n; k++) {
        const a = r.range(0, TAU), d = Math.sqrt(r.float()) * g.r;
        const x = g.x + Math.cos(a) * d, z = g.z + Math.sin(a) * d;
        if (!inBounds(x, z, 6) || !outsideCliff(x, z) || x > beltX - 3) continue;
        const s = surfAt(x, z);
        if (!forest(s) || trailDistAt(x, z) < 2.6 || waterAt(x, z) !== NO_WATER) continue;
        if (paddy.signedDistance(x, z) < 4 || startDist(x, z) < 6) continue;
        const cr = r.range(0.85, 1.3);
        if (!free(x, z, cr + 0.15)) continue;
        const b = { x, z, y: heightAt(x, z), rot: r.range(0, TAU), height: r.range(9, 15), radius: cr, variant: r.int(0, 1), rank: r.float() };
        P.bamboo.push(b);
        occ.add(x, z, cr);
        circles.push({ x, z, r: cr, y0: b.y - 0.5, y1: b.y + b.height, type: 'bamboo', tags: T.bamboo });
        markLitter(x, z, cr + 0.7);
      }
    }
  }

  // --- 나무고사리 (습한 곳에 많음)
  P.treeFern = [];
  {
    const r = rng.fork(14);
    jitterGrid(r, half, VC.treeFernSpacing, (x, z) => {
      if (!inBounds(x, z, 4) || !outsideCliff(x, z) || x > beltX - 2) return;
      const s = surfAt(x, z);
      if (!forest(s) || vegAt(x, z) === VEG.GRASS) return;
      if (trailDistAt(x, z) < 2.2 || waterAt(x, z) !== NO_WATER || paddy.signedDistance(x, z) < 4 || swampQ(x, z) < 1.2) return;
      if (slopeAt(x, z) > 34 || startDist(x, z) < 4) return;
      if (!r.chance(moistAt(x, z) ? 0.45 : 0.14) || !free(x, z, 1.0)) return;
      const height = r.range(2.8, 6);
      const tf = { x, z, y: heightAt(x, z), rot: r.range(0, TAU), height, variant: r.int(0, 1), rank: r.float() };
      P.treeFern.push(tf);
      occ.add(x, z, 0.2);
      circles.push({ x, z, r: 0.14, y0: tf.y - 0.3, y1: tf.y + height, type: 'treeFern', tags: T.treeFern });
      circles.push({ x, z, r: r.range(1.5, 2.2), y0: tf.y + height - 1.4, y1: tf.y + height + 0.6, type: 'treeFernCrown', tags: T.treeFernCrown });
    });
  }

  // --- 어린 나무 (중하층을 빽빽하게)
  P.sapling = [];
  {
    const r = rng.fork(13);
    jitterGrid(r, half, VC.saplingSpacing, (x, z) => {
      if (!inBounds(x, z, 4) || !outsideCliff(x, z) || x > beltX - 2) return;
      const s = surfAt(x, z), v = vegAt(x, z);
      if (!forest(s) || v === VEG.GRASS) return;
      if (trailDistAt(x, z) < 1.8 || waterAt(x, z) !== NO_WATER || paddy.signedDistance(x, z) < 2.5 || swampQ(x, z) < 1.18) return;
      if (slopeAt(x, z) > 35 || startDist(x, z) < 3) return;
      const p = Math.max(lerp(0.66, 0.38, lowAt(x, z)) * (v === VEG.SHRUB || v === VEG.THICKET ? 1.15 : 1), 0.85 * edgeK(x, z));
      if (!r.chance(p) || !free(x, z, 0.8)) return;
      const height = r.chance(0.12) ? r.range(2.6, 4) : r.range(4, 10);
      const sp = { x, z, y: heightAt(x, z), rot: r.range(0, TAU), height, variant: r.int(0, 2), rank: r.float() };
      P.sapling.push(sp);
      occ.add(x, z, 0.12);
      circles.push({ x, z, r: 0.07, y0: sp.y - 0.3, y1: sp.y + height, type: 'sapling', tags: T.sapling });
      circles.push({ x, z, r: height * 0.18 + 0.3, y0: sp.y + Math.max(1.0, height * 0.42), y1: sp.y + height, type: 'saplingCrown', tags: T.saplingCrown });
    });
  }

  // --- 동쪽 가장자리 밀집 대나무 띠 (통과 불가)
  P.bambooDense = [];
  {
    const r = rng.fork(8);
    for (let x = beltX; x <= half + 1; x += 2) {
      for (let z = -half; z <= half; z += 2) {
        const cx = x + r.range(-0.25, 0.25), cz = z + r.range(-0.25, 0.25);
        circles.push({ x: cx, z: cz, r: 1.6, y0: -50, y1: 200, type: 'bambooDense', tags: T.bambooDense, hidden: true });
      }
    }
    for (let x = beltX + 0.5; x <= beltX + LAYOUT.bambooBelt.visualDepth; x += 2.6) {
      for (let z = -half + 1; z <= half - 1; z += 2.6) {
        const cx = x + r.range(-0.9, 0.9), cz = z + r.range(-0.9, 0.9);
        if (Math.abs(z - riverCenterZ(cx)) < R.halfWidth + 1) continue;
        P.bambooDense.push({ x: cx, z: cz, y: heightAt(cx, cz), rot: r.range(0, TAU), height: r.range(10, 16), radius: 1.3, variant: r.int(0, 1), rank: r.float() });
      }
    }
  }

  // ---------------------------------------------------------------
  // 관목층
  // ---------------------------------------------------------------
  // --- 코끼리풀 군락
  P.grass = [];
  {
    const r = rng.fork(9);
    jitterGrid(r, half, 1.1, (x, z) => {
      if (!inBounds(x, z, 2)) return;
      if (vegAt(x, z) !== VEG.GRASS || surfAt(x, z) !== SURFACE.BRUSH || occ.any(x, z, 0.1)) return;
      P.grass.push({ x, z, y: heightAt(x, z), rot: r.range(0, TAU), height: r.range(1.5, 2.6), variant: r.int(0, 2), rank: r.float() });
    });
  }

  // --- 덤불 / 토란잎 / 등나무 (덤불 지면은 빽빽하게, 지피식물 지면에도 드문드문)
  P.shrub = [];
  P.taro = [];
  P.rattan = [];
  {
    const r = rng.fork(10);
    jitterGrid(r, half, VC.shrubSpacing, (x, z) => {
      if (!inBounds(x, z, 2) || !outsideCliff(x, z) || x > beltX + 1) return;
      const v = vegAt(x, z);
      let p;
      switch (v) {
        case VEG.THICKET: p = 0.82; break;
        case VEG.SHRUB: p = 0.52; break;
        case VEG.COVER: p = 0.11; break;
        case VEG.BANK: p = 0.2; break;
        case VEG.LITTER: p = 0.04; break;
        default: return;
      }
      if (trailDistAt(x, z) < 2.0 || waterAt(x, z) !== NO_WATER || paddy.signedDistance(x, z) < 2 || swampQ(x, z) < 1.15) return;
      const ek = edgeK(x, z);
      p = Math.max(p, 0.8 * ek);
      if (startDist(x, z) < 2.2 || !r.chance(p) || occ.any(x, z, 0.25)) return;
      const moist = moistAt(x, z);
      const t = r.float();
      const base = { x, z, y: heightAt(x, z), rot: r.range(0, TAU), variant: r.int(0, 2), rank: r.float() };
      if (t < (moist ? 0.32 : 0.09)) {
        P.taro.push({ ...base, height: r.range(0.7, 1.55), variant: r.int(0, 1) });
      } else if (t < (moist ? 0.4 : 0.22)) {
        P.rattan.push({ ...base, height: r.range(1.6, 3.6), variant: r.int(0, 1) });
      } else {
        // 무릎~허리 덤불 지면은 대부분 허리 아래, 가끔 키를 넘는 덤불
        const h = v === VEG.THICKET || ek > 0.5 ? r.range(1.4, 2.9)
          : v === VEG.SHRUB ? (r.chance(0.82) ? r.range(0.6, 1.45) : r.range(1.45, 2.3))
          : r.range(0.7, 1.7);
        P.shrub.push({ ...base, height: h });
      }
    });
  }

  // --- 갈대·부들 (늪 가장자리, 개울가, 강가)
  P.reed = [];
  {
    const r = rng.fork(15);
    jitterGrid(r, half, 1.05, (x, z) => {
      if (!inBounds(x, z, 3)) return;
      const v = vegAt(x, z);
      if (v !== VEG.REED && v !== VEG.BANK) return;
      const q = swampQ(x, z);
      let p = v === VEG.REED ? 0.4 : 0.06;
      if (q < 1.3) p = q > 0.8 ? 0.6 : 0.22;
      if (trailDistAt(x, z) < 1.6 || paddy.signedDistance(x, z) < 1.5 || !r.chance(p) || occ.any(x, z, 0.15)) return;
      P.reed.push({ x, z, y: heightAt(x, z) - 0.05, rot: r.range(0, TAU), height: r.range(1.2, 2.5), variant: r.chance(0.35) ? 1 : 0, rank: r.float() });
    });
  }

  // --- 물 위 수생식물 (늪 웅덩이, 개울 가장자리 물)
  P.waterPlant = [];
  {
    const r = rng.fork(16);
    jitterGrid(r, half, 1.4, (x, z) => {
      if (!inBounds(x, z, 3)) return;
      const wl = waterAt(x, z);
      if (wl === NO_WATER) return;
      const depth = wl - heightAt(x, z);
      if (depth < 0.08 || depth > 1.0 || Math.abs(z - riverCenterZ(x)) < R.halfWidth + 3) return;
      const s = surfAt(x, z);
      if (s === SURFACE.PADDY) return;
      const p = swampQ(x, z) < 1.05 ? 0.3 : 0.12;
      if (!r.chance(p)) return;
      P.waterPlant.push({ x, z, y: wl + 0.01, rot: r.range(0, TAU), height: r.range(0.6, 1.2), variant: r.int(0, 1), rank: r.float() });
    });
  }

  // --- 얽힌 덩굴 벽 (통과 불가) — 짧은 벽이라 항상 돌아갈 길이 있음
  P.vineWall = [];
  {
    const r = rng.fork(17);
    const avoid = CONFIG.world.testPoints;
    let walls = 0, tries = 0;
    while (walls < VC.vineWalls && tries++ < 6000) {
      const x = r.range(-half + 40, beltX - 10), z = r.range(-half + 40, half - 40);
      const v = vegAt(x, z);
      if (v !== VEG.SHRUB && v !== VEG.THICKET && v !== VEG.COVER) continue;
      if (startDist(x, z) < 18 || avoid.some((p) => Math.hypot(p.x - x, p.z - z) < 12)) continue;
      const len = r.range(6, 14);
      let a = r.range(0, TAU);
      const pts = [];
      let px = x, pz = z, ok = true;
      for (let d = 0; d <= len && ok; d += 0.9) {
        a += r.range(-0.18, 0.18);
        if (d > 0) { px += Math.cos(a) * 0.9; pz += Math.sin(a) * 0.9; }
        const sv = vegAt(px, pz);
        if (trailDistAt(px, pz) < 6 || waterAt(px, pz) !== NO_WATER || slopeAt(px, pz) > 28 || streamDistAt(px, pz) < 8) ok = false;
        else if (sv === VEG.NONE || sv === VEG.REED || occ.any(px, pz, 0.5)) ok = false;
        pts.push([px, pz, a]);
      }
      if (!ok || pts.length < 6) continue;
      for (const [cx, cz] of pts) {
        const gy = heightAt(cx, cz);
        circles.push({ x: cx, z: cz, r: 0.8, y0: gy - 0.5, y1: gy + 4.2, type: 'vineWall', tags: T.vineWall });
        occ.add(cx, cz, 0.6);
      }
      for (let k = 0; k < pts.length; k += 1) {
        const [cx, cz, ca] = pts[k];
        if (k % 2 && k !== pts.length - 1) continue;
        P.vineWall.push({ x: cx, z: cz, y: heightAt(cx, cz), rot: -ca + r.range(-0.3, 0.3), height: r.range(3.0, 4.4), variant: r.int(0, 1), rank: r.float() });
      }
      walls++;
    }
    data.layout.vineWalls = walls;
  }

  // --- 굵은 리아나 덩굴 (이웃한 큰 나무 사이로 늘어짐)
  P.liana = [];
  {
    const r = rng.fork(18);
    const trees = P.bigTree;
    const grid = new Map();
    const key = (i, j) => i * 1000 + j;
    trees.forEach((t, idx) => {
      const k = key(Math.floor(t.x / 25), Math.floor(t.z / 25));
      (grid.get(k) || grid.set(k, []).get(k)).push(idx);
    });
    for (const a of trees) {
      if (!r.chance(VC.lianaChance)) continue;
      const gi = Math.floor(a.x / 25), gj = Math.floor(a.z / 25);
      const near = [];
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        for (const idx of grid.get(key(gi + di, gj + dj)) || []) {
          const b = trees[idx];
          const d = Math.hypot(b.x - a.x, b.z - a.z);
          if (b !== a && d > 7 && d < 24) near.push(b);
        }
      }
      if (!near.length) continue;
      const b = near[r.int(0, near.length - 1)];
      const ay = a.y + a.height * r.range(0.45, 0.72);
      const toGround = r.chance(0.25);
      const by = toGround ? heightAt(b.x, b.z) + 0.1 : b.y + b.height * r.range(0.45, 0.72);
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
      const ax = a.x + (dx / d) * a.trunkR, az = a.z + (dz / d) * a.trunkR;
      const bx = b.x - (dx / d) * (toGround ? b.trunkR + 1.2 : b.trunkR), bz = b.z - (dz / d) * (toGround ? b.trunkR + 1.2 : b.trunkR);
      const midGround = heightAt((ax + bx) / 2, (az + bz) / 2);
      const sagY = Math.max(midGround + r.range(1.6, 4.5), Math.min(ay, by) - r.range(3, 10));
      P.liana.push({ ax, ay, az, bx, by, bz, sagY, r: r.range(0.035, 0.085), x: (ax + bx) / 2, z: (az + bz) / 2, y: sagY, rank: r.float() });
    }
  }

  // --- 논의 모
  P.rice = [];
  {
    const r = rng.fork(12);
    for (let row = 0; row < paddy.rows; row++) {
      for (let col = 0; col < paddy.cols; col++) {
        const u0 = -paddy.halfU + col * paddy.cellW, v0 = -paddy.halfV + row * paddy.cellH;
        const floor = paddy.floors[row * paddy.cols + col];
        if (r.chance(0.15)) continue; // 일부 논은 비어 있음
        for (let u = u0 + 0.6; u < u0 + paddy.cellW - 0.6; u += 0.42) {
          for (let v = v0 + 0.6; v < v0 + paddy.cellH - 0.6; v += 0.34) {
            if (!r.chance(0.92)) continue;
            const [x, z] = paddy.toWorld(u + r.range(-0.05, 0.05), v + r.range(-0.05, 0.05));
            P.rice.push({ x, z, y: floor, rot: r.range(0, TAU), height: r.range(0.38, 0.62), variant: 0, rank: r.float() });
          }
        }
      }
    }
  }

  // 모든 배치 오브젝트에 태그 연결 (config.objects 참조)
  const TAG_OF = {
    bigTree: 'bigTree', midTree: 'midTree', palm: 'palm', banana: 'banana', bamboo: 'bamboo', bambooDense: 'bambooDense', sapling: 'sapling',
    treeFern: 'treeFern', grass: 'elephantGrass', shrub: 'shrub', taro: 'taro', rattan: 'rattan', reed: 'reed',
    waterPlant: 'waterPlant', vineWall: 'vineWall', liana: 'liana', rice: 'rice', log: 'log', rock: 'rock', root: 'root',
  };
  for (const [k, list] of Object.entries(P)) {
    const tags = T[TAG_OF[k]];
    if (!tags) continue;
    for (const it of list) { it.type ??= TAG_OF[k]; it.tags ??= tags; }
  }
}

// =================================================================
// 캐노피(하늘 가림) / 은폐(cover) 1m 격자, 차폐(AO) 0.5m 격자
// =================================================================
export function buildGrids(ctx) {
  const { data, noise, half } = ctx;
  const P = data.placements;
  const T = CONFIG.objects;
  const size = data.size;
  const cN = size;

  // --- 캐노피
  const canopy = new Float32Array(cN * cN);
  const canopyLow = new Float32Array(cN * cN).fill(1e4);
  const canopyHigh = new Float32Array(cN * cN).fill(-1e4);
  // band=false: 하늘 가림(빛)만 기록 — 하층 식물은 시야를 원기둥(잎 덩어리)으로 따로 막으므로 캐노피 높이 구간은 건드리지 않음
  const stampCanopy = (cx, cz, rad, alpha, y0, y1, holeScale, band = true) => {
    const i0 = Math.max(0, Math.floor(cx - rad + half)), i1 = Math.min(cN - 1, Math.ceil(cx + rad + half));
    const j0 = Math.max(0, Math.floor(cz - rad + half)), j1 = Math.min(cN - 1, Math.ceil(cz + rad + half));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = i - half + 0.5, z = j - half + 0.5;
        const d = Math.hypot(x - cx, z - cz) / rad;
        if (d >= 1) continue;
        const holes = smoothstep(-0.35, 0.25, noise.fbm(x / holeScale + 100, z / holeScale - 100, 3));
        const a = alpha * Math.sqrt(1 - d * d) * holes;
        const k = j * cN + i;
        canopy[k] = 1 - (1 - canopy[k]) * (1 - a);
        if (!band) continue;
        canopyLow[k] = Math.min(canopyLow[k], y0);
        canopyHigh[k] = Math.max(canopyHigh[k], y1);
      }
    }
  };
  for (const t of P.bigTree) {
    const top = t.y + t.height;
    stampCanopy(t.crownX, t.crownZ, t.crownR * 1.1, 0.97, top - t.height * 0.34, top + 1, 5.5);
  }
  for (const t of P.midTree) {
    const top = t.y + t.height;
    stampCanopy(t.crownX, t.crownZ, t.crownR * 1.05, 0.8, top - t.height * 0.45, top + 1, 4);
  }
  for (const p of P.palm) stampCanopy(p.x, p.z, 3.6, 0.55, p.y + p.height - 2, p.y + p.height + 1, 2.5);
  for (const b of P.bamboo) stampCanopy(b.x, b.z, 3.5, 0.6, b.y + b.height * 0.45, b.y + b.height, 2.5);
  for (const b of P.bambooDense) stampCanopy(b.x, b.z, 3.2, 0.7, b.y + b.height * 0.4, b.y + b.height, 2.5);
  for (const b of P.banana) stampCanopy(b.x, b.z, 1.8, 0.45, 0, 0, 2, false);
  for (const f of P.treeFern) stampCanopy(f.x, f.z, 2.2, 0.45, 0, 0, 2, false);
  for (const s of P.sapling) stampCanopy(s.x, s.z, s.height * 0.2 + 0.6, 0.3, 0, 0, 2, false);
  data.canopy = canopy;
  data.canopyLow = canopyLow;
  data.canopyHigh = canopyHigh;
  data.cN = cN;

  // --- 은폐: 높이 구간별 1m당 소광계수 σ (칸 면적 평균) — 시야 레이·노출도에 사용
  //  숲 바닥 종류별 기본값(config.vegetation.coverProfiles) + 개별 덤불·풀·갈대의 실제 발자국 × 높이 겹침
  const VC = CONFIG.vegetation;
  const BANDS = VC.coverBands;
  const NB = BANDS.length - 1;
  const coverBands = new Float32Array(cN * cN * NB);
  const coverHeight = new Float32Array(cN * cN);
  const sig = (vb) => -Math.log(1 - Math.min(vb, 0.99));
  const CP = VC.coverProfiles;
  const PROFILE = {
    [VEG.COVER]: [CP.cover, 0.5], [VEG.SHRUB]: [CP.shrub, 1.1], [VEG.THICKET]: [CP.thicket, 2.6],
    [VEG.GRASS]: [CP.grass, 2.2], [VEG.REED]: [CP.reed, 1.6], [VEG.BANK]: [CP.bank, 0.8], [VEG.LITTER]: [CP.litter, 0.1],
  };
  {
    const { sN } = data;
    for (let j = 0; j < sN; j++) {
      for (let i = 0; i < sN; i++) {
        const pr = PROFILE[data.vegKind[j * sN + i]];
        if (!pr) continue;
        const k = (j >> 1) * cN + (i >> 1);
        for (let b = 0; b < NB; b++) coverBands[k * NB + b] += pr[0][b] * 0.25; // 0.5m 칸 4개 평균
        if (pr[1] > coverHeight[k]) coverHeight[k] = pr[1];
      }
    }
  }
  // 원형 발자국이 1m 칸을 덮는 비율(3×3 표본) × 구간과 겹치는 높이 비율만큼 σ를 더한다
  const stampBush = (cx, cz, rad, y0, y1, sigma) => {
    const i0 = Math.max(0, Math.floor(cx - rad + half)), i1 = Math.min(cN - 1, Math.floor(cx + rad + half));
    const j0 = Math.max(0, Math.floor(cz - rad + half)), j1 = Math.min(cN - 1, Math.floor(cz + rad + half));
    const r2 = rad * rad;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        let cov = 0;
        for (let sj = 0; sj < 3; sj++) {
          const dz = j - half + (sj + 0.5) / 3 - cz;
          for (let si = 0; si < 3; si++) {
            const dx = i - half + (si + 0.5) / 3 - cx;
            if (dx * dx + dz * dz < r2) cov++;
          }
        }
        if (!cov) continue;
        const k = j * cN + i;
        for (let b = 0; b < NB; b++) {
          const o = Math.min(y1, BANDS[b + 1]) - Math.max(y0, BANDS[b]);
          if (o > 0) coverBands[k * NB + b] += (sigma * cov * o) / (9 * (BANDS[b + 1] - BANDS[b]));
        }
        if (y1 > coverHeight[k]) coverHeight[k] = y1;
      }
    }
  };
  for (const g of P.grass) stampBush(g.x, g.z, 0.55, 0, g.height, sig(T.elephantGrass.visionBlock));
  for (const s of P.shrub) stampBush(s.x, s.z, 0.25 + s.height * 0.3, s.height * 0.12, s.height, sig(T.shrub.visionBlock));
  for (const s of P.taro) stampBush(s.x, s.z, 0.75, s.height * 0.35, s.height, sig(T.taro.visionBlock));
  for (const s of P.rattan) stampBush(s.x, s.z, 0.8, 0.3, s.height * 0.85, sig(T.rattan.visionBlock));
  for (const s of P.reed) stampBush(s.x, s.z, 0.45, 0, s.height, sig(T.reed.visionBlock));
  for (const s of P.vineWall) stampBush(s.x, s.z, 1.3, 0, s.height, sig(T.vineWall.visionBlock) * 1.5);
  data.coverBands = coverBands;
  data.coverBandEdges = BANDS;
  data.coverHeight = coverHeight;

  // --- 차폐(AO): 줄기 밑동, 덤불·바위·통나무 아래가 어두워짐 (지형 셰이더용, 0.5m)
  const { sN, sRes } = data;
  const ao = new Float32Array(sN * sN).fill(1);
  const stampAO = (cx, cz, rad, minV, inner = 0) => {
    const i0 = Math.max(0, Math.floor((cx - rad + half) / sRes)), i1 = Math.min(sN - 1, Math.floor((cx + rad + half) / sRes));
    const j0 = Math.max(0, Math.floor((cz - rad + half) / sRes)), j1 = Math.min(sN - 1, Math.floor((cz + rad + half) / sRes));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = -half + (i + 0.5) * sRes, z = -half + (j + 0.5) * sRes;
        const d = Math.hypot(x - cx, z - cz);
        if (d >= rad) continue;
        const k = j * sN + i;
        ao[k] *= lerp(minV, 1, smoothstep(inner, rad, d));
      }
    }
  };
  const stampAOCapsule = (s, extra, minV) => {
    const rad = s.r + extra;
    const i0 = Math.max(0, Math.floor((Math.min(s.ax, s.bx) - rad + half) / sRes)), i1 = Math.min(sN - 1, Math.floor((Math.max(s.ax, s.bx) + rad + half) / sRes));
    const j0 = Math.max(0, Math.floor((Math.min(s.az, s.bz) - rad + half) / sRes)), j1 = Math.min(sN - 1, Math.floor((Math.max(s.az, s.bz) + rad + half) / sRes));
    const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz || 1;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = -half + (i + 0.5) * sRes, z = -half + (j + 0.5) * sRes;
        let t = ((x - s.ax) * dx + (z - s.az) * dz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(s.ax + dx * t - x, s.az + dz * t - z);
        if (d >= rad) continue;
        ao[j * sN + i] *= lerp(minV, 1, smoothstep(s.r * 0.6, rad, d));
      }
    }
  };
  for (const t of P.bigTree) {
    const V = BIG_TREE_VARIANTS[t.variant];
    const maxSpan = Math.max(0, ...V.fins.map((f) => f.span)) * t.scale;
    stampAO(t.x, t.z, t.trunkR * 1.3 + maxSpan * 0.85 + 1.0, 0.32, t.trunkR * 0.8);
  }
  for (const t of P.midTree) stampAO(t.x, t.z, t.trunkR * 1.3 + 1.4, 0.45, t.trunkR * 0.8);
  for (const b of P.bamboo) stampAO(b.x, b.z, b.radius + 1.3, 0.42, b.radius * 0.5);
  for (const b of P.bambooDense) stampAO(b.x, b.z, b.radius + 1.1, 0.45, 0);
  for (const s of P.sapling) stampAO(s.x, s.z, 0.55, 0.8);
  for (const f of P.treeFern) stampAO(f.x, f.z, 0.9, 0.65);
  for (const p of P.palm) stampAO(p.x, p.z, 0.8, 0.7);
  for (const b of P.banana) stampAO(b.x, b.z, 0.9, 0.7);
  for (const s of P.shrub) stampAO(s.x, s.z, 0.25 + s.height * 0.35, 0.62);
  for (const s of P.taro) stampAO(s.x, s.z, 0.7, 0.68);
  for (const s of P.rattan) stampAO(s.x, s.z, 0.9, 0.7);
  for (const s of P.vineWall) stampAO(s.x, s.z, 1.6, 0.45);
  for (const l of P.log) stampAOCapsule(l, 0.55, 0.45);
  for (const rt of P.root) stampAOCapsule(rt, 0.2, 0.7);
  for (const r of P.rock) stampAO(r.cx, r.cz, Math.max(r.rx, r.rz) * 1.15 + 0.2, 0.5, Math.max(r.rx, r.rz) * 0.5);
  const aoBytes = new Uint8Array(sN * sN);
  for (let k = 0; k < sN * sN; k++) {
    const coverK = data.splat[k * 4 + 3] / 255;
    aoBytes[k] = Math.round(Math.max(0, Math.min(1, ao[k] * (1 - 0.16 * coverK))) * 255);
  }
  data.ao = aoBytes;
}
