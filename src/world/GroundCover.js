// 지피층 (0~0.5m): 플레이어 주변 반경 안에서만 고밀도로 그리는 동적 식생
//  - 4m 칸 단위로 배치를 만들고 플레이어가 움직이면 새 칸을 만들고 먼 칸을 버린다
//  - 배치는 칸 좌표 해시 시드로 정해져 같은 자리엔 항상 같은 풀이 난다
//  - 인스턴스마다 순위(aRank)를 두어 셰이더가 거리별로 밀도를 부드럽게 줄인다 (경계가 툭 끊기지 않음)
//  - 반경 밖 바닥은 지형 셰이더의 지피식물 텍스처가 대신한다
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { RNG, hash2 } from '../core/rng.js';
import { SURFACE } from './Surfaces.js';
import { VEG, NO_WATER } from './WorldConstants.js';
import { addPatch } from '../render/Materials.js';

/**
 * 종류별 배치 규칙: 숲 바닥 종류(VEG)마다 가중치, 크기 범위
 */
const SPECIES = {
  creeper:   { veg: { [VEG.COVER]: 1, [VEG.SHRUB]: 0.8, [VEG.THICKET]: 0.6, [VEG.LITTER]: 0.45, [VEG.BANK]: 0.5, [VEG.GRASS]: 0.3 }, size: [0.45, 0.9], flat: true },
  moss:      { veg: { [VEG.LITTER]: 1, [VEG.COVER]: 0.12, [VEG.SHRUB]: 0.1, [VEG.BANK]: 0.3 }, size: [0.35, 0.75], flat: true },
  herb:      { veg: { [VEG.COVER]: 1, [VEG.SHRUB]: 0.9, [VEG.THICKET]: 0.5, [VEG.BANK]: 0.7, [VEG.LITTER]: 0.2 }, size: [0.35, 0.65] },
  fern:      { veg: { [VEG.COVER]: 0.9, [VEG.SHRUB]: 1, [VEG.THICKET]: 0.7, [VEG.LITTER]: 0.35, [VEG.BANK]: 0.8 }, size: [0.4, 0.75] },
  grassTuft: { veg: { [VEG.COVER]: 0.7, [VEG.GRASS]: 1, [VEG.SHRUB]: 0.35, [VEG.BANK]: 0.5 }, size: [0.3, 0.55] },
  seedling:  { veg: { [VEG.COVER]: 0.8, [VEG.SHRUB]: 0.7, [VEG.LITTER]: 1, [VEG.THICKET]: 0.4 }, size: [0.35, 0.7] },
  bankGrass: { veg: { [VEG.BANK]: 1, [VEG.REED]: 1 }, size: [0.5, 1.0], wet: true },
};

