// =====================================================================
//  AimModel — 조준 흔들림 · 숨 참기 · 무기 관성 · 반동 · 지향사격 퍼짐 · 가늠자 전환
//  2단계 목표 '맞히기가 매우 어렵다'의 핵심. 플레이어 전용이 아니다 — 4단계 적 병사도 같은 모델·같은 config 로 쏜다.
//  순수 로직 (three.js·DOM 없음 → Node 헤드리스 난이도 시뮬). 수치는 CONFIG.aim 과 무기 데이터에서 호출 시점에 읽는다.
//
//  각도: 내부 rad, config °.  offYaw/offPitch = 시선(look)에 '더하는' 총 조준선의 어긋남 (+yaw 왼쪽, +pitch 위)
//   = 흔들림(8자 + 표류 + 손떨림) + 관성 + 움찔(addShake). 화면 모델은 이 조준선에 가늠자·가늠쇠를 맞춰 그린다
//   → 가늠쇠 끝이 곧 탄이 가는 곳. 시선(카메라) 자체는 반동만 움직인다.
//
//  흔들림 진폭 A(°) = 자세 기본값(거치하면 sway.rested 로 섞임) × 심박 × 스태미나 × 숨 참기 × 제압 × 이동 × 외부(부상)
//   · 8자: 세로 A·sin φ, 가로 A·figureAspect·sin(2φ + figurePhase). φ 는 호흡수로 돈다 (숨 참는 동안 거의 멈춤).
//          호흡마다 깊이가 ±depthVar 만큼 달라 똑같은 궤적이 반복되지 않는다.
//   · 표류: 주파수가 다른 느린 사인 3개의 합 (최대 drift × A) — 8자 전체가 천천히 떠다닌다.
//   · 손떨림: 8~12Hz, tremorDeg × 심박 배율 (거치하면 restTremorMul) + 제압 떨림 (Suppression.effects().tremorDeg)
//   진폭은 목표값을 ampSmoothing(1/s)으로 따라간다 → 근접 통과·숨 참기 때도 조준선이 순간이동하지 않는다.
//  관성: 마우스로 돌린 시선의 gain 배(비조준이면 × hipMul)만큼 총이 뒤처지고, 감쇠비 ζ<1 스프링(ω = stiffness)으로
//        돌아오며 빠르게 돌리면 지나쳤다 돌아온다. 스프링은 해석해로 진행 → 프레임레이트와 무관하고 큰 dt 에도 안정.
//  반동: onShot 마다 수직 (vertical ± jitter) × 연발 배율(burstGrowth) × 자세 배율 × 외부 배율,
//        수평 U(−horizontal, +horizontal) × 자세·외부 배율. 시선에 kickTime 동안 실리고, recoverDelay 뒤
//        autoRecover(40%)만 시간상수 recoverTime 으로 저절로 돌아온다. 나머지는 시선에 남는다 → 플레이어가 끌어내려야 함.
//        update() 가 이번 프레임에 시선에 더할 양(viewKickYaw/Pitch)을 돌려준다.
//  숨 참기 (조준 중 누르고 있기): idle → holding (최대 duration, 흔들림 × swayMul)
//        → 놓거나 시간이 다하면 recovering (recoverTime × f 동안 × recoverSwayMul, 스태미나 −staminaCost × f 를 한 번 돌려줌)
//        → cooldown (숨 참기가 끝난 뒤 cooldown × f 가 될 때까지) → idle.  f = max(minFraction, 참은 시간 / duration).
//        상태가 바뀔 때마다 'holdBreath' {state, prev, ...}. 키를 놓았다 새로 눌러야 다시 참는다 (달리던 Shift 로 저절로 X).
//  가늠자: 누르고 있는 동안 adsTime 에 걸쳐 올라가고 놓으면 adsOutTime 에 걸쳐 내려간다. 달리는 동안 총을 낮추고
//          (lowered → 1), 멈춘 뒤 sprintDelay 동안 다시 들어 올린다 — 그동안 조준·사격 불가 (canFire false).
//  거치: Rest.detectRest 의 순간 판정(s.rested, s.restDrop)을 rest.enterTime / exitTime 으로 걸러 rested,
//        restBlend (0~1, blendTime 에 걸쳐), restDrop (m, 받침에 얹으려고 자세를 낮춘 거리 — 화면 표현용).
//        흔들림 → sway.rested, 반동 → recoilStanceMul.rested, 손떨림 × restTremorMul, 방아쇠 흔들림 × restJerkMul. 조준을 풀면 바로 해제.
//  발사 (onShot): 이번 발의 빗나감 {dyaw, dpitch} = 지향사격 원뿔 (반각 hipSpread × (1 − ads), 원판 균일)
//        + 고유 산포 (dispersionMOA = 90% 원 지름, 정규분포) + 방아쇠 흔들림 (새로 당긴 첫 발만, 거치하면 restJerkMul)
//  외부 배율: setExternal(이름, {swayMul, recoilMul}) — 3단계 팔 부상 등. 여러 개면 곱한다 (reset 해도 유지).
//  디버그용 추가 상태: mul {heart, stamina, breath, suppression, move, external}, tremorAmpDeg, breathPhase (0~1),
//        lastRecoil {vertical, horizontal} (°), stanceRecoilMul, holdFraction, swayYaw/Pitch · shakeYaw/Pitch (rad)
//  결정성: 난수는 모두 opts.rng 에서 → 같은 시드 + 같은 입력 순서면 같은 결과 (헤드리스 시뮬).
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { DEG, clamp, damp, lerp, smoothstep } from '../core/math.js';
import { RNG } from '../core/rng.js';
import { randomInDisc } from './geom.js';

