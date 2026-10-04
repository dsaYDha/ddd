// =====================================================================
//  FootprintMesh — 5단계 발자국 화면 (world/Footprints 의 list 를 그림)
//   군화 밑창 무늬(뒤꿈치·앞창 + 가로 홈) 를 절차로 만든 알파 텍스처, 인스턴스 평면 하나로 모든 발자국.
//   카메라 drawDistance(45m) 안의 것 중 가까운 순서로 그래픽 품질별 상한 (낮음 160 · 중간 280 · 높음 360) 까지만, 0.25초마다 다시 채움.
//   진하기 = Footprints.strength × 깊이 — 오래되거나 비를 맞으면 옅어져 사라진다. 왼발은 좌우 뒤집음.
// =====================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { patchCanopy, addPatch } from './Materials.js';

const W = 0.12, L = 0.29;      // 발자국 크기 (m)

function soleTexture() {
  const w = 32, h = 72;
  const data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const u = (i + 0.5) / w * 2 - 1, v = (j + 0.5) / h;          // u: −1~1 (폭), v: 0(뒤꿈치)~1(앞)
      // 밑창 윤곽: 뒤꿈치 (좁음) → 허리 (오목) → 앞창 (넓고 둥긂)
      const halfW = v < 0.32 ? 0.72 + 0.1 * Math.sin(v / 0.32 * Math.PI * 0.5)
        : v < 0.5 ? 0.66 : 0.86 - 0.5 * Math.max(0, (v - 0.82) / 0.18) ** 2;
      const inside = Math.abs(u) < halfW && v > 0.03 && v < 0.98
        && !(v < 0.1 && Math.abs(u) > halfW * (0.4 + v * 6)) && !(v > 0.9 && Math.abs(u) > halfW * (1 - (v - 0.9) * 6));
      let a = 0;
      if (inside) {
        // 홈: 가로 줄 (러그) — 오목한 허리는 얕게
        const lug = Math.abs(Math.sin(v * Math.PI * 13)) > 0.42 ? 1 : 0.45;
        const edge = Math.min(1, (halfW - Math.abs(u)) * 6);
        a = (v > 0.34 && v < 0.48 ? 0.55 : 0.75 + 0.25 * lug) * Math.min(1, edge * 1.6);
      }
      const k = (j * w + i) * 4;
      data[k] = data[k + 1] = data[k + 2] = 255;
      data[k + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export class FootprintMesh {
  /** @param {THREE.Scene} scene  @param {import('../world/Footprints.js').Footprints} prints  @param {{getSupportHeight}} query */
  constructor(scene, prints, query) {
    this.prints = prints;
    this.query = query;
    const F = CONFIG.footprints;
    this.cap = F.drawCap;
    const geo = new THREE.PlaneGeometry(W, L);
    geo.rotateX(-Math.PI / 2);          // 바닥에 눕힘: 길이 축 = −Z (yaw 0 이 앞)
    this.fade = new THREE.InstancedBufferAttribute(new Float32Array(this.cap), 1);
    geo.setAttribute('aFade', this.fade);
    this.material = new THREE.MeshLambertMaterial({
      color: 0x1c140c, map: soleTexture(), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    patchCanopy(this.material, { sun: 0.9, sky: 0.7 });
    addPatch(this.material, 'printFade', (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aFade;\nvarying float vPrintFade;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPrintFade = aFade;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vPrintFade;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vPrintFade;');
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, this.cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'footprints';
    scene.add(this.mesh);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._e = new THREE.Euler();
    this._t = 0;
    this._sel = [];
    this.shown = 0;
  }

  /** 그래픽 품질: 그리는 발자국 수 상한 (CONFIG.graphics[].footprints — 인스턴스 버퍼는 최대치로 한 번) */
  setQuality(q) { this.limit = Math.min(this.cap, q?.footprints ?? this.cap); this._t = 0; }

  update(dt, camera) {
    this._t -= dt;
    if (this._t > 0) return;
    this._t = 0.25;
    const F = CONFIG.footprints, cam = camera.position, r2 = F.drawDistance * F.drawDistance;
    const sel = this._sel;
    sel.length = 0;
    for (const p of this.prints.list) {
      const dx = p.x - cam.x, dz = p.z - cam.z, d2 = dx * dx + dz * dz;
      if (d2 > r2 || p.strength <= 0.02) continue;
      sel.push({ p, d2 });
    }
    const lim = this.limit ?? this.cap;
    if (sel.length > lim) { sel.sort((a, b) => a.d2 - b.d2); sel.length = lim; }
    const m = this._m, q = this._q, s = this._s, pos = this._p, e = this._e;
    for (let i = 0; i < sel.length; i++) {
      const p = sel[i].p;
      const y = this.query.getSupportHeight(p.x, p.z) + 0.025;
      pos.set(p.x, Math.max(y, p.y + 0.01), p.z);
      e.set(0, p.yaw, 0);
      q.setFromEuler(e);
      s.set(p.foot < 0 ? -1 : 1, 1, 1);
      m.compose(pos, q, s);
      this.mesh.setMatrixAt(i, m);
      this.fade.array[i] = Math.min(1, p.strength * (0.6 + 0.4 * p.depth)) * 0.95;
    }
    this.mesh.count = sel.length;
    this.shown = sel.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.fade.needsUpdate = true;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
  }
}
