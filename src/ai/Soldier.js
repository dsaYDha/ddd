// =====================================================================
//  Soldier — 적 병사 한 명 (순수 로직). 1~3단계 '사람 개체'(HumanEntity: 이동 HumanMotor + 부상 Injuries + 판정 캡슐)
//  에 AI 두뇌를 붙인 것. 사격은 플레이어와 같은 Shooter (Weapon + AimModel — 흔들림·반동·심박·제압 그대로).
//   · 판단(_think): 병사마다 초당 6~9회 (나눠서). 매 프레임(_control): 이동 조종·자세·시선/조준·방아쇠.
//   · 행동 모드 (우선순위): 충격 → 끌려감 → 부상자 끌기 → 혼란(분대장 사망) → 도주 → 웅크림(제압 85+) → 고개 숙임(60+)
//       → 부상 처치 → 후퇴 → 분대 상태별 (순찰·정지·조사·경계·교전[사격조/기동조]·매복 대기·매복 사격·수색)
//   · 사람다운 실수: 발견 → 첫 사격까지 반응 지연 (놀랐으면 길게), 조준 오차가 0.5~2초에 걸쳐 줄어듦 (첫발은 잘 빗나감),
//       안정된 뒤에도 남는 느린 오차, 움직이는 표적 앞 겨누기 불완전, 짧은 연발 (근거리는 길게), 놀라거나 제압당하면 공황 사격,
//       아군 사선 확인은 가끔 빼먹음.
//   · 제압: 30+ 낮은 자세·정확도 하락(AimModel), 60+ 엄폐 뒤 고개 숙임·사격 0 (45 이하로 내려가야 내다본 뒤 재개),
//       85+ 웅크림 (가끔 뒤로 기어 후퇴), 엄폐 없이 제압당하면 바로 엎드려 가까운 엄폐로 기어감.
//   · 부상 (3단계 그대로): 비명·도움 요청 (소음), 엄폐로 기어가 스스로 붕대·지혈대 (같은 규칙·수량),
//       팔이 멀쩡하면 엎드린 채 계속 사격, 동료가 끌고 감 (0.6m/s, 둘 다 노출).
// =====================================================================
import { CONFIG } from '../config.js';
import { RNG } from '../core/rng.js';
import { clamp, wrapAngle } from '../core/math.js';
import { HumanEntity } from '../combat/HumanEntity.js';
import { Shooter } from '../combat/Shooter.js';
import { Perception } from './Perception.js';

const DEG = Math.PI / 180;
const FLANK_WIDE_COS = Math.cos(45 * Math.PI / 180);
const yawOf = (dx, dz) => Math.atan2(-dx, -dz);
const rr = (rng, r) => rng.range(r[0], r[1]);
const ARM_TYPES = new Set(['upperArm', 'forearm']);

let nextSoldier = 1;

export class Soldier extends HumanEntity {
  /**
   * @param {import('./EnemyManager.js').EnemyManager} manager
   * @param {{ x, z, yaw?, stance?, rng?, role?, weapon?: 'rifle556'|'lmg762', name?, variant?, pit?: boolean }} opts
   */
  constructor(manager, opts = {}) {
    const rng = opts.rng ?? new RNG((Math.random() * 4294967296) >>> 0);
    const id = nextSoldier++;
    super(manager.query, manager.combat, {
      ...opts, rng, arms: 'rifle', suppression: true, faction: 'enemy', name: opts.name ?? `적${id}`, data: { kind: 'soldier' },
    });
    this.id = id;
    this.manager = manager;
    this.squad = null;
    this.role = opts.role ?? 'rifleman';
    this.order = 0;
    this.weaponKey = opts.weapon ?? 'rifle556';
    this.weaponData = CONFIG.weapons[this.weaponKey];
    this.variant = opts.variant ?? (id % 6);
    this.voice = rng.range(0, 1);               // 목소리 높낮이 (고함 합성)
    this.shooter = new Shooter(this.combat, this.person, this.weaponData, { rng: new RNG(rng.int(1, 2 ** 30)) });
    this.motor.loadKg = CONFIG.load.baseKg + this.shooter.weapon.weightKg;   // 같은 장비 무게 규칙
    this.person.suppression.gainMul = rng.range(0.85, 1.2);                   // 담력 개인차
    this.perception = new Perception({ rng });
    this.look = { yaw: opts.yaw ?? 0, pitch: 0 };
    this._prevLook = { yaw: this.look.yaw, pitch: 0 };
    this.mode = 'idle';
    this.memory = { x: 0, y: 0, z: 0, time: -Infinity, uncertainty: 0, valid: false, source: '' };
    this.goal = null;
    this.path = null;
    this.pathIdx = 0;
    this.pathPending = false;
    this._stuck = 0;
    this._stuckCount = 0;
    this.cover = null;
    this._coverAt = -Infinity;
    this.pinned = false;
    this.peekUntil = 0;
    this.inPit = !!opts.pit;
    this.pitDepth = this.inPit ? CONFIG.ai.ambush.pitDepth : 0;
    this._pitClimb = 0;
    this.drag = null;          // 끄는 쪽: { wounded, phase: 'approach'|'pull', dest }
    this.draggedBy = null;     // 끌려가는 쪽
    this.fire = {
      mode: 'none',            // 'none' | 'aimed' | 'suppress' | 'panic'
      point: { x: 0, y: 0, z: 0 },
      reactionUntil: 0, burstLeft: 0, gapUntil: 0, nextPress: 0, held: false,
      errYaw: 0, errPitch: 0, errT: 0, tau: 0.5, lead: 1, residualPh: rng.range(0, 6.28), panic: false, hurried: false,
      lastTargetSeen: false,
    };
    this._input = { trigger: false, triggerPressed: false, aim: false, holdBreath: false, reload: false, mode: false, magCheck: false };
    this._pose = this._pose || {};
    this._shot = {
      eye: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, stance: 'stand', stanceFrom: 'stand', stanceProgress: 1, speed: 0, sprinting: false,
      heartRate: 70, stamina: 100, lookDeltaYaw: 0, lookDeltaPitch: 0,
    };
    this.scanPh = rng.range(0, 6.28);
    this.scanRate = rng.range(0.35, 0.6);
    this.thinkPeriod = 1 / rr(rng, CONFIG.ai.thinkHz);
    this.thinkT = rng.range(0, this.thinkPeriod);
    this.stats = { shots: 0, shotsPinned: 0, bursts: 0, firstShotAt: -Infinity, detectAt: -Infinity, aimedShots: 0, panicBursts: 0, reaction: NaN };
    this._lastHelp = -Infinity;
    this._aidTried = -Infinity;
    this._cowerMove = 0;
    this._confusedLook = 0;
    this._wantAds = false;
    this._reloadPressed = false;
    this.shooter.weapon.setMode(this.weaponData.modes.includes('auto') ? 'auto' : this.weaponData.modes[0]);

    this.shooter.on('fired', (e) => this._onFired(e));
    this.shooter.on('noise', (e) => {
      const p = this.motor.position;
      manager.noise?.emitNoise({ x: p.x, y: p.y + 1, z: p.z }, e.radius, e.kind, this.motor, { cause: e.cause });
    });
    for (const ev of ['magOut', 'magIn', 'boltPull', 'boltRelease']) this.shooter.on(ev, () => manager.emit('mech', { soldier: this, kind: ev }));
    this.person.suppression.on('nearPass', (e) => this._onCrack(e));
    this.motor.on('footstep', (e) => manager.emit('footstep', { soldier: this, evt: e }));
    this.injuries.on('wound', (e) => this._onWound(e));
    this.injuries.on('graze', (e) => this._onWound(e));
    if (this.inPit) this.motor.setRestriction('pit', { maxSpeedMultiplier: 0, canSprint: false, canJump: false, canProne: false });
  }

  // =================================================================
  // 읽기
  // =================================================================
  get target() { return this.manager.target; }
  get now() { return this.manager.time; }
  get suppression() { return this.person.suppression.value; }
  get eye() { return this.person.eye ?? { x: this.motor.position.x, y: this.motor.position.y + this.motor.eyeHeight, z: this.motor.position.z }; }
  /** 지금 표적을 보고 있음 (발견 + 보임) */
  get seesTarget() { return this.perception.seen; }