const TAU = Math.PI * 2;
const MOA = DEG / 60;
// 고유 산포 '90% 원' 반경 → 축별 표준편차. 2차원 정규분포 P(r < R) = 1 − exp(−R²/2σ²) = 0.9 → σ = R / √(2·ln 10)
const SIGMA_PER_R90 = 1 / Math.sqrt(2 * Math.LN10);
const STANCES = Object.freeze({ stand: true, crouch: true, prone: true });
const NO_STATE = Object.freeze({});
// 반동이 아직 '실리는 중'이거나 회복 지연 중인 발의 최대 수 (kickTime·recoverDelay ≈ 0.1초 안 — 연사 600rpm 이면 1~2발)
const RECOIL_SLOTS = 16;
// 잡음 스펙트럼 모양 (가중치 합 = 1 → 최대 ±1). 표류는 느린 성분이 가장 크게 (자연스러운 1/f 꼴)
const DRIFT_WEIGHTS = Object.freeze([0.5, 0.3, 0.2]);
const TREMOR_WEIGHTS = Object.freeze([0.6, 0.4]);
const TREMOR_MOD_HZ = Object.freeze([0.3, 1.2]);   // 손떨림 세기가 커졌다 작아졌다 하는 느린 변조 (Hz)
const TREMOR_MOD_DEPTH = 0.35;                     // 변조 깊이 → 손떨림 세기 0.65 ~ 1
const DEPTH_RATE = 2;                              // 호흡마다 바뀌는 깊이를 따라가는 속도 (1/s)
const SP = { x: 0, v: 0 };                         // 스프링 해석해 결과 (쓰레기 객체 없이)
// 반동 데이터가 없는 무기(시험용 모의 데이터 등)는 반동 없음으로
const NO_RECOIL = Object.freeze({
  vertical: 0, verticalJitter: 0, horizontal: 0, autoRecover: 0, kickTime: 0, recoverDelay: 0, recoverTime: 0,
  burstGrowth: Object.freeze([1]), burstGap: 0, kickBackM: 0, kickUpDeg: 0,
});

export class AimModel extends EventEmitter {
  /**
   * @param {object} weaponData  무기 데이터 (recoil, dispersionMOA 를 호출 시점에 읽음)
   * @param {{rng?: RNG}} opts   헤드리스 시뮬은 시드 RNG 를 넘긴다
   */
  constructor(weaponData = CONFIG.weapons[CONFIG.weapons.default], opts = {}) {
    super();
    this.weaponData = weaponData;
    this.rng = opts.rng ?? new RNG((Math.random() * 4294967296) >>> 0);
    // 화면 모델 반동 (감쇠 스프링): back(m, 뒤로), up(rad, 총구 들림), side(rad, + 왼쪽), roll(rad)
    this.weaponKick = { back: 0, up: 0, side: 0, roll: 0 };
    this._kickVel = { back: 0, up: 0, side: 0, roll: 0 };
    this._ext = new Map();
    this.externalSwayMul = 1;
    this.externalRecoilMul = 1;
    // 지금 진폭을 이루는 배율 (디버그·F3 표시용)
    this.mul = { heart: 1, stamina: 1, breath: 1, suppression: 1, move: 1, external: 1 };
    this.lastRecoil = { vertical: 0, horizontal: 0 };   // 마지막 발이 시선에 준 반동 (°, + 위 / + 왼쪽)
    this._imp = [];
    for (let i = 0; i < RECOIL_SLOTS; i++) this._imp.push({ age: 0, v: 0, h: 0, k: 0, r: 0 });
    this._driftYaw = new SineNoise(DRIFT_WEIGHTS);
    this._driftPitch = new SineNoise(DRIFT_WEIGHTS);
    this._tremYaw = new SineNoise(TREMOR_WEIGHTS);
    this._tremPitch = new SineNoise(TREMOR_WEIGHTS);
    this._tremMod = new SineNoise([1]);
    this._out = { viewKickYaw: 0, viewKickPitch: 0, staminaCost: 0 };
    this._dev = { dyaw: 0, dpitch: 0 };
    this._disc = { a: 0, b: 0 };
    this.reset();
  }

