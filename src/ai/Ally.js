// =====================================================================
//  Ally — 7단계 아군 분대원 (순수 로직). 4단계 적 병사(Soldier = 사람 개체 + 사수 + AI 두뇌)를 그대로 이어받아
//   같은 이동·사격·제압·부상·피로·갈증·밤 시야·함정 규칙을 받는다 (AI 예외 없음). 대형 자리·명령은 분대(FriendSquad)가 정한다.
//   역할(job): point 첨병 (앞에서 조용히 걸으며 함정을 찾음) · radio 무전병 (플레이어 곁 — 지원 화력 요청) · mg 기관총수 ·
//             medic 의무병 · rifleman 소총수
//   · 명령: 받은 뒤 0.5~2초에 실행 (queueOrder). 제압 pinned(60) 이상이면 이동 명령은 미뤄짐 (resume 45 아래로 내려가야 따름)
//   · 교전: 보이는 적에게 스스로 (4단계 실수 규칙 — 반응 지연·첫발 빗나감·공황 사격), 대형 자리 근처 엄폐. 사격 통제 (금지·자유·내가 쏘면·제압)
//   · 의무병: 다친 분대원·플레이어에게 달려가 플레이어보다 1.5배 빠르게 처치 (자기 물자) · 부상자 끌기(교전)·업기(이동) · 탄약 던져주기
//   · 업힌 동안(carriedBy) 이동 컴포넌트는 멈추고 업은 사람 어깨 위 (EnemyManager._syncCarries)
// =====================================================================
import { CONFIG } from '../config.js';
import { Soldier } from './Soldier.js';
import { Endurance } from '../human/Endurance.js';

const rr = (rng, r) => rng.range(r[0], r[1]);
const EMPTY = [];
const MOVE_ORDERS = new Set(['follow', 'halt', 'moveTo', 'retreat', 'hold', 'prone']);
const DEFAULT_ENV = { heat: 0, rain: 0, night: 0 };
const ARM_TYPES = new Set(['upperArm', 'forearm']);

export class Ally extends Soldier {
  /**
   * @param {import('./EnemyManager.js').EnemyManager} manager
   * @param {{ x, z, yaw?, rng, job: 'point'|'radio'|'mg'|'medic'|'rifleman', name: string, voice?: number }} opts
   */
  constructor(manager, opts) {
    const A = CONFIG.allies;
    const job = opts.job ?? 'rifleman';
    super(manager, {
      ...opts, faction: 'friend', role: job === 'mg' ? 'mg' : 'rifleman', weapon: job === 'mg' ? A.mgWeapon : A.weapon,
      name: opts.name ?? '분대원',
    });
    this.job = job;
    if (opts.voice !== undefined) this.voice = opts.voice;
    this.variant = opts.variant ?? this.variant;
    // 내가 지금 따르는 명령 (분대가 낸 것을 받은 뒤 — 사람마다 다를 수 있음: 수신호를 못 본 사람)
    this.ord = { move: 'follow', point: null, dir: null, prone: false, formation: 'auto', fire: 'free', suppress: null, holdPos: null, since: 0 };
    this.pendingOrders = [];
    this.medKit = job === 'medic' ? { bandages: A.medic.bandages, tourniquets: A.medic.tourniquets } : null;
    this.hasRadio = job === 'radio';
    this.treat = null;           // 의무병 처치: { patient, kind, wound, t, duration }
    this.give = null;            // 탄약 던져주기: { phase, t }
    this.carry = null;           // 업기: { wounded, phase: 'approach'|'pick'|'carry', t }
    this.carriedBy = null;
    this.beingTreated = null;    // 처치해 주는 사람
    this.endurance = new Endurance();
    this.friendlyHits = 0;       // 아군에게 맞은 횟수 (결과)
    this.loose = job === 'mg' ? 0 : (A.looseRounds ?? 60);   // 낱발 (쓰러지면 플레이어가 회수)
    this.looted = false;
    this._sayAt = -Infinity;
    this._ffAt = -Infinity;
    this._coverAnchor = null;
  }

