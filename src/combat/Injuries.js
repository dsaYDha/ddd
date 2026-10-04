// =====================================================================
//  Injuries — 사람 한 명의 부위별 부상·출혈·자가 처치 (순수 로직: three.js·DOM 없음 → Node 테스트에서 그대로)
//  플레이어·F8 표적(사람 개체)·4단계 적 병사가 모두 이 컴포넌트 하나로 같은 규칙을 받는다.
//
//  판정 (classifyHit — 순수 함수):
//   · 치명: 머리·목 전체, 가슴 상부 안의 심장·대혈관(구), 상부 척추(등 쪽 선) — 탄 경로(들어간 점 → 진행 방향
//     CONFIG.injury.pathLength m)가 구·선을 지나면 치명. 경로 판정 부위는 injury.pathParts (옆에서 상완을 뚫고 가슴으로 등)
//   · 스침: 탄 경로가 판정 표면에서 grazeDepth(2cm) 안쪽까지만 들어감 (또는 근접 통과가 표면 바깥 2cm 안 — applyNearGraze)
//   · 저속 탄: 2단계 관통·도탄 뒤 남은 속도 비율(hit.retained) < lowSpeedRatio → 한 단계 약하게 (치명 → 가슴 중상, 비치명 → 스침)
//  상처: { id, part, type, side, arterial, bleed(%/분), bandaged, tourniquet, time, lowSpeed, label }
//   type = 'graze'|'chest'|'abdomen'|'pelvis'|'thigh'|'shin'|'upperArm'|'forearm' — 효과는 CONFIG.injury.wounds[type]
//   상처는 쌓이고 (치유 없음), 제한·배율은 가장 심한 값, 출혈은 더한다.
//  혈액 100% → weak(80) 미만 심박·흔들림 증가 → faint(60) 미만 회색·흐림·기는 속도 감소 → dead(40) 미만 의식 상실 = 사망
//  자가 처치: startAid('bandage'|'tourniquet') — 시간이 다 차면 적용 (움직이거나 맞으면 취소, 물자는 다 됐을 때만 소모)
//
//  연결: bindMotor(motor) — 강제로 넘어짐(forceStance)·절뚝임(발소리마다 휘청)
//        apply(motor, shooter) — 매 프레임: motor.setRestriction('injury', …), shooter.aim.setExternal('injury', …),
//          weapon.actionTimeMul / fireDelay / setAutoBlocked, shooter.blocked ('dead'|'stun'|'aid'|'dropped')
//  읽기 (4단계 AI·F3): alive, dead, cause, blood, bleedRate, stage, stunned, downed, wounds, summary()
//  이벤트: 'wound' {wound, result, hit} · 'graze' {wound, hit} · 'death' {cause, label, time, hit, result}
//          'stun' {duration, graze} · 'forceStance' {stance} · 'drop' {} · 'pickup' {} · 'stage' {stage, prev}
//          'aidStart' {kind, duration, wound} · 'aidEnd' {kind, wound} · 'aidCancel' {kind, reason} · 'aidRefused' {kind, reason}
//          'cough' {} · 'stumble' {}
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { RNG } from '../core/rng.js';
import { closestSegSeg, pointSegDistSq, segCapsuleRaw } from './geom.js';
import { NEAR_PARTS, partLabel } from './Hitboxes.js';

export const PART_TYPE = Object.freeze({
  head: 'head', neck: 'neck', upperChest: 'chest', abdomen: 'abdomen', pelvis: 'pelvis',
  upperArmL: 'upperArm', upperArmR: 'upperArm', forearmL: 'forearm', forearmR: 'forearm',
  thighL: 'thigh', thighR: 'thigh', shinL: 'shin', shinR: 'shin',
});
export const LIMB_TYPES = new Set(['upperArm', 'forearm', 'thigh', 'shin']);
const ARM_TYPES = new Set(['upperArm', 'forearm']);
const STANCES = ['stand', 'crouch', 'prone'];

/** 부위 이름의 좌우 ('L'|'R'|null) */
export function partSide(part) {
  const c = part ? part[part.length - 1] : '';
  return c === 'L' || c === 'R' ? c : null;
}