  /** 4단계 AI 디버그·테스트 요약 */
  debugInfo() {
    const m = this.memory;
    return {
      id: this.id, name: this.name, role: this.role, mode: this.mode, squadState: this.squad?.state,
      meter: this.perception.meter, visibility: this.perception.visibility, seen: this.perception.seen,
      suppression: this.suppression, morale: this.squad?.morale, pinned: this.pinned,
      memory: m.valid ? { x: m.x, z: m.z, uncertainty: m.uncertainty, age: this.now - m.time } : null,
      path: this.path, pathIdx: this.pathIdx, cover: this.cover, look: this.look, alive: this.alive,
      ammo: this.shooter.weapon.totalRounds, wounds: this.injuries.wounds.length,
    };
  }

  // =================================================================
  // 판 짜기 (pose: 구덩이 높이)
  // =================================================================
  pose() {
    const P = super.pose();
    if (this.pitDepth > 0) P.y -= this.pitDepth;
    return P;
  }

  // =================================================================
  // 프레임
  // =================================================================
  update(dt) {
    if (!(dt > 0)) return;
    if (!this.fall && this.alive) {
      this.thinkT -= dt;
      if (this.thinkT <= 0) {
        this.thinkT += this.thinkPeriod;
        this._think();
      }
    }
    super.update(dt);
  }

  /** 매 프레임 조종: 심박 긴장 → 이동 → 자세 → 시선·조준 → 방아쇠 입력 */
  _control(dt) {
    const m = this.motor, inj = this.injuries;
    const sup = this.person.suppression;
    m.stress = Math.max(sup.effects(this._fx || (this._fx = {})).heartStress, inj.effects().heartStress);
    if (this.draggedBy) { this._stopInput(); return; }
    if (inj.stunned) { this._stopInput(); this._releaseTrigger(); return; }
    this._climbPit(dt);
    this._steer(dt);
    this._aim(dt);
    this._fireControl(dt);
  }

  _afterMotor(dt) {
    super._afterMotor(dt, this.shooter);
    if (!this.alive) return;
    // 고개 숙임(60+)·웅크림 동안 사격 0 — 무기 입력 자체를 막는다 (지연 발사도 취소)
    const pinnedNow = this.pinned || this.suppression >= CONFIG.ai.suppression.pinned || this.mode === 'cower' || this.mode === 'pinned';
    if (pinnedNow && !this.shooter.blocked) {
      this.shooter.blocked = 'pinned';
      if (this.fire.burstLeft > 0) this._releaseTrigger();
    }
    this._shoot(dt);
  }

  // =================================================================
  // 판단 (초당 6~9회)
  // =================================================================
  _think() {
    const now = this.now, inj = this.injuries, S = CONFIG.ai.suppression;
    const sq = this.squad;
    // 기억: 시간이 지나면 흐려짐
    const mem = this.memory;
    if (mem.valid) {
      const M = CONFIG.ai.memory;
      const age = now - mem.time;
      mem.uncertainty = Math.min(M.maxUncertainty, mem.base + M.uncertaintyGrowth * age);
      if (age > M.forget) mem.valid = false;
    }
    if (this.perception.seen) this._sawTarget();
    // 제압 (히스테리시스: 60 이상이면 고개 숙임, 45 이하로 내려가야 내다본 뒤 재개)
    const sv = this.suppression;
    if (sv >= S.pinned) this.pinned = true;
    else if (this.pinned && sv <= S.resume) { this.pinned = false; this.peekUntil = now + rr(this.rng, S.peekTime); }

    let mode;
    if (inj.stunned) mode = 'stunned';
    else if (this.draggedBy) mode = 'dragged';
    else if (this.drag) mode = 'drag';
    else if (sq && sq.confusedUntil > now) mode = 'confused';
    else if (sq && sq.state === 'rout') mode = 'flee';
    else if (sv >= S.cower) mode = 'cower';
    else if (this.pinned) mode = 'pinned';
    else if (this._needsWoundCare()) mode = 'wounded';
    else if (sq && sq.state === 'retreat') mode = 'retreat';
    else mode = this._squadMode();
    if (mode !== this.mode) {
      const prev = this.mode;
      this.mode = mode;
      this._enterMode(mode, prev);
    }
    const fn = this['_m_' + mode];
    this.paceIntent = 1;   // 순찰만 분대 대열에 맞춰 바꿈
    if (fn) fn.call(this, now);
    // 탄창: 비었으면 / 한동안 표적이 없고 조금 남았으면 재장전
    const w = this.shooter.weapon;
    this._reloadPressed = false;
    if (!w.busy && w.totalRounds > 0) {
      const frac = w.magRounds / Math.max(1, w.data.magCapacity);
      if ((!w.chambered && w.magRounds === 0) || (frac < CONFIG.ai.fire.reloadBelow && !this.perception.seen && now - this.perception.lastSeen > 3 && this.fire.burstLeft === 0)) {
        if (w._bestSpareMag() >= 0) {
          this._reloadPressed = true;
          if (this.rng.chance(0.6)) this.manager.shout(this, 'reload');
        }
      }
    }
  }

  _squadMode() {
    const sq = this.squad;
    if (!sq) return 'idle';
    switch (sq.state) {
      case 'patrol': return sq.type === 'camp' ? 'post' : 'patrol';
      case 'suspicious': return sq.investigators.includes(this) ? 'investigate' : 'halt';
      case 'alert': return 'alert';
      case 'ambush': return 'ambushWait';
      case 'search': return 'search';
      case 'engaged':
        if (sq.type === 'ambush') return 'ambushFire';
        return this.role === 'flank' && !this._flankDone ? 'flank' : 'fight';
      default: return 'idle';
    }
  }

  _enterMode(mode, prev) {
    // 모드가 바뀌면 이동 목표는 새로 (엄폐는 유지)
    if (mode !== 'fight' && mode !== 'ambushFire' && mode !== 'pinned') this.fire.mode = 'none';
    if (prev === 'patrol' || prev === 'halt') this.goal = null;
    if (mode === 'pinned' || mode === 'cower') {
      this._releaseTrigger();
      this.manager.emit('modeChange', { soldier: this, mode, prev });
    }
  }

  // ---- 표적 발견·기억 ------------------------------------------------
  /** 내가 지금 표적을 봄 → 기억 정확히, 분대에 알림 */
  _sawTarget() {
    const t = this.target;
    if (!t) return;
    const p = t.motor.position;
    this._remember(p.x, p.y, p.z, 0, 'seen');
    this.squad?.onSighting(this, p);
  }

  _remember(x, y, z, uncertainty, source) {
    const m = this.memory;
    m.x = x; m.y = y; m.z = z; m.time = this.now; m.base = uncertainty; m.uncertainty = uncertainty; m.valid = true; m.source = source;
  }

  /** 분대가 알려준 위치 (고함) — 내 기억이 더 새것이면 무시 */
  told(x, y, z, uncertainty) {
    const m = this.memory;
    if (m.valid && m.source === 'seen' && this.now - m.time < 2) return;
    this._remember(x, y, z, uncertainty, 'told');
  }

  /** 새로 발견 (Perception 누적 또는 총구 화염) */
  onDetect(surprisedOverride = null) {
    const now = this.now;
    this.stats.detectAt = now;
    const sq = this.squad;
    const calm = sq && (sq.state === 'alert' || sq.state === 'engaged' || sq.state === 'search' || sq.state === 'ambush');
    const surprised = surprisedOverride ?? !calm;
    const R = CONFIG.ai.reaction;
    this.fire.reactionUntil = Math.max(this.fire.reactionUntil, now + rr(this.rng, surprised ? R.surprised : R.alert));
    this.stats.reaction = this.fire.reactionUntil - now;
    this._acquire(rr(this.rng, CONFIG.ai.aim.initialErrorDeg));
    this.fire.hurried = true;
    // 가까이서 깜짝 놀라면 공황 사격
    const d = this.perception.distance;
    this.fire.panic = surprised && d < CONFIG.ai.fire.panicClose && this.rng.chance(0.7);
    this._sawTarget();
    sq?.onDetect(this, surprised);
  }

  /** 조준 오차를 새로 (처음 겨눔·다시 겨눔): 크기 deg, 안정 시간 settle */
  _acquire(errDeg, settle = rr(this.rng, CONFIG.ai.aim.settle)) {
    const F = this.fire, a = this.rng.range(0, Math.PI * 2);
    F.errYaw = Math.cos(a) * errDeg * DEG;
    F.errPitch = Math.sin(a) * errDeg * DEG;
    F.errT = 0;
    F.tau = settle / 2.5;
    F.lead = rr(this.rng, CONFIG.ai.aim.leadAccuracy);
  }