  get label() { return `${this.name} (${CONFIG.allies.roleLabels[this.job] ?? this.job})`; }
  /** 의식 없음 (혈액 faint 미만이거나 쓰러져 처치 중이 아닌 것) — 명령을 못 받음 */
  get unconscious() { return !this.alive || this.injuries.blood < CONFIG.injury.thresholds.faint; }
  /** 걸을 수 없음 (업거나 끌어야) */
  get cannotWalk() { return this.alive && (this.injuries.effects().downed || this.injuries.blood < CONFIG.injury.thresholds.faint); }
  /** 예비 탄창 (지금 끼운 것 빼고, 탄이 있는 것) */
  get spareMags() {
    const w = this.shooter.weapon;
    let n = 0;
    for (let i = 0; i < w.mags.length; i++) if (i !== w.magIndex && w.mags[i].rounds > 0) n++;
    return n;
  }

  /** 말하기: 고함(소음 — 적도 들음) + 자막 ('say') */
  say(text, kind = 'call', opts = {}) {
    if (!this.alive && kind !== 'scream') return false;
    const now = this.now;
    if (!opts.force && now - this._sayAt < (opts.gap ?? 1.2)) return false;
    this._sayAt = now;
    if (!opts.quiet) this.manager.shout(this, kind, true, true);   // 소리 내어 말함 (소음 — 적도 들음). 속삭임은 소음 없음
    this.manager.emit('say', { soldier: this, text, kind, quiet: !!opts.quiet });
    return true;
  }

  // =================================================================
  // 명령
  // =================================================================
  /** 명령 받기 (분대가 부름 — 실행은 delay 초 뒤) */
  queueOrder(order, delay) {
    this.pendingOrders.push({ ...order, at: this.now + delay });
  }

  _applyOrders(now) {
    if (!this.pendingOrders.length) return;
    const S = CONFIG.ai.suppression;
    const keep = [];
    for (const o of this.pendingOrders) {
      if (now < o.at) { keep.push(o); continue; }
      // 강하게 제압당하면 이동 명령을 못 따름 (내려갈 때까지 미룸)
      if (MOVE_ORDERS.has(o.key) && (this.pinned || this.suppression >= S.pinned)) { keep.push(o); continue; }
      this._apply(o, now);
    }
    this.pendingOrders = keep;
  }

  _apply(o, now) {
    const ord = this.ord, p = this.motor.position;
    this.manager.emit('orderApplied', { soldier: this, order: o });
    switch (o.key) {
      case 'follow': ord.move = 'follow'; ord.prone = false; ord.holdPos = null; ord.point = null; break;
      case 'halt': ord.move = 'halt'; ord.holdPos = { x: p.x, z: p.z }; break;
      case 'hold': ord.move = 'hold'; ord.holdPos = { x: p.x, z: p.z }; break;
      case 'prone': ord.prone = true; if (ord.move === 'follow') { ord.move = 'halt'; ord.holdPos = { x: p.x, z: p.z }; } break;
      case 'moveTo': ord.move = 'moveTo'; ord.point = o.point ? { x: o.point.x, z: o.point.z } : null; ord.dir = o.dir ?? null; ord.prone = false; break;
      case 'retreat': ord.move = 'retreat'; ord.point = o.point ? { x: o.point.x, z: o.point.z } : null; ord.dir = o.dir ?? null; ord.prone = false; break;
      case 'file': case 'wedge': case 'spread': ord.formation = o.key; break;
      case 'holdFire': ord.fire = 'hold'; break;
      case 'freeFire': ord.fire = 'free'; break;
      case 'onMyShot': ord.fire = this.squad?.playerFiredAt > o.issuedAt ? 'free' : 'onMyShot'; break;
      case 'suppress': ord.prevFire = ord.fire === 'suppress' ? ord.prevFire : ord.fire; ord.fire = 'suppress';
        ord.suppress = { point: o.point ? { x: o.point.x, y: o.point.y ?? 0, z: o.point.z } : null, until: now + CONFIG.allies.suppressTime }; break;
      case 'medic': if (this.job === 'medic') this.squad?.medicToPlayer(this); break;
      case 'ammo': if (o.giver === this) this._startGive(); break;
      default: break;
    }
    ord.since = now;
  }