// 작업 객체 (단일 스레드)
const CS = { distSq: 0, s: 0, t: 0 };
const L0 = { x: 0, y: 0, z: 0 }, L1 = { x: 0, y: 0, z: 0 };
const PT = { t: 0 };

/**
 * 탄 경로가 그 부위 캡슐 안으로 들어간 최대 깊이 (m, 표면 = 0). 캡슐 정보가 없으면 NaN.
 * 경로 = 들어간 점 앞뒤의 직선 조각 (점 − 0.5·dir ~ 점 + 0.8·dir). 몸통 쌍 캡슐은 둘 중 깊은 값.
 */
export function penetrationDepth(caps, part, point, dir) {
  if (!caps || !caps.length || !point || !dir) return NaN;
  L0.x = point.x - dir.x * 0.5; L0.y = point.y - dir.y * 0.5; L0.z = point.z - dir.z * 0.5;
  L1.x = point.x + dir.x * 0.8; L1.y = point.y + dir.y * 0.8; L1.z = point.z + dir.z * 0.8;
  let best = -Infinity;
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    if (c.part !== part) continue;
    closestSegSeg(L0, L1, c.a, c.b, CS);
    const d = c.r - Math.sqrt(CS.distSq);
    if (d > best) best = d;
  }
  return best === -Infinity ? NaN : best;
}

/** 탄 경로(점 → 점 + dir·pathLength)가 심장 구·척추 선을 지나면 먼저 지나는 쪽 'heart'|'spine', 아니면 null */
export function pathVital(caps, point, dir) {
  if (!caps || !caps.heart || !point || !dir) return null;
  const J = CONFIG.injury;
  const L = J.pathLength;
  L1.x = point.x + dir.x * L; L1.y = point.y + dir.y * L; L1.z = point.z + dir.z * L;
  let zone = null, first = Infinity;
  if (pointSegDistSq(caps.heart, point, L1, PT) <= J.heartRadius * J.heartRadius) { zone = 'heart'; first = PT.t; }
  closestSegSeg(point, L1, caps.spineA, caps.spineB, CS);
  if (CS.distSq <= J.spine.radius * J.spine.radius && CS.s < first) zone = 'spine';
  return zone;
}

/**
 * 명중 하나의 결과 (순수 함수 — 상태를 바꾸지 않는다).
 * hit: { part, point, dir, retained?, person?: {hitboxes} | hitboxes?, graze?: true (강제) }
 * @returns {{severity:'lethal'|'wound'|'graze', type, zone:'head'|'neck'|'heart'|'spine'|null, part, side,
 *            lowSpeed:boolean, graze:boolean, depth:number}}
 */
export function classifyHit(hit) {
  const J = CONFIG.injury;
  const part = hit.part;
  const caps = hit.person?.hitboxes ?? hit.hitboxes ?? null;
  const depth = hit.graze === true ? 0 : penetrationDepth(caps, part, hit.point, hit.dir);
  const graze = hit.graze === true || (Number.isFinite(depth) && depth < J.grazeDepth);
  const lowSpeed = Number.isFinite(hit.retained) && hit.retained < J.lowSpeedRatio;
  let zone = null;
  if (part === 'head' || part === 'neck') zone = part;
  else if (J.pathParts.includes(part)) zone = pathVital(caps, hit.point, hit.dir);
  let severity = zone ? 'lethal' : 'wound';
  let type = zone ? 'lethal' : (PART_TYPE[part] ?? 'chest');
  if (graze) { severity = 'graze'; type = 'graze'; }
  else if (lowSpeed) {
    // 한 단계 약하게: 치명 → 가슴 수준 중상, 비치명 → 스침
    if (severity === 'lethal') { severity = 'wound'; type = 'chest'; } else { severity = 'graze'; type = 'graze'; }
  }
  return { severity, type, zone: severity === 'lethal' ? zone : null, vitalZone: zone, part, side: partSide(part), lowSpeed, graze, depth };
}