  /** 들은 소리 (EnemyManager 가 거리/음속 지연 뒤에 넘김) */
  onSound(evt) {
    const sq = this.squad;
    if (!sq || !this.alive) return;
    const pos = this.motor.position;
    const fromTarget = this.target && evt.source === this.target.motor;
    if (evt.kind === 'gunshot') {
      if (fromTarget) {
        const crack = this.now - this.perception.lastCrack < CONFIG.ai.hearing.crackWindow;
        const est = this.manager.estimate(evt, pos, this.rng, crack);
        if (!(this.perception.seen)) this._remember(est.x, evt.y, est.z, est.error * 1.5 + (crack ? est.distance * 0.3 : 3), 'heard');
        sq.onHeardShot(this, est, evt);
        this.manager.requestFlare?.(sq, est);   // 6단계: 밤이면 조명탄으로 확인
      } else if (evt.squad !== sq) {
        sq.onAlliedAlarm(this, evt);
      }
      return;
    }
    if (evt.kind === 'shout') {
      if (evt.squad !== sq) sq.onAlliedAlarm(this, evt);
      return;
    }
    // 6단계: 함정이 터짐 — 누군가 우리 함정에 걸렸다 (총성처럼 경계하고 그쪽을 확인)
    if (evt.kind === 'explosion') {
      const est = this.manager.estimate(evt, pos, this.rng, false);
      if (!this.perception.seen) this._remember(est.x, evt.y, est.z, est.error * 1.5 + 4, 'heard');
      sq.onHeardShot(this, est, evt);
      this.manager.requestFlare?.(sq, est);
      return;
    }
    if (!fromTarget) return;
    if (evt.kind === 'impact') {
      // 내 근처에 탄이 박힘 → 총에 맞고 있다 (어디서 쏘는지는 총성으로)
      if (Math.hypot(evt.x - pos.x, evt.z - pos.z) < 12) sq.onUnderFire(this, null);
      return;
    }
    // 발소리·식물 헤치는 소리·자세 바꾸는 소리·진흙·장전 소리 → 대략적인 위치
    const est = this.manager.estimate(evt, pos, this.rng, false);
    if (!this.perception.seen) this._remember(est.x, evt.y, est.z, est.error * 1.5 + 2, 'heard');
    sq.onSuspicious(this, est, evt.kind);
    // 6단계: 밤엔 눈보다 귀 — 또렷한 소리(걷는 발소리 이상)를 들으면 조명탄으로 확인
    if ((evt.radius ?? 0) >= CONFIG.night.flare.hearNoiseMin) this.manager.requestFlare?.(sq, est);
  }

  /** 근접 탄 ('딱') — 방향 헷갈림 시작 + 분대 경계 */
  _onCrack(e) {
    this.perception.lastCrack = this.now;
    this.squad?.onUnderFire(this, e);
  }

  _onWound(e) {
    if (!this.alive) return;
    this.manager.shout(this, 'scream', true);
    this.squad?.onWounded(this, e.wound);
    this.cover = null;
    this._lastHelp = this.now;
  }

  /** 총에 맞음 (EnemyManager 가 combat 'hit' 에서) — 쏜 방향을 대충 앎 */
  onHit(e) {
    if (e.dir && this.alive) {
      const p = this.motor.position, d = rr(this.rng, [20, 60]);
      if (!this.perception.seen) this._remember(p.x - e.dir.x * d, p.y, p.z - e.dir.z * d, d * 0.5, 'hit');
    }
    this.squad?.onUnderFire(this, e);
  }

  _onDeath(e) {
    this._releaseTrigger();
    if (this.drag) this._endDrag();
    if (this.draggedBy) this.draggedBy._endDrag();
    super._onDeath(e);
    this.squad?.onKilled(this);
    this.manager.onSoldierDeath(this);
  }

  // =================================================================
  // 행동 모드 (판단 때 목표·자세·시선·사격 허가를 정함)
  // =================================================================
  _m_stunned() { this.goal = null; this.fire.mode = 'none'; }
  _m_dragged() { this.goal = null; this.fire.mode = 'none'; this.wantStance = 'prone'; }
  _m_idle() { this.goal = null; this.wantStance = 'stand'; this.fire.mode = this.perception.seen ? 'aimed' : 'none'; }

  _m_patrol(now) {
    const sq = this.squad, slot = sq.slotFor(this);
    this.wantStance = 'stand';
    this.fire.mode = 'none';
    this.paceIntent = slot?.intent ?? 1;
    if (slot) this._setGoal(slot.x, slot.z, slot.pace ?? 'walk', { direct: !slot.farFromRoute, arrive: slot.arrive ?? 0.8, hold: slot.hold });
    else this.goal = null;
    this.lookMode = 'move';
  }

  /** 5단계 야영지: 보초는 자리에서 바깥을 살피고, 쉬는 병사는 모닥불 곁에 앉아 있음 (경계 전) */
  _m_post() {
    const p = this.post;
    this.fire.mode = this.perception.seen ? 'aimed' : 'none';
    if (!p) { this.goal = null; return; }
    const d = Math.hypot(p.x - this.motor.position.x, p.z - this.motor.position.z);
    if (d > 0.8) this._setGoal(p.x, p.z, 'walk', { arrive: 0.5 });
    else this.goal = null;
    if (this.postRole === 'rest') {
      this.wantStance = 'crouch';
      this.lookAt = p.look; this.lookMode = 'scanPoint'; this.scanAmp = 0.5;
    } else {
      this.wantStance = 'stand';
      this.lookAt = p.look; this.lookMode = 'scanPoint'; this.scanAmp = 1.1;
    }
  }

  _m_halt() {
    this.goal = null;
    this.wantStance = 'crouch';
    this.fire.mode = 'none';
    this.lookAt = this.squad.suspicion ?? null;
    this.lookMode = this.lookAt ? 'point' : 'scan';
  }

  _m_investigate() {
    const p = this.squad.suspicion;
    this.wantStance = 'crouch';
    this.fire.mode = this.perception.seen ? 'aimed' : 'none';
    if (p) {
      this._setGoal(p.x, p.z, 'sneak', { arrive: 2.5 });
      this.lookAt = p; this.lookMode = 'point';
    }
  }

  _m_alert(now) {
    const sq = this.squad;
    const th = this.memory.valid ? this.memory : sq.threat;
    this.fire.mode = this.perception.seen ? 'aimed' : 'none';
    if (th) {
      this._ensureCover(th, { radius: 12 });
      if (this.cover) this._setGoal(this.cover.hideX, this.cover.hideZ, 'run', { combat: true, arrive: 0.9 });
      else this.goal = null;
      this.lookAt = th; this.lookMode = 'scanPoint';
    } else { this.goal = null; this.lookMode = 'scan'; }
    this.wantStance = this._atGoal() ? 'crouch' : 'stand';
  }

  /** 교전 — 사격조: 위협을 막는 엄폐 옆에서 내다보며 사격, 안 보이면 마지막 확인 위치로 제압 사격 */
  _m_fight(now) {
    const sq = this.squad, th = this._threatPoint();
    if (!th) { this.goal = null; this.fire.mode = 'none'; this.lookMode = 'scan'; return; }
    this._ensureCover(th, { radius: CONFIG.ai.cover.search, prefer: { min: 12, max: 70 } });
    const c = this.cover;
    const isMg = this.weaponData.bipod;
    if (c) {
      const peekX = c.kind === 'hard' ? c.peekX : c.hideX, peekZ = c.kind === 'hard' ? c.peekZ : c.hideZ;
      this._setGoal(peekX, peekZ, this._moveUnderFire(), { combat: true, arrive: 0.8 });
    } else this.goal = null;
    const there = !c || this._atGoal();
    this.wantStance = !there ? (this.suppression >= CONFIG.ai.suppression.lowStance ? 'crouch' : 'stand')
      : isMg || this.suppression >= CONFIG.ai.suppression.lowStance || (c && c.kind === 'soft') ? 'prone' : 'crouch';
    this.lookAt = th; this.lookMode = 'aim';
    this._chooseFire(now, there || this.perception.seen);
  }