  // =================================================================
  // 프레임
  // =================================================================
  update(dt) {
    if (!(dt > 0)) return;
    if (this.alive && !this.fall) { this._applyOrders(this.now); this._tickTasks(dt); }
    super.update(dt);
    if (this.alive) {
      // 6단계 피로·갈증 (같은 규칙) — 무전기 무게
      if (this.hasRadio) this.motor.loadKg += CONFIG.allies.radioKg;
      const env = this.manager.fieldEnv ?? DEFAULT_ENV;
      const E = this.endurance;
      E.update(dt, { motor: this.motor, heat: env.heat, rain: env.rain, night: env.night, loadKg: this.motor.loadKg });
      E.apply(this.motor, this.shooter);
      // 목이 마르면 멈춰 있을 때 수통을 마심 (물이 있으면)
      if (!E.busy && E.thirst < 45 && E.water > 0.01 && this.motor.speed < 0.1 && this.squad?.state !== 'contact' && !this.treat && !this.carry) E.startDrink();
    }
  }

  /** 매 프레임: 처치·업기 진행 시간 */
  _tickTasks(dt) {
    const T = this.treat;
    if (T && T.active) {
      T.t += dt;
      if (T.t >= T.duration) this._finishTreat();
    }
    const C = this.carry;
    if (C && C.phase === 'pick') {
      C.t += dt;
      if (C.t >= CONFIG.allies.carry.pickTime) this._pickUp();
    }
    const G = this.give;
    if (G && G.phase === 'throw') {
      G.t += dt;
      if (G.t >= 0.55) this._throwMag();
    }
  }

  // =================================================================
  // 판단 (초당 6~9회)
  // =================================================================
  _think() {
    const now = this.now, inj = this.injuries, S = CONFIG.ai.suppression;
    // 기억: 시간이 지나면 흐려짐
    const mem = this.memory;
    if (mem.valid) {
      const M = CONFIG.ai.memory;
      const age = now - mem.time;
      mem.uncertainty = Math.min(M.maxUncertainty, mem.base + M.uncertaintyGrowth * age);
      if (age > M.forget) mem.valid = false;
    }
    if (this.perception.seen) this._sawTarget();
    const sv = this.suppression;
    if (sv >= S.pinned) this.pinned = true;
    else if (this.pinned && sv <= S.resume) { this.pinned = false; this.peekUntil = now + rr(this.rng, S.peekTime); }
    // 탄창: 비었으면 / 뜸할 때 조금 남았으면
    this._reloadPressed = false;

    let mode;
    if (inj.stunned) mode = 'stunned';
    else if (this.carriedBy) mode = 'carried';
    else if (this.draggedBy) mode = 'dragged';
    else if (this.drag) mode = 'drag';
    else if (this.carry) mode = 'carry';
    else if (sv >= S.cower) mode = 'cower';
    else if (this.pinned) mode = 'pinned';
    else if (this.treat) mode = 'treat';
    else if (this.beingTreated) mode = 'treated';
    else if (this._needsWoundCare()) mode = 'wounded';
    else if (this.give) mode = 'give';
    else mode = 'slot';
    if (mode !== this.mode) {
      const prev = this.mode;
      this.mode = mode;
      this._enterMode(mode, prev);
    }
    this.paceIntent = 1;
    const fn = this['_m_' + mode];
    if (fn) fn.call(this, now);
    // 재장전
    const w = this.shooter.weapon;
    if (!w.busy && w.totalRounds > 0 && mode !== 'carry' && mode !== 'carried') {
      const frac = w.magRounds / Math.max(1, w.data.magCapacity);
      if ((!w.chambered && w.magRounds === 0) || (frac < CONFIG.ai.fire.reloadBelow && !this.perception.seen && now - this.perception.lastSeen > 3 && this.fire.burstLeft === 0)) {
        if (w._bestSpareMag() >= 0) {
          this._reloadPressed = true;
          if (this.squad?.state === 'contact' && this.rng.chance(0.5)) this.say('재장전!', 'reload', { gap: 4 });
        }
      }
    }
    if (w.totalRounds === 0 && this.squad?.state === 'contact') this.say('탄약 떨어졌다!', 'ammo', { gap: 20 });
  }