/** 점에서 가장 가까운 머리·몸통 부위 (근접 통과 스침의 부위) */
export function nearestPart(caps, point) {
  let best = Infinity, part = 'upperChest';
  if (!caps) return part;
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    if (!NEAR_PARTS.has(c.part)) continue;
    const d = Math.sqrt(pointSegDistSq(point, c.a, c.b)) - c.r;
    if (d < best) { best = d; part = c.part; }
  }
  return part;
}

// =====================================================================
export class Injuries extends EventEmitter {
  /**
   * @param {{ rng?: RNG, name?: string, isPlayer?: boolean, motor?: object }} opts
   */
  constructor(opts = {}) {
    super();
    this.rng = opts.rng ?? new RNG((Math.random() * 4294967296) >>> 0);
    this.name = opts.name ?? '';
    this.isPlayer = !!opts.isPlayer;
    this.motor = null;
    this._onFootstep = () => this._limpStep();
    this._fx = {
      restriction: null, swayMul: 1, recoilMul: 1, reloadMul: 1, fireDelay: 0, noAuto: false, limp: false, cough: false,
      heartStress: 0, downed: false,
    };
    this.reset();
    if (opts.motor) this.bindMotor(opts.motor);
  }

  /** 처음 상태 (혈액 100, 상처 없음, 물자 가득) */
  reset() {
    const A = CONFIG.injury.aid;
    this.blood = 100;
    this.wounds = [];
    this.dead = false;
    this.cause = null;            // 'head'|'neck'|'heart'|'spine'|'bleed'
    this.causeLabel = '';
    this.deathTime = NaN;
    this.time = 0;                // 살아 있는 시간 (s)
    this.stun = 0;
    this.stunMax = 0;
    this.bandages = A.bandages;
    this.tourniquets = A.tourniquets;
    this.aid = null;              // { kind, t, duration, wound }
    this.weaponDropped = false;
    this.lastHit = null;          // 마지막 결과 (F8 로그·개체 반응용)
    this.invulnerable = this.invulnerable ?? false;   // F9 무적 (4단계 테스트 — reset 해도 유지)
    this._nextId = 1;
    this._stage = 'normal';
    this._cough = this._coughDelay();
    this._limpCount = this._limpSteps();
    this._ver = 1;                // 효과가 바뀔 때마다 증가 → apply 가 바뀐 것만 다시 건다
    this._fxVer = 0;
    this._appliedMotorVer = -1;
    this._appliedAimVer = -1;
  }

  /** 5단계 체크포인트: 상처·피·처치 도구 (사망 아닌 상태만) */
  snapshot() {
    return {
      blood: this.blood, wounds: this.wounds.map((w) => ({ ...w })), bandages: this.bandages, tourniquets: this.tourniquets,
      time: this.time, nextId: this._nextId, weaponDropped: this.weaponDropped,
    };
  }

  restore(st) {
    this.reset();
    if (!st) return;
    this.blood = st.blood;
    this.wounds = st.wounds.map((w) => ({ ...w }));
    this.bandages = st.bandages; this.tourniquets = st.tourniquets;
    this.time = st.time; this._nextId = st.nextId;
    this.weaponDropped = !!st.weaponDropped;
    this._ver++;
  }

  // -----------------------------------------------------------------
  // 읽기
  // -----------------------------------------------------------------
  get alive() { return !this.dead; }
  get stunned() { return this.stun > 0; }
  /** 혈액량 단계 'normal'|'weak'|'faint'|'dead' */
  get stage() { return this._stage; }
  /** 지금 출혈 속도 (%/분, 상처 합) */
  get bleedRate() {
    let s = 0;
    for (let i = 0; i < this.wounds.length; i++) s += this.woundBleed(this.wounds[i]);
    return s;
  }
  /** 일어설 수 없음 (가슴·복부·골반·대퇴 부상 또는 사망) */
  get downed() { return this.dead || this.effects().downed; }
  get hasWounds() { return this.wounds.length > 0; }
  /** 0..1 — weak 단계부터 dead 까지 혈액 손실 정도 */
  get bloodLossFactor() {
    const T = CONFIG.injury.thresholds;
    return Math.min(1, Math.max(0, (T.weak - this.blood) / (T.weak - T.dead)));
  }