  /** 움직이는 상태를 처음으로 (외부 배율은 소유자가 관리하므로 유지) */
  reset() {
    const C = CONFIG.aim;
    const rng = this.rng;
    this.time = 0;
    // 가늠자·달리기
    this.aiming = false;
    this.ads = 0;
    this.adsLinear = 0;
    this.sprinting = false;
    this.lowered = 0;
    this._lowerLin = 0;
    this.canFire = true;
    // 조준선 어긋남 (rad)
    this.offYaw = 0; this.offPitch = 0;
    this.swayYaw = 0; this.swayPitch = 0;
    this.inertiaYaw = 0; this.inertiaPitch = 0;
    this._ivYaw = 0; this._ivPitch = 0;
    this.shakeYaw = 0; this.shakePitch = 0;
    this._svYaw = 0; this._svPitch = 0;
    // 흔들림
    this.swayAmpDeg = C.sway.stand;
    this._ampReady = false;          // 첫 update 에서는 목표 진폭으로 바로 (0에서 차오르지 않게)
    this.tremorAmpDeg = 0;
    this.hipSpreadDeg = C.hipSpread.stand;
    this.breathMul = 1;
    this._rateMul = 1;
    this._phase = rng.range(0, TAU);
    this.breathPhase = this._phase / TAU;
    this._depth = 1;
    this._depthTarget = 1;
    this._driftYaw.seed(rng); this._driftPitch.seed(rng);
    this._tremYaw.seed(rng); this._tremPitch.seed(rng); this._tremMod.seed(rng);
    // 거치
    this.rested = false;
    this.restBlend = 0;
    this.restDrop = 0;               // 받침에 얹으려고 자세를 낮춘 거리 (m, 부드럽게) — 화면 표현용
    this._restDropTarget = 0;
    this._restOn = 0; this._restOff = 0;
    // 숨 참기
    this.holdState = 'idle';
    this.holdT = 0;
    this._holdArmed = true;
    this._sinceHoldEnd = Infinity;
    this._recoverDur = 0;
    this._cooldownDur = 0;
    this.holdFraction = 0;
    // 반동
    const g = (this.weaponData.recoil || NO_RECOIL).burstGrowth;
    this.burst = 0;
    this.recoilMul = g && g.length ? g[0] : 1;
    this.recoilClimbDeg = 0;
    this.stanceRecoilMul = 1;
    this._sinceShot = Infinity;
    this._impCount = 0;
    this._tailV = 0; this._tailH = 0;     // 지연이 끝나 순수 지수로 돌아오는 중인 자동 회복 잔량 (rad)
    this._pendV = 0; this._pendH = 0;     // 슬롯이 넘쳐 즉시 정리한 발의 남은 반동 (다음 update 에 실음)
    this.lastRecoil.vertical = 0; this.lastRecoil.horizontal = 0;
    for (const k in this.weaponKick) { this.weaponKick[k] = 0; this._kickVel[k] = 0; }
  }