  _enterMode(mode, prev) {
    if (mode !== 'slot' && mode !== 'wounded' && mode !== 'pinned') this.fire.mode = 'none';
    if (prev === 'slot' || prev === 'give') this.goal = null;
    if (mode === 'pinned' || mode === 'cower') this._releaseTrigger();
    if (mode === 'carried' || mode === 'carry') this._releaseTrigger();
    this.manager.emit('modeChange', { soldier: this, mode, prev });
  }

  _needsWoundCare() {
    const inj = this.injuries;
    if (!inj.hasWounds) return false;
    if (inj.downed || inj.aid) return true;
    if (inj.bleedRate <= 0.5) return false;
    // 의무병이 오고 있으면 기다림 (멀거나 오래 걸리면 스스로)
    const med = this.squad?.medicFor?.(this);
    if (med && med.alive && Math.hypot(med.motor.position.x - this.motor.position.x, med.motor.position.z - this.motor.position.z) < 40) return true;
    if (inj.bandages <= 0 && inj.tourniquets <= 0) return false;
    return !this.perception.seen;
  }

  // =================================================================
  // 행동 모드
  // =================================================================
  _m_carried() { this.goal = null; this.fire.mode = 'none'; this.wantStance = 'prone'; }

  _m_treated(now) {
    // 의무병이 처치하는 동안 가만히 (낮은 자세)
    this.goal = null;
    this.fire.mode = 'none';
    this.wantStance = this.injuries.downed ? 'prone' : 'crouch';
    const th = this._threatPoint();
    this.lookAt = th; this.lookMode = th ? 'point' : 'scan';
    const T = this.beingTreated?.treat;
    if (!T || T.patient !== this) this.beingTreated = null;
  }

  /** 부상: 의무병이 오면 기다리고, 없으면 4단계 규칙대로 스스로 (엄폐로 기어가 붕대·지혈대) */
  _m_wounded(now) {
    const med = this.squad?.medicFor?.(this);
    const inj = this.injuries;
    if (med && med.alive && !inj.aid) {
      this.goal = null;
      this.wantStance = inj.downed ? 'prone' : 'crouch';
      const th = this._threatPoint();
      if (this.perception.seen && !inj.weaponDropped && !inj.wounds.some((w) => ARM_TYPES.has(w.type))) {
        this.lookAt = th; this.lookMode = 'aim';
        this._chooseFire(now, true);
      } else { this.fire.mode = 'none'; this.lookAt = th; this.lookMode = th ? 'point' : 'scan'; }
      // 도움 요청
      if (inj.bleedRate > 0 && now - this._lastHelp > rr(this.rng, CONFIG.ai.wounded.helpInterval)) {
        this._lastHelp = now;
        this.say('의무병!', 'help', { gap: 4 });
      }
      return;
    }
    super._m_wounded(now);
  }