  /** 상처 하나의 지금 출혈 (%/분) */
  woundBleed(w) {
    if (w.tourniquet) return 0;
    const A = CONFIG.injury.aid;
    return w.bandaged ? w.bleed * (w.arterial ? A.bandageArterialMul : A.bandageMul) : w.bleed;
  }

  // -----------------------------------------------------------------
  // 피격
  // -----------------------------------------------------------------
  /**
   * 명중 적용. hit = Ballistics 'hit' payload (또는 makeTestHit 결과).
   * opts.forceArterial: true/false 면 동맥 출혈 판정을 고정 (테스트), opts.forceDrop: 총 떨어뜨림 고정
   * @returns 결과 {severity, type, zone, part, side, lowSpeed, graze, depth, wound, arterial, killed, cause, dropped, alreadyDead}
   */
  applyHit(hit, opts = {}) {
    const r = classifyHit(hit);
    r.wound = null; r.arterial = false; r.killed = false; r.cause = null; r.dropped = false; r.alreadyDead = this.dead;
    r.ignored = false;
    this.lastHit = r;
    if (this.dead) return r;
    // 4단계 테스트: 무적 (판정만 하고 효과 없음)
    if (this.invulnerable) { r.ignored = true; return r; }
    if (this.aid) this.cancelAid('hit');
    const J = CONFIG.injury;
    if (r.severity === 'lethal') {
      this._die(r.zone, hit, r);
      r.killed = true;
      r.cause = r.zone;
      return r;
    }
    const spec = J.wounds[r.type] || {};
    let arterial = false;
    if (spec.arterial) arterial = opts.forceArterial ?? this.rng.chance(spec.arterial.chance);
    const w = {
      id: this._nextId++, part: r.part, type: r.type, side: r.side, arterial,
      bleed: arterial ? spec.arterial.bleed : spec.bleed || 0,
      bandaged: false, tourniquet: false, time: this.time, lowSpeed: r.lowSpeed,
      label: partLabel(r.part),
    };
    this.wounds.push(w);
    r.wound = w;
    r.arterial = arterial;
    this._ver++;
    // 충격: 조작 불가 (스침은 경직)
    const stun = r.type === 'graze' ? J.grazeStun : J.stun;
    if (stun > this.stun) { this.stun = stun; this.stunMax = stun; }
    this.emit('stun', { duration: stun, graze: r.type === 'graze' });
    // 넘어짐
    if (spec.forceStance) {
      if (this.motor) this.motor.forceStance(spec.forceStance, 0.35);
      this.emit('forceStance', { stance: spec.forceStance });
    }
    // 팔: 총을 떨어뜨릴 수 있음
    if (ARM_TYPES.has(r.type) && !this.weaponDropped) {
      const drop = opts.forceDrop ?? this.rng.chance(J.arm.dropChance);
      if (drop) { this.weaponDropped = true; r.dropped = true; this.emit('drop', {}); }
    }
    this.emit(r.type === 'graze' ? 'graze' : 'wound', { wound: w, result: r, hit });
    return r;
  }

  /** 근접 통과가 머리·몸통 표면 바깥 grazeDepth 안을 지남 → 스침 (e = Ballistics 'nearPass') */
  applyNearGraze(e, caps = e.person?.hitboxes) {
    if (this.dead) return null;
    const part = nearestPart(caps, e.point);
    return this.applyHit({ part, point: e.point, dir: e.dir, retained: 1, graze: true, nearPass: true, person: e.person });
  }

  /** 총 줍기 (Game 이 줍는 시간·거리를 확인한 뒤 부름) */
  pickUpWeapon() {
    if (!this.weaponDropped) return false;
    this.weaponDropped = false;
    this.emit('pickup', {});
    return true;
  }

  /** 강제 사망 (테스트·디버그) */
  kill(cause = 'bleed') {
    if (!this.dead) this._die(cause, null, null);
  }

  _die(cause, hit, result) {
    this.dead = true;
    this.cause = cause;
    this.causeLabel = CONFIG.injury.causes[cause] ?? cause;
    this.deathTime = this.time;
    this.stun = 0;
    if (this.aid) this.cancelAid('dead');
    this._stage = 'dead';
    this._ver++;
    this.emit('death', { cause, label: this.causeLabel, time: this.time, hit, result });
  }

