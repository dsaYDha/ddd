// F8 표적 화면 모델 — 판정 캡슐(Hitboxes.buildHitboxes)과 '같은 캡슐'로 만든 마네킹 + 반쯤 가리는 정글 덤불.
//  · 마네킹: 표적 자세(서기·앉기·엎드리기, 팔 내림)를 발 위치·yaw 0 의 국소 좌표로 buildHitboxes 해서
//    캡슐마다 반구 + 원기둥 메시를 만들어 하나로 합친다 (꼭짓점이 캡슐 표면 위) → 위치·yaw 만 바꿔 그리면
//    판정 캡슐과 정확히 겹친다. 피벗 = 발 (국소 원점).
//    색: 올리브색 상의, 더 어두운 바지, 밝은 머리 + 손·허리띠·장화 띠 (100m 에서도 덩어리 색으로 읽히게 단순하게).
//  · 흔들림: target.wobble {x, z} (rad) — 머리 쪽이 수평 방향 (x, z) 로 |(x, z)| 만큼 기울도록 발을 축으로 돌린다 (화면 표현만).
//  · 걷는 표적: 매 프레임 target.pos / target.yaw 를 따라간다.
//  · 3단계 쓰러짐: pose.fall {ax, az, angle, lift} — Hitboxes 와 같은 회전(발을 축으로 수평축 둘레)을 메시에 건다
//    (판정 캡슐 = 보이는 시체). 자세 전환(넘어짐·주저앉음)은 진행도를 1/12 단위로 끊어 지오메트리를 캐시한다
//    (기어가며 바뀌는 경사 각·눈높이도 끊음 — 매 프레임 지오메트리를 새로 만들지 않게).
//  · 덤불: range.bushes → 월드 덤불 지오메트리(PlantGeometry.buildShrub) + 월드 잎 머티리얼(world.materials.leaves).
//    잎 머티리얼은 월드 식생처럼 InstancedMesh(+ 인스턴스 색)로 그린다: 일반 Mesh 도 그려지지만(aWind 는 지오메트리에 있음)
//    USE_INSTANCING 이 다른 셰이더 변형이라 F8 을 처음 누를 때 셰이더를 새로 컴파일해 끊긴다 → 인스턴싱이면 월드와 같은 프로그램.
import * as THREE from 'three';
import { buildHitboxes } from '../combat/Hitboxes.js';
import { hashFloat } from '../core/rng.js';
import { createFoliageMaterial, patchCanopy } from './Materials.js';
import { buildShrub as defaultBuildShrub } from './PlantGeometry.js';
import { makeLeafAtlas } from './Textures.js';

const RADIAL = 12;          // 캡슐 둘레 분할
const CAP_RINGS = 5;        // 반구 위도 분할
const MAX_TILT = 0.35;      // 흔들림 최대 기울기 (rad) — 이상한 값이 와도 넘어지지 않게
const BUSH_FILL = 1.08;     // 잎 카드 끝이 판정 원기둥보다 안쪽에 있어 조금 크게 (보이는 덤불 ≈ 판정 덤불)

// 색 (sRGB → 선형). 상의는 빛바랜 올리브 — 숲 그늘의 어두운 줄기·덤불 앞에서도 윤곽이 읽히게 바지보다 확실히 밝게
const C = (hex) => new THREE.Color(hex);
const COL = {
  head: C('#b3a47c'), neck: C('#998b69'), hand: C('#8c765e'),
  top: C('#6b7349'), sleeve: C('#646c44'),
  trousers: C('#3a3d28'), belt: C('#2a2619'), boot: C('#211b15'),
};