  // -----------------------------------------------------------------
  // 갱신
  // -----------------------------------------------------------------
  /**
   * @param {number} dt
   * @param {{ aimHeld, holdBreathHeld, stance, stanceFrom, stanceProgress, speed, sprinting, heartRate, stamina,
   *           breathRate?, suppression?, suppressionEffects?, rested?, restDrop?, lookDeltaYaw?, lookDeltaPitch? }} s
   *        rested/restDrop = 이번 프레임 Rest.detectRest 결과 (순간값 — 지연은 여기서)
   * @returns {{viewKickYaw:number, viewKickPitch:number, staminaCost:number}}  시선에 더할 반동(rad)과 이번에 뺄 스태미나.
   *          반환 객체는 재사용된다 (다음 update 전까지 유효).
   */
  update(dt, s = NO_STATE) {
    dt = dt > 0 ? dt : 0;
    const C = CONFIG.aim;
    const out = this._out;
    out.viewKickYaw = 0; out.viewKickPitch = 0; out.staminaCost = 0;
    this.time += dt;

    const aimHeld = !!s.aimHeld;
    const sprinting = !!s.sprinting;
    const speed = s.speed > 0 ? s.speed : 0;
    const stance = STANCES[s.stance] ? s.stance : 'stand';
    const from = STANCES[s.stanceFrom] ? s.stanceFrom : stance;
    // 자세 전환 중이면 HumanMotor 눈높이와 같은 곡선으로 섞는다
    const sk = from === stance ? 1 : smoothstep(0, 1, Number.isFinite(s.stanceProgress) ? s.stanceProgress : 1);

    this._updateReady(dt, aimHeld, sprinting);
    this._updateRest(dt, aimHeld, !!s.rested, s.restDrop);
    this._updateHold(dt, aimHeld, !!s.holdBreathHeld, out);

    // 자세 배율표 (자세 전환 섞기 → 거치 섞기)
    const sw = C.sway;
    const RS = C.recoilStanceMul;
    this.stanceRecoilMul = lerp(lerp(RS[from], RS[stance], sk), RS.rested, this.restBlend);
    const HS = C.hipSpread;
    this.hipSpreadDeg = lerp(HS[from], HS[stance], sk) *
      lerp(1, C.hipMoveMul, C.hipMoveFullSpeed > 0 ? clamp(speed / C.hipMoveFullSpeed, 0, 1) : 1);

    // ---- 흔들림 진폭
    const base = lerp(lerp(sw[from], sw[stance], sk), sw.rested, this.restBlend);
    const M = this.mul;
    M.heart = heartSwayMul(s.heartRate);
    M.stamina = staminaSwayMul(s.stamina);
    M.breath = this.breathMul;
    const fx = s.suppressionEffects;
    const supV = clamp(Number.isFinite(s.suppression) ? s.suppression : 0, 0, 100);
    M.suppression = fx && Number.isFinite(fx.swayMul) ? fx.swayMul : suppressionSwayMul(supV);
    M.move = 1 + C.move.swayPerMps * speed;
    M.external = this.externalSwayMul;
    const target = base * M.heart * M.stamina * M.breath * M.suppression * M.move * M.external;
    this.swayAmpDeg = this._ampReady ? damp(this.swayAmpDeg, target, sw.ampSmoothing, dt) : target;
    this._ampReady = true;

    // ---- 8자 궤적 위상 (호흡). 숨 참는 동안 거의 멈추고, 몰아쉬는 동안 빨라진다
    const hb = C.holdBreath;
    const rateTarget = this.holdState === 'holding' ? hb.phaseRateMul : this.holdState === 'recovering' ? hb.recoverRateMul : 1;
    this._rateMul = damp(this._rateMul, rateTarget, sw.ampSmoothing, dt);
    const hz = s.breathRate > 0 ? s.breathRate : breathRateFor(s.heartRate);
    this._phase += TAU * hz * (sw.rateMul ?? 1) * this._rateMul * dt;
    if (this._phase >= TAU) {
      this._phase %= TAU;
      // 새 호흡 — 이번 숨의 깊이
      this._depthTarget = 1 + (sw.depthVar || 0) * this.rng.range(-1, 1);
    }
    this.breathPhase = this._phase / TAU;
    this._depth = damp(this._depth, this._depthTarget, DEPTH_RATE, dt);

    // ---- 흔들림 = 8자 + 표류 + 손떨림 (°)
    const A = this.swayAmpDeg;
    const figA = A * this._depth;
    this._driftYaw.advance(dt, sw.driftHz[0], sw.driftHz[1]);
    this._driftPitch.advance(dt, sw.driftHz[0], sw.driftHz[1]);
    this._tremYaw.advance(dt, sw.tremorHz[0], sw.tremorHz[1]);
    this._tremPitch.advance(dt, sw.tremorHz[0], sw.tremorHz[1]);
    this._tremMod.advance(dt, TREMOR_MOD_HZ[0], TREMOR_MOD_HZ[1]);
    const supTremor = fx && Number.isFinite(fx.tremorDeg) ? fx.tremorDeg : CONFIG.suppression.effects.tremorDeg * supV / 100;
    this.tremorAmpDeg = sw.tremorDeg * M.heart * lerp(1, sw.restTremorMul, this.restBlend) * M.external + supTremor;
    const trem = this.tremorAmpDeg * (1 - TREMOR_MOD_DEPTH * (0.5 + 0.5 * this._tremMod.value()));
    const drift = A * sw.drift;
    this.swayPitch = (figA * Math.sin(this._phase) + drift * this._driftPitch.value() + trem * this._tremPitch.value()) * DEG;
    this.swayYaw = (figA * sw.figureAspect * Math.sin(2 * this._phase + (sw.figurePhase || 0)) +
      drift * (sw.driftAspect ?? 1) * this._driftYaw.value() + trem * this._tremYaw.value()) * DEG;

    // ---- 관성 · 움찔 · 반동 · 화면 모델 반동
    this._updateInertia(dt, s.lookDeltaYaw, s.lookDeltaPitch);
    this._updateShake(dt);
    this._updateRecoil(dt, out);
    this._updateKick(dt);

    this.offYaw = this.swayYaw + this.inertiaYaw + this.shakeYaw;
    this.offPitch = this.swayPitch + this.inertiaPitch + this.shakePitch;
    return out;
  }

  /** 달리기 → 총을 낮춤, 멈춘 뒤 sprintDelay 동안 들어 올림 / 가늠자 진행 */
  _updateReady(dt, aimHeld, sprinting) {
    const C = CONFIG.aim;
    this.sprinting = sprinting;
    // 잠깐만 뛰었으면 덜 내려간 만큼 빨리 다시 든다 (낮춘 정도에 비례한 지연)
    this._lowerLin = step01(this._lowerLin, sprinting ? rate(dt, C.sprintLowerTime) : -rate(dt, C.sprintDelay));
    this.lowered = smoothstep(0, 1, this._lowerLin);
    const ready = !sprinting && this._lowerLin <= 0;
    this.canFire = ready;
    this.aiming = aimHeld;
    this.adsLinear = step01(this.adsLinear, aimHeld && ready ? rate(dt, C.adsTime) : -rate(dt, C.adsOutTime ?? C.adsTime));
    this.ads = smoothstep(0, 1, this.adsLinear);
  }

  /** 거치 — 감지가 enterTime 동안 이어지면 거치, exitTime 동안 끊기면 해제 (받침 가장자리에서 깜빡이지 않게) */
  _updateRest(dt, aimHeld, detected, drop) {
    const R = CONFIG.aim.rest;
    if (!aimHeld) {
      // 조준을 풀면 바로 해제 (총을 내렸다)
      this._restOn = 0; this._restOff = 0;
      this.rested = false;
    } else if (detected) {
      this._restOn += dt; this._restOff = 0;
      if (this._restOn >= R.enterTime) this.rested = true;
    } else {
      this._restOff += dt; this._restOn = 0;
      if (this._restOff >= R.exitTime) this.rested = false;
    }
    const step = rate(dt, R.blendTime);
    this.restBlend = step01(this.restBlend, this.rested ? step : -step);
    // 자세를 낮춘 거리: 감지되는 동안의 값을 기억했다가 거치가 풀리면 0 으로
    if (detected) this._restDropTarget = drop > 0 ? drop : 0;
    if (!this.rested) this._restDropTarget = 0;
    this.restDrop = damp(this.restDrop, this._restDropTarget, R.blendTime > 0 ? 3 / R.blendTime : 60, dt);
  }

