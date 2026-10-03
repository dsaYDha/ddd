// 식생·장애물 인스턴싱: InstancedMesh + 청크 단위 컬링 + 거리별 LOD + 품질별 밀도
//
// 각 '종류(kind)'는 배치 목록과 LOD 목록을 가진다. LOD 하나는 여러 부품(지오메트리+머티리얼)으로 구성.
// 청크마다 인스턴스 행렬을 미리 계산해(순위 rank 오름차순 정렬 → 밀도는 앞에서부터 자르기) 두고,
// 카메라가 일정 거리 이상 움직이거나 돌면 보이는 청크만 InstancedMesh 버퍼로 복사한다.
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _frustum = new THREE.Frustum();
const _pm = new THREE.Matrix4();
const _dir = new THREE.Vector3();

export class InstancedSystem {
  constructor(scene, { half, chunkSize }) {
    this.scene = scene;
    this.half = half;
    this.chunkSize = chunkSize;
    this.kinds = [];
    this.lastPos = new THREE.Vector3(1e9, 0, 0);
    this.lastDir = new THREE.Vector3();
    this.settings = null;
    this.stats = { instances: 0, drawn: 0 };
  }

  /**
   * @param {string} name
   * @param {Array} items    배치 목록
   * @param {Array<{maxDist:string|number, parts:Array<{geometry, material, castShadow?, receiveShadow?}>}>} lods
   * @param {object} o       transform(item, m) 행렬 계산, color(item) → [r,g,b], density: 'veg'|'grass'|null, distKey
   */
  addKind(name, items, lods, o = {}) {
    const n = Math.max(1, Math.ceil((this.half * 2) / this.chunkSize));
    const buckets = new Map();
    for (const it of items) {
      const ci = Math.min(n - 1, Math.max(0, Math.floor((it.x + this.half) / this.chunkSize)));
      const cj = Math.min(n - 1, Math.max(0, Math.floor((it.z + this.half) / this.chunkSize)));
      const key = cj * n + ci;
      let b = buckets.get(key);
      if (!b) { b = { ci, cj, items: [] }; buckets.set(key, b); }
      b.items.push(it);
    }
    const chunks = [];
    for (const b of buckets.values()) {
      b.items.sort((a, c) => (a.rank ?? 0) - (c.rank ?? 0));
      const count = b.items.length;
      const matrices = new Float32Array(count * 16);
      const colors = new Float32Array(count * 3);
      const pos = new Float32Array(count * 3);
      let minY = Infinity, maxY = -Infinity;
      b.items.forEach((it, i) => {
        o.transform(it, _m);
        _m.toArray(matrices, i * 16);
        const c = o.color ? o.color(it) : [1, 1, 1];
        colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2];
        pos[i * 3] = it.x; pos[i * 3 + 1] = it.y; pos[i * 3 + 2] = it.z;
        minY = Math.min(minY, it.y); maxY = Math.max(maxY, it.y + (o.height ? o.height(it) : 5));
      });
      const x0 = -this.half + b.ci * this.chunkSize, z0 = -this.half + b.cj * this.chunkSize;
      chunks.push({
        cx: x0 + this.chunkSize / 2, cz: z0 + this.chunkSize / 2,
        box: new THREE.Box3(new THREE.Vector3(x0 - 12, minY - 2, z0 - 12), new THREE.Vector3(x0 + this.chunkSize + 12, maxY + 2, z0 + this.chunkSize + 12)),
        count, matrices, colors, pos,
      });
    }
    const meshes = lods.map((lod) => lod.parts.map((part) => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, Math.max(1, items.length));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, items.length) * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = !!part.castShadow;
      mesh.receiveShadow = !!part.receiveShadow;
      mesh.name = `${name}_lod${lods.indexOf(lod)}`;
      mesh.visible = false;
      // 흔들림·알파가 같은 그림자용 깊이 머티리얼
      if (part.material.userData?.depthMaterial) mesh.customDepthMaterial = part.material.userData.depthMaterial;
      mesh.userData.shadowQuality = part.shadowQuality || 'medium';
      mesh.userData.castShadowWanted = !!part.castShadow;
      this.scene.add(mesh);
      return mesh;
    }));
    const kind = { name, lods, meshes, chunks, density: o.density ?? null, total: items.length };
    this.kinds.push(kind);
    return kind;
  }

  setSettings(settings) {
    this.settings = settings;
    // 그림자 품질 반영
    for (const k of this.kinds) {
      for (const lodMeshes of k.meshes) {
        for (const mesh of lodMeshes) {
          const want = mesh.userData.castShadowWanted;
          const q = mesh.userData.shadowQuality;
          mesh.castShadow = want && settings.shadows && (q !== 'high' || settings.shadowMapSize >= 2048);
        }
      }
    }
    this.lastPos.set(1e9, 0, 0);
  }

  _dist(lod) {
    const d = lod.maxDist;
    return typeof d === 'number' ? d : this.settings[d];
  }

  update(camera, force = false) {
    if (!this.settings) return;
    camera.getWorldDirection(_dir);
    const moved = camera.position.distanceTo(this.lastPos);
    const turned = 1 - _dir.dot(this.lastDir);
    if (!force && moved < 2.0 && turned < 0.006) return;
    this.lastPos.copy(camera.position);
    this.lastDir.copy(_dir);

    // 회전 여유를 둔 넓은 프러스텀
    const wide = this._cullCam || (this._cullCam = new THREE.PerspectiveCamera());
    wide.position.copy(camera.position);
    wide.quaternion.copy(camera.quaternion);
    wide.aspect = camera.aspect;
    wide.near = 0.1;
    wide.far = 1000;
    wide.fov = Math.min(150, camera.fov + 40);
    wide.updateProjectionMatrix();
    wide.updateMatrixWorld();
    _pm.multiplyMatrices(wide.projectionMatrix, wide.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);

    const cx = camera.position.x, cz = camera.position.z;
    const shadowKeep = (this.settings.shadowRadius || 0) + 6;
    let drawn = 0, total = 0;
    for (const k of this.kinds) {
      total += k.total;
      const dens = k.density === 'veg' ? this.settings.vegDensity : k.density === 'grass' ? this.settings.grassDensity : 1;
      const dists = k.lods.map((l) => this._dist(l));
      const maxD = dists[dists.length - 1];
      const counts = new Array(k.lods.length).fill(0);
      const half = this.chunkSize * 0.5;
      for (const ch of k.chunks) {
        const dx = Math.max(0, Math.abs(cx - ch.cx) - half), dz = Math.max(0, Math.abs(cz - ch.cz) - half);
        const dMin = Math.hypot(dx, dz);
        if (dMin > maxD) continue;
        if (dMin > shadowKeep && !_frustum.intersectsBox(ch.box)) continue;
        const n = Math.round(ch.count * dens);
        if (n <= 0) continue;
        const dMax = Math.hypot(Math.abs(cx - ch.cx) + half, Math.abs(cz - ch.cz) + half);
        // 청크 전체가 하나의 LOD 구간에 들어가면 통째로 복사
        let lodMin = dists.findIndex((d) => dMin <= d);
        let lodMax = dists.findIndex((d) => dMax <= d);
        if (lodMax === -1) lodMax = dists.length; // 최대 거리 넘어서는 인스턴스 있음
        if (lodMin === lodMax) {
          this._copy(k.meshes[lodMin], ch, 0, n, counts[lodMin]);
          counts[lodMin] += n;
        } else {
          // 인스턴스별 거리 판정
          for (let i = 0; i < n; i++) {
            const ddx = ch.pos[i * 3] - cx, ddz = ch.pos[i * 3 + 2] - cz;
            const d = Math.sqrt(ddx * ddx + ddz * ddz);
            let li = -1;
            for (let l = 0; l < dists.length; l++) { if (d <= dists[l]) { li = l; break; } }
            if (li < 0) continue;
            this._copy(k.meshes[li], ch, i, 1, counts[li]);
            counts[li]++;
          }
        }
      }
      for (let l = 0; l < k.meshes.length; l++) {
        for (const mesh of k.meshes[l]) {
          mesh.count = counts[l];
          mesh.visible = counts[l] > 0;   // 빈 메시는 그리지 않음 (드로우콜 절약)
          mesh.instanceMatrix.clearUpdateRanges();
          mesh.instanceMatrix.addUpdateRange(0, counts[l] * 16);
          mesh.instanceMatrix.needsUpdate = true;
          mesh.instanceColor.clearUpdateRanges();
          mesh.instanceColor.addUpdateRange(0, counts[l] * 3);
          mesh.instanceColor.needsUpdate = true;
        }
        drawn += counts[l];
      }
    }
    this.stats.drawn = drawn;
    this.stats.instances = total;
  }

  _copy(meshes, ch, start, n, offset) {
    for (const mesh of meshes) {
      mesh.instanceMatrix.array.set(ch.matrices.subarray(start * 16, (start + n) * 16), offset * 16);
      mesh.instanceColor.array.set(ch.colors.subarray(start * 3, (start + n) * 3), offset * 3);
    }
  }
}