/** 부위·축 위치(s: 캡슐 a 끝에서 축 방향 거리, L: 축 길이)별 색 */
function partColor(part, s, L, r) {
  switch (part) {
    case 'head': return COL.head;
    case 'neck': return COL.neck;
    case 'upperChest': case 'abdomen': return COL.top;
    case 'upperArmL': case 'upperArmR': return COL.sleeve;
    case 'forearmL': case 'forearmR': return s > L - 0.07 ? COL.hand : COL.sleeve;   // b 끝 = 손
    case 'pelvis': return s > L + r - 0.055 ? COL.belt : COL.trousers;                 // b 끝(위) = 허리띠
    case 'shinL': case 'shinR': return s > L - 0.11 ? COL.boot : COL.trousers;         // b 끝 = 발목·장화
    default: return COL.trousers;                                                       // 골반·대퇴
  }
}

/** 캡슐 하나를 버퍼에 추가: a 쪽 반구 → 원기둥 → b 쪽 반구 (꼭짓점은 정확히 표면 위) */
function addCapsule(buf, cap) {
  const { a, b, r, part } = cap;
  let ax = b.x - a.x, ay = b.y - a.y, az = b.z - a.z;
  const L = Math.hypot(ax, ay, az);
  if (L < 1e-6) { ax = 0; ay = 1; az = 0; } else { ax /= L; ay /= L; az /= L; }
  // 축에 수직인 기저 (u, v, 축) 오른손 → 감는 방향이 바깥을 향함
  let hx = 0, hy = 1, hz = 0;
  if (Math.abs(ay) > 0.9) { hx = 1; hy = 0; }
  let ux = hy * az - hz * ay, uy = hz * ax - hx * az, uz = hx * ay - hy * ax;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ay * uz - az * uy, vy = az * ux - ax * uz, vz = ax * uy - ay * ux;
  const base = buf.pos.length / 3;
  const ring = (cx, cy, cz, phi) => {
    const sp = Math.sin(phi), cp = Math.cos(phi);
    for (let k = 0; k <= RADIAL; k++) {
      const th = (k / RADIAL) * Math.PI * 2;
      const ct = Math.cos(th), st = Math.sin(th);
      const nx = ax * sp + (ux * ct + vx * st) * cp;
      const ny = ay * sp + (uy * ct + vy * st) * cp;
      const nz = az * sp + (uz * ct + vz * st) * cp;
      const px = cx + nx * r, py = cy + ny * r, pz = cz + nz * r;
      buf.pos.push(px, py, pz);
      buf.nor.push(nx, ny, nz);
      const s = (px - a.x) * ax + (py - a.y) * ay + (pz - a.z) * az;
      const c = partColor(part, s, L, r);
      buf.col.push(c.r, c.g, c.b);
    }
  };
  for (let i = 0; i <= CAP_RINGS; i++) ring(a.x, a.y, a.z, -Math.PI / 2 + (i / CAP_RINGS) * (Math.PI / 2));
  for (let i = 0; i <= CAP_RINGS; i++) ring(b.x, b.y, b.z, (i / CAP_RINGS) * (Math.PI / 2));
  const rings = (CAP_RINGS + 1) * 2, row = RADIAL + 1;
  for (let i = 0; i < rings - 1; i++) {
    for (let k = 0; k < RADIAL; k++) {
      const p0 = base + i * row + k, p1 = p0 + 1, p2 = p0 + row + 1, p3 = p0 + row;
      buf.idx.push(p0, p1, p2, p0, p2, p3);
    }
  }
}

/** 국소 자세(발 원점, yaw 0) → 마네킹 지오메트리 + 쓴 캡슐 (검증용) */
export function buildMannequinGeometry(localPose) {
  const caps = buildHitboxes(localPose, []);
  const buf = { pos: [], nor: [], col: [], idx: [] };
  for (const cap of caps) addCapsule(buf, cap);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  g.setIndex(buf.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(buf.idx, 1) : new THREE.Uint16BufferAttribute(buf.idx, 1));
  g.computeBoundingSphere();
  g.userData.capsules = caps;
  return g;
}