  /** 숨 참기 상태 기계 */
  _updateHold(dt, aimHeld, held, out) {
    const hb = CONFIG.aim.holdBreath;
    // 숨 참기는 '새로 누를 때'만 시작 — 조준 전부터 쥐고 있던 Shift(달리기)나, 아직 숨이 찬(회복·쿨다운) 동안 누른 키는
    // 놓았다 다시 눌러야 한다 (쥐고 있다가 쿨다운이 끝나는 순간 저절로 참지 않게)
    if (!held) this._holdArmed = true;
    else if (!aimHeld || this.holdState === 'recovering' || this.holdState === 'cooldown') this._holdArmed = false;
    this.holdT += dt;
    if (this.holdState === 'recovering' || this.holdState === 'cooldown') this._sinceHoldEnd += dt;
    switch (this.holdState) {
      case 'idle':
        if (held && aimHeld && this._holdArmed) {
          this._holdArmed = false;
          this._setHold('holding', 0, null);
        }
        break;
      case 'holding':
        if (!held || !aimHeld || this.holdT >= hb.duration) this._endHold(out);
        break;
      case 'recovering':
        if (this.holdT >= this._recoverDur) {
          const over = this.holdT - this._recoverDur;
          this._setHold(this._sinceHoldEnd >= this._cooldownDur ? 'idle' : 'cooldown', over, null);
        }
        break;
      case 'cooldown':
        if (this._sinceHoldEnd >= this._cooldownDur) this._setHold('idle', this._sinceHoldEnd - this._cooldownDur, null);
        break;
    }
    this.breathMul = this.holdState === 'holding' ? hb.swayMul : this.holdState === 'recovering' ? hb.recoverSwayMul : 1;
  }

  _endHold(out) {
    const hb = CONFIG.aim.holdBreath;
    const held = Math.min(this.holdT, hb.duration);
    // 일찍 놓아도 회복·대가는 최소 minFraction 만큼 (톡톡 끊어 참는 꼼수 방지)
    const f = hb.duration > 0 ? clamp(held / hb.duration, hb.minFraction, 1) : 1;
    const over = Math.max(0, this.holdT - hb.duration);   // 프레임 경계를 넘긴 시간은 다음 상태로 넘긴다
    const cost = hb.staminaCost * f;
    this.holdFraction = f;
    this._recoverDur = hb.recoverTime * f;
    this._cooldownDur = hb.cooldown * f;
    this._sinceHoldEnd = over;
    out.staminaCost += cost;
    this._setHold('recovering', over, { held, fraction: f, staminaCost: cost });
  }

  _setHold(state, t, extra) {
    const prev = this.holdState;
    this.holdState = state;
    this.holdT = t;
    this.emit('holdBreath', extra ? { state, prev, ...extra } : { state, prev });
  }

  /** 무기 관성: 시선을 돌린 만큼 총이 뒤처지고, 감쇠 스프링으로 돌아오며 지나쳤다 돌아옴 */
  _updateInertia(dt, dYaw, dPitch) {
    const I = CONFIG.aim.inertia;
    const gain = I.gain * lerp(I.hipMul, 1, this.ads);
    const maxLag = I.maxLagDeg * DEG;
    this.inertiaYaw -= gain * (Number.isFinite(dYaw) ? dYaw : 0);
    this.inertiaPitch -= gain * (Number.isFinite(dPitch) ? dPitch : 0);
    this._clampInertia(maxLag);
    spring(this.inertiaYaw, this._ivYaw, dt, I.stiffness, I.damping);
    this.inertiaYaw = SP.x; this._ivYaw = SP.v;
    spring(this.inertiaPitch, this._ivPitch, dt, I.stiffness, I.damping);
    this.inertiaPitch = SP.x; this._ivPitch = SP.v;
    this._clampInertia(maxLag);
  }

  /** 최대 뒤처짐 (두 축 합친 크기) — 바깥으로 향하는 속도도 버린다 (벽에 닿은 듯 멈췄다 돌아오게) */
  _clampInertia(maxLag) {
    const m = Math.hypot(this.inertiaYaw, this.inertiaPitch);
    if (!(m > maxLag)) return;
    const nY = this.inertiaYaw / m, nP = this.inertiaPitch / m;
    this.inertiaYaw = nY * maxLag;
    this.inertiaPitch = nP * maxLag;
    const vr = this._ivYaw * nY + this._ivPitch * nP;
    if (vr > 0) { this._ivYaw -= vr * nY; this._ivPitch -= vr * nP; }
  }

  _updateShake(dt) {
    const S = CONFIG.aim.shake;
    const w = TAU * S.frequency;
    spring(this.shakeYaw, this._svYaw, dt, w, S.damping); this.shakeYaw = SP.x; this._svYaw = SP.v;
    spring(this.shakePitch, this._svPitch, dt, w, S.damping); this.shakePitch = SP.x; this._svPitch = SP.v;
  }