  /** 대형 자리 (따라와·정지·이동·후퇴·대기·엎드려) + 교전 (자리 근처 엄폐·사격) */
  _m_slot(now) {
    const sq = this.squad;
    if (!sq) { this.goal = null; return; }
    const slot = sq.slotFor(this);
    const p = this.motor.position;
    const contact = sq.state === 'contact';
    const th = contact ? this._threatPoint() : null;
    const ord = this.ord;
    if (!slot) { this.goal = null; this.wantStance = 'crouch'; return; }
    const dSlot = Math.hypot(slot.x - p.x, slot.z - p.z);
    if (contact && th) {
      // 교전: 자리 근처(8m) 엄폐물 — 자리가 멀어지면 다시 고름
      const anchor = this._coverAnchor;
      if (!anchor || Math.hypot(anchor.x - slot.x, anchor.z - slot.z) > 8) { this._coverAnchor = { x: slot.x, z: slot.z }; this.cover = null; }
      if (!this.cover) this._findCoverNear(slot, th);
      const c = this.cover;
      const isMg = this.weaponData.bipod;
      if (c && dSlot < 14) {
        const peekX = c.kind === 'hard' ? c.peekX : c.hideX, peekZ = c.kind === 'hard' ? c.peekZ : c.hideZ;
        this._goTo(peekX, peekZ, this._moveUnderFire(), { combat: true, arrive: 0.8 });
      } else if (dSlot > 2.5) this._goTo(slot.x, slot.z, dSlot > 8 ? 'run' : 'walk', { combat: true, arrive: 1.2 });
      else this.goal = null;
      const there = this._atGoal();
      this.wantStance = ord.prone ? 'prone' : !there ? (this.suppression >= CONFIG.ai.suppression.lowStance ? 'crouch' : 'stand')
        : isMg || this.suppression >= CONFIG.ai.suppression.lowStance || (c && c.kind === 'soft') ? 'prone' : 'crouch';
      this.lookAt = th; this.lookMode = 'aim';
      this._chooseFire(now, there || this.perception.seen);
      return;
    }
    this._coverAnchor = null;
    this.cover = null;
    // 평시: 자리로 (속도는 플레이어 걸음에 맞춤)
    this.fire.mode = 'none';
    if (dSlot < (slot.hold ? 1.2 : 0.9) && (slot.hold || slot.still)) {
      this.goal = null;
    } else {
      const C = CONFIG.allies.catchUp;
      let pace = slot.pace ?? 'walk';
      // 뒤처지면 보통 걸음으로 따라잡음 — 첨병은 많이 (9m) 뒤처졌을 때만, 4m 안으로 오면 다시 조용히 (땅을 살피는 걸음)
      if (this.job === 'point') this._catchUp = dSlot > 9 || (this._catchUp && dSlot > 4);
      if (dSlot > C.run) pace = 'run';
      else if ((this.job === 'point' ? this._catchUp : dSlot > C.walk) && (pace === 'quiet' || pace === 'sneak')) pace = 'walk';
      this.paceIntent = dSlot < C.walk ? (slot.intent ?? 1) : 1;
      // 첨병: 움직이는 자리보다 조금 앞을 목표로 (도착해 멈췄다 다시 걷는 일 없이 조용한 걸음으로 계속 — 처지지 않게)
      let gx = slot.x, gz = slot.z;
      if (this.job === 'point' && !slot.still && !slot.hold) {
        const H = sq._heading, lead = this.manager.nav.nearestOpen(gx + H.x * 3, gz + H.z * 3, 2);
        if (lead) { gx = lead.x; gz = lead.z; }
      }
      this._goTo(gx, gz, pace, { arrive: slot.hold ? 1.0 : 0.8, direct: dSlot < 18 && this.manager.nav.lineWalkable(p, { x: gx, z: gz }, 6) });
    }
    this.wantStance = ord.prone ? 'prone' : slot.stance ?? 'stand';
    // 시선: 맡은 방향 (첨병 앞쪽 땅·뒤쪽 경계 등)
    if (sq.threat && now - (sq.threat.time ?? -Infinity) < 12) { this.lookAt = sq.threat; this.lookMode = 'scanPoint'; this.scanAmp = 0.6; }
    else if (slot.look) { this.lookAt = slot.look; this.lookMode = 'scanPoint'; this.scanAmp = slot.scanAmp ?? 0.7; }
    else this.lookMode = 'move';
    // '제압 사격' 명령: 평시에도 지정 지점으로
    if (ord.fire === 'suppress' && ord.suppress?.point && now < ord.suppress.until) {
      this.goal = dSlot > 3 ? this.goal : null;
      this.lookAt = ord.suppress.point; this.lookMode = 'aim';
      this._chooseFire(now, true);
    }
  }

  /** 목표가 거의 같으면 새로 만들지 않음 (플레이어를 따라 자리가 계속 움직여도 경로 요청이 넘치지 않게) */
  _goTo(x, z, pace, opts) {
    const g = this.goal;
    if (g && !g.done && Math.hypot(g.x - x, g.z - z) < 1.5 && g.pace === pace) { g.arrive = opts.arrive ?? g.arrive; return; }
    this._setGoal(x, z, pace, opts);
  }