/** 표적의 현재 자세 (Person.pose 우선, 없으면 표적 필드) */
function poseOf(t) {
  const p = t.person?.pose ?? (typeof t.person?.getPose === 'function' ? t.person.getPose() : null);
  return p || { x: t.pos?.x ?? 0, y: t.pos?.y ?? 0, z: t.pos?.z ?? 0, yaw: t.yaw ?? 0, stance: t.stance ?? 'stand', arms: 'down' };
}
/** 모양을 바꾸는 자세 값만 (위치·yaw 제외) — 지오메트리 캐시 키 */
const Q = (v, step) => (Number.isFinite(v) ? Math.round(v / step) * step : v);
function quantPose(p) {
  const prog = p.stanceProgress ?? 1;
  return {
    stance: p.stance ?? 'stand', stanceFrom: prog >= 1 ? (p.stance ?? 'stand') : p.stanceFrom, stanceProgress: Q(prog, 1 / 12),
    lean: Q(p.lean || 0, 0.01), arms: p.arms ?? 'rifle', bodyPitch: Q(p.bodyPitch || 0, 0.02), eyeHeight: Q(p.eyeHeight, 0.02),
  };
}
function shapeKey(p) {
  const q = quantPose(p);
  const f = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '');
  return `${q.stance}|${q.stanceFrom ?? ''}|${f(q.stanceProgress, 3)}|${f(q.lean)}|${q.arms}|${f(q.bodyPitch)}|${f(q.eyeHeight)}`;
}
function localPose(p) {
  return { x: 0, y: 0, z: 0, yaw: 0, ...quantPose(p) };
}

const _up = new THREE.Vector3(0, 1, 0);
const _axis = new THREE.Vector3();
const _qTilt = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _qFall = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pv = new THREE.Vector3();
const _sv = new THREE.Vector3();

export class TargetMeshes {
  /**
   * @param {THREE.Scene} scene
   * @param {{ leafMaterial?: THREE.Material, buildShrub?: Function, stemMaterial?: THREE.Material, atlas?: THREE.Texture }} opts
   *   leafMaterial: world.materials.leaves (없으면 잎 아틀라스로 새로 만듦), buildShrub: PG.buildShrub (기본값 같은 함수),
   *   stemMaterial: world.materials.stem (있으면 덤불 줄기도 그림)
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.leafMaterial = opts.leafMaterial ?? null;
    this.stemMaterial = opts.stemMaterial ?? null;
    this.buildShrub = opts.buildShrub ?? defaultBuildShrub;
    this._atlas = opts.atlas ?? null;
    this._ownLeafMaterial = null;
    this.root = new THREE.Group();
    this.root.name = 'targetMeshes';
    scene.add(this.root);
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    patchCanopy(this.material, { sun: 1, sky: 0.7 });   // 숲속에서는 다른 물체처럼 그늘·햇빛 얼룩
    this._geo = new Map();       // 모양 키 → { geometry, users }
    this._items = new Map();     // 표적 → { mesh, key }
    this._bushRefs = [];         // 마지막으로 만든 덤불 목록 (객체 동일성으로 변화 감지)
    this._bushMeshes = [];
    this._shrubGeo = new Map();  // 변형 → { leaves, stem, r0, h0 }
    this.range = null;
  }

  /** range.targets / range.bushes 에 맞춰 메시를 만들고 지움 (F8 배치·제거 뒤 부르면 됨 — update 도 변화를 감지) */
  sync(range) {
    this.range = range ?? null;
    const on = !!range && range.active !== false;
    const targets = on && Array.isArray(range.targets) ? range.targets : [];
    for (const [t, item] of this._items) if (!targets.includes(t)) this._removeItem(t, item);
    for (const t of targets) if (!this._items.has(t)) this._addItem(t);
    this._syncBushes(on && Array.isArray(range.bushes) ? range.bushes : []);
    this._place();
  }

  /** 걷는 표적 위치·방향, 흔들림 기울기 반영 */
  update(dt) {
    const r = this.range;
    if (r && this._changed(r)) this.sync(r);
    else this._place();
  }