  // -----------------------------------------------------------------
  // 시간
  // -----------------------------------------------------------------
  /**
   * @param {number} dt
   * @param {{ speed?: number, moving?: boolean }} ctx  처치 취소 판정 (움직임)
   */
  update(dt, ctx = {}) {
    if (this.dead || !(dt > 0)) return;
    const J = CONFIG.injury;
    this.time += dt;
    // 충격
    if (this.stun > 0) {
      this.stun = Math.max(0, this.stun - dt);
      if (this.stun === 0) this._ver++;
    }
    // 출혈
    const rate = this.bleedRate;
    if (rate > 0) this.blood = Math.max(0, this.blood - (rate / 60) * dt);
    const T = J.thresholds;
    const stage = this.blood < T.dead ? 'dead' : this.blood < T.faint ? 'faint' : this.blood < T.weak ? 'weak' : 'normal';
    if (stage !== this._stage) {
      const prev = this._stage;
      this._stage = stage;
      this._ver++;
      if (stage === 'dead') { this._stage = prev; this._die('bleed', null, null); return; }
      this.emit('stage', { stage, prev });
    } else if (stage === 'weak' || stage === 'faint') {
      // 혈액 손실에 따른 흔들림·심박은 연속값 — 0.5% 마다 다시 건다
      const q = Math.floor(this.blood * 2);
      if (q !== this._bloodQ) { this._bloodQ = q; this._ver++; }
    }
    // 처치
    const a = this.aid;
    if (a) {
      const moving = ctx.moving || (ctx.speed ?? 0) > J.aid.moveCancelSpeed;
      if (moving) this.cancelAid('move');
      else {
        a.t += dt;
        if (a.t >= a.duration) this._finishAid();
      }
    }
    // 기침 (가슴 부상)
    if (this.effects().cough) {
      this._cough -= dt;
      if (this._cough <= 0) { this._cough = this._coughDelay(); this.emit('cough', {}); }
    }
  }

  _coughDelay() {
    const [a, b] = CONFIG.injury.cough.interval;
    return this.rng.range(a, b);
  }

  _limpSteps() {
    const [a, b] = CONFIG.injury.limp.steps;
    return this.rng.int(a, b);
  }

  // -----------------------------------------------------------------
  // 자가 처치
  // -----------------------------------------------------------------
  /** 붕대·지혈대를 쓸 상처 (없으면 null) */
  aidTarget(kind) {
    let best = null, bestB = 0;
    for (const w of this.wounds) {
      if (w.tourniquet) continue;
      if (kind === 'bandage' && w.bandaged) continue;
      if (kind === 'tourniquet' && !LIMB_TYPES.has(PART_TYPE[w.part])) continue;   // 몸통 불가 (팔다리 스침은 가능)
      const b = this.woundBleed(w) + (kind === 'tourniquet' && w.arterial ? 1000 : 0);
      if (b > bestB) { bestB = b; best = w; }
    }
    return best;
  }

  /**
   * 처치 시작. @returns {{ok:boolean, reason?:string, duration?:number}}
   *  reason: 'dead'|'busy'|'stunned'|'none'(물자 없음)|'noWound'|'noLimb'
   */
  startAid(kind) {
    const A = CONFIG.injury.aid;
    let reason = null;
    if (this.dead) reason = 'dead';
    else if (this.aid) reason = 'busy';
    else if (this.stun > 0) reason = 'stunned';
    else if ((kind === 'bandage' ? this.bandages : this.tourniquets) <= 0) reason = 'none';
    const w = reason ? null : this.aidTarget(kind);
    if (!reason && !w) reason = kind === 'tourniquet' && this.wounds.some((x) => this.woundBleed(x) > 0) ? 'noLimb' : 'noWound';
    if (reason) {
      this.emit('aidRefused', { kind, reason });
      return { ok: false, reason };
    }
    const armHurt = this.wounds.some((x) => ARM_TYPES.has(x.type));
    const duration = (kind === 'bandage' ? A.bandageTime : A.tourniquetTime) * (armHurt ? A.armTimeMul : 1);
    this.aid = { kind, t: 0, duration, wound: w };
    this._ver++;
    this.emit('aidStart', { kind, duration, wound: w });
    return { ok: true, duration };
  }

