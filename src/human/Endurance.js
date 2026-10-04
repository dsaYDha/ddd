// =====================================================================
//  Endurance — 6단계 피로·갈증·수통 (순수 로직: three.js·DOM 없음 → Node 테스트 가능)
//   1단계 스태미나(순간 숨참)와 별개인 긴 수치. 숫자는 보여주지 않는다 — 숨소리·화면·움직임으로만.
//   · 피로 0~100: 임무 시간(base) + 걷기(move × 짐 무게 × 진흙 × 한낮 더위, 달리면 × sprintMul).
//       앉거나 엎드려 restStill 초 넘게 가만히 쉬면 분당 rest 씩 풀림.
//       효과: 스태미나 상한 × (1 − fatigueStamina·f) · 회복 × (1 − fatigueRegen·f) · 조준 흔들림 × (1 + fatigueSway·f)
//   · 갈증 100→0: 가만히 idle / 움직이면 move (달리면 × sprintMul) × (1 + heat·더위) · 비 × rainMul · 밤 × nightMul
//       50 아래: 흔들림 +, 회복 − · 25 아래: 맥박에 맞춰 시야가 어두워졌다 밝아짐 + 거친 숨 · 10 아래: 피로가 급히 최대로
//   · 수통 2개 (1L): drink — drinkTime 초 동안 멈추지 않고 마시면 갈증 +drinkGain (sip L), refill — 개울 얕은 물에 앉아 refillTime 초
//  단위: 비율은 실제 1분당 (CONFIG.endurance)
//  이벤트: 'drinkStart' · 'drink' {gain, left} · 'drinkCancel' {reason} · 'refillStart' · 'refill' {liters} · 'refillCancel' {reason}
//          'refused' {kind, reason} · 'stage' {thirst: 'ok'|'dry'|'parched'|'collapse', prev}
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Endurance extends EventEmitter {
  constructor(opts = {}) {
    super();
    const C = CONFIG.endurance.canteen;
    this.fatigue = opts.fatigue ?? 0;
    this.thirst = opts.thirst ?? 100;
    this.canteens = Array.from({ length: C.count }, () => C.liters);
    this.action = null;           // { kind: 'drink'|'refill', t, duration }
    this.still = 0;               // 가만히 있은 시간 (s)
    this.time = 0;
    this.rates = { fatigue: 0, thirst: 0 };   // 마지막 비율 (/분, 디버그·테스트)
    this.stage = 'ok';
    this._pulse = 0;
  }

  /** 남은 물 (L) */
  get water() { return this.canteens.reduce((a, b) => a + b, 0); }
  /** 수통 무게 (kg) — 장비 무게에 더함 */
  get kg() { return this.water + CONFIG.endurance.canteen.emptyKg * this.canteens.length; }
  get busy() { return !!this.action; }
  get progress() { return this.action ? Math.min(1, this.action.t / this.action.duration) : 0; }

  /**
   * @param {number} dt
   * @param {{ motor, heat?: number (0~1 한낮 더위), rain?: number, night?: number, loadKg?: number, swayExtra?: number }} ctx
   */
  update(dt, ctx = {}) {
    if (!(dt > 0)) return;
    const E = CONFIG.endurance, Fz = E.fatigue, Th = E.thirst, X = E.effects;
    this.time += dt;
    const m = ctx.motor;
    const speed = m ? m.speed : 0;
    const moving = speed > 0.15;
    const sprint = moving && m?.gait === 'sprint';
    const heat = clamp(ctx.heat ?? 0, 0, 1);
    const mins = dt / 60;
    this.still = moving ? 0 : this.still + dt;
    // ---- 피로
    let fr = Fz.base;
    if (moving) {
      const extraKg = Math.max(0, (ctx.loadKg ?? CONFIG.load.baseKg) - CONFIG.load.baseKg);
      const mud = m && (m.sink > 0.08 || isMud(m.surface)) ? Fz.mud : 1;
      fr += Fz.move * (1 + extraKg * Fz.loadPerKg) * mud * (1 + heat * Fz.heat) * (sprint ? Fz.sprintMul : 1);
    } else if (m && (m.stance === 'crouch' || m.stance === 'prone') && this.still >= Fz.restStill) {
      fr = -Fz.rest;
    }
    if (this.thirst < X.collapseBelow) fr += X.collapseRate;
    this.fatigue = clamp(this.fatigue + fr * mins, 0, 100);
    // ---- 갈증
    let tr = moving ? Th.move * (sprint ? Th.sprintMul : 1) : Th.idle;
    tr *= 1 + heat * Th.heat;
    if ((ctx.rain ?? 0) > 0.2) tr *= Th.rainMul;
    tr *= 1 - (1 - Th.nightMul) * clamp(ctx.night ?? 0, 0, 1);
    this.thirst = clamp(this.thirst - tr * mins, 0, 100);
    this.rates.fatigue = fr; this.rates.thirst = tr;
    // ---- 단계 (소리·화면 연결용)
    const st = this.thirst < X.collapseBelow ? 'collapse' : this.thirst < X.pulseBelow ? 'parched' : this.thirst < X.thirstBelow ? 'dry' : 'ok';
    if (st !== this.stage) { const prev = this.stage; this.stage = st; this.emit('stage', { thirst: st, prev }); }
    // ---- 마시기·채우기 동작
    const a = this.action;
    if (a) {
      if (m && speed > E.canteen.moveCancel) { this.cancel('move'); return; }
      if (a.kind === 'refill' && ctx.atWater === false) { this.cancel('water'); return; }
      a.t += dt;
      if (a.t >= a.duration) this._finish();
    }
  }

  // -----------------------------------------------------------------
  /** 마시기 시작 (U 누르는 동안). 물이 없거나 다른 동작 중이면 거절 */
  startDrink() {
    const C = CONFIG.endurance.canteen;
    if (this.action) return false;
    if (this.water < 0.01) { this.emit('refused', { kind: 'drink', reason: 'empty' }); return false; }
    this.action = { kind: 'drink', t: 0, duration: C.drinkTime };
    this.emit('drinkStart', {});
    return true;
  }

  /** 수통 채우기 시작 (개울 얕은 물에서 앉아 F). atWater: 지금 물가인지 (Game 이 판단) */
  startRefill(atWater) {
    const C = CONFIG.endurance.canteen;
    if (this.action) return false;
    if (!atWater) { this.emit('refused', { kind: 'refill', reason: 'water' }); return false; }
    if (this.water >= C.liters * this.canteens.length - 1e-6) { this.emit('refused', { kind: 'refill', reason: 'full' }); return false; }
    this.action = { kind: 'refill', t: 0, duration: C.refillTime };
    this.emit('refillStart', {});
    return true;
  }

  /** 손을 뗌·움직임·맞음 → 중단 (마시기는 마신 만큼은 아님 — 다 마셔야 효과, 채우기는 채운 비율만큼) */
  cancel(reason = 'release') {
    const a = this.action;
    if (!a) return;
    this.action = null;
    if (a.kind === 'refill') {
      // 채우던 만큼은 들어감
      const k = Math.min(1, a.t / a.duration);
      const added = this._fill(k * CONFIG.endurance.canteen.liters * this.canteens.length);
      this.emit('refillCancel', { reason, liters: added });
    } else this.emit('drinkCancel', { reason });
  }

  _finish() {
    const a = this.action, C = CONFIG.endurance.canteen;
    this.action = null;
    if (a.kind === 'drink') {
      // 가장 적게 남은(비지 않은) 수통부터
      let need = C.sip, used = 0;
      const order = this.canteens.map((v, i) => i).filter((i) => this.canteens[i] > 1e-6).sort((x, y) => this.canteens[x] - this.canteens[y]);
      for (const i of order) {
        const take = Math.min(need, this.canteens[i]);
        this.canteens[i] -= take; need -= take; used += take;
        if (need <= 1e-9) break;
      }
      const gain = C.drinkGain * (used / C.sip);
      this.thirst = clamp(this.thirst + gain, 0, 100);
      this.emit('drink', { gain, left: this.water });
    } else {
      const added = this._fill(Infinity);
      this.emit('refill', { liters: added });
    }
  }

  _fill(liters) {
    const C = CONFIG.endurance.canteen;
    let left = liters, added = 0;
    for (let i = 0; i < this.canteens.length && left > 0; i++) {
      const add = Math.min(C.liters - this.canteens[i], left);
      this.canteens[i] += add; left -= add; added += add;
    }
    return added;
  }

  // -----------------------------------------------------------------
  /** 효과 (Game·HUD·소리가 읽음) */
  effects(out = {}) {
    const X = CONFIG.endurance.effects;
    const f = this.fatigue / 100;
    const dry = clamp((X.thirstBelow - this.thirst) / X.thirstBelow, 0, 1);   // 50 → 0, 0 → 1
    out.staminaMaxMul = 1 - X.fatigueStamina * f;
    out.regenMul = (1 - X.fatigueRegen * f) * (1 - X.thirstRegen * dry);
    out.swayMul = (1 + X.fatigueSway * f) * (1 + X.thirstSway * dry);
    // 25 아래: 맥박에 맞춰 어두워졌다 밝아짐 (깊이 0 → pulseDepth), 거친 숨
    const parched = clamp((X.pulseBelow - this.thirst) / X.pulseBelow, 0, 1);
    out.pulse = parched > 0 ? X.pulseDepth * (0.35 + 0.65 * parched) : 0;
    out.roughBreath = parched > 0 ? 0.3 + 0.7 * parched : 0;
    out.fatigue = f;
    out.thirst = this.thirst;
    out.collapse = this.thirst < X.collapseBelow;
    return out;
  }

  /** 매 프레임: 스태미나 상한·회복, 조준 흔들림 */
  apply(motor, shooter = null) {
    const fx = this.effects(this._fx || (this._fx = {}));
    if (motor) {
      motor.setRestriction('endurance', { maxStamina: CONFIG.stamina.max * fx.staminaMaxMul });
      motor.regenMul = fx.regenMul;
    }
    if (shooter?.aim) {
      if (fx.swayMul > 1.001) shooter.aim.setExternal('endurance', { swayMul: fx.swayMul });
      else shooter.aim.clearExternal('endurance');
    }
    return fx;
  }

  /** 7단계: 보급 상자 물로 수통을 모두 가득 — 채운 양 (L) */
  refillAll() { return this._fill(CONFIG.endurance.canteen.liters * this.canteens.length); }

  snapshot() {
    return { fatigue: this.fatigue, thirst: this.thirst, canteens: this.canteens.slice() };
  }

  restore(s) {
    if (!s) return;
    this.fatigue = s.fatigue; this.thirst = s.thirst; this.canteens = s.canteens.slice();
    this.action = null; this.still = 0;
  }

  reset() {
    const C = CONFIG.endurance.canteen;
    this.fatigue = 0; this.thirst = 100; this.canteens = Array.from({ length: C.count }, () => C.liters);
    this.action = null; this.still = 0; this.stage = 'ok';
  }
}

const MUD = new Set(['shallowMud', 'deepMud', 'paddy']);
const SKEYS = Object.keys(CONFIG.surfaces);
function isMud(surface) {
  return MUD.has(typeof surface === 'number' ? SKEYS[surface] : surface);
}
