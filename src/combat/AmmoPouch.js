// =====================================================================
//  AmmoPouch — 5단계 낱발 탄약 주머니와 탄창 채우기 (순수 로직: three.js·DOM 없음)
//   · 탄창 6개와 별도로 낱발 CONFIG.ammo.loose 발 (무게는 장비에 더함). 임무 중 보급 없음.
//   · 채우기: 앉거나 엎드려 멈춘 채 (V 누르고 있기) 발당 roundTime 초 — 끼우지 않은 탄창 중 가장 적게 남은 것부터.
//     손을 떼거나·움직이거나·자세가 바뀌거나·제압 maxSuppression 이상이면 중단 → 그때까지 넣은 탄은 그대로 탄창에.
//     팔 하나 부상 = 시간 ×armMul, 양팔 부상 = 불가. 탄 계열(caliber)이 다른 총(주운 적 소총)에는 못 넣음.
//     재장전·탄창 확인 같은 무기 동작 중에는 시작하지 않음.
//   이벤트: 'start' {mag} · 'round' {mag, rounds, loose} (탄 넣는 소리·작은 소음) · 'stop' {reason, inserted}
//           reason: 'release' | 'move' | 'stance' | 'suppressed' | 'full' | 'empty' | 'busy' | 'arms'
//   읽기: loose, weightKg, label (주머니 무게감 — 숫자 없음), refilling, progress (이번 발 0~1)
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';

export class AmmoPouch extends EventEmitter {
  constructor(opts = {}) {
    super();
    const A = CONFIG.ammo;
    this.caliber = opts.caliber ?? A.caliber;
    this.initial = opts.rounds ?? A.loose;
    this.roundKg = opts.roundKg ?? CONFIG.weapons.rifle762.roundKg;
    this.reset(this.initial);
  }

  reset(rounds = this.initial) {
    this.loose = rounds;
    this.initial = rounds;
    this.refilling = false;
    this.mag = -1;
    this.t = 0;
    this.inserted = 0;
    this.loaded = 0;          // 이번 임무에서 탄창에 넣은 낱발 (결과 집계)
  }

  get weightKg() { return this.loose * this.roundKg; }

  /** 탄약 주머니 무게감 (T 길게) */
  get label() {
    const f = this.initial > 0 ? this.loose / this.initial : 0;
    for (const [min, lab] of CONFIG.ammo.pouchLabels) if (f >= min) return this.loose > 0 || min === 0 ? lab : '없음';
    return '없음';
  }

  /** 이번 발 진행도 (화면 동작용 0~1) */
  get progress() {
    return this.refilling ? Math.min(1, this.t / Math.max(1e-6, this._roundTime ?? CONFIG.ammo.roundTime)) : 0;
  }

  /** 지금 시작할 수 있는지와 안 되는 이유 (null = 가능) */
  blockReason(weapon, s) {
    const A = CONFIG.ammo;
    if (s.armsWounded >= 2) return 'arms';
    if (!weapon || weapon.data.caliber !== this.caliber) return 'caliber';
    if (this.loose <= 0) return 'empty';
    if (weapon.busy) return 'busy';
    if (!(s.stance === 'crouch' || s.stance === 'prone') || s.transitioning) return 'stance';
    if (s.speed > A.moveCancelSpeed) return 'move';
    if (s.suppression >= A.maxSuppression) return 'suppressed';
    if (weapon.refillIndex() < 0) return 'full';
    return null;
  }

  /**
   * 한 프레임. s: { held (V), stance, transitioning, speed, suppression, armsWounded (0|1|2) }
   * @returns {string|null} 이번 프레임에 막힌 이유 (누르기 시작했는데 못 할 때 — 토스트용, 한 번만)
   */
  update(dt, weapon, s) {
    const A = CONFIG.ammo;
    if (!this.refilling) {
      if (!s.held) { this._denied = null; this._needRelease = false; return null; }
      if (this._needRelease) return null;    // 끊긴 뒤에는 V 를 다시 눌러야 시작
      const why = this.blockReason(weapon, s);
      if (why) {
        if (this._denied === why) return null;
        this._denied = why;
        return why;
      }
      this.refilling = true;
      this.inserted = 0;
      this.t = 0;
      this.mag = weapon.refillIndex();
      this.emit('start', { mag: this.mag });
      return null;
    }
    // 채우는 중: 중단 조건
    let stop = null;
    if (!s.held) stop = 'release';
    else if (s.speed > A.moveCancelSpeed) stop = 'move';
    else if (!(s.stance === 'crouch' || s.stance === 'prone') || s.transitioning) stop = 'stance';
    else if (s.suppression >= A.maxSuppression) stop = 'suppressed';
    else if (s.armsWounded >= 2) stop = 'arms';
    else if (weapon.busy) stop = 'busy';
    if (stop) { this._stop(stop); return null; }
    const per = A.roundTime * (s.armsWounded >= 1 ? A.armMul : 1);
    this._roundTime = per;
    this.t += dt;
    while (this.t >= per && this.refilling) {
      this.t -= per;
      if (this.loose <= 0) { this._stop('empty'); break; }
      let i = this.mag;
      if (i < 0 || weapon.mags[i]?.rounds >= weapon.data.magCapacity || i === weapon.magIndex) i = this.mag = weapon.refillIndex();
      if (i < 0) { this._stop('full'); break; }
      weapon.addRound(i);
      this.loose--;
      this.inserted++;
      this.loaded++;
      this.emit('round', { mag: i, rounds: weapon.mags[i].rounds, loose: this.loose });
      // 가득 차면 다음으로 가장 적은 탄창 (모두 가득이면 끝)
      if (weapon.mags[i].rounds >= weapon.data.magCapacity) {
        this.mag = weapon.refillIndex();
        if (this.mag < 0) { this._stop('full'); break; }
      }
      if (this.loose <= 0) { this._stop('empty'); break; }
    }
    return null;
  }

  /** 맞았을 때 등 바깥에서 끊기 */
  cancel(reason = 'hit') { if (this.refilling) this._stop(reason); }

  _stop(reason) {
    this.refilling = false;
    this.t = 0;
    this._needRelease = true;
    this.emit('stop', { reason, inserted: this.inserted });
  }
}
