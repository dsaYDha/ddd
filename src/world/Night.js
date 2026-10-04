// =====================================================================
//  Night — 6단계 밤 (순수 로직: three.js·DOM 없음 → Node 테스트 가능)
//   · 빛 수준 (0~1, 낮 = 1): 시간대 낮 빛 비율(시계 todBlend.light) + (1 − 그 비율) × 밤 빛
//       밤 빛 = 달빛(보름 1 · 반달 0.45 · 그믐 0.07) × 트임(캐노피 아래 0.045 → 트인 곳 0.32) + 별빛
//     → 캐노피 아래는 거의 칠흑, 논·강가 같은 트인 곳은 조금 밝다. 적 시야·함정 발견·노출도가 이 값을 쓴다.
//   · DarkAdapt: 암순응 — 어둠 속 시간상수 tau 로 0→1 (30~60초면 거의 다), 밝은 빛을 정면으로 보면 깨짐
//   · Flares: 낙하산 조명탄 — 솟아올라 height m 에서 불이 붙고 fall m/s 로 흔들리며 내려옴 (life 초). lightAt() 로 땅의 빛
//   · lampLight(): 손전등 원뿔 빛 (플레이어·적 손전등)
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';

const DEG = Math.PI / 180;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 달 모양 → 달빛 배율 */
export function moonLight(moon = 'half') {
  return CONFIG.night.moon[moon]?.light ?? CONFIG.night.moon.half.light;
}

/** 밤 빛 (0~1): 달빛 × 트임 + 별빛. canopy = 캐노피 덮임 0~1 */
export function nightAmbient(moon, canopy) {
  const A = CONFIG.night.ambient;
  const c = clamp01(canopy);
  return moonLight(moon) * (A.open + (A.canopy - A.open) * c) + A.star * (1 - 0.8 * c);
}

/** 빛 수준: dayLight = 시계 todBlend().light (낮 빛 비율), 밤에는 달·트임 */
export function ambientLight(dayLight, moon, canopy) {
  const d = clamp01(dayLight);
  return d + (1 - d) * nightAmbient(moon, canopy);
}

/**
 * 손전등 원뿔 빛 (0~1) — lamp: { x, y, z, dx, dy, dz (단위 벡터), range, angle (°), light }
 * 점 (x,y,z) 가 원뿔 안이면 거리·각도에 따라 줄어듦
 */
export function lampLight(lamp, x, y, z) {
  if (!lamp) return 0;
  const vx = x - lamp.x, vy = y - lamp.y, vz = z - lamp.z;
  const d = Math.hypot(vx, vy, vz);
  if (d > lamp.range || d < 1e-4) return d < 1e-4 ? lamp.light : 0;
  const c = (vx * lamp.dx + vy * lamp.dy + vz * lamp.dz) / d;
  const ang = Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
  if (ang > lamp.angle) return 0;
  const edge = 1 - (ang / lamp.angle) ** 2;
  const fall = 1 - (d / lamp.range) ** 2;
  return (lamp.light ?? 1) * edge * fall;
}

// ---------------------------------------------------------------------
// 암순응
// ---------------------------------------------------------------------
export class DarkAdapt {
  constructor() {
    this.level = 0;            // 0~1
    this.time = 0;             // 어둠 속에 있은 시간 (s, 디버그)
  }

  /**
   * @param {number} dt
   * @param {number} sceneLight  지금 보는 장면의 빛 수준 (0~1)
   * @param {number} glare       지금 정면으로 보는 밝은 빛 (0~1: 조명탄 flareLook, 손전등 lampLook …)
   */
  update(dt, sceneLight, glare = 0) {
    const A = CONFIG.night.adapt;
    if (!(dt > 0)) return this.level;
    if (sceneLight < A.darkBelow) {
      this.time += dt;
      this.level += (1 - this.level) * (1 - Math.exp(-dt / A.tau));
    } else {
      // 밝으면 금방 풀림 (밝기에 비례)
      this.time = 0;
      this.level -= this.level * (1 - Math.exp(-dt / 3)) * clamp01((sceneLight - A.darkBelow) * 4 + 0.2);
    }
    if (glare > 0) this.level -= this.level * clamp01(glare) * (1 - Math.exp(-dt / A.loseTau));
    if (this.level < 0) this.level = 0;
    return this.level;
  }

  /** 순간 섬광 (내 총구 화염 등) — 순응도 × (1 − amount) */
  flash(amount) {
    this.level *= 1 - clamp01(amount);
    if (this.level < 0.05) this.time = 0;
  }

  reset() { this.level = 0; this.time = 0; }

  /** 화면 노출 배율 (1 ~ 1 + gain) */
  get exposureMul() { return 1 + CONFIG.night.adapt.gain * this.level; }
}

// ---------------------------------------------------------------------
// 조명탄
// ---------------------------------------------------------------------
export class Flares extends EventEmitter {
  /** @param {{ query?, rng }} opts */
  constructor(opts = {}) {
    super();
    this.query = opts.query ?? null;
    this.rng = opts.rng;
    this.list = [];
    this.time = 0;
    this.launched = 0;
    this._id = 1;
  }

