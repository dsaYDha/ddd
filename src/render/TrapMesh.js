// =====================================================================
//  TrapMeshes — 6단계 함정 화면 모델 (절차 생성, 파일 없음). Traps.TrapField 상태를 그린다.
//   · 인계철선: 길 양쪽 말뚝 + 발목 높이 가는 철선 (금속 — 가까이서 빛을 받으면 반짝임) + 한쪽 말뚝에 묶은 수류탄형 폭약.
//     알아채면 철선이 조금 굵게 보임 (눈에 들어옴). 해제하면 끊긴 철선이 늘어지고, 터지면 말뚝·폭약이 사라짐 (그을린 자국은 CombatFX).
//   · 꼬챙이 구덩이: 덮개 = 주변보다 살짝 볼록하고 덜 시든 잎을 덮은 '부자연스러운' 낙엽 더미 + 잔가지.
//     빠지면 덮개가 무너지고 어두운 구멍 + 대나무 꼬챙이 끝이 드러남.
//   · 매설 지뢰: 새로 파서 덮은 짙은 흙 (둘레보다 축축하고 붉음) + 흙 사이로 아주 작은 금속 뿔. 터지면 사라짐.
//   · 적의 표시: 묶은 풀 (풀잎을 모아 꼭대기를 묶음) · 꺾은 가지 · 땅에 엇갈려 놓은 막대.
//  고어 없음. 재질은 정점색 + 캐노피 그늘 패치 (월드와 같은 빛).
// =====================================================================
import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { CONFIG } from '../config.js';
import { PartBuilder, mat } from './WeaponModel.js';
import { patchCanopy, patchWetness } from './Materials.js';

const S = {
  stake: { kind: 0, color: 0x6a5536, rough: 0.9, metal: 0 },
  stakeCut: { kind: 0, color: 0xb59b6a, rough: 0.9, metal: 0 },
  grenade: { kind: 0, color: 0x3f4428, rough: 0.6, metal: 0.2 },
  fuse: { kind: 0, color: 0x5a5a52, rough: 0.5, metal: 0.6 },
  tape: { kind: 0, color: 0x2a2a24, rough: 0.8, metal: 0 },
  litter: { kind: 0, color: 0x5b4428, rough: 1, metal: 0 },
  leafDead: { kind: 0, color: 0x7a5a30, rough: 0.9, metal: 0 },
  leafFresh: { kind: 0, color: 0x52632c, rough: 0.85, metal: 0 },
  twig: { kind: 0, color: 0x4a3a26, rough: 0.9, metal: 0 },
  hole: { kind: 0, color: 0x0d0b08, rough: 1, metal: 0 },
  holeWall: { kind: 0, color: 0x2a1f15, rough: 1, metal: 0 },
  spike: { kind: 0, color: 0x9a8a5a, rough: 0.8, metal: 0 },
  freshDirt: { kind: 0, color: 0x5e4630, rough: 1, metal: 0 },   // 둘레 흙보다 조금 짙고 붉게 (너무 어두우면 멀리서도 검은 얼룩으로 보임)
  prong: { kind: 0, color: 0x4a4a42, rough: 0.5, metal: 0.7 },
  grass: { kind: 0, color: 0x6b7a38, rough: 0.9, metal: 0 },
  grassDry: { kind: 0, color: 0x9a8a50, rough: 0.9, metal: 0 },
  branch: { kind: 0, color: 0x4d3c28, rough: 0.9, metal: 0 },
  branchIn: { kind: 0, color: 0xb8a172, rough: 0.9, metal: 0 },
};
const UP = new THREE.Vector3(0, 1, 0);