  dispose() {
    for (const [t, item] of this._items) this._removeItem(t, item);
    this._clearBushes();
    for (const g of this._shrubGeo.values()) { g.leaves?.dispose(); g.stem?.dispose(); }
    this._shrubGeo.clear();
    this.material.dispose();
    if (this._ownLeafMaterial) { this._ownLeafMaterial.userData.depthMaterial?.dispose(); this._ownLeafMaterial.dispose(); this._ownLeafMaterial.map?.dispose(); }
    this.scene.remove(this.root);
    this.range = null;
  }

  // -------------------------------------------------------------
  _changed(range) {
    const on = range.active !== false;
    const targets = on && Array.isArray(range.targets) ? range.targets : null;
    const n = targets ? targets.length : 0;
    if (n !== this._items.size) return true;
    for (let i = 0; i < n; i++) if (!this._items.has(targets[i])) return true;
    const bushes = on && Array.isArray(range.bushes) ? range.bushes : null;
    const m = bushes ? bushes.length : 0;
    if (m !== this._bushRefs.length) return true;
    for (let i = 0; i < m; i++) if (bushes[i] !== this._bushRefs[i]) return true;
    return false;
  }

  _acquireGeometry(pose) {
    const key = shapeKey(pose);
    let e = this._geo.get(key);
    if (!e) { e = { geometry: buildMannequinGeometry(localPose(pose)), users: 0 }; this._geo.set(key, e); }
    e.users++;
    return { key, geometry: e.geometry };
  }

  _releaseGeometry(key) {
    const e = this._geo.get(key);
    if (!e) return;
    if (--e.users <= 0) { e.geometry.dispose(); this._geo.delete(key); }
  }

  _addItem(t) {
    const { key, geometry } = this._acquireGeometry(poseOf(t));
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = 'targetMannequin';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    this._items.set(t, { mesh, key });
  }

  _removeItem(t, item) {
    this.root.remove(item.mesh);
    this._releaseGeometry(item.key);
    this._items.delete(t);
  }

  _place() {
    for (const [t, item] of this._items) {
      const pose = poseOf(t);
      const key = shapeKey(pose);
      if (key !== item.key) {
        // 자세가 바뀜 (표적 자세 변경) → 그 모양으로 교체
        const next = this._acquireGeometry(pose);
        this._releaseGeometry(item.key);
        item.key = next.key;
        item.mesh.geometry = next.geometry;
      }
      const x = t.pos?.x ?? pose.x ?? 0, y = t.pos?.y ?? pose.y ?? 0, z = t.pos?.z ?? pose.z ?? 0;
      const yaw = Number.isFinite(t.yaw) ? t.yaw : (pose.yaw || 0);
      _qYaw.setFromAxisAngle(_up, yaw);
      const wx = t.wobble?.x || 0, wz = t.wobble?.z || 0;
      const ang = Math.hypot(wx, wz);
      if (ang > 1e-6) {
        // 머리가 (wx, wz) 쪽으로 기울도록: 축 = 위 × 기울 방향 = (wz, 0, -wx)
        _axis.set(wz / ang, 0, -wx / ang);
        _qTilt.setFromAxisAngle(_axis, Math.min(MAX_TILT, ang));
        item.mesh.quaternion.multiplyQuaternions(_qTilt, _qYaw);
      } else item.mesh.quaternion.copy(_qYaw);
      let lift = 0;
      const fall = pose.fall;
      if (fall && fall.angle) {
        // Hitboxes 와 같은 쓰러짐 회전: yaw(·흔들림) 다음에 발을 축으로 (ax, 0, az) 둘레 angle
        const kl = Math.hypot(fall.ax, fall.az) || 1;
        _axis.set(fall.ax / kl, 0, fall.az / kl);
        _qFall.setFromAxisAngle(_axis, fall.angle);
        item.mesh.quaternion.premultiply(_qFall);
        lift = fall.lift || 0;
      }
      item.mesh.position.set(x, y + lift, z);
    }
  }