  /** 반동을 시선에: 발마다 kickTime 동안 싣고, recoverDelay 뒤 autoRecover 만큼 시간상수 recoverTime 으로 되돌림 */
  _updateRecoil(dt, out) {
    const R = this.weaponData.recoil || NO_RECOIL;
    const kT = R.kickTime, delay = R.recoverDelay, tau = R.recoverTime;
    const aV = R.autoRecover, aH = aV * (CONFIG.aim.recoilHorizontalRecover ?? 1);
    let dv = this._pendV, dh = this._pendH;
    this._pendV = 0; this._pendH = 0;
    // 1) 지연이 이미 끝난 몫: 같은 시간상수의 지수 감소는 합쳐도 같은 지수 → 잔량 하나로 관리
    if (this._tailV !== 0 || this._tailH !== 0) {
      const f = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
      const rv = this._tailV * f, rh = this._tailH * f;
      this._tailV -= rv; this._tailH -= rh;
      dv -= rv; dh -= rh;
      if (Math.abs(this._tailV) < 1e-9 && Math.abs(this._tailH) < 1e-9) { this._tailV = 0; this._tailH = 0; }
    }
    // 2) 아직 실리는 중이거나 지연 중인 발: 닫힌 식의 누적량 차이 → 프레임레이트와 무관
    for (let i = 0; i < this._impCount;) {
      const imp = this._imp[i];
      const a = imp.age + dt;
      const k = kickFraction(a, kT), r = recoverFraction(a, delay, tau);
      dv += imp.v * (k - imp.k) - aV * imp.v * (r - imp.r);
      dh += imp.h * (k - imp.k) - aH * imp.h * (r - imp.r);
      imp.age = a; imp.k = k; imp.r = r;
      if (a >= kT && a > delay) {
        // 다 실렸고 회복이 시작됨 → 남은 회복은 순수 지수 (잔량으로 넘김)
        this._tailV += aV * imp.v * (1 - r);
        this._tailH += aH * imp.h * (1 - r);
        this._removeImpulse(i);
      } else i++;
    }
    out.viewKickPitch += dv;
    out.viewKickYaw += dh;
    this.recoilClimbDeg += dv / DEG;
    // 연발 누적: burstGap 넘게 쉬면 초기화
    this._sinceShot += dt;
    if (this.burst > 0 && this._sinceShot > R.burstGap) {
      this.burst = 0;
      const g = R.burstGrowth;
      this.recoilMul = g && g.length ? g[0] : 1;
    }
  }

  /** 화면 모델 반동 스프링 */
  _updateKick(dt) {
    const K = CONFIG.aim.weaponKick;
    const w = TAU * K.frequency;
    const x = this.weaponKick, v = this._kickVel;
    for (const k in x) {
      spring(x[k], v[k], dt, w, K.damping);
      x[k] = SP.x; v[k] = SP.v;
    }
  }

  // -----------------------------------------------------------------
  // 발사 · 외부 충격
  // -----------------------------------------------------------------
  /**
   * 한 발이 나갈 때마다 부른다: 반동을 다음 프레임들의 시선에 걸고, 이번 발의 빗나감을 돌려준다.
   * @param {number} burstIndex  무기의 연발 순번 (1 = 방아쇠를 새로 당긴 첫 발 → 방아쇠 흔들림)
   * @param {number} timeOffset  이번 프레임 안에서 발사 시각 ~ 프레임 끝 (s) — 반동 진행을 그만큼 앞당긴다 (선택)
   * @returns {{dyaw:number, dpitch:number}} rad, 조준선에서 탄 방향을 비트는 양 (반환 객체 재사용)
   */
  onShot(burstIndex = 1, timeOffset = 0) {
    const C = CONFIG.aim, sw = C.sway;
    const W = this.weaponData, R = W.recoil || NO_RECOIL;
    const rng = this.rng;
    const age = timeOffset > 0 ? timeOffset : 0;

    // ---- 반동 (연발 누적 → 5발째부터 최대 배율)
    if (this._sinceShot > R.burstGap) this.burst = 0;
    this.burst++;
    if (this.burst === 1) this.recoilClimbDeg = 0;    // 새 연사의 누적값
    this._sinceShot = age;
    const g = R.burstGrowth;
    this.recoilMul = g && g.length ? g[Math.min(this.burst, g.length) - 1] : 1;
    const k = this.stanceRecoilMul * this.externalRecoilMul;
    const vDeg = (R.vertical + rng.range(-1, 1) * R.verticalJitter) * this.recoilMul * k;
    const hDeg = rng.range(-1, 1) * R.horizontal * k;
    this.lastRecoil.vertical = vDeg;
    this.lastRecoil.horizontal = hDeg;
    this._addImpulse(vDeg * DEG, hDeg * DEG, age);
    this._kickImpulse(k);

    // ---- 이번 발의 빗나감
    const disc = randomInDisc(rng, this.hipSpreadDeg * DEG * (1 - this.ads), this._disc);
    const sd = (W.dispersionMOA || 0) * 0.5 * MOA * SIGMA_PER_R90;   // 지름 → 반경 → 축별 표준편차
    let dyaw = disc.a + rng.gauss() * sd;
    let dpitch = disc.b + rng.gauss() * sd;
    if (!(burstIndex > 1)) {
      // 방아쇠를 새로 당길 때만 (연발로 쥐고 있는 동안은 손가락이 움직이지 않는다)
      const j = sw.triggerJerkDeg * DEG * lerp(1, sw.restJerkMul ?? 1, this.restBlend) * this.externalSwayMul;
      dyaw += rng.gauss() * j;
      dpitch += rng.gauss() * j;
    }
    const dev = this._dev;
    dev.dyaw = dyaw;
    dev.dpitch = dpitch;
    return dev;
  }

