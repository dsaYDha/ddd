// =====================================================================
//  SupportMesh — 7단계 지원 화력·보급의 화면 모델 (절차 생성, 외부 파일 없음)
//   · 크레이터: 포탄이 땅에 떨어진 자리 — 지형을 따라 깔린 원판 (가운데 검게 탄 흙 → 파헤쳐진 흙 둔덕 → 바깥으로 흩어진 흙,
//     가장자리는 투명하게 지면에 녹아듦). 그을림 자국(CombatFX)과 달리 총알 자국에 밀려 사라지지 않는다 (FireSupport.craters 그대로).
//   · 보급 상자: 헬기가 떨어뜨린 올리브색 나무 상자 (떨어지는 동안 흔들림 → 땅에 닿으면 Game 에 'land'), 열면 뚜껑이 옆으로.
//   · 던진 탄창: 분대원 손에서 플레이어 가슴까지 포물선 (날아가는 동안만).
// =====================================================================
import * as THREE from 'three';
import { patchCanopy } from './Materials.js';

const C = (hex) => new THREE.Color(hex);
const CRATER = { char: C('#16110c'), dirt: C('#3e2f1f'), rim: C('#5b4630'), spray: C('#4d3c28') };

/** 크레이터 원판: 반지름 r, 지형 높이 h(x,z) — 국소 좌표 (중심 0) */
function buildCraterGeometry(r, h, x0, z0, seed) {
  const RINGS = [0, 0.35, 0.7, 0.95, 1.25, 1.7, 2.3];
  const SEG = 20;
  const pos = [], col = [], idx = [];
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296); };
  const wob = Array.from({ length: SEG }, () => 0.85 + rnd() * 0.3);
  for (let i = 0; i < RINGS.length; i++) {
    for (let k = 0; k < SEG; k++) {
      const a = (k / SEG) * Math.PI * 2;
      const rr = RINGS[i] * r * (i ? wob[k] : 1);
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      const gy = h(x0 + x, z0 + z);
      // 둔덕 (0.95r 근처 위로), 가운데는 지면에 바짝
      const rim = i === 3 ? 0.13 * r : i === 2 || i === 4 ? 0.05 * r : 0;
      pos.push(x, gy + 0.03 + rim, z);
      let c, alpha = 1;
      if (i <= 1) c = CRATER.char;
      else if (i === 2) c = CRATER.dirt;
      else if (i <= 4) c = CRATER.rim;
      else { c = CRATER.spray; alpha = i === 5 ? 0.75 * (0.6 + rnd() * 0.4) : 0; }
      const v = 0.85 + rnd() * 0.3;
      col.push(c.r * v, c.g * v, c.b * v, alpha);
      if (i === 0) break;   // 가운데 점 하나
    }
  }
  // 가운데 부채
  for (let k = 0; k < SEG; k++) idx.push(0, 1 + ((k + 1) % SEG), 1 + k);
  for (let i = 1; i < RINGS.length - 1; i++) {
    const b0 = 1 + (i - 1) * SEG, b1 = 1 + i * SEG;
    for (let k = 0; k < SEG; k++) {
      const k1 = (k + 1) % SEG;
      idx.push(b0 + k, b0 + k1, b1 + k1, b0 + k, b1 + k1, b1 + k);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** 보급 상자 (몸통 + 뚜껑 따로) — 올리브색 판자, 모서리 각재, 노란 글자 띠 */
function buildCrateGeometry() {
  const W = 0.95, D = 0.6, Hh = 0.5;
  const pos = [], nor = [], col = [], idx = [];
  const olive = C('#6f7a4a'), dark = C('#4e5634'), stripe = C('#d2b45c');
  const box = (cx, cy, cz, sx, sy, sz, color) => {
    const faces = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
      [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    ];
    for (const [n, u, v] of faces) {
      const b = pos.length / 3;
      const hs = [sx / 2, sy / 2, sz / 2];
      const dot = (a, w) => a[0] * w[0] + a[1] * w[1] + a[2] * w[2];
      for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = [0, 1, 2].map((ax) => n[ax] * hs[ax] + u[ax] * du * Math.abs(dot(u, hs)) + v[ax] * dv * Math.abs(dot(v, hs)));
        pos.push(cx + p[0], cy + p[1], cz + p[2]);
        nor.push(n[0], n[1], n[2]);
        const shade = n[1] > 0.5 ? 1.05 : n[1] < -0.5 ? 0.6 : 0.9;
        col.push(color.r * shade, color.g * shade, color.b * shade);
      }
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
  };
  // 몸통 (뚜껑 빼고)
  box(0, Hh * 0.44, 0, W, Hh * 0.88, D, olive);
  // 모서리 각재
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(sx * (W / 2 - 0.02), Hh * 0.44, sz * (D / 2 - 0.02), 0.05, Hh * 0.9, 0.05, dark);
  // 글자 띠 (앞뒤)
  for (const sz of [-1, 1]) box(0, Hh * 0.5, sz * (D / 2 + 0.003), W * 0.6, 0.06, 0.004, stripe);
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  body.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  body.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  body.setIndex(idx);
  pos.length = nor.length = col.length = idx.length = 0;
  box(0, 0.035, 0, W + 0.02, 0.07, D + 0.02, olive);
  box(0, 0.075, 0, W * 0.9, 0.012, 0.05, dark);
  const lid = new THREE.BufferGeometry();
  lid.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  lid.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  lid.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  lid.setIndex(idx);
  return { body, lid, height: Hh * 0.88 };
}

export class SupportMeshes {
  /** @param {THREE.Scene} scene @param {{ getSupportHeight, getTerrainHeight }} query */
  constructor(scene, query) {
    this.scene = scene;
    this.query = query;
    this.root = new THREE.Group();
    this.root.name = 'support';
    scene.add(this.root);
    this.craterMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    patchCanopy(this.craterMat, { sun: 1, sky: 0.7 });
    this.solidMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    patchCanopy(this.solidMat, { sun: 1, sky: 0.7 });
    this._crate = buildCrateGeometry();
    this._magGeo = new THREE.BoxGeometry(0.035, 0.2, 0.075);
    this._magGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(this._magGeo.attributes.position.count * 3).fill(0.13), 3));
    this._craters = new Map();   // crater 자료 → mesh
    this._crates = new Map();    // crate 자료 → { group, lid, fall, landed }
    this._mags = [];             // { mesh, from, to, t, dur }
    this.onLand = null;          // (crate) => void — 상자가 땅에 닿음 (소리)
  }

  /** FireSupport.craters 목록에 맞춤 (새로 생긴 것만 만들고, 없어진 것은 지움) */
  syncCraters(list) {
    for (const [c, mesh] of this._craters) if (!list.includes(c)) { this.root.remove(mesh); mesh.geometry.dispose(); this._craters.delete(c); }
    for (const c of list) {
      if (this._craters.has(c)) continue;
      const q = this.query;
      const geo = buildCraterGeometry(c.r, (x, z) => q.getTerrainHeight(x, z), c.x, c.z, Math.floor(c.x * 131 + c.z * 71));
      const mesh = new THREE.Mesh(geo, this.craterMat);
      mesh.position.set(c.x, 0, c.z);
      mesh.receiveShadow = true;
      mesh.renderOrder = 2;
      this.root.add(mesh);
      this._craters.set(c, mesh);
    }
  }

  /** 상자 떨어뜨리기 (헬기 — dropHeight 위에서) */
  addCrate(crate, dropHeight = 14) {
    if (this._crates.has(crate)) return;
    const group = new THREE.Group();
    const body = new THREE.Mesh(this._crate.body, this.solidMat);
    const lid = new THREE.Mesh(this._crate.lid, this.solidMat);
    lid.position.y = this._crate.height;
    for (const m of [body, lid]) { m.castShadow = true; m.receiveShadow = true; group.add(m); }
    group.position.set(crate.x, crate.y + dropHeight, crate.z);
    group.rotation.y = (crate.x * 7.1 + crate.z * 3.3) % (Math.PI * 2);
    this.root.add(group);
    this._crates.set(crate, { group, lid, vy: 0, landed: dropHeight <= 0, spin: 0.6 });
    if (dropHeight <= 0) group.position.y = crate.y;
  }

  /** 상자 열림 (뚜껑을 옆으로) */
  openCrate(crate) {
    const it = this._crates.get(crate);
    if (!it) return;
    it.lid.position.set(0.62, 0.04, 0.1);
    it.lid.rotation.set(0, 0.4, 0.12);
  }

  /** 탄창 던지기: from → to (월드), dur 초 */
  throwMag(from, to, dur) {
    const mesh = new THREE.Mesh(this._magGeo, this.solidMat);
    mesh.castShadow = true;
    mesh.position.set(from.x, from.y, from.z);
    this.root.add(mesh);
    this._mags.push({ mesh, from: { ...from }, to, t: 0, dur: Math.max(0.2, dur) });
  }

  update(dt) {
    for (const [crate, it] of this._crates) {
      if (it.landed) continue;
      it.vy -= 9.8 * dt;
      const g = it.group;
      g.position.y += it.vy * dt;
      g.rotation.z = Math.sin(g.position.y * 0.7) * 0.15;
      if (g.position.y <= crate.y) {
        g.position.y = crate.y;
        g.rotation.z = 0;
        it.landed = true;
        this.onLand?.(crate);
      }
    }
    for (let i = this._mags.length - 1; i >= 0; i--) {
      const m = this._mags[i];
      m.t += dt;
      const k = Math.min(1, m.t / m.dur);
      const to = typeof m.to === 'function' ? m.to() : m.to;
      const arc = Math.sin(k * Math.PI) * Math.min(2.2, 0.3 + Math.hypot(to.x - m.from.x, to.z - m.from.z) * 0.12);
      m.mesh.position.set(m.from.x + (to.x - m.from.x) * k, m.from.y + (to.y - m.from.y) * k + arc, m.from.z + (to.z - m.from.z) * k);
      m.mesh.rotation.set(m.t * 9, m.t * 4, 0);
      if (k >= 1) { this.root.remove(m.mesh); this._mags.splice(i, 1); }
    }
  }

  clear() {
    for (const mesh of this._craters.values()) { this.root.remove(mesh); mesh.geometry.dispose(); }
    this._craters.clear();
    for (const it of this._crates.values()) this.root.remove(it.group);
    this._crates.clear();
    for (const m of this._mags) this.root.remove(m.mesh);
    this._mags.length = 0;
  }
}