  _findCoverNear(slot, th) {
    const now = this.now;
    if (now - this._coverAt < 1.5) return;
    this._coverAt = now;
    const taken = this.manager.takenCover(this);
    const list = this.manager.nav.findCover(slot, th, { radius: 8, taken, max: 3 });
    this.cover = list[0] ?? null;
    this.goal = null;
  }

  /** 의무병 처치: 환자에게 달려가 옆에서 (플레이어보다 1.5배 빠르게) */
  _m_treat(now) {
    const T = this.treat, M = CONFIG.allies.medic;
    const pat = T.patient;
    const pinj = pat.injuries;
    if (!pat.alive || !pinj || pinj.dead || !this.medKit || (!this.medKit.bandages && !this.medKit.tourniquets)) { this._endTreat(); return; }
    const kind = pinj.treatmentKind(this.medKit.tourniquets > 0);
    if (!kind || (kind === 'bandage' && !this.medKit.bandages)) { this._endTreat(); return; }
    const pp = pat.motor.position, p = this.motor.position;
    const d = Math.hypot(pp.x - p.x, pp.z - p.z);
    this.fire.mode = 'none';
    if (d > M.range) {
      T.active = false;
      this._goTo(pp.x, pp.z, d > 6 ? 'run' : 'walk', { combat: this.squad?.state === 'contact', arrive: M.range * 0.75, direct: d < 12 });
      this.wantStance = d > 6 ? 'stand' : 'crouch';
      this.lookMode = 'move';
      return;
    }
    // 옆에 도착: 웅크려 처치 (환자가 움직이면 멈춤)
    this.goal = null;
    this.wantStance = 'crouch';
    this.lookAt = pp; this.lookMode = 'point';
    const moving = Math.hypot(pat.motor.velocity.x, pat.motor.velocity.z) > 0.6;
    if (!T.active || T.kind !== kind) {
      const w = pinj.treatmentTarget(kind);
      if (!w) { this._endTreat(); return; }
      const base = kind === 'bandage' ? CONFIG.injury.aid.bandageTime : CONFIG.injury.aid.tourniquetTime;
      if (T.kind !== kind || T.wound !== w) T.t = 0;   // 같은 상처를 하던 중이면 이어서
      T.kind = kind; T.wound = w; T.duration = base / M.speedMul;
      T.active = true;
      if (pat !== this.squad?.playerRef) pat.beingTreated = this;
      this.manager.emit('treat', { medic: this, patient: pat, phase: 'start', kind, duration: T.duration });
    }
    if (moving || this.suppression >= 85) T.active = false;
  }

  _finishTreat() {
    const T = this.treat;
    T.active = false;
    const pat = T.patient, pinj = pat.injuries;
    if (pinj && T.wound && pinj.applyTreatment(T.kind, T.wound)) {
      if (T.kind === 'bandage') this.medKit.bandages--; else this.medKit.tourniquets--;
      this.manager.emit('treat', { medic: this, patient: pat, phase: 'done', kind: T.kind, wound: T.wound });
    }
    T.t = 0; T.kind = null; T.wound = null;
    // 다음 상처가 있으면 이어서 (판단 때)
  }

  _endTreat() {
    const T = this.treat;
    if (!T) return;
    if (T.patient?.beingTreated === this) T.patient.beingTreated = null;
    this.treat = null;
    this.goal = null;
    this.manager.emit('treat', { medic: this, patient: T.patient, phase: 'end' });
  }

  /** 의무병에게 환자 맡기기 (분대가 부름) */
  assignTreat(patient) {
    if (this.treat?.patient === patient) return;
    if (this.treat) this._endTreat();
    this.treat = { patient, kind: null, wound: null, t: 0, duration: 1, active: false };
    this.goal = null;
  }

  // ---- 탄약 던져주기 ----------------------------------------------------
  _startGive() {
    if (this.spareMags < CONFIG.allies.giveAmmo.minMags) { this.say('탄창이 얼마 없다!', 'ammo', { force: true }); return false; }
    this.give = { phase: 'approach', t: 0 };
    this.say('탄창 간다!', 'ammo', { force: true });
    return true;
  }