// ---------------------------------------------------------------
// 행렬 도우미
// ---------------------------------------------------------------
export function trsMatrix(m, x, y, z, rotY, sx, sy = sx, sz = sx, tiltX = 0, tiltZ = 0) {
  _p.set(x, y, z);
  _e.set(tiltX, rotY, tiltZ, 'YXZ');
  _q.setFromEuler(_e);
  _s.set(sx, sy, sz);
  return m.compose(_p, _q, _s);
}

/** 캡슐(통나무·뿌리): X축 단위 원기둥을 A→B 로 */
const _ax = new THREE.Vector3(1, 0, 0);
const _d = new THREE.Vector3();
const _roll = new THREE.Quaternion();
export function capsuleMatrix(m, s) {
  _d.set(s.bx - s.ax, s.by - s.ay, s.bz - s.az);
  const len = _d.length();
  _d.divideScalar(len || 1);
  _q.setFromUnitVectors(_ax, _d);
  _roll.setFromAxisAngle(_ax, s.rot ?? 0);
  _q.multiply(_roll);
  _p.set((s.ax + s.bx) / 2, (s.ay + s.by) / 2, (s.az + s.bz) / 2);
  _s.set(len + s.r * 0.6, s.r, s.r);
  return m.compose(_p, _q, _s);
}
