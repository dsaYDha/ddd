// =====================================================================
//  Perception — 적 병사 한 명의 감지 (순수 로직)
//  시각: 바로 발견하지 않는다. 내부 '발견 수치'(0~1+)가 시간에 따라 쌓여 1 에 닿으면 발견 (화면에 표시 안 함).
//   속도 = baseRate × 거리 배율 (refDistance/d)^distanceExp × 노출도(1단계: 자세·식생·빛·움직임)
//          × 시야 투과율 (raycastWorld 'vision' — visionBlock·체적형 식생·캐노피) × 움직임 (1 + motionMul × 속도비)
//          × 주변시 (중앙 60° 밖이면 peripheralMul) × 상태 (순찰 < 경계 < 교전) × 개인차 × (1 − 제압 감쇠)
//   시야각 120° 밖·사거리 밖·투과율 visibleMin 미만이면 0. 안 보이면 decay 로 줄어듦.
//   투과율은 비싼 레이캐스트라 EnemyManager 가 프레임당 예산 안에서 병사들을 돌아가며 갱신한다 (그 사이에는 마지막 값).
//   총구 화염: 플레이어가 쏠 때 시야 안이고 조금이라도 보이면 즉시 1 (위치 정확히).
//   6단계 밤: 노출도에 빛 수준이 이미 들어 있고 (Exposure), 노출도 하한도 빛 수준만큼 낮아진다 (칠흑 속 사람은 거의 안 보임).
//   플레이어 손전등은 info.lampRate 로 더해진다 (빛 자체가 보임 — 100m 밖에서도).
//  청각: 들은 소리로는 대략적인 위치만 — 오차 = 거리 × errorFrac (평균), 방향은 무작위.
//   총성은 거리/음속 뒤에 들리고, 직전 crackWindow 초 안에 근접 탄('딱')을 들었으면 방향을 크게 헷갈린다
//   (각도 오차 crackAngleDeg, 거리 오차 crackDistFrac).
//  7단계: 표적이 여럿 (적 → 플레이어 + 아군 분대원, 아군 → 적 병사들) — 시각 상태(발견 수치·투과율·거리·보임)는 표적마다 '추적'(Track)에
//   따로 두고, 소리·'딱'·경계 수준·개인차는 병사 하나에 하나. meter·seen·distance 같은 읽기/쓰기는 지금 '주목'하는 추적(focus)을 가리킨다
//   (표적이 플레이어 하나뿐이면 4~6단계와 똑같다 — 첫 표적은 기본 추적을 그대로 물려받음).
// =====================================================================
import { CONFIG } from '../config.js';

const DEG = Math.PI / 180;

/** 시각 감지 속도 (/s). p: { distance, exposure, visibility, speed, angleDeg, state, sharpness, suppression } */
export function detectionRate(p) {
  const V = CONFIG.ai.vision;
  const half = V.fovDeg / 2;
  if (!(p.visibility >= V.visibleMin) || p.distance > V.range) return 0;
  if (p.angleDeg > half && p.distance > V.nearDistance) return 0;
  const d = Math.max(p.distance, V.nearDistance);
  const distMul = Math.min(V.maxDistanceMul, Math.pow(V.refDistance / d, V.distanceExp));
  // 6단계: 밤에는 하한도 빛 수준만큼 (ambient 1 = 낮 그대로, 0.025 이하면 ×0.1)
  const floor = V.exposureFloor * Math.min(1, Math.max(0.1, (p.ambient ?? 1) * 4));
  const exposure = Math.max(floor, p.exposure ?? 0.5);
  const motion = 1 + V.motionMul * Math.min(1, Math.max(0, (p.speed ?? 0) / V.motionFullSpeed));
  const periph = p.angleDeg > V.centralDeg / 2 ? V.peripheralMul : 1;
  const stateMul = V.stateMul[p.state] ?? 1;
  const dull = 1 - V.suppressionDull * Math.min(1, Math.max(0, (p.suppression ?? 0) / 100));
  return V.baseRate * distMul * exposure * p.visibility * motion * periph * stateMul * (p.sharpness ?? 1) * (p.alertMul ?? 1) * dull;
}