  /** 근접 통과 순간 움찔 — 총이 무작위 방향으로 deg 만큼 튀었다가 약 0.3초에 가라앉는다 (조준선에 더해짐) */
  addShake(deg) {
    if (!(deg > 0)) return;
    const S = CONFIG.aim.shake;
    const v = deg * DEG * TAU * S.frequency / impulsePeak(S.damping);
    const a = this.rng.range(0, TAU);
    this._svYaw += Math.cos(a) * v;
    this._svPitch += Math.sin(a) * v;
  }

  /** 외부 배율 (3단계 팔 부상 등). 같은 이름이면 덮어쓴다 */
  setExternal(name, { swayMul = 1, recoilMul = 1 } = {}) {
    this._ext.set(name, {
      swayMul: Number.isFinite(swayMul) && swayMul > 0 ? swayMul : 1,
      recoilMul: Number.isFinite(recoilMul) && recoilMul > 0 ? recoilMul : 1,
    });
    this._refreshExternal();
  }

  clearExternal(name) {
    if (this._ext.delete(name)) this._refreshExternal();
  }

  // -----------------------------------------------------------------
  _refreshExternal() {
    let s = 1, r = 1;
    for (const e of this._ext.values()) { s *= e.swayMul; r *= e.recoilMul; }
    this.externalSwayMul = s;
    this.externalRecoilMul = r;
  }

  _addImpulse(v, h, age) {
    if (this._impCount >= RECOIL_SLOTS) {
      // 병적인 연사 속도: 가장 오래된 발을 지금 정리 (남은 반동은 다음 update 에, 남은 회복은 잔량으로)
      const o = this._imp[0];
      const R = this.weaponData.recoil || NO_RECOIL;
      const aV = R.autoRecover, aH = aV * (CONFIG.aim.recoilHorizontalRecover ?? 1);
      this._pendV += o.v * (1 - o.k);
      this._pendH += o.h * (1 - o.k);
      this._tailV += aV * o.v * (1 - o.r);
      this._tailH += aH * o.h * (1 - o.r);
      this._removeImpulse(0);
    }
    const imp = this._imp[this._impCount++];
    imp.age = age; imp.v = v; imp.h = h; imp.k = 0; imp.r = 0;
  }

  _removeImpulse(i) {
    const last = --this._impCount;
    if (i !== last) {
      const t = this._imp[i];
      this._imp[i] = this._imp[last];
      this._imp[last] = t;
    }
  }

  /** 화면 모델 반동: 속도 충격 → 최대 변위가 정확히 kickBackM·kickUpDeg (× 자세·외부 배율)가 되게 */
  _kickImpulse(k) {
    const K = CONFIG.aim.weaponKick, R = this.weaponData.recoil || NO_RECOIL;
    const n = TAU * K.frequency / impulsePeak(K.damping) * k;
    const v = this._kickVel;
    v.back += (R.kickBackM || 0) * n;
    v.up += (R.kickUpDeg || 0) * DEG * n;
    v.side += this.rng.range(-1, 1) * K.sideDeg * DEG * n;
    v.roll += this.rng.range(-1, 1) * K.rollDeg * DEG * n;
  }
}

// ---------------------------------------------------------------------
// 배율 (헤드리스 시뮬·디버그에서도 쓰도록 내보냄) — 모두 CONFIG 를 호출 시점에 읽는다
// ---------------------------------------------------------------------
/** 심박 → 흔들림 배율: restBpm 이하 1, maxBpm 이상 maxMul, 사이 선형 */
export function heartSwayMul(heartRate) {
  const H = CONFIG.aim.heart;
  if (!Number.isFinite(heartRate)) return 1;
  return 1 + (H.maxMul - 1) * clamp((heartRate - H.restBpm) / (H.maxBpm - H.restBpm), 0, 1);
}

/** 스태미나 → 흔들림 배율: below 이상 1, 0 이면 maxMul (지수 exponent 로 낮을수록 가파르게) */
export function staminaSwayMul(stamina) {
  const S = CONFIG.aim.stamina;
  if (!Number.isFinite(stamina) || !(S.below > 0)) return 1;
  return 1 + (S.maxMul - 1) * Math.pow(clamp((S.below - stamina) / S.below, 0, 1), S.exponent ?? 1.5);
}

/** 제압 수치 → 흔들림 배율 (Suppression.effects().swayMul 과 같은 식 — 호출자가 effects 를 주지 않을 때) */
export function suppressionSwayMul(value) {
  const S = CONFIG.suppression, E = S.effects;
  const v = clamp(value || 0, 0, 100);
  return (1 + (E.swayMaxMul - 1) * v / 100) * (v >= S.levels.pinned ? E.pinnedSwayMul : 1);
}