  _m_give(now) {
    const G = this.give, pl = this.manager.player;
    if (!pl || !pl.alive) { this.give = null; return; }
    const pp = pl.motor.position, p = this.motor.position;
    const d = Math.hypot(pp.x - p.x, pp.z - p.z);
    const R = CONFIG.allies.giveAmmo.throwRange;
    this.fire.mode = 'none';
    this.lookAt = pp; this.lookMode = 'point';
    if (G.phase === 'approach') {
      if (d > R) { this._goTo(pp.x, pp.z, d > 15 ? 'run' : 'walk', { arrive: R * 0.8, direct: d < 15 }); this.wantStance = 'stand'; }
      else { G.phase = 'throw'; G.t = 0; }
    }
    if (G.phase === 'throw' && d > R * 1.6) G.phase = 'approach';   // 그새 멀어짐
  }

  _throwMag() {
    const G = this.give;
    this.give = null;
    const w = this.shooter.weapon, i = w._bestSpareMag();
    if (i < 0) return;
    const rounds = w.mags[i].rounds;
    w.mags.splice(i, 1);
    if (i < w.magIndex) w.magIndex--;
    this.squad?.ammoThrown(this, rounds);
    void G;
  }

  // ---- 업기 -------------------------------------------------------------
  assignCarry(w) {
    this.carry = { wounded: w, phase: 'approach', t: 0 };
    this.goal = null;
  }

  _m_carry(now) {
    const C = this.carry, w = C.wounded;
    const A = CONFIG.allies.carry;
    if (!w.alive || this.injuries.downed || (C.phase !== 'carry' && w.carriedBy && w.carriedBy !== this)) { this.dropCarry(); return; }
    this.fire.mode = 'none';
    const p = this.motor.position, wp = w.motor.position;
    if (C.phase === 'approach') {
      const d = Math.hypot(wp.x - p.x, wp.z - p.z);
      this._goTo(wp.x, wp.z, d > 6 ? 'run' : 'walk', { arrive: 1.0, direct: d < 10 });
      this.wantStance = 'stand';
      this.lookMode = 'move';
      if (d < 1.3) { C.phase = 'pick'; C.t = 0; this.goal = null; this.wantStance = 'crouch'; }
      return;
    }
    if (C.phase === 'pick') { this.goal = null; this.wantStance = 'crouch'; return; }
    // 업고 대형 자리로 (느리게 · 쏘지 않음) — 교전·제압이면 내려놓음
    if (this.suppression >= A.dropSuppression || (this.squad?.state === 'contact' && this.perception.seen)) { this.dropCarry(); return; }
    const slot = this.squad?.slotFor(this);
    if (slot) {
      const d = Math.hypot(slot.x - p.x, slot.z - p.z);
      if (d > 1.5) this._goTo(slot.x, slot.z, 'walk', { arrive: 1.2 }); else this.goal = null;
    }
    this.wantStance = 'stand';
    this.lookMode = 'move';
  }

  _pickUp() {
    const C = this.carry, w = C.wounded;
    if (!w.alive || w.carriedBy || w.draggedBy) { this.dropCarry(); return; }
    C.phase = 'carry';
    w.carriedBy = this;
    w._releaseTrigger?.();
    if (w.motor.stance !== 'prone') w.motor.forceStance('prone', 0.1);
    this.motor.setRestriction('carry', { maxSpeed: CONFIG.allies.carry.speed, canSprint: false, canJump: false, canProne: false });
    this.manager.emit('carry', { soldier: this, wounded: w, phase: 'start' });
  }

  /** 내려놓기 (교전·도착·명령) */
  dropCarry() {
    const C = this.carry;
    if (!C) return;
    this.carry = null;
    this.motor.clearRestriction('carry');
    const w = C.wounded;
    if (w && w.carriedBy === this) {
      w.carriedBy = null;
      const p = this.motor.position, yaw = this.motor.yaw;
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const q = this.manager.nav.nearestOpen(p.x + rx * 0.9, p.z + rz * 0.9, 2) ?? { x: p.x + rx * 0.9, z: p.z + rz * 0.9 };
      w.motor.teleport(q.x, q.z, yaw);
      if (w.motor.stance !== 'prone') w.motor.forceStance('prone', 0.1);
    }
    this.goal = null;
    this.manager.emit('carry', { soldier: this, wounded: w, phase: 'end' });
  }