/**
 * 들은 소리의 추정 위치. 오차 크기 = 거리 × errorFrac × U(0.5, 1.5) (평균 errorFrac), 방향 무작위.
 * crack 이면 (근접 탄 직후의 총성) 듣는 사람 기준 방향을 ±crackAngleDeg 안에서 비틀고 거리도 ±crackDistFrac.
 */
export function estimateSound(src, listener, rng, crack = false) {
  const H = CONFIG.ai.hearing;
  const dx = src.x - listener.x, dz = src.z - listener.z;
  const d = Math.hypot(dx, dz);
  if (crack && d > 1) {
    const ang = Math.atan2(dz, dx) + rng.range(-H.crackAngleDeg, H.crackAngleDeg) * DEG;
    const dd = d * (1 + rng.range(-H.crackDistFrac, H.crackDistFrac));
    return { x: listener.x + Math.cos(ang) * dd, z: listener.z + Math.sin(ang) * dd, error: 0, distance: d, crack: true };
  }
  const err = d * H.errorFrac * rng.range(0.5, 1.5);
  const a = rng.range(0, Math.PI * 2);
  const x = src.x + Math.cos(a) * err, z = src.z + Math.sin(a) * err;
  return { x, z, error: err, distance: d, crack: false };
}

/** 7단계: 표적 하나에 대한 시각 상태 */
export class Track {
  constructor(target = null) {
    this.target = target;
    this.meter = 0;               // 발견 수치 (1 이상 = 발견)
    this.visibility = 0;          // 마지막 레이캐스트 투과율 (0~1)
    this.visibilityAge = Infinity;
    this.inView = false;          // 시야각·사거리 안
    this.angleDeg = 180;
    this.distance = Infinity;
    this.rate = 0;
    this.seen = false;            // 지금 보고 있음 (발견 + 보임)
    this.lastSeen = -Infinity;
    this.detectedAt = -Infinity;
    this.flashCheck = -Infinity;  // 총구 화염 확인 (AI 사수는 0.2초에 한 번)
  }
}

const FOCUS_KEYS = ['meter', 'visibility', 'visibilityAge', 'inView', 'angleDeg', 'distance', 'rate', 'seen', 'lastSeen', 'detectedAt'];

export class Perception {
  /** @param {{ rng: object, sharpness?: number }} opts */
  constructor(opts = {}) {
    const V = CONFIG.ai.vision;
    this.rng = opts.rng;
    this.sharpness = opts.sharpness ?? (this.rng ? this.rng.range(V.sharpness[0], V.sharpness[1]) : 1);
    this.tracks = new Map();      // 표적 → Track
    this.focus = new Track(null); // 지금 주목하는 추적 (첫 표적이 물려받음)
    this.lastCrack = -Infinity;
    this.pending = [];            // 늦게 들리는 소리 (총성: 거리/음속)
    this.alertMul = 1;            // 순찰 경계 수준 (수색 포기 후 높아짐)
  }

  /** 표적의 추적 (없으면 만듦 — 아직 표적이 없으면 기본 추적을 그대로 씀) */
  track(target) {
    if (!target) return this.focus;
    let t = this.tracks.get(target);
    if (t) return t;
    if (this.focus.target === null && this.tracks.size === 0) { t = this.focus; t.target = target; }
    else t = new Track(target);
    this.tracks.set(target, t);
    return t;
  }

  /** 표적이 사라짐 (죽음·제거) — 주목하던 추적이면 다른 추적으로 */
  drop(target) {
    const t = this.tracks.get(target);
    if (!t) return;
    this.tracks.delete(target);
    if (this.focus === t) {
      let best = null;
      for (const k of this.tracks.values()) if (!best || k.meter > best.meter) best = k;
      this.focus = best ?? new Track(null);
    }
  }

  setFocus(track) { if (track) this.focus = track; }