/** 호출자가 호흡수를 주지 않을 때: 심박에서 (BreathCycle 과 같은 꼴) base + hrHz × hrN^hrExp */
export function breathRateFor(heartRate) {
  const B = CONFIG.aim.breath, H = CONFIG.heart;
  const hr = Number.isFinite(heartRate) ? heartRate : H.rest;
  const n = clamp((hr - H.rest) / (H.max - H.rest), 0, 1);
  return B.baseHz + B.hrHz * Math.pow(n, B.hrExp);
}

// ---------------------------------------------------------------------
// 내부 도우미
// ---------------------------------------------------------------------
/** dt 동안 0→1 을 time 초에 걸쳐 가는 증분 (time ≤ 0 이면 즉시) */
function rate(dt, time) {
  return time > 0 ? dt / time : 1;
}

/** 0~1 진행값에 증분을 더하고 끝에 붙인다 — 부동소수 찌꺼기(1e-16)로 한 프레임 늦게 0·1 에 닿지 않게 */
function step01(v, delta) {
  v += delta;
  return v <= 1e-9 ? 0 : v >= 1 - 1e-9 ? 1 : v;
}

/** 반동이 시선에 실린 비율 (kickTime 동안 처음이 빠른 ease-out) */
function kickFraction(age, kickTime) {
  if (!(kickTime > 0)) return 1;
  if (age >= kickTime) return 1;
  const x = age / kickTime;
  return x * (2 - x);
}

/** 자동 회복이 진행된 비율 (지연 뒤 지수) */
function recoverFraction(age, delay, tau) {
  if (age <= delay) return 0;
  return tau > 0 ? 1 - Math.exp(-(age - delay) / tau) : 1;
}

/**
 * 감쇠 스프링 x'' = −ω²x − 2ζωx' 를 dt 만큼 해석해로 진행 (부족·임계·과감쇠 모두) → 결과는 SP.
 * 반복 적분과 달리 프레임레이트와 무관하고 dt 가 커도 발산하지 않는다.
 */
function spring(x, v, dt, w, z) {
  if (!(w > 0) || !(dt > 0)) { SP.x = x; SP.v = v; return SP; }
  if (z < 1 - 1e-4) {
    const wd = w * Math.sqrt(1 - z * z);
    const e = Math.exp(-z * w * dt), c = Math.cos(wd * dt), s = Math.sin(wd * dt);
    SP.x = e * (x * c + ((v + z * w * x) / wd) * s);
    SP.v = e * (v * c - ((w * w * x + z * w * v) / wd) * s);
  } else if (z <= 1 + 1e-4) {
    const e = Math.exp(-w * dt), b = v + w * x;
    SP.x = (x + b * dt) * e;
    SP.v = (v - w * b * dt) * e;
  } else {
    const q = Math.sqrt(z * z - 1);
    const r1 = -w * (z - q), r2 = -w * (z + q);
    const c2 = (v - r1 * x) / (r2 - r1), c1 = x - c2;
    const e1 = Math.exp(r1 * dt), e2 = Math.exp(r2 * dt);
    SP.x = c1 * e1 + c2 * e2;
    SP.v = c1 * r1 * e1 + c2 * r2 * e2;
  }
  return SP;
}

/** 단위 속도 충격(x0 = 0, v0 = 1)에 대한 최대 변위 × ω — 충격 크기를 '최대 변위'로 맞출 때 나눈다 */
function impulsePeak(z) {
  if (z < 1 - 1e-4) {
    const q = Math.sqrt(1 - z * z);
    return Math.exp((-z * Math.atan2(q, z)) / q);
  }
  if (z <= 1 + 1e-4) return Math.exp(-1);
  const q = Math.sqrt(z * z - 1);
  const r1 = -(z - q), r2 = -(z + q);          // ω = 1 기준 두 근 (r2 < r1 < 0)
  const t = Math.log(r2 / r1) / (r1 - r2);     // 최대 변위 시각
  return (Math.exp(r1 * t) - Math.exp(r2 * t)) / (r1 - r2);
}

/**
 * 주파수가 서로 다른 사인 몇 개의 합 (−1 ~ 1). 주파수는 범위를 성분 수로 나눈 칸마다 하나씩 무작위
 * (느린 성분이 가장 큰 가중치). 위상을 적분하므로 config 의 주파수 범위를 바꿔도 신호가 끊기지 않는다.
 */
class SineNoise {
  constructor(weights) {
    this.w = weights;
    this.phase = new Float64Array(weights.length);
    this.u = new Float64Array(weights.length);
  }
  seed(rng) {
    const n = this.w.length;
    for (let k = 0; k < n; k++) {
      this.phase[k] = rng.range(0, TAU);
      this.u[k] = (k + rng.float()) / n;
    }
  }
  advance(dt, f0, f1) {
    for (let k = 0; k < this.w.length; k++) {
      const p = this.phase[k] + TAU * (f0 + (f1 - f0) * this.u[k]) * dt;
      this.phase[k] = p >= TAU ? p % TAU : p;
    }
  }
  value() {
    let s = 0;
    for (let k = 0; k < this.w.length; k++) s += this.w[k] * Math.sin(this.phase[k]);
    return s;
  }
}
