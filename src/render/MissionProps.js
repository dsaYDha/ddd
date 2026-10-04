// =====================================================================
//  MissionProps — 5단계 임무 소품 (모두 절차 생성, 파일 없음)
//   · 야영지: 대나무 기둥·엮은 벽(뒤·양옆, 앞은 트임)·야자잎 지붕을 겹쳐 얹은 오두막 2~3채, 꺼져가는 모닥불
//     (돌 둘레·숯이 된 장작·재·깜빡이는 잉걸·가는 연기), 상자·자루. 문서 오두막 안 상자 위에 서류철.
//     오두막 벽은 원기둥 충돌체로 (움직임 막음·시야 대부분·탄 일부 관통) — 길찾기 격자도 다시 계산.
//   · 흔적: 탄피 무더기, 꺼진 모닥불 자리, 잘린 덩굴 (발자국은 FootprintMesh).
//   · 땅에 놓인 총: 주울 수 있는 적 소총 / 바꿔 들고 내려놓은 내 소총.
//  재질은 정점색 + 캐노피 그늘 패치 (월드와 같은 빛), 젖음 패치.
// =====================================================================
import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { PartBuilder, mat, buildCasing, buildRifle } from './WeaponModel.js';
import { patchCanopy, patchWetness } from './Materials.js';

const C = {
  bamboo: { kind: 0, color: 0x8f7a48, rough: 0.7, metal: 0 },
  bambooDark: { kind: 0, color: 0x5f5232, rough: 0.8, metal: 0 },
  weave: { kind: 0, color: 0x9c8659, rough: 0.9, metal: 0 },
  thatch: { kind: 0, color: 0x6f6338, rough: 0.95, metal: 0 },
  thatchDry: { kind: 0, color: 0x8a7a48, rough: 0.95, metal: 0 },
  crate: { kind: 0, color: 0x5a4a30, rough: 0.85, metal: 0 },
  crateOD: { kind: 0, color: 0x47502f, rough: 0.8, metal: 0 },
  sack: { kind: 0, color: 0x8a7d5c, rough: 1, metal: 0 },
  paper: { kind: 0, color: 0xcfc6a8, rough: 1, metal: 0 },
  folder: { kind: 0, color: 0x6d7a4c, rough: 0.9, metal: 0 },
  stone: { kind: 0, color: 0x5d5a50, rough: 0.95, metal: 0 },
  char: { kind: 0, color: 0x1d1a17, rough: 1, metal: 0 },
  ash: { kind: 0, color: 0x6e6a63, rough: 1, metal: 0 },
  vine: { kind: 0, color: 0x46542a, rough: 0.8, metal: 0 },
  vineCut: { kind: 0, color: 0xb4ad7a, rough: 0.8, metal: 0 },
  leaf: { kind: 0, color: 0x3c5524, rough: 0.8, metal: 0 },
};
const WALL_TAGS = { blocksMovement: true, visionBlock: 0.9, bulletBlock: 'partial' };
const POST_TAGS = { blocksMovement: true, visionBlock: 1, bulletBlock: 'partial' };