  /** 교전 — 기동조: 숨을 수 있는 경로로 측면 지점까지, 가는 중에 가까이서 보이면 그 자리에서 사격 */
  _m_flank(now) {
    const fp = this.flankPoint;
    if (!fp) { this._flankDone = true; return; }
    const d = Math.hypot(fp.x - this.motor.position.x, fp.z - this.motor.position.z);
    // 측면으로 충분히 돌아간 뒤 (사격조와 45° 이상) 가까이서 보이면 그 자리에서 사격
    const ax = this.squad?.flankAxis;
    let wide = true;
    if (ax) {
      const vx = this.motor.position.x - ax.x, vz = this.motor.position.z - ax.z;
      wide = (vx * ax.ux + vz * ax.uz) / (Math.hypot(vx, vz) || 1) < FLANK_WIDE_COS;
    }
    if (d < 2.5 || (this.perception.seen && this.perception.distance < 25 && wide)) {
      this._flankDone = true;
      this.cover = null;
      return;
    }
    this._setGoal(fp.x, fp.z, d > 12 ? 'run' : 'walk', { combat: true, arrive: 2 });
    this.wantStance = d > 12 ? 'stand' : 'crouch';
    this.fire.mode = 'none';
    this.lookAt = this._threatPoint(); this.lookMode = this.lookAt ? 'scanPoint' : 'move';
  }

  _m_ambushWait() {
    const a = this.squad.ambush;
    this.goal = null;
    this.wantStance = this.inPit ? 'stand' : this.ambushKind === 'observe' ? 'crouch' : 'prone';
    this.fire.mode = 'none';
    this.lookAt = this.ambushLook ?? a.killZone;
    this.lookMode = 'scanPoint';
    this.scanAmp = 0.35;
  }

  _m_ambushFire(now) {
    this.goal = null;
    this.wantStance = this.inPit ? 'stand' : 'prone';
    const th = this._threatPoint();
    this.lookAt = th ?? this.squad.ambush.killZone; this.lookMode = 'aim';
    if (th) this._chooseFire(now, true); else this.fire.mode = 'none';
  }

  _m_search(now) {
    const sq = this.squad, task = sq.searchTaskFor(this);
    this.wantStance = 'crouch';
    this.fire.mode = this.perception.seen ? 'aimed' : 'none';
    if (task) {
      if (task.follow) {
        const L = task.follow.motor.position;
        const dx = this.motor.position.x - L.x, dz = this.motor.position.z - L.z, dl = Math.hypot(dx, dz) || 1;
        const gap = CONFIG.ai.search.pairGap;
        this._setGoal(L.x + dx / dl * gap, L.z + dz / dl * gap, 'sneak', { arrive: 1.5, direct: dl < 12 });
      } else if (task.point) this._setGoal(task.point.x, task.point.z, 'sneak', { arrive: 2 });
      // 위력 수색: 의심 가는 수풀로 짧은 연발
      if (task.recon && now < task.recon.until) {
        const p = task.recon.point;
        this.fire.mode = 'suppress';
        this.fire.point.x = p.x; this.fire.point.y = p.y; this.fire.point.z = p.z;
        this.lookAt = p; this.lookMode = 'aim';
        this.goal = null;
        return;
      }
      this.lookAt = task.point ?? sq.contact; this.lookMode = 'scanPoint';
    }
  }

  /** 후퇴 (사기 저하): 절반은 엄호, 절반은 다음 엄폐로 뒤로 — 번갈아 */
  _m_retreat(now) {
    const sq = this.squad, r = sq.retreat;
    const th = this._threatPoint() ?? sq.contact;
    if (!r || !th) { this.goal = null; return; }
    const moving = r.scatter || (this.order % 2) === r.phase;
    if (moving) {
      if (!this.retreatPoint || this.retreatPoint.phaseId !== r.phaseId) this.retreatPoint = sq.retreatPointFor(this, th);
      const p = this.retreatPoint;
      if (p) this._setGoal(p.x, p.z, 'run', { combat: true, arrive: 1.5 });
      this.wantStance = 'stand';
      this.fire.mode = 'none';
      this.lookMode = 'move';
    } else {
      this.goal = null;
      this.wantStance = 'crouch';
      this.lookAt = th; this.lookMode = 'aim';
      this._chooseFire(now, true);
    }
  }

  /** 도주 (사기 붕괴): 흩어져 달아남 */
  _m_flee(now) {
    if (!this.fleePoint) this.fleePoint = this.squad.fleePointFor(this);
    const p = this.fleePoint;
    if (p && Math.hypot(p.x - this.motor.position.x, p.z - this.motor.position.z) > 2) {
      this._setGoal(p.x, p.z, 'run', { arrive: 2 });
      this.wantStance = 'stand';
      this.lookMode = 'move';
    } else {
      this.goal = null;
      this.wantStance = 'prone';
      this.lookMode = 'scan';
    }
    this.fire.mode = 'none';
  }

  /** 제압 60+: 엄폐 뒤로 머리를 숙이고 반격하지 않음. 엄폐가 없으면 엎드려 가까운 엄폐로 기어감 */
  _m_pinned(now) {
    this.fire.mode = 'none';
    const th = this._threatPoint();
    if (th) this._ensureCover(th, { radius: 10 });
    const c = this.cover;
    if (c) {
      const atHide = Math.hypot(c.hideX - this.motor.position.x, c.hideZ - this.motor.position.z) < 1.2;
      this._setGoal(c.hideX, c.hideZ, atHide ? 'crawl' : 'crawl', { combat: true, arrive: 0.7 });
      this.wantStance = atHide && c.kind === 'hard' && c.r >= 0.35 ? 'crouch' : 'prone';
    } else {
      this.goal = null;
      this.wantStance = 'prone';
    }
    this.lookAt = th; this.lookMode = th ? 'point' : 'scan';
  }

  /** 제압 85+: 완전히 웅크림. 숨을 수 있는 쪽이 있으면 가끔 뒤로 기어 후퇴 */
  _m_cower(now) {
    const S = CONFIG.ai.suppression;
    this.fire.mode = 'none';
    this.wantStance = 'prone';
    const th = this._threatPoint();
    if (this.goal && !this._atGoal()) return;   // 기어가는 중
    this.goal = null;
    if (th && now > this._cowerMove) {
      this._cowerMove = now + this.rng.range(4, 8);
      if (this.rng.chance(S.crawlBackChance)) {
        const p = this.motor.position;
        let ux = p.x - th.x, uz = p.z - th.z;
        const ul = Math.hypot(ux, uz) || 1;
        ux /= ul; uz /= ul;
        const d = rr(this.rng, S.crawlBack);
        const nav = this.manager.nav;
        const tx = p.x + ux * d, tz = p.z + uz * d;
        if (nav.walkable(tx, tz) && nav.concealAt(tx, tz) > 0.3) this._setGoal(tx, tz, 'crawl', { arrive: 0.6, direct: true });
      }
    }
    this.lookAt = th; this.lookMode = th ? 'point' : 'scan';
  }

  /** 부상: 엄폐로 기어가 스스로 처치. 팔이 멀쩡하면 엎드린 채 계속 사격. 도움 요청 */
  _m_wounded(now) {
    const inj = this.injuries;
    const th = this._threatPoint();
    const armHurt = inj.wounds.some((w) => ARM_TYPES.has(w.type));
    const canShoot = !inj.weaponDropped && !armHurt;
    // 도움 요청 (소음 — 플레이어도 위치를 안다)
    const W = CONFIG.ai.wounded;
    if (inj.bleedRate > 0 && now - this._lastHelp > rr(this.rng, W.helpInterval)) {
      this._lastHelp = now;
      this.manager.shout(this, 'help');
    }
    if (inj.aid) {
      // 처치 중: 멈춤. 적이 보이고 쏠 수 있으면 처치를 그만두고 싸운다
      if (this.perception.seen && canShoot) inj.cancelAid('threat');
      else {
        this.goal = null;
        this.fire.mode = 'none';
        this.lookAt = th; this.lookMode = th ? 'point' : 'scan';
        return;
      }
    }
    if (th) this._ensureCover(th, { radius: 12 });
    const c = this.cover;
    const atCover = c ? Math.hypot(c.hideX - this.motor.position.x, c.hideZ - this.motor.position.z) < 1.4 : false;
    if (this.perception.seen && canShoot) {
      // 엎드린 채 사격 (부위별 제한은 3단계 규칙 그대로 — 쓰러졌으면 기는 것만 가능)
      this.goal = null;
      this.wantStance = inj.downed ? 'prone' : 'crouch';
      this.lookAt = th; this.lookMode = 'aim';
      this._chooseFire(now, true);
      return;
    }
    this.fire.mode = 'none';
    if (c && !atCover) {
      this._setGoal(c.hideX, c.hideZ, inj.downed ? 'crawl' : 'sneak', { combat: true, arrive: 0.8 });
      this.wantStance = inj.downed ? 'prone' : 'crouch';
    } else {
      this.goal = null;
      this.wantStance = inj.downed ? 'prone' : 'crouch';
      if (inj.bleedRate > 0 && now - this._aidTried > 2 && this.motor.speed < 0.05 && now - this.perception.lastSeen > 2) {
        this._aidTried = now;
        const arterialLimb = inj.wounds.some((w) => w.arterial && !w.tourniquet && ['thigh', 'shin', 'upperArm', 'forearm'].includes(w.type));
        const r = inj.startAid(arterialLimb && inj.tourniquets > 0 ? 'tourniquet' : 'bandage');
        if (!r.ok && r.reason === 'noLimb') inj.startAid('bandage');
      }
    }
    this.lookAt = th; this.lookMode = th ? 'point' : 'scan';
  }