  cancelAid(reason = 'cancel') {
    const a = this.aid;
    if (!a) return;
    this.aid = null;
    this._ver++;
    this.emit('aidCancel', { kind: a.kind, reason });
  }

  _finishAid() {
    const a = this.aid;
    this.aid = null;
    const w = a.wound;
    if (a.kind === 'bandage') { w.bandaged = true; this.bandages--; } else { w.tourniquet = true; this.tourniquets--; }
    this._ver++;
    this.emit('aidEnd', { kind: a.kind, wound: w });
  }

  // -----------------------------------------------------------------
  // 효과
  // -----------------------------------------------------------------
  /** 모든 상처·혈액·충격을 합친 효과 (재사용 객체 — 바뀔 때만 다시 계산) */
  effects() {
    if (this._fxVer === this._ver) return this._fx;
    this._fxVer = this._ver;
    const J = CONFIG.injury;
    const fx = this._fx;
    let sway = 1, recoil = 1, reload = 1, fireDelay = 0, noAuto = false, limp = false, cough = false;
    const R = { canStand: true, canCrouch: true, canSprint: true, canJump: true, maxSpeedMultiplier: 1,
      maxSpeed: { stand: Infinity, crouch: Infinity, prone: Infinity }, maxStamina: Infinity };
    let restricted = false;
    for (const w of this.wounds) {
      const s = J.wounds[w.type];
      if (!s) continue;
      let ws = s.swayMul ?? 1;
      if (ARM_TYPES.has(w.type)) {
        if (w.side === J.arm.triggerSide) { if (J.arm.noAuto) noAuto = true; fireDelay = Math.max(fireDelay, J.arm.fireDelay); } else ws *= J.arm.supportSwayMul;
      }
      sway = Math.max(sway, ws);
      recoil = Math.max(recoil, s.recoilMul ?? 1);
      reload = Math.max(reload, s.reloadMul ?? 1);
      for (const k of ['canStand', 'canCrouch', 'canSprint', 'canJump']) if (s[k] === false) { R[k] = false; restricted = true; }
      if (typeof s.maxSpeed === 'number') { for (const st of STANCES) R.maxSpeed[st] = Math.min(R.maxSpeed[st], s.maxSpeed); restricted = true; }
      else if (s.maxSpeed) { for (const st of STANCES) if (Number.isFinite(s.maxSpeed[st])) R.maxSpeed[st] = Math.min(R.maxSpeed[st], s.maxSpeed[st]); restricted = true; }
      if (Number.isFinite(s.maxStamina)) { R.maxStamina = Math.min(R.maxStamina, s.maxStamina); restricted = true; }
      if (s.limp) limp = true;
      if (s.cough) cough = true;
    }
    // 혈액 손실
    const loss = this.bloodLossFactor;
    const BL = J.bloodLoss;
    sway *= 1 + (BL.swayMulAtDead - 1) * loss;
    if (this.blood < J.thresholds.faint) {
      R.maxSpeedMultiplier *= BL.faintCrawlMul;
      for (const st of STANCES) if (Number.isFinite(R.maxSpeed[st])) R.maxSpeed[st] *= BL.faintCrawlMul;
      restricted = true;
    }
    // 충격 (조작 불가) · 사망
    if (this.stun > 0 || this.dead) {
      R.maxSpeedMultiplier = 0; R.canSprint = false; R.canJump = false;
      restricted = true;
    }
    if (this.dead) { R.canStand = false; R.canCrouch = false; }
    fx.restriction = restricted ? R : null;
    fx.swayMul = sway; fx.recoilMul = recoil; fx.reloadMul = reload;
    fx.fireDelay = fireDelay; fx.noAuto = noAuto; fx.limp = limp && !this.dead; fx.cough = cough && !this.dead;
    fx.heartStress = Math.min(1, (this.wounds.length ? J.pain.heartStress : 0) + BL.heartStress * loss);
    fx.downed = !R.canStand;
    return fx;
  }