  /** 시야 기하 (레이 없이): 거리·각도·시야각 안 여부 */
  geometry(eye, lookYaw, target, tr = this.focus) {
    const V = CONFIG.ai.vision;
    const dx = target.x - eye.x, dz = target.z - eye.z;
    const d = Math.hypot(dx, dz);
    const fx = -Math.sin(lookYaw), fz = -Math.cos(lookYaw);
    const c = d > 1e-6 ? (dx * fx + dz * fz) / d : 1;
    tr.angleDeg = Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
    tr.distance = Math.hypot(d, target.y - eye.y);
    tr.inView = tr.distance <= V.range && (tr.angleDeg <= V.fovDeg / 2 || tr.distance <= V.nearDistance);
    return tr.inView;
  }

  /** 레이캐스트 결과 반영 (EnemyManager 예산) */
  setVisibility(v, tr = this.focus) {
    tr.visibility = v;
    tr.visibilityAge = 0;
  }

  /**
   * 한 프레임 누적. info: { exposure, speed, state, suppression, now }
   * @returns {boolean} 이번에 새로 발견했나
   */
  accumulate(dt, info, tr = this.focus) {
    const V = CONFIG.ai.vision;
    tr.visibilityAge += dt;
    let vis = tr.inView ? tr.visibility : 0;
    // 아주 가까우면 잎에 가려도 (숨소리·흔들리는 풀·냄새) 알아챌 수 있다
    const NS = V.nearSense;
    if (NS && tr.inView && tr.distance < NS.distance) vis = Math.max(vis, NS.visibility * (1 - tr.distance / NS.distance));
    // 5단계: 안개·비 — 화면 안개와 같은 식 exp(−(밀도·거리)²), 맑은 한낮(fogBase) 대비만큼 덜 보인다
    const fd = info.fogD ?? 0;
    if (fd > V.fogBase && vis > 0) {
      const d = tr.distance;
      vis *= Math.exp(-((fd * d) ** 2 - (V.fogBase * d) ** 2));
    }
    tr.rate = detectionRate({
      distance: tr.distance, exposure: info.exposure, visibility: vis, speed: info.speed, angleDeg: tr.angleDeg,
      state: info.state, sharpness: this.sharpness, suppression: info.suppression, alertMul: this.alertMul, ambient: info.ambient,
    }) + (info.lampRate ?? 0);
    const before = tr.meter;
    if (tr.rate > 0) {
      // 매 순간 집중이 들쭉날쭉 (한 번 훑어보고 놓치기도) — 평균 1
      tr.meter += tr.rate * dt * (this.rng ? this.rng.range(0.4, 1.6) : 1);
    } else if (tr.meter > 0) {
      tr.meter = Math.max(0, tr.meter - V.decay * dt);
    }
    if (tr.meter > 1.5) tr.meter = 1.5;
    tr.seen = tr.meter >= 1 && vis >= V.visibleMin;
    if (tr.seen) tr.lastSeen = info.now;
    const fresh = before < 1 && tr.meter >= 1;
    if (fresh) tr.detectedAt = info.now;
    return fresh;
  }

  /** 총구 화염을 봄 → 즉시 발견 */
  flash(now, tr = this.focus) {
    const fresh = tr.meter < 1;
    tr.meter = Math.max(tr.meter, 1.2);
    tr.lastSeen = now;
    if (fresh) tr.detectedAt = now;
    return fresh;
  }

  /** 7단계: 아무 표적이나 지금 보고 있나 */
  get seesAny() {
    if (this.focus.seen) return true;
    for (const t of this.tracks.values()) if (t.seen) return true;
    return false;
  }

  /** 소리 듣기 예약 (delay 초 뒤 처리) */
  hear(evt, delay, now) {
    this.pending.push({ evt, at: now + delay });
  }

  /** 들을 때가 된 소리들 (처리 순서대로) */
  due(now, out = []) {
    out.length = 0;
    if (!this.pending.length) return out;
    let w = 0;
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (p.at <= now) out.push(p.evt); else this.pending[w++] = p;
    }
    this.pending.length = w;
    return out;
  }
}

// 주목하는 추적의 값을 그대로 읽고 쓰는 속성 (4~6단계 코드·테스트가 perception.meter 등을 직접 씀)
for (const k of FOCUS_KEYS) {
  Object.defineProperty(Perception.prototype, k, {
    get() { return this.focus[k]; },
    set(v) { this.focus[k] = v; },
    configurable: true,
  });
}
