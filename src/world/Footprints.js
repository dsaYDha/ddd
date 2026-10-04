// =====================================================================
//  Footprints — 5단계 발자국 (순수 로직). 진흙·젖은 흙(CONFIG.footprints.surfaces)을 밟으면 남는다 — 적·플레이어 모두.
//   life 초에 걸쳐 흐려지고(strength 1 → 0), 비가 오면 × (1 + rainMul × 비 강도) 빨리 사라진다. 개수 상한 cap (오래된 것부터).
//   4단계 수색 중인 적이 플레이어 발자국을 찾으면 따라온다 (Squad 가 near()/newestNear() 로 읽음).
//   화면은 render/FootprintMesh.js 가 list 를 그린다 (가까운 것만).
// =====================================================================
import { CONFIG, SURFACE_KEYS } from '../config.js';

export class Footprints {
  constructor(opts = {}) {
    const F = CONFIG.footprints;
    this.cap = opts.cap ?? F.cap;
    this.list = [];               // { x, y, z, yaw, foot, who, age, strength, depth, id }
    this._surf = new Set(F.surfaces.map((k) => SURFACE_KEYS.indexOf(k)).filter((i) => i >= 0));
    this._id = 0;
    this.version = 0;             // 바뀌면 화면 다시 채움
  }

  /** 이 지면에 발자국이 남나 */
  marks(surface) { return this._surf.has(surface); }

  /**
   * 발자국 하나. who: 'player' | 'enemy'. depth (빠진 깊이 m) 가 클수록 진하게.
   * @returns 만든 발자국 또는 null (안 남는 지면)
   */
  add(x, y, z, yaw, foot, who, surface, opts = {}) {
    if (!this.marks(surface)) return null;
    const p = {
      x, y, z, yaw, foot: foot === 'R' ? 1 : -1, who, age: opts.age ?? 0, strength: 1,
      depth: Math.min(1, 0.45 + (opts.depth ?? 0) * 4), id: ++this._id,
    };
    p.strength = this._strength(p);
    this.list.push(p);
    if (this.list.length > this.cap) this.list.splice(0, this.list.length - this.cap);
    this.version++;
    return p;
  }

  _strength(p) {
    return Math.max(0, 1 - p.age / CONFIG.footprints.life);
  }

  /** HumanMotor 'footstep' 이벤트 → 발자국 (엎드려 기거나 장애물 위면 없음). 발은 몸 중심선에서 좌우로 조금 */
  step(motor, e, who) {
    if (!e || e.onObstacle || e.stance === 'prone' || !this.marks(e.surface)) return null;
    const yaw = motor.yaw, side = e.foot === 'R' ? 1 : -1;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    return this.add(e.x + rx * 0.11 * side, e.y, e.z + rz * 0.11 * side, yaw, e.foot, who, e.surface, { depth: e.sink });
  }

  /** 시간 경과 (rain: 0~1) */
  update(dt, rain = 0) {
    if (!(dt > 0) || !this.list.length) return;
    const F = CONFIG.footprints;
    const k = dt * (1 + F.rainMul * Math.max(0, rain));
    let w = 0, removed = false;
    for (let i = 0; i < this.list.length; i++) {
      const p = this.list[i];
      p.age += k;
      p.strength = this._strength(p);
      if (p.strength > 0) this.list[w++] = p; else removed = true;
    }
    this.list.length = w;
    if (removed) this.version++;
  }

  /** 반경 r 안 (who 가 주어지면 그 사람 것만, minStrength 이상) */
  near(x, z, r, who = null, minStrength = 0.05, out = []) {
    out.length = 0;
    const r2 = r * r;
    for (const p of this.list) {
      if (who && p.who !== who) continue;
      if (p.strength < minStrength) continue;
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz <= r2) out.push(p);
    }
    return out;
  }

  /** 반경 안에서 가장 최근(나이가 가장 적은) 발자국 — 수색하는 적이 발자국을 따라갈 때 */
  newestNear(x, z, r, who = 'player', newerThanId = 0, minStrength = 0.2) {
    let best = null;
    const r2 = r * r;
    for (const p of this.list) {
      if (p.who !== who || p.strength < minStrength || p.id <= newerThanId) continue;
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz > r2) continue;
      if (!best || p.id > best.id) best = p;
    }
    return best;
  }

  clear() {
    this.list.length = 0;
    this.version++;
  }
}