  /** 이동 컴포넌트 연결 (강제로 넘어짐, 절뚝임) */
  bindMotor(motor) {
    if (this.motor === motor) return;
    if (this.motor) this.motor.off('footstep', this._onFootstep);
    this.motor = motor;
    this._appliedMotorVer = -1;
    if (motor) motor.on('footstep', this._onFootstep);
  }

  _limpStep() {
    const m = this.motor;
    if (!m || this.dead || !this.effects().limp || m.stance !== 'stand') return;
    if (--this._limpCount > 0) return;
    this._limpCount = this._limpSteps();
    const k = CONFIG.injury.limp.stumbleSpeedMul;
    m.velocity.x *= k; m.velocity.z *= k;
    this.emit('stumble', {});
  }

  /**
   * 효과를 이동 컴포넌트·사수에 건다 (매 프레임 불러도 됨 — 바뀐 것만 다시 건다).
   * motor.stress 는 건드리지 않는다 (제압과 합치는 쪽이 effects().heartStress 를 읽어 max 로).
   */
  apply(motor = this.motor, shooter = null) {
    const fx = this.effects();
    if (motor && this._appliedMotorVer !== this._ver) {
      this._appliedMotorVer = this._ver;
      if (fx.restriction) motor.setRestriction('injury', fx.restriction); else motor.clearRestriction('injury');
    }
    if (shooter) {
      if (this._appliedAimVer !== this._ver) {
        this._appliedAimVer = this._ver;
        if (fx.swayMul !== 1 || fx.recoilMul !== 1) shooter.aim.setExternal('injury', { swayMul: fx.swayMul, recoilMul: fx.recoilMul });
        else shooter.aim.clearExternal('injury');
      }
      const w = shooter.weapon;
      w.actionTimeMul = fx.reloadMul;
      w.fireDelay = fx.fireDelay;
      w.setAutoBlocked(fx.noAuto);
      shooter.blocked = this.dead ? 'dead' : this.stun > 0 ? 'stun' : this.aid ? 'aid' : this.weaponDropped ? 'dropped' : null;
    }
  }

  /** 4단계 AI·F3 가 읽는 요약 (새 객체) */
  summary() {
    return {
      alive: !this.dead, cause: this.cause, causeLabel: this.causeLabel, time: this.time,
      blood: this.blood, bleedRate: this.bleedRate, stage: this._stage, stunned: this.stun > 0, downed: this.downed,
      weaponDropped: this.weaponDropped, bandages: this.bandages, tourniquets: this.tourniquets,
      aid: this.aid ? { kind: this.aid.kind, progress: this.aid.t / this.aid.duration } : null,
      wounds: this.wounds.map((w) => ({
        part: w.part, label: w.label, type: w.type, arterial: w.arterial, bandaged: w.bandaged, tourniquet: w.tourniquet,
        bleed: this.woundBleed(w), lowSpeed: w.lowSpeed,
      })),
    };
  }
}

// =====================================================================
// 테스트용 명중 만들기 (F9 메뉴·자동 테스트) — 사람의 지금 캡슐에서 원하는 결과가 나오는 탄 경로를 만든다.
// =====================================================================
/**
 * kind: 'head'|'neck'|'heart'|'spine'|'lung'|'lowSpeed'|'graze' 또는 부위 이름 (abdomen, pelvis, upperArmR, forearmL, thighL, shinR …)
 * opts.part: 'graze' 의 부위 (기본 upperChest), opts.retained: 남은 속도 비율 (기본 1)
 * @returns hit-like { person, part, point, dir, speed, retained, test: true } — 캡슐이 없으면 null
 */
