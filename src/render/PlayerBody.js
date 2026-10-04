// =====================================================================
//  PlayerBody — 6단계 내려다보면 보이는 내 몸 (다리·몸통·군화·탄띠·탄입대·수통 2개, 상처에 감은 붕대·지혈대)
//   판정 캡슐(Hitboxes)과 같은 자세 표 → 서기·앉기·엎드리기·전환이 그대로. 걸으면 다리를 앞뒤로 흔듦 (걸음 위상).
//   눈 아래에서 body.offsetBack m 뒤로 (눈이 몸 앞쪽에 있음). 머리·팔은 그리지 않는다 (1인칭 화면 모델이 팔·총).
//   지오메트리는 (자세, 걸음 칸, 붕대 상태) 키로 캐시 — 같은 모양이면 다시 만들지 않음 (최대 CACHE 개).
// =====================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { buildPlayerGeometry, playerBodyMaterial } from './SoldierMesh.js';

const CACHE = 48;
const SWING_STEPS = 8;

export class PlayerBody {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.material = playerBodyMaterial();
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = 'playerBody';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;   // 바로 위 몸통 그림자에 다리가 새까매지지 않게 (하늘빛만으로도 보이게)
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this._cache = new Map();
    this._key = '';
    this._pose = { x: 0, y: 0, z: 0, yaw: 0, stance: 'stand', stanceFrom: 'stand', stanceProgress: 1, lean: 0, arms: 'rifle', bodyPitch: 0, eyeHeight: 1.65 };
    this.visible = true;
  }

  /**
   * @param {{ motor, yaw: number, pitch: number, wounds: Array, dead?: boolean, bodyPitch?: number }} st
   */
  update(st) {
    const m = st.motor, B = CONFIG.body;
    const show = this.visible && !st.dead && st.pitch * 180 / Math.PI < B.hideAbovePitch;
    this.mesh.visible = show;
    if (!show) return;
    const P = this._pose;
    const prog = Math.round(m.stanceProgress * 12) / 12;
    P.stance = m.stance; P.stanceFrom = prog >= 1 ? m.stance : m.stanceFrom; P.stanceProgress = prog;
    P.lean = Math.round((m.leanOffset ?? 0) / 0.05) * 0.05;
    P.eyeHeight = Math.round(m.eyeHeight / 0.02) * 0.02;
    P.bodyPitch = Math.round((st.bodyPitch ?? 0) / 0.04) * 0.04;
    // 걸음: 서거나 앉아 걸을 때만 다리를 흔듦 (위상 8칸)
    let sw = 0, swK = 0;
    if (m.stance !== 'prone' && (m.moveFactor ?? 0) > 0.15 && prog >= 1) {
      swK = Math.round(((m.gaitPhase % 2) / 2) * SWING_STEPS) % SWING_STEPS;
      const amp = m.gait === 'sprint' ? 0.55 : m.stance === 'crouch' ? 0.28 : 0.38;
      sw = Math.sin((swK / SWING_STEPS) * Math.PI * 2) * amp * Math.min(1, m.moveFactor);
      sw = Math.round(sw / 0.05) * 0.05;
    }
    const dress = (st.wounds ?? []).filter((w) => w.bandaged || w.tourniquet);
    const wk = dress.map((w) => `${w.part}${w.bandaged ? 'b' : ''}${w.tourniquet ? 't' : ''}${w.type === 'graze' ? 'g' : ''}`).join(',');
    const key = `${P.stance}|${P.stanceFrom}|${prog.toFixed(3)}|${P.lean.toFixed(2)}|${P.bodyPitch.toFixed(2)}|${P.eyeHeight.toFixed(2)}|${sw.toFixed(2)}|${wk}`;
    if (key !== this._key) {
      this._key = key;
      let g = this._cache.get(key);
      if (!g) {
        g = buildPlayerGeometry(P, sw, dress);
        this._cache.set(key, g);
        if (this._cache.size > CACHE) {
          const [k0, g0] = this._cache.entries().next().value;
          if (g0 !== this.mesh.geometry) { g0.dispose(); this._cache.delete(k0); }
        }
      }
      this.mesh.geometry = g;
    }
    // 발 위치 · 몸 방향 (시선 yaw) · 눈 아래에서 뒤로
    const yaw = st.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    // 자세별 눈 ↔ 몸 거리 (전환 중엔 섞음) + 내려다볼수록 고개를 숙여 눈이 몸 앞쪽으로 나감 → 군화 끝이 배·탄띠 너머로 보임
    const off = (s) => (s === 'prone' ? B.offsetBackProne : s === 'crouch' ? B.offsetBackCrouch : B.offsetBack);
    const down = Math.max(0, Math.min(1, (-st.pitch - 0.55) / 0.6));
    const neck = m.stance === 'stand' ? 1 : m.stance === 'crouch' ? 0.3 : 0;   // 앉으면 무릎이 이미 앞에 있어 덜 숙임
    const back = off(P.stanceFrom) + (off(P.stance) - off(P.stanceFrom)) * prog + down * B.neckForward * neck;
    this.mesh.position.set(m.position.x - fx * back, m.position.y, m.position.z - fz * back);
    this.mesh.rotation.set(0, yaw, 0);
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    for (const g of this._cache.values()) g.dispose();
    this._cache.clear();
  }
}