export class MissionProps {
  /** @param {THREE.Scene} scene  @param {import('../world/World.js').World} world */
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.query = world.query;
    this.root = new THREE.Group();
    this.root.name = 'missionProps';
    scene.add(this.root);
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
    patchCanopy(this.material, { sun: 1, sky: 0.7 });
    patchWetness(this.material, 0.7);
    this.brass = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.75 });
    patchCanopy(this.brass, { sun: 1, sky: 0.7 });
    this.gunMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 });
    patchCanopy(this.gunMat, { sun: 1, sky: 0.7 });
    this.emberMat = new THREE.MeshBasicMaterial({ color: 0xff6a1c, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: true });
    // 스프라이트는 사용자 안개 청크(정점 변환 변수)가 없어 안개를 끈다 (가까운 야영지에서만 보임)
    this.smokeMat = new THREE.SpriteMaterial({ map: smokeTexture(), color: 0xb9b5ab, transparent: true, opacity: 0.18, depthWrite: false, fog: false });
    this._casingGeo = buildCasing(false);
    this._gunGeo = {};
    this.colliders = [];         // 더한 원기둥 (치울 때 뺌)
    this.fire = null;
    this.docs = null;
    this.groundWeapons = [];
    this.huts = [];
  }

  // -----------------------------------------------------------------
  /**
   * 임무 소품 세우기. def = MissionGen 임무 (camp, traces). 오두막이 큰 나무 줄기와 겹치면 둘레를 돌려 자리를 옮기고
   * 문서 위치를 고친다 (def.camp.docs, 'documents' 목표 좌표). nav 가 있으면 오두막 둘레 길찾기 칸을 다시 계산.
   */
  build(def, nav = null) {
    this.clear();
    const q = this.query;
    if (def.camp) this._buildCamp(def, nav);
    for (const tr of def.traces ?? []) {
      if (tr.kind === 'casings') this._casings(tr);
      else if (tr.kind === 'firepit') this._firepit(tr);
      else if (tr.kind === 'vines') this._vines(tr);
    }
    void q;
  }

  clear() {
    for (const c of this.colliders) this.query.removeCircle(c);
    this.colliders.length = 0;
    for (const o of this.root.children.slice()) {
      this.root.remove(o);
      if (o.isMesh && o.geometry !== this._casingGeo && !Object.values(this._gunGeo).includes(o.geometry)) o.geometry.dispose();
      if (o.isSprite) o.material.dispose();
    }
    this.fire = null;
    this.docs = null;
    this.groundWeapons.length = 0;
    this.huts.length = 0;
  }

  /** 문서를 가져감 → 서류철이 사라짐 */
  takeDocs() { if (this.docs) this.docs.visible = false; }

  update(dt, camera) {
    const f = this.fire;
    if (!f) return;
    f.t += dt;
    // 잉걸: 숨 쉬듯 느리게 + 가끔 확 (꺼져가는 불)
    const flick = 0.55 + 0.25 * Math.sin(f.t * 1.7) + 0.12 * Math.sin(f.t * 5.3 + 1) + 0.08 * Math.sin(f.t * 11.1);
    this.emberMat.opacity = Math.max(0.15, Math.min(1, flick));
    // 연기: 가는 줄기가 위로 올라가며 퍼지고 옅어짐 (반복)
    const near = camera ? camera.position.distanceTo(f.pos) < 120 : true;
    for (const p of f.smoke) {
      p.visible = near;
      if (!near) continue;
      p.userData.t = (p.userData.t + dt / 9) % 1;
      const k = p.userData.t;
      p.position.set(f.pos.x + Math.sin(k * 4 + p.userData.ph) * 0.25 * k + k * 0.8, f.pos.y + 0.3 + k * 5.5, f.pos.z + k * 0.5);
      const s = 0.5 + k * 2.6;
      p.scale.set(s, s, 1);
      p.material.opacity = 0.16 * Math.sin(Math.PI * Math.min(1, k * 1.3));
    }
  }

  // -----------------------------------------------------------------
  // 야영지
  // -----------------------------------------------------------------
  _buildCamp(def, nav) {
    const camp = def.camp, q = this.query;
    const rng = new RNG((def.seed * 131 + 7) >>> 0);
    // 오두막이 큰 줄기(판근 큰 나무)와 겹치면 모닥불 둘레로 돌려 빈자리를 찾음
    const trunks = [];
    q.circleGrid.forEachNear(camp.x, camp.z, camp.r + 6, (c) => {
      if ((c.type === 'bigTree') && c.tags.blocksMovement && !trunks.includes(c)) trunks.push(c);
    });
    const clash = (h) => trunks.some((t) => {
      const lx = (t.x - h.x) * Math.cos(h.yaw) - (t.z - h.z) * Math.sin(h.yaw);
      const lz = (t.x - h.x) * Math.sin(h.yaw) + (t.z - h.z) * Math.cos(h.yaw);
      return Math.abs(lx) < h.w / 2 + t.r + 0.6 && Math.abs(lz) < h.d / 2 + t.r + 0.6;
    });
    const placed = [];
    camp.huts.forEach((h0, idx) => {
      let h = { ...h0 };
      const a0 = Math.atan2(h0.z - camp.fire.z, h0.x - camp.fire.x), r0 = Math.hypot(h0.x - camp.fire.x, h0.z - camp.fire.z);
      for (let k = 0; k < 16 && (clash(h) || placed.some((p) => Math.hypot(p.x - h.x, p.z - h.z) < 4.6)); k++) {
        const a = a0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.32, r = r0 + (k > 8 ? 1.2 : 0);
        h = { ...h0, x: camp.fire.x + Math.cos(a) * r, z: camp.fire.z + Math.sin(a) * r };
        h.yaw = Math.atan2(-(camp.fire.x - h.x), -(camp.fire.z - h.z));
      }
      placed.push(h);
      camp.huts[idx] = h;
    });
    // 문서 위치 (문서 오두막 안쪽 뒤 벽 앞) 다시 계산 → 목표 좌표도
    const dh = camp.huts[camp.docsHut];
    const fx = -Math.sin(dh.yaw), fz = -Math.cos(dh.yaw);
    camp.docs = { x: dh.x - fx * (dh.d * 0.25), z: dh.z - fz * (dh.d * 0.25) };
    const o = def.objectives.find((x) => x.kind === 'documents');
    if (o) { o.x = camp.docs.x; o.z = camp.docs.z; }
    camp.huts.forEach((h, i) => this._hut(h, i === camp.docsHut, rng));
    this._campfire(camp.fire, rng, true);
    // 상자·자루 몇 개 (모닥불과 오두막 사이)
    for (let i = 0; i < 3; i++) {
      const a = rng.range(0, Math.PI * 2), r = rng.range(2.4, 4.2);
      const x = camp.fire.x + Math.cos(a) * r, z = camp.fire.z + Math.sin(a) * r;
      if (camp.huts.some((h) => Math.hypot(h.x - x, h.z - z) < 2.6)) continue;
      const b = new PartBuilder();
      if (rng.chance(0.5)) {
        b.add(new THREE.BoxGeometry(0.62, 0.36, 0.42), { surf: C.crateOD, matrix: mat(0, 0.18, 0), shade: (p) => 0.85 + 0.3 * (p.y + 0.18) });
        b.add(new THREE.BoxGeometry(0.66, 0.04, 0.46), { surf: C.crate, matrix: mat(0, 0.38, 0) });
      } else {
        b.add(new THREE.SphereGeometry(0.28, 8, 6), { surf: C.sack, matrix: mat(0, 0.2, 0, 0, 0, 0, 1, 0.75, 0.85) });
        b.add(new THREE.SphereGeometry(0.24, 8, 6), { surf: C.sack, matrix: mat(0.32, 0.17, 0.1, 0, 0.6, 0.2, 1, 0.7, 0.8) });
      }
      this._mesh(b, x, z, rng.range(0, 6.28));
    }
    // 오두막 둘레 길찾기 칸 다시 (벽)
    if (nav) for (const h of camp.huts) nav.rebuildRegion(h.x, h.z, Math.max(h.w, h.d) / 2 + 3);
  }

  _hut(h, withDocs, rng) {
    const q = this.query, b = new PartBuilder();
    const w = h.w, d = h.d, eave = 1.45, ridge = 2.35, over = 0.4;
    const y0 = q.getTerrainHeight(h.x, h.z);
    // 기둥 (모서리 4 + 앞뒤 가운데 2 + 용마루 받침 2)
    const post = (x, z, top, r = 0.065) => b.add(new THREE.CylinderGeometry(r * 0.9, r, top + 0.4, 6), { surf: C.bamboo, matrix: mat(x, (top - 0.4) / 2, z), shade: (p) => 0.85 + 0.15 * Math.sin(p.y * 9) });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) post(sx * w / 2, sz * d / 2, eave + 0.05);
    post(0, d / 2, eave + 0.05); post(-w / 2, 0, ridge, 0.07); post(w / 2, 0, ridge, 0.07);
    // 엮은 벽 (뒤·양옆): 판 + 가로 대나무 살 3줄 — 앞은 트임 (모닥불 쪽)
    const panel = (cx, cz, len, alongX) => {
      b.add(new THREE.BoxGeometry(alongX ? len : 0.04, eave - 0.05, alongX ? 0.04 : len), {
        surf: C.weave, matrix: mat(cx, (eave - 0.05) / 2, cz),
        shade: (p) => 0.78 + 0.22 * (0.5 + 0.5 * Math.sin((alongX ? p.x : p.z) * 31) * Math.sin(p.y * 29)),
      });
      for (const yy of [0.25, 0.75, 1.25]) {
        b.add(new THREE.CylinderGeometry(0.025, 0.025, len, 5), { surf: C.bambooDark, matrix: alongX ? mat(cx, yy, cz + Math.sign(cz || 1) * 0.03, 0, 0, Math.PI / 2) : mat(cx + Math.sign(cx || 1) * 0.03, yy, cz, Math.PI / 2, 0, 0) });
      }
    };
    panel(0, d / 2, w, true);
    panel(-w / 2, 0, d, false);
    panel(w / 2, 0, d, false);
    // 박공 (옆 삼각형, 엮은 벽)
    for (const sx of [-1, 1]) {
      const g = new THREE.BufferGeometry();
      const x = sx * w / 2;
      const v = sx > 0 ? [x, eave, -d / 2, x, ridge, 0, x, eave, d / 2] : [x, eave, -d / 2, x, eave, d / 2, x, ridge, 0];
      g.setAttribute('position', new THREE.Float32BufferAttribute(v.concat([v[0], v[1], v[2], v[6], v[7], v[8], v[3], v[4], v[5]]), 3));
      b.add(g, { surf: C.weave, crease: 80 });
    }
    // 지붕: 앞·뒤 비탈 — 야자잎 띠 4겹을 기와처럼 겹침 (색이 조금씩 다름)
    const slopeLen = Math.hypot(d / 2, ridge - eave) + over;
    const ang = Math.atan2(ridge - eave, d / 2);
    for (const sz of [-1, 1]) {
      for (let k = 0; k < 4; k++) {
        const t0 = k / 4, len = slopeLen / 4 + 0.18;
        const along = (t0 + 0.125) * slopeLen;           // 용마루에서 처마 쪽으로
        const zc = sz * Math.cos(ang) * along, yc = ridge + 0.04 - Math.sin(ang) * along + 0.03 * k;
        b.add(new THREE.BoxGeometry(w + over * 2, 0.07, len), {
          surf: k % 2 ? C.thatchDry : C.thatch, matrix: mat(0, yc, zc, sz * ang, 0, 0),
          tint: 0.9 + rng.range(0, 0.2), shade: (p, n) => (n.y > 0.2 ? 1 : 0.6) * (0.85 + 0.15 * Math.sin(p.x * 23)),
        });
      }
    }
    // 용마루 (굵은 대나무)
    b.add(new THREE.CylinderGeometry(0.06, 0.06, w + over * 2 + 0.1, 6), { surf: C.bambooDark, matrix: mat(0, ridge + 0.06, 0, 0, 0, Math.PI / 2) });
    // 안쪽 뒤: 대나무 평상 (낮게)
    b.add(new THREE.BoxGeometry(w - 0.4, 0.06, 0.8), { surf: C.bamboo, matrix: mat(0, 0.38, d / 2 - 0.55), shade: (p) => 0.8 + 0.2 * Math.sin(p.x * 40) });
    for (const sx of [-1, 1]) b.add(new THREE.CylinderGeometry(0.04, 0.04, 0.4, 5), { surf: C.bambooDark, matrix: mat(sx * (w / 2 - 0.35), 0.18, d / 2 - 0.55) });
    const mesh = this._mesh(b, h.x, h.z, h.yaw, y0);
    mesh.castShadow = true;
    // 문서 상자 + 서류철 (안쪽, 평상 앞 가운데)
    if (withDocs) {
      const cb = new PartBuilder();
      cb.add(new THREE.BoxGeometry(0.56, 0.42, 0.4), { surf: C.crate, matrix: mat(0, 0.21, 0), shade: (p) => 0.8 + 0.4 * (p.y + 0.21) });
      this._mesh(cb, 0, 0, h.yaw, y0, this._local(h, 0, d * 0.25));
      const db = new PartBuilder();
      db.add(new THREE.BoxGeometry(0.3, 0.025, 0.22), { surf: C.folder, matrix: mat(0, 0.0125, 0) });
      db.add(new THREE.BoxGeometry(0.26, 0.012, 0.2), { surf: C.paper, matrix: mat(0.01, 0.03, 0.005, 0, 0.12, 0) });
      db.add(new THREE.BoxGeometry(0.21, 0.004, 0.29), { surf: C.paper, matrix: mat(-0.04, 0.04, 0.0, 0, -0.35, 0) });
      const p = this._local(h, 0, d * 0.25);
      this.docs = this._mesh(db, 0, 0, h.yaw + 0.3, y0 + 0.42, p);
    }
    // 충돌체: 벽 (원기둥을 0.34m 마다) — 앞은 트임
    const add = (lx, lz, r, tags, y1) => {
      const p = this._local(h, lx, lz);
      const c = { x: p.x, z: p.z, r, y0: y0 - 0.5, y1: y0 + y1, type: 'hutWall', tags };
      q.addCircle(c);
      this.colliders.push(c);
    };
    const step = 0.34;
    for (let x = -w / 2; x <= w / 2 + 1e-6; x += step) add(x, d / 2, 0.17, WALL_TAGS, eave);
    for (let z = -d / 2; z < d / 2; z += step) { add(-w / 2, z, 0.17, WALL_TAGS, eave); add(w / 2, z, 0.17, WALL_TAGS, eave); }
    for (const sx of [-1, 1]) add(sx * w / 2, -d / 2, 0.09, POST_TAGS, eave);
    this.huts.push(h);
  }

  /** 오두막 국소 (lx, lz) → 월드 (yaw 규약: 앞 = −Z 국소 → (−sin yaw, −cos yaw)) */
  _local(h, lx, lz) {
    const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
    return { x: h.x + lx * c + lz * s, z: h.z - lx * s + lz * c };
  }

  _campfire(p, rng, burning) {
    const q = this.query, b = new PartBuilder();
    const y0 = q.getTerrainHeight(p.x, p.z);
    const R = burning ? 0.55 : 0.45;
    // 재 (얕은 원판)
    b.add(new THREE.CylinderGeometry(R * 0.85, R * 0.95, 0.04, 14), { surf: C.ash, matrix: mat(0, 0.01, 0), shade: (v) => 0.7 + 0.3 * Math.sin(v.x * 17 + v.z * 13) });
    // 돌 둘레
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.range(-0.15, 0.15);
      const s = rng.range(0.09, 0.15);
      b.add(new THREE.IcosahedronGeometry(1, 0), { surf: C.stone, matrix: mat(Math.cos(a) * R, s * 0.5, Math.sin(a) * R, rng.range(0, 3), rng.range(0, 3), 0, s * 1.2, s * 0.8, s), tint: rng.range(0.8, 1.15), crease: 25 });
    }
    // 숯이 된 장작 (서로 기댐)
    for (let i = 0; i < (burning ? 4 : 2); i++) {
      const a = (i / 4) * Math.PI * 2 + rng.range(-0.3, 0.3);
      b.add(new THREE.CylinderGeometry(0.035, 0.045, 0.75, 6), { surf: C.char, matrix: mat(Math.cos(a) * 0.15, 0.1, Math.sin(a) * 0.15, Math.cos(a) * 1.15, 0, -Math.sin(a) * 1.15) });
    }
    const m = this._mesh(b, p.x, p.z, rng.range(0, 6.28), y0);
    if (!burning) return m;
    // 잉걸 (가산 혼합, 깜빡임) + 연기
    const ember = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 5), this.emberMat);
    ember.scale.set(1, 0.32, 1);
    ember.position.set(p.x, y0 + 0.06, p.z);
    ember.renderOrder = 3;
    this.root.add(ember);
    const smoke = [];
    for (let i = 0; i < 5; i++) {
      const sp = new THREE.Sprite(this.smokeMat.clone());
      sp.userData = { t: i / 5, ph: rng.range(0, 6.28) };
      sp.renderOrder = 4;
      this.root.add(sp);
      smoke.push(sp);
    }
    this.fire = { pos: new THREE.Vector3(p.x, y0, p.z), t: 0, smoke };
    return m;
  }

  // -----------------------------------------------------------------
  // 흔적
  // -----------------------------------------------------------------
  _casings(tr) {
    const rng = new RNG(tr.seed);
    const n = tr.n;
    const mesh = new THREE.InstancedMesh(this._casingGeo, this.brass, n);
    const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2), r = rng.range(0, 1.3);
      const x = tr.x + Math.cos(a) * r, z = tr.z + Math.sin(a) * r;
      p.set(x, this.query.getSupportHeight(x, z) + 0.006, z);
      e.set(0, rng.range(0, Math.PI * 2), 0);         // 축(−Z) 이 수평 — 옆으로 누움
      qq.setFromEuler(e);
      m.compose(p, qq, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = 'casings';
    this.root.add(mesh);
  }

  _firepit(tr) {
    this._campfire({ x: tr.x, z: tr.z }, new RNG(tr.seed), false);
  }

  _vines(tr) {
    const rng = new RNG(tr.seed), b = new PartBuilder();
    const n = 3 + (tr.n % 3);
    for (let i = 0; i < n; i++) {
      // 덩굴 토막: 몇 마디로 휜 가는 원기둥, 잘린 끝은 밝은 속살
      const len = rng.range(0.6, 1.5), segs = 4;
      let x = rng.range(-0.8, 0.8), z = rng.range(-0.8, 0.8), a = rng.range(0, Math.PI * 2);
      const r = rng.range(0.012, 0.028);
      for (let k = 0; k < segs; k++) {
        const l = len / segs;
        b.add(new THREE.CylinderGeometry(r, r, l, 5), { surf: C.vine, matrix: mat(x + Math.cos(a) * l / 2, r, z + Math.sin(a) * l / 2, 0, -a, Math.PI / 2) });
        x += Math.cos(a) * l; z += Math.sin(a) * l;
        a += rng.range(-0.5, 0.5);
      }
      b.add(new THREE.CylinderGeometry(r * 1.02, r * 1.02, 0.012, 6), { surf: C.vineCut, matrix: mat(x, r, z, 0, -a, Math.PI / 2) });
      // 시든 잎 두어 장
      for (let k = 0; k < 2; k++) {
        b.add(new THREE.PlaneGeometry(0.09, 0.16), { surf: C.leaf, matrix: mat(x - Math.cos(a) * k * 0.3, 0.012, z - Math.sin(a) * k * 0.3, -Math.PI / 2, 0, rng.range(0, 6)), tint: rng.range(0.7, 1.1) });
      }
    }
    // 마체테로 친 자국: 서 있는 덩굴 그루터기 둘
    for (let i = 0; i < 2; i++) {
      const h = rng.range(0.4, 0.9);
      b.add(new THREE.CylinderGeometry(0.02, 0.025, h, 5), { surf: C.vine, matrix: mat(rng.range(-0.6, 0.6), h / 2, rng.range(-0.6, 0.6), rng.range(-0.2, 0.2), 0, rng.range(-0.2, 0.2)) });
    }
    this._mesh(b, tr.x, tr.z, tr.yaw);
  }

  // -----------------------------------------------------------------
  // 땅에 놓인 총
  // -----------------------------------------------------------------
  /** model 'wood' | 'polymer' — 옆으로 누운 소총. 돌려주는 객체를 removeGroundWeapon 으로 치움 */
  addGroundWeapon(model, x, z, yaw, extra = {}) {
    let g = this._gunGeo[model];
    if (!g) g = this._gunGeo[model] = buildRifle({ model }).geometry;
    const mesh = new THREE.Mesh(g, this.gunMat);
    mesh.position.set(x, this.query.getSupportHeight(x, z) + 0.035, z);
    mesh.rotation.set(0, yaw, Math.PI / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'groundWeapon';
    this.root.add(mesh);
    const gw = { mesh, x, z, model, ...extra };
    this.groundWeapons.push(gw);
    return gw;
  }

  removeGroundWeapon(gw) {
    this.root.remove(gw.mesh);
    const i = this.groundWeapons.indexOf(gw);
    if (i >= 0) this.groundWeapons.splice(i, 1);
  }

  // -----------------------------------------------------------------
  _mesh(b, x, z, yaw, y = null, at = null) {
    const g = b.build();
    for (const k of ['aSurf', 'skinIndex', 'skinWeight']) g.deleteAttribute(k);
    const mesh = new THREE.Mesh(g, this.material);
    const px = at ? at.x : x, pz = at ? at.z : z;
    mesh.position.set(px, y ?? this.query.getTerrainHeight(px, pz), pz);
    mesh.rotation.y = yaw;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    return mesh;
  }
}

/** 연기 스프라이트 (부드러운 원 — 가장자리로 갈수록 투명, 약간 얼룩) */
function smokeTexture() {
  const n = 64, data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n * 2 - 1, v = (j + 0.5) / n * 2 - 1;
      const r = Math.hypot(u, v);
      const blot = 0.75 + 0.25 * Math.sin(u * 7.1 + v * 3.3) * Math.sin(v * 6.2 - u * 2.4);
      const a = Math.max(0, 1 - r) ** 1.6 * blot;
      const k = (j * n + i) * 4;
      data[k] = data[k + 1] = data[k + 2] = 255;
      data[k + 3] = Math.round(a * 255);
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