export class GroundCover {
  /**
   * @param {THREE.Scene} scene
   * @param {object} data   generateWorld() 결과
   * @param {import('./WorldQuery.js').WorldQuery} query
   * @param {THREE.Material} material  지피층 전용 잎 머티리얼 (거리 감쇠 패치를 여기에 더함)
   * @param {Object<string, THREE.BufferGeometry>} geometries  종류별 지오메트리 (PlantGeometry.buildGroundCoverSpecies)
   */
  constructor(scene, data, query, material, geometries) {
    this.scene = scene;
    this.data = data;
    this.query = query;
    this.cfg = CONFIG.vegetation.groundCover;
    this.cell = this.cfg.cellSize;
    this.cells = new Map();
    this.center = { i: 1e9, j: 1e9 };
    this.radius = 30;
    this.density = 1;
    this.stats = { instances: 0, cells: 0 };
    this.uniforms = {
      uGCInfo: { value: new THREE.Vector4(30, 0.62, 0.25, 0) },   // 반경, 감쇠 시작 비율, 끝 밀도
    };
    this.material = material;
    addPatch(material, 'gcfade', (shader) => this._fadePatch(shader));
    this.meshes = {};
    for (const [key, sp] of Object.entries(SPECIES)) {
      const g = geometries[key];
      if (!g) continue;
      const cap = 24000;
      const geo = g.clone();
      const rank = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      rank.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aRank', rank);
      const mesh = new THREE.InstancedMesh(geo, this.material, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.name = `groundCover_${key}`;
      scene.add(mesh);
      this.meshes[key] = { mesh, rank, sp, cap };
    }
  }

  _fadePatch(shader) {
    shader.uniforms.uGCInfo = this.uniforms.uGCInfo;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aRank;\nuniform vec4 uGCInfo;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  {
    // 거리별 밀도: 순위가 밀도보다 큰 인스턴스는 땅속으로 줄어들어 사라짐
    vec3 gcOrg = ( modelMatrix * instanceMatrix[ 3 ] ).xyz;
    float gcD = length( gcOrg.xz - cameraPosition.xz );
    float gcR = uGCInfo.x;
    float gcDens = gcD < gcR * uGCInfo.y ? 1.0 : mix( 1.0, uGCInfo.z, clamp( ( gcD - gcR * uGCInfo.y ) / ( gcR * ( 1.0 - uGCInfo.y ) ), 0.0, 1.0 ) );
    gcDens *= 1.0 - smoothstep( gcR * 0.94, gcR, gcD );
    float gcKeep = clamp( ( gcDens - aRank ) / 0.08, 0.0, 1.0 );
    transformed *= gcKeep;
  }`);
  }

  setSettings(q) {
    this.radius = q.groundCoverRadius;
    this.density = q.groundCoverDensity;
    this.uniforms.uGCInfo.value.set(this.radius, this.cfg.fadeStart, this.cfg.farDensity, 0);
    this.cells.clear();
    this.center.i = 1e9;
  }

  /** 칸 하나의 배치 (종류별 행렬·순위 배열) */
  _buildCell(ci, cj) {
    const d = this.data, q = this.query;
    const C = this.cell;
    const x0 = -d.half + ci * C, z0 = -d.half + cj * C;
    const out = {};
    const m = new THREE.Matrix4(), quat = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
    for (const [key, M] of Object.entries(this.meshes)) {
      const sp = M.sp;
      const rng = new RNG(hash2(hash2(ci + 7919, cj - 104729), key.length * 131 + key.charCodeAt(0)));
      const want = (this.cfg.species[key] ?? 0.3) * C * C * this.density;
      const n = Math.floor(want) + (rng.chance(want - Math.floor(want)) ? 1 : 0);
      const mats = [], ranks = [];
      for (let k = 0; k < n; k++) {
        const x = x0 + rng.float() * C, z = z0 + rng.float() * C;
        const rot = rng.float() * Math.PI * 2, sc = rng.range(sp.size[0], sp.size[1]), rank = rng.float(), accept = rng.float();
        if (Math.abs(x) > d.half - 1 || Math.abs(z) > d.half - 1) continue;
        const si = Math.floor((x + d.half) / d.sRes), sj = Math.floor((z + d.half) / d.sRes);
        const c = sj * d.sN + si;
        const veg = d.vegKind[c];
        const w = sp.veg[veg] ?? 0;
        if (!w) continue;
        const cover = d.splat[c * 4 + 3] / 255;
        if (accept > w * Math.min(1, cover * 1.15)) continue;
        const surf = d.surface[c];
        if (surf === SURFACE.PACKED_DIRT || surf === SURFACE.DEEP_MUD || surf === SURFACE.PADDY || surf === SURFACE.DEEP_WATER) continue;
        if (!sp.wet && (surf === SURFACE.SHALLOW_MUD || surf === SURFACE.SHALLOW_WATER)) continue;
        if (d.waterLevel[c] !== NO_WATER && !sp.wet) continue;
        const y = q.getTerrainHeight(x, z);
        if (d.waterLevel[c] !== NO_WATER && d.waterLevel[c] > y + 0.12) continue;
        // 통나무·바위 위, 줄기 속에는 나지 않음
        if (q.getSupportHeight(x, z) > y + 0.05) continue;
        if (q.clearanceAt(x, z, y + 0.4) < 0.05) continue;
        // 경사면을 따라 눕힘 (납작한 종류)
        let tx = 0, tz = 0;
        if (sp.flat) {
          const sl = q.getSlope(x, z);
          tx = Math.atan(sl.gz); tz = -Math.atan(sl.gx);
        }
        e.set(tx, rot, tz, 'YXZ');
        quat.setFromEuler(e);
        p.set(x, y - 0.02, z);
        s.set(sc, sc * (sp.flat ? 1 : rng.range(0.85, 1.2)), sc);
        m.compose(p, quat, s);
        mats.push(...m.elements);
        ranks.push(rank);
      }
      out[key] = { mats: new Float32Array(mats), ranks: new Float32Array(ranks) };
    }
    return out;
  }

  update(camPos, force = false) {
    const C = this.cell, d = this.data;
    const ci = Math.floor((camPos.x + d.half) / C), cj = Math.floor((camPos.z + d.half) / C);
    if (force || ci !== this.center.i || cj !== this.center.j) {
      this.center.i = ci; this.center.j = cj;
      const R = this.radius + C;
      const rc = Math.ceil(R / C);
      const want = new Set();
      const queue = [];
      for (let j = cj - rc; j <= cj + rc; j++) {
        for (let i = ci - rc; i <= ci + rc; i++) {
          const cx = -d.half + (i + 0.5) * C, cz = -d.half + (j + 0.5) * C;
          const dist = Math.hypot(cx - camPos.x, cz - camPos.z);
          if (dist > R + C * 0.71) continue;
          const key = j * 4096 + i;
          want.add(key);
          if (!this.cells.has(key)) queue.push({ key, i, j, dist });
        }
      }
      for (const key of this.cells.keys()) if (!want.has(key)) { this.cells.delete(key); this._dirty = true; }
      // 가까운 칸부터 만든다 (먼 칸은 어차피 밀도가 낮아 몇 프레임 늦어도 티가 안 남)
      this._queue = queue.sort((a, b) => a.dist - b.dist);
      this._want = want;
    }
    // 한 프레임에 만드는 칸 수 제한 (걷는 중 프레임이 튀지 않게)
    const budget = force ? Infinity : 8;
    let made = 0;
    while (this._queue && this._queue.length && made < budget) {
      const c = this._queue.shift();
      if (!this._want.has(c.key) || this.cells.has(c.key)) continue;
      this.cells.set(c.key, this._buildCell(c.i, c.j));
      made++;
    }
    if (!made && !this._dirty) return;
    this._dirty = false;
    // 인스턴스 버퍼 다시 채우기
    let total = 0;
    for (const [key, M] of Object.entries(this.meshes)) {
      const arr = M.mesh.instanceMatrix.array, rk = M.rank.array;
      let n = 0;
      for (const cellData of this.cells.values()) {
        const c = cellData[key];
        if (!c || !c.ranks.length) continue;
        const k = Math.min(c.ranks.length, M.cap - n);
        if (k <= 0) break;
        arr.set(c.mats.subarray(0, k * 16), n * 16);
        rk.set(c.ranks.subarray(0, k), n);
        n += k;
      }
      M.mesh.count = n;
      M.mesh.visible = n > 0;
      M.mesh.instanceMatrix.clearUpdateRanges();
      M.mesh.instanceMatrix.addUpdateRange(0, n * 16);
      M.mesh.instanceMatrix.needsUpdate = true;
      M.rank.clearUpdateRanges();
      M.rank.addUpdateRange(0, n);
      M.rank.needsUpdate = true;
      total += n;
    }
    this.stats.instances = total;
    this.stats.cells = this.cells.size;
  }
}