  // -------------------------------------------------------------
  // 덤불
  // -------------------------------------------------------------
  _leafMat() {
    if (this.leafMaterial) return this.leafMaterial;
    if (!this._ownLeafMaterial) this._ownLeafMaterial = createFoliageMaterial(this._atlas ?? makeLeafAtlas(), { translucency: 1, sky: 0.6 });
    return this._ownLeafMaterial;
  }

  _shrub(variant) {
    let g = this._shrubGeo.get(variant);
    if (!g) {
      const geo = this.buildShrub(variant, 0);
      const bb = geo.leaves.boundingBox ?? (geo.leaves.computeBoundingBox(), geo.leaves.boundingBox);
      // 판정 원기둥(반경 r, 높이 height)에 맞출 기준 크기: 잎 덩어리의 수평 반경·꼭대기 높이
      const r0 = Math.max(0.2, Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z));
      const h0 = Math.max(0.3, bb.max.y);
      g = { leaves: geo.leaves, stem: geo.stem ?? null, r0, h0 };
      this._shrubGeo.set(variant, g);
    }
    return g;
  }

  _clearBushes() {
    for (const m of this._bushMeshes) { this.root.remove(m); m.dispose(); }
    this._bushMeshes.length = 0;
    this._bushRefs.length = 0;
  }

  _syncBushes(bushes) {
    let same = bushes.length === this._bushRefs.length;
    for (let i = 0; same && i < bushes.length; i++) same = bushes[i] === this._bushRefs[i];
    if (same) return;
    this._clearBushes();
    for (const b of bushes) this._bushRefs.push(b);
    if (!bushes.length) return;
    // 덤불 하나 = 변형이 다른 덤불 두 개를 돌려 겹침 (월드 덤불 하나보다 빽빽해야 '반쯤 가림'이 읽힘)
    const inst = new Map();   // 변형 → [{ b, rot, k }]
    bushes.forEach((b, i) => {
      const h = hashFloat(Math.round(b.x * 10), Math.round(b.z * 10), 9);
      const v1 = Math.floor(h * 3) % 3, v2 = (v1 + 1) % 3;
      const rot = h * Math.PI * 2;
      for (const [v, dr, k] of [[v1, 0, 1], [v2, 1.9, 0.86]]) {
        if (!inst.has(v)) inst.set(v, []);
        inst.get(v).push({ b, rot: rot + dr, k, h: hashFloat(i, v, 17) });
      }
    });
    const leafMat = this._leafMat();
    for (const [v, list] of inst) {
      const g = this._shrub(v);
      const parts = [[g.leaves, leafMat]];
      if (g.stem && this.stemMaterial) parts.push([g.stem, this.stemMaterial]);
      for (const [geometry, material] of parts) {
        const mesh = new THREE.InstancedMesh(geometry, material, list.length);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
        list.forEach((e, i) => {
          const { b } = e;
          const sxz = ((b.r ?? 0.7) / g.r0) * e.k * BUSH_FILL;
          const sy = ((b.height ?? 1.2) / g.h0) * (0.92 + 0.08 * e.k);
          _pv.set(b.x, b.y ?? 0, b.z);
          _q.setFromAxisAngle(_up, e.rot);
          _sv.set(sxz, sy, sxz);
          mesh.setMatrixAt(i, _m.compose(_pv, _q, _sv));
          // 월드 덤불과 같은 계열의 녹색 틴트
          const k = 0.84 + 0.28 * e.h;
          mesh.instanceColor.setXYZ(i, k * (0.96 + 0.12 * (1 - e.h)), k, k * (0.9 + 0.1 * e.h));
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.castShadow = false;      // 월드 덤불과 같게 (그림자 대신 캐노피 얼룩)
        mesh.receiveShadow = true;    // 월드 근거리 덤불과 같은 셰이더 변형
        if (material.userData?.depthMaterial) mesh.customDepthMaterial = material.userData.depthMaterial;
        mesh.name = 'targetBush';
        this.root.add(mesh);
        this._bushMeshes.push(mesh);
      }
    }
  }
}