export class TrapMeshes {
  /** @param {THREE.Scene} scene  @param {import('../world/WorldQuery.js').WorldQuery} query */
  constructor(scene, query) {
    this.scene = scene;
    this.query = query;
    this.root = new THREE.Group();
    this.root.name = 'traps';
    scene.add(this.root);
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
    patchCanopy(this.material, { sun: 1, sky: 0.7 });
    patchWetness(this.material, 0.7);
    // 철선: 금속 — 빛을 받으면 반짝 (가는 원기둥, 길이 1 을 늘려 씀)
    this.wireMat = new THREE.MeshStandardMaterial({ color: 0x6d6e66, roughness: 0.22, metalness: 0.9 });
    patchCanopy(this.wireMat, { sun: 1, sky: 0.6 });
    this.wireGeo = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true).rotateX(Math.PI / 2);   // 축 +Z, 반경 1, 길이 1
    this._items = new Map();
    this._ver = -1;
    this.showAll = false;        // 디버그: 함정 자리 표시 (F10)
    this._dbgMat = new THREE.MeshBasicMaterial({ color: 0xff3020, transparent: true, opacity: 0.55, depthTest: false, fog: false });
    this._dbgGeo = new THREE.ConeGeometry(0.25, 0.6, 8).rotateX(Math.PI);
  }

  clear() {
    for (const it of this._items.values()) this._dispose(it);
    this._items.clear();
    this._ver = -1;
  }

  /** TrapField 와 맞춤 (상태가 바뀌었을 때만) + 먼 함정은 숨김 */
  update(field, camera) {
    if (!field) return;
    if (field.version !== this._ver) {
      this._ver = field.version;
      const live = new Set(field.list);
      for (const [t, it] of this._items) if (!live.has(t)) { this._dispose(it); this._items.delete(t); }
      for (const t of field.list) {
        let it = this._items.get(t);
        if (!it) { it = this._build(t); this._items.set(t, it); }
        this._apply(t, it);
      }
    }
    const cp = camera.position;
    for (const [t, it] of this._items) {
      const d2 = (t.x - cp.x) ** 2 + (t.z - cp.z) ** 2;
      it.group.visible = d2 < 70 * 70;
      if (it.dbg) it.dbg.visible = this.showAll && t.state !== 'exploded' && t.state !== 'disarmed';
    }
  }

  // -----------------------------------------------------------------
  _build(t) {
    const q = this.query, rng = new RNG(t.seed ?? t.id * 977);
    const group = new THREE.Group();
    group.name = `trap_${t.kind}_${t.id}`;
    const y0 = q.getTerrainHeight(t.x, t.z);
    group.position.set(t.x, y0, t.z);
    this.root.add(group);
    const it = { group, parts: {} };
    const add = (b, key, x = 0, z = 0, yaw = 0, y = null) => {
      const mesh = new THREE.Mesh(b.build(), this.material);
      const gy = y ?? (q.getTerrainHeight(t.x + x, t.z + z) - y0);
      mesh.position.set(x, gy, z);
      mesh.rotation.y = yaw;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      it.parts[key] = mesh;
      return mesh;
    };
    if (t.kind === 'tripwire') {
      // 말뚝 두 개 (깎은 끝이 위로 — 철선을 감는 홈)
      for (const [key, p] of [['stakeA', t.a], ['stakeB', t.b]]) {
        const b = new PartBuilder();
        const h = rng.range(0.32, 0.42), lean = rng.range(-0.15, 0.15);
        b.add(new THREE.CylinderGeometry(0.012, 0.018, h, 6), { surf: S.stake, matrix: mat(0, h / 2 - 0.08, 0, lean, 0, rng.range(-0.1, 0.1)) });
        b.add(new THREE.ConeGeometry(0.012, 0.03, 6), { surf: S.stakeCut, matrix: mat(0, h - 0.08 + 0.015, 0, lean, 0, 0) });
        add(b, key, p.x - t.x, p.z - t.z, rng.range(0, 6));
      }
      // 폭약: a 쪽 말뚝에 묶은 수류탄 (몸통 + 신관 + 테이프)
      {
        const b = new PartBuilder();
        const gy = t.charge.y - y0;
        b.add(new THREE.SphereGeometry(0.034, 10, 8).scale(1, 1.35, 1), { surf: S.grenade, matrix: mat(0, 0, 0) });
        b.add(new THREE.CylinderGeometry(0.012, 0.014, 0.035, 8), { surf: S.fuse, matrix: mat(0, 0.058, 0) });
        b.add(new THREE.BoxGeometry(0.008, 0.05, 0.016), { surf: S.fuse, matrix: mat(0.016, 0.045, 0, 0, 0, -0.35) });
        b.add(new THREE.CylinderGeometry(0.037, 0.037, 0.012, 10), { surf: S.tape, matrix: mat(0, -0.01, 0) });
        const mesh = add(b, 'charge', t.charge.x - t.x, t.charge.z - t.z, 0, gy);
        mesh.rotation.z = rng.range(-0.3, 0.3);
      }
      // 철선 (말뚝 사이, 발목 높이)
      const wire = new THREE.Mesh(this.wireGeo, this.wireMat);
      wire.castShadow = false;
      group.add(wire);
      it.parts.wire = wire;
      this._placeWire(t, wire, y0, 1);
      // 끊긴 철선 (해제 뒤): 말뚝에서 늘어진 두 토막
      const cutA = new THREE.Mesh(this.wireGeo, this.wireMat), cutB = new THREE.Mesh(this.wireGeo, this.wireMat);
      for (const [m, p, toward] of [[cutA, t.a, t.b], [cutB, t.b, t.a]]) {
        const gx = p.x - t.x, gz = p.z - t.z;
        const gy = q.getTerrainHeight(p.x, p.z) - y0;
        const dx = toward.x - p.x, dz = toward.z - p.z, dl = Math.hypot(dx, dz) || 1;
        const L = 0.45;
        const start = new THREE.Vector3(gx, gy + CONFIG.traps.tripwire.height, gz);
        const end = new THREE.Vector3(gx + dx / dl * L * 0.8, gy + 0.01, gz + dz / dl * L * 0.8);
        group.add(m);
        m.position.copy(start).add(end).multiplyScalar(0.5);
        m.lookAt(end.clone().add(group.position));
        m.scale.set(0.0012, 0.0012, start.distanceTo(end));
        m.visible = false;
      }
      it.parts.cutA = cutA; it.parts.cutB = cutB;
    } else if (t.kind === 'spikePit') {
      const R = t.r;
      // 덮개: 살짝 볼록한 낙엽 더미 (덜 시든 잎·잔가지 — 둘레와 다름)
      {
        const b = new PartBuilder();
        b.add(new THREE.SphereGeometry(1, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(R + 0.12, 0.07, R + 0.12), { surf: S.litter, matrix: mat(0, -0.02, 0) });
        for (let i = 0; i < 26; i++) {
          const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.range(0, 1)) * (R + 0.1);
          const h = 0.05 * (1 - (r / (R + 0.12)) ** 2) - 0.012;
          b.add(new THREE.PlaneGeometry(rng.range(0.08, 0.14), rng.range(0.14, 0.24)), {
            surf: rng.chance(0.45) ? S.leafFresh : S.leafDead, tint: rng.range(0.75, 1.15),
            matrix: mat(Math.cos(a) * r, h + 0.004 * i / 26, Math.sin(a) * r, -Math.PI / 2 + rng.range(-0.25, 0.25), rng.range(-0.25, 0.25), rng.range(0, 6.3)),
          });
        }
        for (let i = 0; i < 4; i++) {
          const a = rng.range(0, Math.PI * 2), l = rng.range(0.4, 0.8);
          b.add(new THREE.CylinderGeometry(0.006, 0.008, l, 5), { surf: S.twig, matrix: mat(Math.cos(a) * 0.15, 0.04, Math.sin(a) * 0.15, 0, a, Math.PI / 2 + rng.range(-0.1, 0.1)) });
        }
        add(b, 'cover', 0, 0, rng.range(0, 6), 0);
      }
      // 열린 구덩이 (빠진 뒤): 어두운 구멍 + 안쪽 벽 + 꼬챙이 끝 + 무너진 잔가지·잎
      {
        const b = new PartBuilder();
        b.add(new THREE.CircleGeometry(R, 18).rotateX(-Math.PI / 2), { surf: S.hole, matrix: mat(0, 0.012, 0) });
        b.add(new THREE.CylinderGeometry(R, R * 0.92, 0.1, 18, 1, true), { surf: S.holeWall, matrix: mat(0, -0.03, 0), tint: 0.7 });
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * Math.PI * 2 + rng.range(-0.2, 0.2), r = rng.range(0.05, R * 0.7);
          b.add(new THREE.ConeGeometry(0.012, rng.range(0.1, 0.16), 5), { surf: S.spike, matrix: mat(Math.cos(a) * r, 0.03, Math.sin(a) * r, rng.range(-0.15, 0.15), 0, rng.range(-0.15, 0.15)) });
        }
        for (let i = 0; i < 10; i++) {
          const a = rng.range(0, Math.PI * 2), r = R + rng.range(0.02, 0.35);
          b.add(new THREE.PlaneGeometry(rng.range(0.08, 0.14), rng.range(0.14, 0.22)), { surf: rng.chance(0.5) ? S.leafFresh : S.leafDead, tint: rng.range(0.7, 1.1), matrix: mat(Math.cos(a) * r, 0.015, Math.sin(a) * r, -Math.PI / 2, 0, rng.range(0, 6.3)) });
        }
        for (let i = 0; i < 5; i++) {
          const a = rng.range(0, Math.PI * 2), l = rng.range(0.25, 0.5);
          b.add(new THREE.CylinderGeometry(0.006, 0.008, l, 5), { surf: S.twig, matrix: mat(Math.cos(a) * (R + 0.15), 0.02, Math.sin(a) * (R + 0.15), 0, a + 1.2, Math.PI / 2) });
        }
        const m = add(b, 'open', 0, 0, 0, 0.0);
        m.visible = false;
      }
    } else if (t.kind === 'mine') {
      // 새로 판 흙 (짙고 축축) + 작은 금속 뿔 두어 개
      const b = new PartBuilder();
      b.add(new THREE.SphereGeometry(1, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2).scale(t.r + 0.08, 0.025, t.r + 0.05), { surf: S.freshDirt, matrix: mat(0, -0.006, 0) });
      for (let i = 0; i < 7; i++) {
        const a = rng.range(0, Math.PI * 2), r = rng.range(0.05, t.r);
        b.add(new THREE.DodecahedronGeometry(rng.range(0.012, 0.025), 0), { surf: S.freshDirt, tint: rng.range(0.8, 1.3), matrix: mat(Math.cos(a) * r, 0.015, Math.sin(a) * r, rng.range(0, 3), rng.range(0, 3), 0) });
      }
      for (let i = 0; i < 2; i++) {
        b.add(new THREE.CylinderGeometry(0.0025, 0.003, 0.03, 4), { surf: S.prong, matrix: mat(rng.range(-0.04, 0.04), 0.03, rng.range(-0.04, 0.04), rng.range(-0.2, 0.2), 0, rng.range(-0.2, 0.2)) });
      }
      // 덮은 낙엽 몇 장 (잘 덮지 못함)
      for (let i = 0; i < 5; i++) {
        const a = rng.range(0, Math.PI * 2), r = rng.range(0, t.r + 0.1);
        b.add(new THREE.PlaneGeometry(rng.range(0.07, 0.12), rng.range(0.12, 0.2)), { surf: S.leafDead, tint: rng.range(0.7, 1.1), matrix: mat(Math.cos(a) * r, 0.028, Math.sin(a) * r, -Math.PI / 2, 0, rng.range(0, 6.3)) });
      }
      add(b, 'patch', 0, 0, rng.range(0, 6), 0);
    }
    // 적의 표시
    if (t.marker) this._marker(t, it, group, y0, rng);
    // 디버그 표시 (F10: 함정 자리)
    const dbg = new THREE.Mesh(this._dbgGeo, this._dbgMat);
    dbg.position.set(0, 1.4, 0);
    dbg.renderOrder = 30;
    dbg.visible = false;
    group.add(dbg);
    it.dbg = dbg;
    return it;
  }

  _marker(t, it, group, y0, rng) {
    const m = t.marker, q = this.query;
    const b = new PartBuilder();
    if (m.kind === 'grass') {
      // 풀잎 여러 장을 모아 꼭대기를 묶음 (작은 천막 모양)
      const top = new THREE.Vector3(0, rng.range(0.3, 0.42), 0);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2 + rng.range(-0.2, 0.2), r = rng.range(0.1, 0.17);
        const base = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
        const dir = top.clone().sub(base), L = dir.length();
        const m4 = new THREE.Matrix4().lookAt(base, top, UP);
        const q4 = new THREE.Quaternion().setFromRotationMatrix(m4);
        const mid = base.clone().add(top).multiplyScalar(0.5);
        const g = new THREE.BoxGeometry(0.012, 0.002, L).applyQuaternion(q4).translate(mid.x, mid.y, mid.z);
        b.add(g, { surf: rng.chance(0.4) ? S.grassDry : S.grass, tint: rng.range(0.8, 1.15) });
        // 묶은 위로 삐죽 나온 끝
        const tip = top.clone().add(dir.clone().normalize().multiplyScalar(0.06));
        const g2 = new THREE.BoxGeometry(0.01, 0.002, 0.06).applyQuaternion(q4).translate((top.x + tip.x) / 2, (top.y + tip.y) / 2, (top.z + tip.z) / 2);
        b.add(g2, { surf: S.grass });
      }
      b.add(new THREE.TorusGeometry(0.018, 0.006, 4, 8).rotateX(Math.PI / 2), { surf: S.grassDry, matrix: mat(0, top.y - 0.02, 0) });
    } else if (m.kind === 'branch') {
      // 땅에 꽂은 가지 — 위쪽을 꺾어 접음 (속살이 보임)
      const h = rng.range(0.45, 0.6);
      b.add(new THREE.CylinderGeometry(0.01, 0.014, h, 6), { surf: S.branch, matrix: mat(0, h / 2, 0, rng.range(-0.1, 0.1), 0, 0) });
      b.add(new THREE.CylinderGeometry(0.008, 0.01, 0.3, 6), { surf: S.branch, matrix: mat(0.11, h - 0.06, 0, 0, 0, -2.2) });
      b.add(new THREE.CylinderGeometry(0.0105, 0.0105, 0.012, 6), { surf: S.branchIn, matrix: mat(0, h + 0.004, 0) });
      for (let i = 0; i < 3; i++) b.add(new THREE.PlaneGeometry(0.06, 0.12), { surf: S.leafFresh, tint: 0.8, matrix: mat(0.18 + i * 0.05, h - 0.12 - i * 0.03, 0, 0.4, 0, 0.3 * i) });
    } else {
      // 막대 둘을 엇갈려 땅에 놓음
      for (const a of [0.6, -0.6]) b.add(new THREE.CylinderGeometry(0.008, 0.01, 0.45, 5), { surf: S.branch, matrix: mat(0, 0.012, 0, 0, a, Math.PI / 2) });
      b.add(new THREE.CylinderGeometry(0.007, 0.009, 0.3, 5), { surf: S.branch, matrix: mat(0.12, 0.02, 0.0, 0, 0, Math.PI / 2) });
    }
    const mesh = new THREE.Mesh(b.build(), this.material);
    mesh.position.set(m.x - t.x, q.getTerrainHeight(m.x, m.z) - y0, m.z - t.z);
    mesh.rotation.y = m.yaw ?? 0;
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    it.parts.marker = mesh;
  }

  /** 철선 (a → b, 발목 높이) — k 배 굵기 */
  _placeWire(t, wire, y0, k) {
    const q = this.query, H = CONFIG.traps.tripwire.height;
    const ya = q.getTerrainHeight(t.a.x, t.a.z) + H - y0, yb = q.getTerrainHeight(t.b.x, t.b.z) + H - y0;
    const a = new THREE.Vector3(t.a.x - t.x, ya, t.a.z - t.z), b = new THREE.Vector3(t.b.x - t.x, yb, t.b.z - t.z);
    wire.position.copy(a).add(b).multiplyScalar(0.5);
    const target = b.clone().add(wire.parent ? wire.parent.position : new THREE.Vector3());
    wire.lookAt(target);
    const r = 0.0012 * k;
    wire.scale.set(r, r, a.distanceTo(b));
  }

  _apply(t, it) {
    const P = it.parts;
    if (t.kind === 'tripwire') {
      const live = t.state === 'armed' || t.state === 'fuse';
      P.wire.visible = live;
      if (live) this._placeWire(t, P.wire, it.group.position.y, t.known ? 2.4 : 1);
      P.cutA.visible = P.cutB.visible = t.state === 'disarmed';
      const blown = t.state === 'exploded';
      P.charge.visible = !blown;
      P.stakeA.visible = !blown;
      P.stakeB.visible = !blown;
    } else if (t.kind === 'spikePit') {
      const open = t.state === 'sprung';
      P.cover.visible = !open;
      P.open.visible = open;
    } else if (t.kind === 'mine') {
      P.patch.visible = t.state !== 'exploded';
    }
    if (P.marker) P.marker.visible = true;
  }

  _dispose(it) {
    this.root.remove(it.group);
    it.group.traverse((o) => { if (o.isMesh && o.geometry !== this.wireGeo && o.geometry !== this._dbgGeo) o.geometry.dispose(); });
  }
}