export function makeTestHit(person, kind, opts = {}) {
  const caps = person?.hitboxes;
  if (!caps || !caps.length || !caps.heart) return null;
  const fwd = caps.torsoFwd;
  // 몸의 수평 앞 방향 (엎드려도 수평으로 정면에서 쏜다)
  let hx = fwd.x, hz = fwd.z;
  const pose = person.pose;
  if (pose && Number.isFinite(pose.yaw)) { hx = -Math.sin(pose.yaw); hz = -Math.cos(pose.yaw); }
  const hl = Math.hypot(hx, hz) || 1;
  hx /= hl; hz /= hl;
  let part = kind, target = null, dir = { x: -hx, y: 0, z: -hz };   // 기본: 정면에서 몸 쪽으로
  let retained = opts.retained ?? 1;
  const mid = (p) => {
    let n = 0; const o = { x: 0, y: 0, z: 0 };
    for (const c of caps) if (c.part === p) { o.x += c.a.x + c.b.x; o.y += c.a.y + c.b.y; o.z += c.a.z + c.b.z; n += 2; }
    if (!n) return null;
    o.x /= n; o.y /= n; o.z /= n;
    return o;
  };
  if (kind === 'heart' || kind === 'lowSpeed') {
    part = 'upperChest';
    target = { ...caps.heart };
    dir = { x: -fwd.x, y: -fwd.y, z: -fwd.z };       // 가슴 정면에서 등 쪽으로
    if (kind === 'lowSpeed') retained = opts.retained ?? 0.3;
  } else if (kind === 'spine') {
    part = 'upperChest';
    const a = caps.spineA, b = caps.spineB;
    target = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    dir = { x: fwd.x, y: fwd.y, z: fwd.z };          // 등 뒤에서 가슴 쪽으로
  } else if (kind === 'lung') {
    // 가슴 상부의 오른쪽 폐 (심장·척추에서 먼 쪽)
    part = 'upperChest';
    const c = caps.chest;
    const rx = -hz, rz = hx;                            // 오른쪽 = (cos yaw, −sin yaw) = (−fwdZ, fwdX)
    target = { x: c.x + rx * 0.11, y: c.y, z: c.z + rz * 0.11 };
    dir = { x: -fwd.x, y: -fwd.y, z: -fwd.z };
  } else if (kind === 'graze') {
    part = opts.part ?? 'upperChest';
    target = mid(part);
  } else {
    target = mid(kind);
  }
  if (!target) return null;
  const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
  dir.x /= dl; dir.y /= dl; dir.z /= dl;
  if (kind === 'graze') {
    // 탄 경로를 옆으로 밀어 표면에서 1cm 만 들어가게: 축·탄 방향 모두에 수직인 방향으로 (r − 0.01)
    const c = caps.find((x) => x.part === part);
    let ax = c.b.x - c.a.x, ay = c.b.y - c.a.y, az = c.b.z - c.a.z;
    let sx = ay * dir.z - az * dir.y, sy = az * dir.x - ax * dir.z, sz = ax * dir.y - ay * dir.x;
    let sl = Math.hypot(sx, sy, sz);
    if (sl < 1e-6) { sx = 0; sy = 1; sz = 0; sl = 1; }
    sx /= sl; sy /= sl; sz /= sl;
    // 쌍 캡슐이면 바깥쪽 캡슐 축 기준 (옆 변위만큼 더)
    let off = c.r - 0.01;
    if (c.off && (c.off.x || c.off.z)) {
      const o = Math.abs(c.off.x * sx + c.off.y * sy + c.off.z * sz);
      off += o;
    }
    target = { x: target.x + sx * off, y: target.y + sy * off, z: target.z + sz * off };
  }
  // 탄 경로에서 그 부위 캡슐에 처음 닿는 점
  const S = { x: target.x - dir.x * 1.5, y: target.y - dir.y * 1.5, z: target.z - dir.z * 1.5 };
  let best = Infinity;
  for (const c of caps) {
    if (c.part !== part) continue;
    const t = segCapsuleRaw(S.x, S.y, S.z, dir.x * 2, dir.y * 2, dir.z * 2, c.a.x, c.a.y, c.a.z, c.b.x, c.b.y, c.b.z, c.r);
    if (t >= 0 && t < best) best = t;
  }
  if (best === Infinity) return null;
  const point = { x: S.x + dir.x * 2 * best, y: S.y + dir.y * 2 * best, z: S.z + dir.z * 2 * best };
  const speed = 700 * retained;
  return { person, part, point, dir, speed, retained, distance: 30, timeOfFlight: 0.05, penetrated: [], test: true, kind };
}