  /** 부상자 끌기 (끄는 쪽) */
  _m_drag(now) {
    const d = this.drag, w = d.wounded;
    if (!w.alive || !this.alive || this.suppression >= CONFIG.ai.suppression.pinned || this.injuries.downed) { this._endDrag(); return; }
    const p = this.motor.position, wp = w.motor.position;
    this.fire.mode = 'none';
    if (d.phase === 'approach') {
      const dist = Math.hypot(wp.x - p.x, wp.z - p.z);
      this._setGoal(wp.x, wp.z, 'run', { combat: true, arrive: 1.1 });
      this.wantStance = dist > 6 ? 'stand' : 'crouch';
      this.lookMode = 'move';
      if (dist < 1.3) {
        d.phase = 'pull';
        d.dest = this.squad.dragDestination(w);
        w.draggedBy = this;
        this.motor.setRestriction('drag', { maxSpeed: CONFIG.ai.wounded.dragSpeed, canSprint: false, canJump: false });
        this.manager.emit('drag', { soldier: this, wounded: w, phase: 'start' });
      }
    } else {
      const dest = d.dest;
      if (!dest || Math.hypot(dest.x - p.x, dest.z - p.z) < 1.0) { this._endDrag(); return; }
      this._setGoal(dest.x, dest.z, 'walk', { combat: true, arrive: 0.9, face: this._threatPoint() });
      this.wantStance = 'crouch';
      this.lookAt = this._threatPoint(); this.lookMode = this.lookAt ? 'point' : 'move';
    }
  }

