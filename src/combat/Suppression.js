// =====================================================================
//  Suppression — '사람' 공용 제압 컴포넌트
//  플레이어 전용이 아니다. HumanMotor 처럼 사람마다 하나씩 붙고, 4단계 적 병사도
//  같은 규칙(같은 config)으로 겁을 먹는다. 순수 로직 (three.js·DOM 없음 → Node 시뮬 가능).
//
//  수치 0~100
//   + 근접 통과: 빗나간 거리 → suppression.passGain 표 (0.3m 이하 +30, 1m +15, 2m +5, 사이 선형, 2m 초과 0)
//               연발이면 발마다 계속 누적
//   + 근처 착탄: ballistics.nearImpactRadius(2m) 이내 +impactGain(10)
//   + add():    외부 요인 (이후 단계: 폭발 등)
//   - 마지막 증가 후 decayDelay(2초) 동안 유지, 이후 초당 decayRate(12)씩 감소
//  단계: none < light(30 이상) < heavy(60 이상) < pinned(85 이상)
//
//  외부에서 읽기: value, level, normalized, timeSinceEvent, nearPasses, nearImpacts, effects()
//  이벤트: 'nearPass'   {...info, distance, gain, value, shakeDeg}
//          'nearImpact' {...info, distance, gain, value}
//          'add'        {...info, kind, gain, value}
//          'level'      {level, prev, value}   — add*() 직후와 update() 감소 중 단계가 바뀔 때
//  4단계 연결: 적 AI 가 level(heavy 이상이면 엄폐 뒤로 머리를 숙임)과 'nearPass'
//             (info.dir = 탄의 진행 방향 → 그 반대쪽에 사수, info.shooter)를 읽는다.
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { clamp } from '../core/math.js';

export const SUPPRESSION_LEVELS = Object.freeze(['none', 'light', 'heavy', 'pinned']);

export class Suppression extends EventEmitter {
  /** @param {object|null} owner  이 수치를 가진 사람 (People.Person 등) — 이벤트 구독자가 누구인지 알 수 있게 */
  constructor(owner = null) {
    super();
    this.owner = owner;
    this.value = 0;                  // 0~100
    this.level = 'none';
    this.timeSinceEvent = Infinity;  // 마지막 증가 이후 경과 (s) — 아직 없으면 Infinity
    this.gainMul = 1;                // 사람별 담력 차이 (4단계 적 병사용 배율, 기본 1)
    this.nearPasses = 0;             // 누적 횟수 (디버그·테스트)
    this.nearImpacts = 0;
  }

  // -----------------------------------------------------------------
  // 규칙 (config 를 호출 시점에 읽음 → 콘솔에서 고쳐도 바로 반영)
  // -----------------------------------------------------------------
  /** 빗나간 거리(m) → 증가량. passGain 표를 선형 보간 (첫 거리 이하 = 첫 값, 마지막 거리 초과 = 0) */
  static gainForPass(distance) {
    const table = CONFIG.suppression.passGain;
    if (!table || !table.length || Number.isNaN(distance)) return 0;
    if (distance <= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
      const d1 = table[i][0];
      if (distance <= d1) {
        const d0 = table[i - 1][0], g0 = table[i - 1][1], g1 = table[i][1];
        // 비율을 먼저 구해야 표의 거리에서 정확히 표의 값이 나온다 (1m → 15, 14.999… 아님)
        return d1 > d0 ? g0 + (g1 - g0) * ((distance - d0) / (d1 - d0)) : g1;
      }
    }
    return 0;
  }

  /** 근접 통과 순간 화면 흔들림 (°) — 가까울수록 크다 (증가량에 비례, 표 첫 값일 때 effects.shakeDeg) */
  static shakeForPass(distance) {
    const table = CONFIG.suppression.passGain;
    const top = table && table.length ? table[0][1] : 0;
    return top > 0 ? CONFIG.suppression.effects.shakeDeg * Suppression.gainForPass(distance) / top : 0;
  }

  /** 수치 → 단계 */
  static levelFor(value) {
    const L = CONFIG.suppression.levels;
    if (value >= L.pinned) return 'pinned';
    if (value >= L.heavy) return 'heavy';
    if (value >= L.light) return 'light';
    return 'none';
  }

  get normalized() { return this.value / 100; }