  /**
   * 쏘기: from (쏘는 사람 위치) 에서 toward 쪽으로 30~70m 앞 상공 (없으면 바로 위 근처)
   * @returns flare { id, x, y, z, phase: 'rise'|'burn'|'out', t, life, ... }
   */
  launch(from, toward = null, opts = {}) {
    const F = CONFIG.night.flare, rng = this.rng;
    let ax = from.x, az = from.z;
    if (toward) {
      const dx = toward.x - from.x, dz = toward.z - from.z, dl = Math.hypot(dx, dz) || 1;
      const ahead = Math.min(dl, rng.range(30, 70));
      ax += dx / dl * ahead; az += dz / dl * ahead;
    } else { ax += rng.range(-20, 20); az += rng.range(-20, 20); }
    const gy = this.query ? this.query.getTerrainHeight(ax, az) : 0;
    const f = {
      id: this._id++, from: { x: from.x, y: from.y ?? 0, z: from.z }, apex: { x: ax, y: gy + rng.range(F.height[0], F.height[1]), z: az },
      x: from.x, y: from.y ?? 0, z: from.z, phase: 'rise', t: 0, burn: 0, life: opts.life ?? F.life,
      sway: rng.range(F.sway[0], F.sway[1]), period: rng.range(F.swayPeriod[0], F.swayPeriod[1]), ph: rng.range(0, Math.PI * 2),
      drift: { x: rng.range(-1, 1) * F.drift, z: rng.range(-1, 1) * F.drift }, flick: 1, squad: opts.squad ?? null, ground: gy,
      intensity: 0,
    };
    this.list.push(f);
    this.launched++;
    this.emit('launch', { flare: f });
    return f;
  }

  update(dt) {
    if (!(dt > 0)) return;
    const F = CONFIG.night.flare, rng = this.rng;
    this.time += dt;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const f = this.list[i];
      f.t += dt;
      if (f.phase === 'rise') {
        const k = Math.min(1, f.t / F.riseTime), e = 1 - (1 - k) * (1 - k);
        f.x = f.from.x + (f.apex.x - f.from.x) * k;
        f.z = f.from.z + (f.apex.z - f.from.z) * k;
        f.y = f.from.y + (f.apex.y - f.from.y) * e;
        if (k >= 1) { f.phase = 'burn'; f.burn = 0; this.emit('ignite', { flare: f }); }
        continue;
      }
      if (f.phase === 'burn') {
        f.burn += dt;
        const b = f.burn;
        // 낙하산: 천천히 내려오며 흔들림 (진자) + 바람에 밀림
        const w = (Math.PI * 2) / f.period;
        f.x = f.apex.x + f.drift.x * b + f.sway * Math.sin(w * b + f.ph);
        f.z = f.apex.z + f.drift.z * b + f.sway * 0.6 * Math.sin(w * 2 * b + f.ph * 1.7);
        f.y = f.apex.y - F.fall * b;
        // 깜빡임: 연소가 고르지 않음
        f.flick = 1 + (rng.range(-1, 1) * 0.6 + Math.sin(b * 23 + f.ph) * 0.4) * F.flicker;
        // 켜질 때 0.6초, 꺼질 때 마지막 3초 페이드
        const fadeIn = Math.min(1, b / 0.6), fadeOut = Math.min(1, Math.max(0, (f.life - b) / 3));
        f.intensity = fadeIn * fadeOut * f.flick;
        if (b >= f.life || f.y <= f.ground + 4) { f.phase = 'out'; f.intensity = 0; this.emit('out', { flare: f }); }
        continue;
      }
      // 꺼진 뒤 잠깐 남겨 둠 (연기 흔적용) 후 제거
      if (f.t > f.life + F.riseTime + 6) this.list.splice(i, 1);
    }
  }

  /** 타는 중인 조명탄 */
  get burning() { return this.list.filter((f) => f.phase === 'burn' && f.intensity > 0.01); }

  /** 땅 (x, z) 의 조명탄 빛 (0~1, 가장 밝은 것) — canopy: 캐노피 덮임 (잎이 가림) */
  lightAt(x, z, canopy = 0) {
    const F = CONFIG.night.flare;
    let best = 0;
    for (const f of this.list) {
      if (f.phase !== 'burn' || f.intensity <= 0) continue;
      const h = Math.max(10, f.y - f.ground);
      const range = F.range * Math.max(0.5, Math.min(1.2, h / 140));
      const d = Math.hypot(f.x - x, f.z - z);
      if (d >= range) continue;
      const v = F.light * (1 - (d / range) ** 2) * f.intensity;
      if (v > best) best = v;
    }
    return clamp01(best * (0.25 + 0.75 * (1 - clamp01(canopy))));
  }

  /** 가장 밝게 비추는 조명탄 (점 x,z 기준) — 화면의 방향광으로 씀 */
  brightest(x, z) {
    let best = null, bv = 0;
    for (const f of this.list) {
      if (f.phase !== 'burn' || f.intensity <= 0) continue;
      const v = f.intensity / (1 + (Math.hypot(f.x - x, f.z - z) / 150) ** 2);
      if (v > bv) { bv = v; best = f; }
    }
    return best;
  }

  clear() { this.list.length = 0; }
}