  _endDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.motor.clearRestriction('drag');
    if (d.wounded && d.wounded.draggedBy === this) {
      d.wounded.draggedBy = null;
      d.wounded.cover = null;
    }
    this.goal = null;
    this.manager.emit('drag', { soldier: this, wounded: d.wounded, phase: 'end' });
  }

  /** 분대장 사망 직후 3~6초: 우왕좌왕 */
  _m_confused(now) {
    this.fire.mode = this.perception.seen && this.rng.chance(0.4) ? 'panic' : 'none';
    if (this.fire.mode === 'panic') this.fire.panic = true;
    this.wantStance = 'crouch';
    if (now > this._confusedLook) {
      this._confusedLook = now + this.rng.range(0.6, 1.4);
      this.look.targetYaw = this.look.yaw + this.rng.range(-1.6, 1.6);
      if (this.rng.chance(0.35)) {
        const p = this.motor.position, a = this.rng.range(0, Math.PI * 2), r = this.rng.range(1, 3);
        if (this.manager.nav.walkable(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r)) this._setGoal(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, 'walk', { direct: true, arrive: 0.5 });
      } else this.goal = null;
    }
    this.lookMode = 'free';
  }

  // ---- 공통 도우미 ----------------------------------------------------
  /** 지금 겨눌 위협 위치: 보이면 표적, 아니면 내 기억, 아니면 분대 접촉 정보 */
  _threatPoint() {
    const t = this.target;
    if (t && this.perception.seen) return t.motor.position;
    const m = this.memory;
    if (m.valid) return m;
    return this.squad?.contact ?? null;
  }

  _needsWoundCare() {
    const inj = this.injuries;
    if (!inj.hasWounds) return false;
    if (inj.downed) return true;
    // 서 있을 수 있으면: 출혈이 있고 처치할 물자가 있으면 (교전 중 표적이 보이면 미룸)
    if (inj.aid) return true;
    if (inj.bleedRate <= 0.5) return false;
    if (inj.bandages <= 0 && inj.tourniquets <= 0) return false;
    return !this.perception.seen;
  }

  _moveUnderFire() {
    return this.suppression >= CONFIG.ai.suppression.lowStance ? 'sneak' : 'run';
  }

  /** 엄폐 정하기 (재평가: 위협 방향이 크게 바뀌면) */
  _ensureCover(th, opts = {}) {
    const C = CONFIG.ai.cover, now = this.now, p = this.motor.position;
    const c = this.cover;
    if (c) {
      // 이 엄폐가 지금 위협을 아직 막나 (엄폐물 → 숨는 점 방향과 위협 → 엄폐물 방향)
      const ax = c.hideX - c.x, az = c.hideZ - c.z, bx = c.x - th.x, bz = c.z - th.z;
      const al = Math.hypot(ax, az) || 1, bl = Math.hypot(bx, bz) || 1;
      if ((ax * bx + az * bz) / (al * bl) >= C.reevalDot || c.kind === 'soft') return;
    }
    if (now - this._coverAt < 1.5) return;
    this._coverAt = now;
    const taken = this.manager.takenCover(this);
    const list = this.manager.nav.findCover(p, th, { radius: opts.radius ?? C.search, taken, prefer: opts.prefer, max: 4 });
    this.cover = list[0] ?? null;
    this.goal = null;
  }

  _atGoal() { return !this.goal || this.goal.done; }

  /**
   * 사격 방식 정하기: 보이면 조준 사격(놀랐으면 공황), 안 보이면 사격조는 마지막 확인 위치로 제압 사격.
   * @param {boolean} ready  엄폐에 도착했거나 보임
   */
  _chooseFire(now, ready) {
    const F = this.fire, Fc = CONFIG.ai.fire;
    const seen = this.perception.seen;
    if (!ready) { F.mode = 'none'; return; }
    if (seen) {
      if (!F.lastTargetSeen) this._acquire(rr(this.rng, CONFIG.ai.aim.reacquireErrorDeg));
      F.mode = F.panic || (this.suppression >= Fc.panicSuppression && this.rng.chance(Fc.panicChance * 0.15)) ? 'panic' : 'aimed';
      if (F.mode === 'panic') F.panic = true;
    } else {
      // 사격조·매복조: 최근 위치로 제압 사격 (보이지 않아도)
      const m = this.memory.valid ? this.memory : this.squad?.contact;
      const age = m ? now - (m.time ?? now) : Infinity;
      const suppressor = this.role !== 'flank' || this._flankDone;
      if (m && age < 25 && suppressor && this.squad?.state !== 'search') {
        F.mode = 'suppress';
        if (F.burstLeft === 0) {
          const s = CONFIG.ai.fire.suppressiveSpread + (m.uncertainty ?? 0) * 0.3;
          F.point.x = m.x + this.rng.range(-s, s);
          F.point.z = m.z + this.rng.range(-s, s);
          F.point.y = this.manager.query.getSupportHeight(F.point.x, F.point.z) + this.rng.range(0.3, 1.1);
        }
      } else F.mode = 'none';
    }
    F.lastTargetSeen = seen;
  }

  // =================================================================
  // 매 프레임: 이동
  // =================================================================
  /** 이동 목표. pace: 'walk'|'run'|'sneak'|'crawl'. opts: { direct, combat, arrive, hold, face } */
  _setGoal(x, z, pace, opts = {}) {
    const g = this.goal;
    // 5단계: 막혀서 포기한 목표라도 멀리 떨어져 있으면 몇 초 뒤 다시 시도 (분대 행렬이 영영 멈추지 않게)
    const retry = g && g.done && g.gaveUp && this.now - g.gaveUp > 4
      && Math.hypot(x - this.motor.position.x, z - this.motor.position.z) > (opts.arrive ?? 1) + 2.5;
    if (g && !retry && Math.hypot(g.x - x, g.z - z) < (g.done ? 1.2 : 0.6) && g.pace === pace) {
      g.arrive = opts.arrive ?? g.arrive; g.hold = !!opts.hold; g.face = opts.face ?? null;
      return;
    }
    this.goal = { x, z, pace, arrive: opts.arrive ?? 1, combat: !!opts.combat, direct: !!opts.direct, hold: !!opts.hold, face: opts.face ?? null, done: false };
    this.path = null; this.pathIdx = 0;
    this._stuck = 0;
    const p = this.motor.position;
    const d = Math.hypot(x - p.x, z - p.z);
    const nav = this.manager.nav;
    if (!opts.direct && d > 3 && !nav.lineWalkable(p, this.goal, 6)) {
      this.pathPending = true;
      this.manager.requestPath(this, this.goal.combat ? 'combat' : 'normal');
    } else this.pathPending = false;
  }

  /** EnemyManager 가 A* 결과를 넘김 */
  setPath(goal, path) {
    if (goal !== this.goal) return;
    this.pathPending = false;
    this.path = path; this.pathIdx = 0;
    if (!path) { this._stuckCount++; if (this._stuckCount > 2) { goal.done = true; goal.gaveUp = this.now; } }
  }

  _steer(dt) {
    const m = this.motor, g = this.goal, inp = m.input;
    inp.jump = false; inp.lean = 0;
    if (!g || g.done || g.hold) { this._stopInput(); this._stance(this.wantStance); return; }
    const p = m.position;
    let tx = g.x, tz = g.z;
    if (this.path && this.pathIdx < this.path.length) {
      let w = this.path[this.pathIdx];
      while (this.pathIdx < this.path.length - 1 && Math.hypot(w.x - p.x, w.z - p.z) < 1.0) w = this.path[++this.pathIdx];
      tx = w.x; tz = w.z;
    } else if (this.pathPending && Math.hypot(g.x - p.x, g.z - p.z) > 3) {
      // 경로를 기다리는 중: 바로 갈 수 있으면 걸어가고 아니면 잠깐 서서 기다림
      if (!this.manager.nav.lineWalkable(p, g, 6)) { this._stopInput(); this._stance(this.wantStance); return; }
    }
    const dgx = g.x - p.x, dgz = g.z - p.z, dGoal = Math.hypot(dgx, dgz);
    if (dGoal < g.arrive) { g.done = true; this._stopInput(); this._stance(this.wantStance); return; }
    let dx = tx - p.x, dz = tz - p.z;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl; dz /= dl;
    // 앞 1.8m 안의 줄기를 옆으로 비켜 감 (큰 나무에 정면으로 박지 않게)
    {
      const av = this._avoid(p, dx, dz);
      if (av) { dx = av.x; dz = av.z; }
    }
    // 5단계: 넘을 수 없는 턱 (뛰어넘기 높이보다 높은 통나무·바위) 이 바로 앞이면 그 턱을 따라 옆으로 돈다
    {
      const M = CONFIG.movement, wall = M.stepHeight + M.jumpHeight;
      const hAt = (ax, az) => this.query.getSupportHeight(p.x + ax * 0.6, p.z + az * 0.6) - m.position.y;
      if (this._wallT > 0) this._wallT -= dt;
      if (hAt(dx, dz) > wall) {
        if (!(this._wallT > 0)) {
          // 목표 쪽에 더 가까운 옆 (좌·우 70°) 중 지나갈 수 있는 쪽
          const turn = (sgn) => { const a = sgn * 1.22, ca = Math.cos(a), sa = Math.sin(a); return { x: dx * ca - dz * sa, z: dx * sa + dz * ca }; };
          const L = turn(1), R = turn(-1);
          const okL = hAt(L.x, L.z) <= wall, okR = hAt(R.x, R.z) <= wall;
          this._wallSide = okL && !okR ? 1 : okR && !okL ? -1 : (this._wallSide ?? (this.rng.chance(0.5) ? 1 : -1));
          this._wallT = 1.2;
        }
        const a = this._wallSide * 1.22, ca = Math.cos(a), sa = Math.sin(a);
        const rx2 = dx * ca - dz * sa, rz2 = dx * sa + dz * ca;
        dx = rx2; dz = rz2;
      } else if (this._wallT > 0) {
        // 턱 끝까지 조금 더 옆으로 (모서리를 돌 여유)
        const a = this._wallSide * 0.6, ca = Math.cos(a), sa = Math.sin(a);
        const rx2 = dx * ca - dz * sa, rz2 = dx * sa + dz * ca;
        dx = rx2; dz = rz2;
      }
    }
    // 줄기에 걸려 비비고 있으면 옆으로 비켜 걷기 (번갈아 좌우 75°)
    if (this._sidestep > 0) {
      this._sidestep -= dt;
      const a = this._sideDir * 1.3, ca = Math.cos(a), sa = Math.sin(a);
      const rx2 = dx * ca - dz * sa, rz2 = dx * sa + dz * ca;
      dx = rx2; dz = rz2;
    }
    // 자세·속도
    let stance = this.wantStance, intent = 1, sprint = false, quiet = false;
    switch (g.pace) {
      case 'run': stance = this.injuries.effects().downed ? 'prone' : 'stand'; sprint = dGoal > 6 && !this.drag; break;
      case 'walk': stance = this.wantStance === 'prone' ? 'prone' : this.wantStance === 'crouch' ? 'crouch' : 'stand';
        intent = this.paceIntent ?? 1; break;
      case 'sneak': stance = this.wantStance === 'prone' ? 'prone' : 'crouch'; quiet = true; intent = 0.85; break;
      case 'crawl': stance = 'prone'; break;
      default: break;
    }
    this._stance(stance);
    // 시선과 몸: 조준·감시 중이면 그쪽을 보며 옆걸음·뒷걸음, 아니면 가는 방향을 봄
    const faceAim = (this.lookMode === 'aim' || this.lookMode === 'point' || g.face) && !sprint;
    if (faceAim) m.yaw = this.look.yaw;
    else {
      const want = yawOf(dx, dz);
      m.yaw += clamp(wrapAngle(want - m.yaw), -6 * dt, 6 * dt);
    }
    const fx = -Math.sin(m.yaw), fz = -Math.cos(m.yaw), rx = Math.cos(m.yaw), rz = -Math.sin(m.yaw);
    inp.move.x = (dx * rx + dz * rz) * intent;
    inp.move.z = (dx * fx + dz * fz) * intent;
    inp.sprint = sprint;
    inp.quiet = quiet;
    // 통나무·턱: 앞이 디딜 높이보다 높으면 플레이어처럼 뛰어넘음 (1단계 규칙 — 디딤 높이·점프 높이 그대로)
    if (m.stance === 'stand' && m.grounded && m.speed < 0.4 && !m.transitioning) {
      const M = CONFIG.movement;
      const h = this.query.getSupportHeight(p.x + dx * 0.55, p.z + dz * 0.55) - m.position.y;
      if (h > M.stepHeight * 0.75 && h < M.stepHeight + M.jumpHeight) inp.jump = true;
    }
    // 막힘: 실제로 움직인 거리로 판단 (줄기에 비비면 속도는 있어도 제자리) → 옆으로 비켜 보고,
    //  2초 넘게 막히면 다시 경로를 찾고, 다섯 번이면 포기
    const pr = this._prog || (this._prog = { x: p.x, z: p.z, t: 0, dt: 0, d0: Infinity, wx: NaN, wz: NaN });
    pr.t += dt;
    if (pr.t >= 0.5) {
      const moved = Math.hypot(p.x - pr.x, p.z - pr.z);
      const frozen = this.injuries.effects().restriction?.maxSpeedMultiplier === 0;
      // 5단계: 제자리에서 흔들리기만 하는 것도 막힘 — 같은 경유점에 2초 동안 0.4m 도 못 다가갔으면
      const dWay = Math.hypot(tx - p.x, tz - p.z);
      let jitter = false;
      if (pr.wx !== tx || pr.wz !== tz) { pr.wx = tx; pr.wz = tz; pr.d0 = dWay; pr.dt = 0; }
      else {
        pr.dt += pr.t;
        if (pr.dt >= 2) { jitter = pr.d0 - dWay < 0.4; pr.d0 = dWay; pr.dt = 0; }
      }
      if (moved < 0.1 && !m.transitioning && !frozen) this._stuck += pr.t;
      else if (jitter && !m.transitioning && !frozen) this._stuck = Math.max(this._stuck + pr.t, 2);
      else this._stuck = 0;
      pr.x = p.x; pr.z = p.z; pr.t = 0;
      if (this._stuck >= 0.5 && !(this._sidestep > 0)) { this._sidestep = 0.8; this._sideDir = this._sideDir === 1 ? -1 : 1; }
      if (this._stuck >= 2) {
        this._stuck = 0;
        this._stuckCount++;
        // 5단계: 판근·통나무 틈에 끼어 세 번째로 막히면, 플레이어가 못 보는 곳에서만 경유점 쪽 가까운 트인 칸으로 살짝 옮긴다
        if (this._stuckCount >= 3 && this._unstick(tx, tz)) { this._stuckCount = 0; this.path = null; this.pathIdx = 0; }
        else if (this._stuckCount > 4) { g.done = true; g.gaveUp = this.now; this._stuckCount = 0; }
        else if (!this.pathPending) { this.pathPending = true; this.manager.requestPath(this, g.combat ? 'combat' : 'normal'); }
      }
    }
  }

  /** 막힘 풀기: 플레이어에게서 35m 밖이고 (90m 안이면) 시야 밖일 때만, 경유점 쪽 2.5m 안의 트인 칸으로 옮김 */
  _unstick(tx, tz) {
    const p = this.motor.position, t = this.manager.target;
    if (t?.motor) {
      const tp = t.motor.position, d = Math.hypot(tp.x - p.x, tp.z - p.z);
      if (d < 35) return false;
      const fx = -Math.sin(t.motor.yaw), fz = -Math.cos(t.motor.yaw);
      if (d < 90 && ((p.x - tp.x) * fx + (p.z - tp.z) * fz) / d > 0.4) return false;
    }
    const dl = Math.hypot(tx - p.x, tz - p.z) || 1, step = Math.min(2.5, dl);
    const q = this.manager.nav.nearestOpen(p.x + (tx - p.x) / dl * step, p.z + (tz - p.z) / dl * step, 1);
    if (!q || Math.hypot(q.x - p.x, q.z - p.z) > 3.5) return false;
    this.motor.teleport(q.x, q.z, this.motor.yaw);
    this.unstuck = (this.unstuck ?? 0) + 1;
    return true;
  }

  /** 국소 회피: 진행 방향 (dx, dz) 앞 통로에 걸리는 가장 가까운 줄기를 피하는 방향 (없으면 null) */
  _avoid(p, dx, dz) {
    let best = null, bestT = Infinity;
    const rx = -dz, rz = dx;   // 오른쪽
    const look = 1.8;
    this.query.circleGrid.forEachNear(p.x + dx * 0.9, p.z + dz * 0.9, 1.4, (c) => {
      if (!c.tags.blocksMovement || c.r < 0.1) return;
      const ox = c.x - p.x, oz = c.z - p.z;
      const t = ox * dx + oz * dz;
      if (t < -0.2 || t > look + c.r) return;
      const lat = ox * rx + oz * rz;
      if (Math.abs(lat) > c.r + 0.42) return;
      if (t < bestT) { bestT = t; best = { c, lat }; }
    });
    // 6단계: 자기 편 지뢰·구덩이 (자리를 안다) — 줄기처럼 비켜 감, 너무 가까우면 바로 멀어지는 쪽으로
    const hz = this.manager.nav.hazards;
    if (hz && hz.length) {
      const SR = CONFIG.traps.avoid.steerRadius;
      for (const h of hz) {
        const ox = h.x - p.x, oz = h.z - p.z;
        if (Math.abs(ox) > look + SR + 1 || Math.abs(oz) > look + SR + 1) continue;
        const dd = Math.hypot(ox, oz);
        if (dd < h.r + 0.3) {
          const l = dd || 1;
          return { x: -ox / l, z: -oz / l };
        }
        const t = ox * dx + oz * dz;
        const r = h.r + SR - 0.42;
        if (t < -0.2 || t > look + r) continue;
        const lat = ox * rx + oz * rz;
        if (Math.abs(lat) > r + 0.42) continue;
        if (t < bestT) { bestT = t; best = { c: { r }, lat }; }
      }
    }
    if (!best) return null;
    const side = best.lat > 0 ? -1 : 1;           // 장애물이 오른쪽이면 왼쪽으로
    const w = 1 - Math.min(1, Math.max(0, bestT) / (look + best.c.r));
    let x = dx * (1 - 0.7 * w) + rx * side * (0.35 + w), z = dz * (1 - 0.7 * w) + rz * side * (0.35 + w);
    const l = Math.hypot(x, z) || 1;
    return { x: x / l, z: z / l };
  }

  _stance(st) {
    const m = this.motor;
    if (!st || m.transitioning) return;
    if (this.inPit) st = this.pinned || this.mode === 'cower' ? 'crouch' : 'stand';
    if (m.stance !== st) m.requestStance(st);
  }

  /** 구덩이에서 나옴 (후퇴·도주) */
  _climbPit(dt) {
    if (!this.inPit) return;
    const leave = this.mode === 'flee' || this.mode === 'retreat' || (this.squad && this.squad.state === 'search');
    if (!leave) return;
    this._pitClimb += dt;
    this.pitDepth = Math.max(0, CONFIG.ai.ambush.pitDepth * (1 - this._pitClimb / 1.2));
    if (this.pitDepth <= 0) {
      this.inPit = false;
      this.motor.clearRestriction('pit');
      this.manager.emit('pitExit', { soldier: this });
    }
  }

  // =================================================================
  // 매 프레임: 시선·조준
  // =================================================================
  _aim(dt) {
    const A = CONFIG.ai.aim, F = this.fire, look = this.look;
    const eye = this.eye;
    let wantYaw = look.yaw, wantPitch = 0;
    const t = this.target;
    const mode = this.lookMode ?? 'move';
    this.scanPh += dt * this.scanRate;
    const scanAmp = this.scanAmp ?? 0.55;
    if (mode === 'aim' && F.mode !== 'none') {
      const ap = this._aimPoint();
      if (ap) {
        const dx = ap.x - eye.x, dy = ap.y - eye.y, dz = ap.z - eye.z;
        wantYaw = yawOf(dx, dz);
        wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
        // 조준 오차: 처음 크고 점점 줄어듦 (안정 시간 — 반응 지연이 끝나야 겨누기 시작) + 남는 느린 오차
        if (this.now >= F.reactionUntil) F.errT += dt;
        const k = Math.exp(-F.errT / Math.max(0.05, F.tau));
        const res = A.residualDeg * DEG * (this.suppression >= 30 ? 1.5 : 1);
        F.residualPh += dt * 0.9;
        wantYaw += F.errYaw * k + res * Math.sin(F.residualPh * 1.3) * 0.8;
        wantPitch += F.errPitch * k + res * Math.sin(F.residualPh * 0.9 + 1.7) * 0.8;
        if (F.mode === 'panic') {
          wantYaw += this._panicYaw ?? 0; wantPitch += this._panicPitch ?? 0;
        }
      }
    } else if ((mode === 'aim' || mode === 'point' || mode === 'scanPoint') && this.lookAt) {
      const la = this.lookAt;
      wantYaw = yawOf(la.x - eye.x, la.z - eye.z);
      if (mode === 'scanPoint') wantYaw += Math.sin(this.scanPh) * scanAmp * 0.7;
      wantPitch = 0;
    } else if (mode === 'scan') {
      wantYaw = (this.look.baseYaw ?? this.motor.yaw) + Math.sin(this.scanPh) * 1.1;
    } else if (mode === 'free') {
      wantYaw = this.look.targetYaw ?? look.yaw;
    } else {
      // 가는 방향 + 고개를 좌우로 (서 있으면 마지막으로 가던 방향 기준 — 몸이 시선을 따라 돌다 빙빙 돌지 않게)
      const moving = this.goal && !this.goal.done && !this.goal.hold;
      if (moving || this.look.restYaw === undefined) this.look.restYaw = this.motor.yaw;
      this.look.baseYaw = this.look.restYaw;
      wantYaw = this.look.restYaw + Math.sin(this.scanPh) * scanAmp;
    }
    if (mode !== 'scan') this.look.baseYaw = wantYaw;
    // 시선 회전 (사람 손 — 최대 속도 + 부드럽게)
    const maxStep = A.turnRateDeg * DEG * dt;
    const k = 1 - Math.exp(-dt * 9);
    this._prevLook.yaw = look.yaw; this._prevLook.pitch = look.pitch;
    look.yaw += clamp(wrapAngle(wantYaw - look.yaw) * k, -maxStep, maxStep);
    look.pitch += clamp((wantPitch - look.pitch) * k, -maxStep, maxStep);
    look.pitch = clamp(look.pitch, -1.2, 1.2);
    // 서 있으면 몸도 보는 쪽으로 (움직일 때는 _steer 가 몸 방향을 정함)
    const g = this.goal;
    if (!g || g.done || g.hold) this.motor.yaw = look.yaw;
  }

  /** 겨눌 점: 보이면 표적 가슴 + 앞 겨누기 (불완전), 제압 사격이면 그 지점 */
  _aimPoint() {
    const F = this.fire, t = this.target;
    if (F.mode === 'suppress') return F.point;
    if (!t) return null;
    const c = t.person.hitboxes.chest ?? t.motor.position;
    const eye = this.eye;
    const d = Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z);
    const tof = d / Math.max(200, this.weaponData.muzzleVelocity);
    const v = t.motor.velocity;
    const out = this._ap || (this._ap = { x: 0, y: 0, z: 0 });
    out.x = c.x + v.x * tof * F.lead;
    out.y = c.y;
    out.z = c.z + v.z * tof * F.lead;
    return out;
  }

  // =================================================================
  // 매 프레임: 방아쇠
  // =================================================================
  _fireControl(dt) {
    const F = this.fire, Fc = CONFIG.ai.fire, now = this.now, inp = this._input;
    const w = this.shooter.weapon;
    inp.triggerPressed = false;
    inp.reload = this._reloadPressed;
    this._reloadPressed = false;
    const t = this.target;
    const dist = t ? this.perception.distance : Infinity;
    // 가늠자: 겨누는 중이면 (가까우면·공황이면 지향사격)
    const aiming = F.mode !== 'none' && this.lookMode === 'aim';
    this._wantAds = aiming && F.mode !== 'panic' && !(F.mode === 'aimed' && dist < CONFIG.ai.aim.hipDistance);
    inp.aim = this._wantAds;
    // 제압 60 이상이면 사격 0 — 판단 주기와 상관없이 지금 수치로 막는다
    const blocked = !aiming || this.pinned || this.suppression >= CONFIG.ai.suppression.pinned || this.shooter.blocked || w.busy || now < F.reactionUntil
      || (F.mode === 'aimed' && dist > Fc.maxRange) || w.totalRounds === 0;
    if (blocked) { this._releaseTrigger(); return; }
    // 사격 모드: 멀면 단발, 가까우면 연발 (testMode: 테스트에서 고정)
    const wantMode = this.testMode ?? (w._modes().includes('auto') && (dist < 55 || F.mode !== 'aimed') ? 'auto' : 'semi');
    if (w.mode !== wantMode && F.burstLeft === 0 && !w._modes().every((x) => x === w.mode)) w.setMode(wantMode);
    if (F.burstLeft > 0) {
      if (w.mode === 'auto') { inp.trigger = true; }
      else if (now >= F.nextPress) {
        inp.trigger = true; inp.triggerPressed = true;
        F.nextPress = now + this.rng.range(0.28, 0.5);
      } else inp.trigger = false;
      return;
    }
    if (now < F.gapUntil) { this._releaseTrigger(); return; }
    // 조준이 안정됐나 (공황·제압 사격은 대충)
    const k = Math.exp(-F.errT / Math.max(0.05, F.tau));
    const errDeg = Math.hypot(F.errYaw, F.errPitch) * k / DEG;
    // 거리에 맞춰 '맞았다' 싶으면 쏨 — 발견 직후 첫발은 서둘러 덜 맞춘 채로
    const A = CONFIG.ai.aim;
    const thr = F.hurried ? A.firstShotReadyDeg : clamp(A.readyK / Math.max(1, dist), A.readyMinDeg, A.readyMaxDeg);
    const ready = F.mode === 'panic' || F.mode === 'suppress' || (errDeg < thr && this.shooter.aim.ads > (this._wantAds ? 0.85 : -1));
    if (!ready) { this._releaseTrigger(); return; }
    // 아군 사선 (가끔 확인을 빼먹음, 공황이면 안 봄)
    const ap = this._aimPoint();
    if (ap && F.mode !== 'panic' && !this.rng.chance(Fc.friendlyCheckMiss) && this.manager.friendlyInLine(this, this.eye, ap)) {
      F.gapUntil = now + 0.4;
      this._releaseTrigger();
      return;
    }
    // 연발 시작
    const isMg = this.weaponData.bipod;
    let n;
    if (F.mode === 'panic') { n = this.rng.int(Fc.panicBurst[0], Fc.panicBurst[1]); this.stats.panicBursts++; }
    else if (isMg) n = this.rng.int(Fc.mgBurst[0], Fc.mgBurst[1]);
    else if (w.mode === 'semi') n = this.testSingle ? 1 : this.rng.int(1, 2);
    else n = dist < Fc.closeRange ? this.rng.int(Fc.closeBurst[0], Fc.closeBurst[1]) : this.rng.int(Fc.burst[0], Fc.burst[1]);
    F.burstLeft = n;
    F.nextPress = now + this.rng.range(0.28, 0.5);
    inp.trigger = true; inp.triggerPressed = true;
    this.stats.bursts++;
    if (F.mode === 'panic') {
      const e = rr(this.rng, Fc.panicErrorDeg) * DEG, a = this.rng.range(0, Math.PI * 2);
      this._panicYaw = Math.cos(a) * e; this._panicPitch = Math.sin(a) * e * 0.6;
    } else { this._panicYaw = 0; this._panicPitch = 0; }
  }

  _releaseTrigger() {
    const inp = this._input;
    inp.trigger = false; inp.triggerPressed = false;
    if (this.fire.burstLeft > 0) this._endBurst();
  }

  _endBurst() {
    const F = this.fire, Fc = CONFIG.ai.fire;
    F.burstLeft = 0;
    const gap = F.mode === 'suppress' ? Fc.suppressiveGap : this.weaponData.bipod ? Fc.mgBurstGap : Fc.burstGap;
    F.gapUntil = this.now + rr(this.rng, gap);
    if (F.mode === 'panic' && this.rng.chance(0.5)) F.panic = false;
    // 다음 연발은 다시 겨눔 (반동으로 흐트러진 만큼)
    this._acquire(rr(this.rng, CONFIG.ai.aim.reacquireErrorDeg), rr(this.rng, [0.35, 0.9]));
  }

  _onFired(e) {
    const now = this.now;
    this.stats.shots++;
    if (this.suppression >= CONFIG.ai.suppression.pinned) this.stats.shotsPinned++;
    if (this.stats.firstShotAt === -Infinity) this.stats.firstShotAt = now;
    if (this.fire.mode === 'aimed') this.stats.aimedShots++;
    const F = this.fire;
    F.hurried = false;
    if (F.burstLeft > 0 && --F.burstLeft === 0) {
      this._input.trigger = false;
      this._endBurst();
    }
    this.manager.onSoldierFired(this, e);
  }

  /** Shooter 갱신: 자세·시선 → 발사 → 반동을 시선에 */
  _shoot(dt) {
    const m = this.motor, P = this._shot, look = this.look;
    const e = this.eye;
    P.eye.x = e.x; P.eye.y = e.y; P.eye.z = e.z;
    P.yaw = look.yaw; P.pitch = look.pitch;
    P.stance = m.stance; P.stanceFrom = m.stanceFrom; P.stanceProgress = m.stanceProgress;
    P.speed = m.speed; P.sprinting = m.gait === 'sprint';
    P.heartRate = m.heartRate; P.stamina = m.stamina;
    P.lookDeltaYaw = wrapAngle(look.yaw - this._prevLook.yaw);
    P.lookDeltaPitch = look.pitch - this._prevLook.pitch;
    const k = this.shooter.update(dt, P, this._input, this.manager.restQuery);
    if (k.viewKickYaw || k.viewKickPitch) { look.yaw += k.viewKickYaw; look.pitch += k.viewKickPitch; }
    if (k.staminaCost) m.stamina = Math.max(0, m.stamina - k.staminaCost);
    m.loadKg = CONFIG.load.baseKg + this.shooter.weapon.weightKg;
    this._input.triggerPressed = false;
  }
}