  // -----------------------------------------------------------------
  // 증가
  // -----------------------------------------------------------------
  /**
   * 맞지 않고 지나간 탄 (CombatSystem 이 Ballistics 'nearPass' 를 받아 호출).
   * 증가량이 0 이면(표 범위 밖) 이벤트도 대기 시간 초기화도 없다 — 2m 밖은 '근접 통과'가 아니다.
   * mul: 무기별 배율 (4단계 경기관총 suppressionMul · 양각대 거치 bipodSuppressionMul — CombatSystem 이 넘김)
   * @returns {number} 이번 증가량 (100 상한으로 잘리기 전 값)
   */
  addNearPass(distance, info = {}, mul = 1) {
    const gain = Suppression.gainForPass(distance) * this.gainMul * (Number.isFinite(mul) && mul > 0 ? mul : 1);
    if (!(gain > 0)) return 0;
    this.nearPasses++;
    this._raise(gain);
    // info 를 먼저 펼치고 계산값을 뒤에 — 같은 키가 와도 이 컴포넌트 값이 이긴다
    this.emit('nearPass', { ...info, distance, gain, value: this.value, shakeDeg: Suppression.shakeForPass(distance) });
    this._refreshLevel();
    return gain;
  }

  /**
   * 근처 착탄 (흙 튐·파편). 판정 거리는 라우팅과 같은 ballistics.nearImpactRadius 를 쓴다
   * (suppression.impactRadius 를 따로 두면 그쪽이 우선) — 두 값이 어긋나 착탄이 무시되는 일이 없게.
   */
  addNearImpact(distance, info = {}) {
    const S = CONFIG.suppression;
    const radius = S.impactRadius ?? CONFIG.ballistics.nearImpactRadius;
    if (!(distance <= radius)) return 0;
    const gain = S.impactGain * this.gainMul;
    if (!(gain > 0)) return 0;
    this.nearImpacts++;
    this._raise(gain);
    this.emit('nearImpact', { ...info, distance, gain, value: this.value });
    this._refreshLevel();
    return gain;
  }

  /**
   * 외부 요인. 양수면 이벤트로 취급(감소 대기 초기화), 음수면 그냥 줄인다.
   * @returns {number} 실제 변화량 (0~100 범위로 잘린 뒤)
   */
  add(amount, kind = 'external', info = {}) {
    if (!amount) return 0;   // 0, NaN
    const before = this.value;
    if (amount > 0) this._raise(amount * this.gainMul);
    else this.value = clamp(before + amount, 0, 100);
    this.emit('add', { ...info, kind, gain: this.value - before, value: this.value });
    this._refreshLevel();
    return this.value - before;
  }

  // -----------------------------------------------------------------
  // 감소
  // -----------------------------------------------------------------
  update(dt) {
    if (!(dt > 0)) return;
    const S = CONFIG.suppression;
    this.timeSinceEvent += dt;
    if (this.value > 0) {
      // 이번 프레임 중 대기 시간을 넘긴 부분만 감소 → 프레임레이트와 무관하게 같은 시간표
      const t = Math.min(dt, this.timeSinceEvent - S.decayDelay);
      if (t > 0) this.value = Math.max(0, this.value - S.decayRate * t);
    }
    this._refreshLevel();
  }

  /**
   * 플레이어 지속 효과 (전부 수치에 비례, 수치 100 기준 최대값 = config.suppression.effects).
   * 매 프레임 부를 때는 out 을 재사용할 것.
   *  swayMul    : 조준 흔들림 배율 1 → swayMaxMul, 완전 제압(85 이상)이면 pinnedSwayMul 추가
   *  tremorDeg  : 지속적인 미세 떨림 (°)
   *  heartStress: 심박 긴장 (motor.stress 0~1)
   *  tunnel     : 터널 시야 (0~1)
   *  muffle     : 주변 소리 먹먹함 (0~1)
   */
  effects(out = {}) {
    const S = CONFIG.suppression, E = S.effects;
    const v = clamp(this.value, 0, 100), n = v / 100;
    out.swayMul = (1 + (E.swayMaxMul - 1) * n) * (v >= S.levels.pinned ? E.pinnedSwayMul : 1);
    out.tremorDeg = E.tremorDeg * n;
    out.heartStress = E.heartStress * n;
    out.tunnel = E.tunnel * n;
    out.muffle = E.muffle * n;
    return out;
  }

  reset() {
    this.value = 0;
    this.timeSinceEvent = Infinity;
    this.nearPasses = 0;
    this.nearImpacts = 0;
    this._refreshLevel();
  }

  // -----------------------------------------------------------------
  _raise(gain) {
    this.value = clamp(this.value + gain, 0, 100);
    this.timeSinceEvent = 0;
  }

  _refreshLevel() {
    const level = Suppression.levelFor(this.value);
    if (level === this.level) return;
    const prev = this.level;
    this.level = level;
    this.emit('level', { level, prev, value: this.value });
  }
}