  // =================================================================
  // 사격 통제
  // =================================================================
  _chooseFire(now, ready) {
    const ord = this.ord, F = this.fire;
    if (this.carry || this.carriedBy || this.give) { F.mode = 'none'; return; }
    // 제압 사격 명령: 지정 지점 주변으로 (보이는 적이 있으면 그쪽 먼저)
    if (ord.fire === 'suppress' && ord.suppress && now < ord.suppress.until && !this.perception.seen) {
      const p = ord.suppress.point;
      if (!p) { F.mode = 'none'; return; }
      F.mode = 'suppress';
      if (F.burstLeft === 0) {
        const s = 3;
        F.point.x = p.x + this.rng.range(-s, s);
        F.point.z = p.z + this.rng.range(-s, s);
        F.point.y = this.manager.query.getSupportHeight(F.point.x, F.point.z) + this.rng.range(0.3, 1.2);
      }
      return;
    }
    if (ord.fire === 'suppress' && ord.suppress && now >= ord.suppress.until) { ord.fire = ord.prevFire ?? 'free'; ord.suppress = null; }
    const sq = this.squad;
    const underFire = this.suppression > 15 || now - (this._hitAt ?? -Infinity) < 3 || now - this.perception.lastCrack < 3;
    if (ord.fire === 'hold' && !underFire) { F.mode = 'none'; F.lastTargetSeen = this.perception.seen; return; }
    if (ord.fire === 'onMyShot') {
      if ((sq?.playerFiredAt ?? -Infinity) > ord.since || underFire) ord.fire = 'free';
      else { F.mode = 'none'; F.lastTargetSeen = this.perception.seen; return; }
    }
    // 보이지 않는 곳으로의 제압 사격은 확실한 접촉일 때만 (플레이어가 쏜 곳·발견 보고) — 아군 쪽으로 난사하지 않게
    if (!this.perception.seen) {
      const m = this.memory.valid ? this.memory : sq?.contact;
      if (!m || (m.uncertainty ?? 0) > 15) { F.mode = 'none'; F.lastTargetSeen = false; return; }
    }
    super._chooseFire(now, ready);
  }

  // =================================================================
  // 사건
  // =================================================================
  onDetect(surprisedOverride = null) {
    super.onDetect(surprisedOverride);
    this.squad?.report?.(this, this.target);
  }

  onHit(e) {
    this._hitAt = this.now;
    const sh = e.shooter;
    const friendly = sh && (sh === this.manager.player?.person || sh.faction === 'friend' || (sh.isShell && sh.faction === 'friend'));
    if (friendly) {
      this.friendlyHits++;
      this.squad?.onFriendlyFire?.(this, e);
      if (this.now - this._ffAt > 4) { this._ffAt = this.now; this.say('사격 중지! 아군이다!', 'friendlyFire', { force: true }); }
      return;
    }
    super.onHit(e);
  }

  _onDeath(e) {
    if (this.carry) this.dropCarry();
    if (this.carriedBy) this.carriedBy.dropCarry();
    if (this.treat) this._endTreat();
    super._onDeath(e);
  }

  /** 알아챈 함정만 비켜 감 (적 함정 자리는 모름) */
  _hazardList() { return this.squad?.knownHazards ?? EMPTY; }

  /** 4단계 디버그 요약 + 7단계 (역할·명령·처치·업기) */
  debugInfo() {
    const d = super.debugInfo();
    d.job = this.job; d.ord = { ...this.ord }; d.pending = this.pendingOrders.length;
    d.treat = this.treat ? { patient: this.treat.patient?.name ?? 'player', t: this.treat.t, active: this.treat.active } : null;
    d.carry = this.carry?.phase ?? null; d.carried = !!this.carriedBy;
    d.fatigue = this.endurance.fatigue; d.thirst = this.endurance.thirst;
    return d;
  }
}
