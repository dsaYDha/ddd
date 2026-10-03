// =====================================================================
//  HumanEntity — 전투에 참여하는 '사람 개체' (F8 표적 → 4단계 적 병사의 바탕). 순수 로직.
//   HumanMotor (1단계 이동 규칙) + Injuries (3단계 부상) + Person (부위별 판정 캡슐) 를 묶는다.
//   플레이어와 같은 컴포넌트·같은 규칙 — 적 AI 는 아직 없음 (서 있기·걷기·맞으면 반응만).
//
//  반응 (onHit — Injuries 가 결과를 정한 뒤 부름):
//   · 치명: 맞은 방향(탄 진행 수평 방향)으로 쓰러짐 — 발을 축으로 몸 전체가 돌아 지형 경사에 맞춰 눕는다 (물리 없음).
//     앉아 있었으면 엎드리며 쓰러지고, 엎드려 있었으면 그대로 늘어진다.
//   · 비치명: 부상 효과대로 넘어지거나(가슴·복부·골반·대퇴 → 엎드림) 주저앉는다(하퇴·팔·스침 → 앉기).
//     충격이 풀리면 가장 가까운 엄폐물(총알을 막는 줄기·바위·통나무) 뒤로 crawlMin~crawlMax m 기어간다
//     (coverSearch m 안에 없으면 쏜 쪽 반대로). 그 뒤 엎드리거나 앉은 채 신음·거친 숨 ('vocal').
//   · 출혈: Injuries 가 혈액을 줄이고 40% 미만이면 사망 → 그 자리에서 늘어짐 (fall.kind 'slump').
//  이벤트: 'vocal' {kind: 'moan'|'breath'|'cough', position} · 'bleed' {position, rate} (땅 핏자국) ·
//          'fall' {kind, dir} · 'death' {cause} · 'state' {state, prev}
//  상태 읽기 (4단계): state ('idle'|'walk'|'turn'|'stunned'|'crawl'|'down'|'dead'), injuries.summary(), motor.getState()
//  pose(): Hitboxes pose — fall {ax, az, angle, lift} 포함 (TargetMesh 가 같은 회전으로 그린다)
//  4단계: 적 병사(ai/Soldier.js)가 이 클래스를 이어받는다 — _control(dt) (매 프레임 조종)·_afterMotor(dt) (부상·소리)를 바꿔 끼움.
//   opts.suppression: true 면 제압 컴포넌트를 붙임 (병사), opts.faction: 'enemy' 등 (소음 출처 구분)
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { RNG } from '../core/rng.js';
import { smoothstep, wrapAngle } from '../core/math.js';
import { HumanMotor } from '../human/HumanMotor.js';
import { Injuries } from './Injuries.js';

const yawOf = (dx, dz) => Math.atan2(-dx, -dz);
const BODY_LEN = 1.62;        // 쓰러진 몸 길이 (발 → 머리, m) — 경사 맞추기
const LIE_LIFT = 0.12;        // 누운 몸통 반경만큼 발 축을 올림 (땅에 반쯤 묻히지 않게)
const STAIN_EVERY = 1.6;      // 피를 흘리는 동안 땅 핏자국 간격 (s)

export class HumanEntity extends EventEmitter {
  /**
   * @param {object} query  WorldQuery (지면·충돌·엄폐물)
   * @param {import('./CombatSystem.js').CombatSystem} combat
   * @param {{ x, z, y?, yaw?, stance?, rng?: RNG, name?: string, data?: object, arms?: 'down'|'rifle',
   *           walk?: { center:{x,z}, axis:{x,z}, min, max, dir?, speed?, turnTime?, faceYaw? } | null }} opts
   */
  constructor(query, combat, opts = {}) {
    super();
    this.query = query;
    this.combat = combat;
    this.rng = opts.rng ?? new RNG((Math.random() * 4294967296) >>> 0);
    this.name = opts.name ?? '사람';
    this.arms = opts.arms ?? 'down';
    const motor = new HumanMotor(query, { x: opts.x ?? 0, z: opts.z ?? 0, yaw: opts.yaw ?? 0, name: this.name });
    this.motor = motor;
    const st = opts.stance ?? 'stand';
    motor.stance = st; motor.stanceFrom = st; motor.stanceProgress = 1;
    motor.eyeHeight = CONFIG.stance.eyeHeight[st];
    if (Number.isFinite(opts.y)) motor.position.y = Math.max(motor.position.y, opts.y);
    this.injuries = new Injuries({ rng: this.rng.fork ? this.rng.fork(3) : this.rng, motor, name: this.name });
    this._pose = { x: 0, y: 0, z: 0, yaw: 0, stance: st, stanceFrom: st, stanceProgress: 1, lean: 0, arms: this.arms, eyeHeight: motor.eyeHeight, bodyPitch: 0, fall: null };
    this.faction = opts.faction ?? 'neutral';
    motor.faction = this.faction;
    this.person = combat.addPerson({
      name: this.name, getPose: () => this.pose(), suppression: opts.suppression ? undefined : null, injuries: this.injuries,
      noiseSource: motor, data: opts.data ?? {},
    });
    this.person.faction = this.faction;
    this.person.entity = this;
    this.walk = opts.walk ? {
      dir: 1, speed: CONFIG.testRange.walkSpeed, turnTime: CONFIG.testRange.walkTurnTime, center: { x: opts.x ?? 0, z: opts.z ?? 0 },
      ...opts.walk, turn: 0, turnFrom: 0, turnDelta: 0,
    } : null;
    this.state = this.walk ? 'walk' : 'idle';
    this.fall = null;             // { kind: 'collapse'|'slump', t (0..1), dir {x,z}, angle, lift, duration }
    this.settled = false;         // 쓰러짐이 끝남
    this.crawl = null;            // { target {x,z}, left (m), timeout }
    this.threat = null;           // 마지막으로 쏜 쪽 {x, z}
    this._vocal = this._vocalDelay();
    this._stain = STAIN_EVERY * 0.5;
    if (this.walk) this.motor.yaw = this._walkYaw();
    this.injuries.on('death', (e) => this._onDeath(e));
    this.injuries.on('cough', () => this.emit('vocal', { kind: 'cough', position: this.motor.position }));
    this.person.refresh();
  }

  get alive() { return !this.injuries.dead; }
  get position() { return this.motor.position; }

  /** 판정·화면 자세 (재사용 객체) */
  pose() {
    const m = this.motor, P = this._pose;
    P.x = m.position.x; P.y = m.position.y; P.z = m.position.z;
    P.yaw = m.yaw;
    // 모양 값은 TargetMesh 지오메트리 캐시와 같은 단위로 끊는다 (판정 캡슐 = 보이는 모습, 매 프레임 지오메트리 생성 없음)
    const prog = m.stanceProgress;
    P.stance = m.stance; P.stanceFrom = prog >= 1 ? m.stance : m.stanceFrom; P.stanceProgress = Math.round(prog * 12) / 12;
    P.lean = 0;
    P.eyeHeight = Math.round(m.eyeHeight / 0.02) * 0.02;
    P.bodyPitch = 0;
    if (m.stance === 'prone' || m.stanceFrom === 'prone') {
      const fx = -Math.sin(m.yaw), fz = -Math.cos(m.yaw);
      const q = this.query;
      const hf = q.getSupportHeight(P.x + fx * 0.3, P.z + fz * 0.3);
      const hb = q.getSupportHeight(P.x - fx * 1.3, P.z - fz * 1.3);
      P.bodyPitch = Math.round(Math.atan2(hf - hb, 1.6) / 0.02) * 0.02;
    }
    const f = this.fall;
    if (f && f.angle) {
      const k = f.kind === 'collapse' ? fallCurve(f.t) : smoothstep(0, 1, f.t);
      const fa = P.fall || (P.fall = { ax: 0, az: 0, angle: 0, lift: 0 });
      fa.ax = f.dir.z; fa.az = -f.dir.x;        // 축 = 위 × 쓰러지는 방향 (머리가 dir 쪽으로)
      fa.angle = f.angle * k;
      fa.lift = f.lift * k;
    } else if (P.fall) P.fall.angle = 0;
    return P;
  }

  /** Injuries.applyHit 뒤에 부름 (TargetRange 가 combat 'hit' 에서) */
  onHit(e) {
    const r = e.wound ?? this.injuries.lastHit;
    if (e.shooter) {
      const sp = e.shooter.position ?? e.shooter.motor?.position ?? null;
      if (sp) this.threat = { x: sp.x, z: sp.z };
      else if (e.dir) this.threat = { x: this.motor.position.x - e.dir.x * 30, z: this.motor.position.z - e.dir.z * 30 };
    } else if (e.dir) this.threat = { x: this.motor.position.x - e.dir.x * 30, z: this.motor.position.z - e.dir.z * 30 };
    if (!r || r.alreadyDead) return;
    this.walk = null;
    this.crawl = null;
    this._stopInput();
    if (r.killed) return;   // _onDeath 가 쓰러뜨림 (Injuries 'death')
    // 비치명: 넘어짐(Injuries 가 강제 자세) 또는 주저앉음
    const spec = CONFIG.injury.wounds[r.type] || {};
    if (!spec.forceStance && this.motor.stance === 'stand') this.motor.forceStance('crouch', 0.45);
    this._setState('stunned');
    this._crawlPending = true;
    this.emit('fall', { kind: spec.forceStance ? 'down' : 'sit', dir: e.dir ? { x: e.dir.x, z: e.dir.z } : null });
  }

  update(dt) {
    if (!(dt > 0)) return;
    const inj = this.injuries;
    const m = this.motor;
    if (this.fall) {
      // 쓰러지는 중·쓰러진 시체: 이동 컴포넌트는 멈춘 채 지면만 따라감
      const f = this.fall;
      if (f.t < 1) {
        f.t = Math.min(1, f.t + dt / f.duration);
        if (f.t >= 1) this.settled = true;
      }
      this._stopInput();
      m.update(dt);
      return;
    }
    if (inj.alive) this._control(dt);
    m.update(dt);
    this._afterMotor(dt);
  }

  /** 매 프레임 조종 (표적: 걷기·기어가기) — 병사는 AI 두뇌로 바꿔 끼운다 */
  _control(dt) {
    const inj = this.injuries;
    if (this.walk && this.state !== 'stunned') this._walkStep(dt);
    else if (inj.stunned) { this._stopInput(); }
    else if (this._crawlPending) { this._crawlPending = false; this._startCrawl(); }
    else if (this.crawl) this._crawlStep(dt);
    else if (this.state !== 'idle' && this.state !== 'walk') { this._stopInput(); this._setState('down'); }
  }

  /** 이동 뒤: 부상 갱신·효과 적용, 신음·핏자국 */
  _afterMotor(dt, shooter = null) {
    const inj = this.injuries, m = this.motor;
    inj.update(dt, { speed: Math.hypot(m.velocity.x, m.velocity.z) });
    inj.apply(m, shooter);
    if (!inj.alive) return;
    // 신음·거친 숨, 땅 핏자국
    if (inj.hasWounds) {
      this._vocal -= dt;
      if (this._vocal <= 0) {
        this._vocal = this._vocalDelay();
        const kind = inj.stage === 'faint' ? 'breath' : this.rng.chance(0.55) ? 'moan' : 'breath';
        this.emit('vocal', { kind, position: m.position, stage: inj.stage });
      }
      const rate = inj.bleedRate;
      if (rate > 0) {
        this._stain -= dt * Math.min(3, 0.5 + rate / 8);
        if (this._stain <= 0) {
          this._stain = STAIN_EVERY;
          this.emit('bleed', { position: { x: m.position.x, y: m.position.y, z: m.position.z }, rate });
        }
      }
    }
  }

  /** 제거 (사람 목록에서) */
  dispose() {
    this.combat.removePerson(this.person);
    this.injuries.bindMotor(null);
  }

  // -----------------------------------------------------------------
  _setState(s) {
    if (s === this.state) return;
    const prev = this.state;
    this.state = s;
    this.emit('state', { state: s, prev });
  }

  _stopInput() {
    const i = this.motor.input;
    i.move.x = 0; i.move.z = 0; i.sprint = false; i.quiet = false;
  }

  _vocalDelay() {
    const [a, b] = CONFIG.injury.entity.vocalInterval;
    return this.rng.range(a, b);
  }

  // ---- 죽음 --------------------------------------------------------
  _onDeath(e) {
    const m = this.motor;
    this.walk = null; this.crawl = null; this._crawlPending = false;
    this._stopInput();
    const E = CONFIG.injury.entity;
    let dir = null;
    const hit = e.hit;
    if (hit && hit.dir) {
      const h = Math.hypot(hit.dir.x, hit.dir.z);
      if (h > 1e-3) dir = { x: hit.dir.x / h, z: hit.dir.z / h };
    }
    if (!dir) {
      // 출혈: 엎드려 있으면 그대로, 아니면 앞으로 늘어짐
      dir = { x: -Math.sin(m.yaw), z: -Math.cos(m.yaw) };
    }
    const visible = m.stanceProgress < 0.5 ? m.stanceFrom : m.stance;
    if (visible === 'stand') {
      // 선 채 맞음: 발을 축으로 몸 전체가 맞은 방향으로 넘어가 지형 경사에 맞춰 눕는다
      const p = m.position, q = this.query;
      const hFeet = q.getSupportHeight(p.x, p.z);
      const hHead = q.getSupportHeight(p.x + dir.x * BODY_LEN, p.z + dir.z * BODY_LEN);
      const angle = Math.atan2(BODY_LEN, hHead - hFeet + LIE_LIFT * 0.5);
      this.fall = { kind: 'collapse', t: 0, dir, angle: Math.min(Math.PI * 0.62, Math.max(Math.PI * 0.3, angle)), lift: LIE_LIFT, duration: E.fallTime };
    } else {
      // 앉거나 엎드린 채: 엎드리며 늘어짐 (몸 회전 없음 — 엎드린 모양이 곧 쓰러진 모양)
      if (m.stance !== 'prone') m.forceStance('prone', E.fallTime * 0.7);
      this.fall = { kind: 'slump', t: 0, dir, angle: 0, lift: 0, duration: E.slumpTime };
    }
    this.settled = false;
    this._setState('dead');
    this.emit('fall', { kind: this.fall.kind, dir });
    this.emit('death', { cause: e.cause, label: e.label });
  }

  // ---- 걷기 (다치지 않은 표적) ---------------------------------------
  _walkYaw() {
    const w = this.walk;
    return yawOf(w.axis.x * w.dir, w.axis.z * w.dir);
  }

  _walkStep(dt) {
    const w = this.walk, m = this.motor;
    if (w.turn > 0) {
      w.turn = Math.max(0, w.turn - dt);
      this._stopInput();
      if (w.turn === 0) { w.dir = -w.dir; m.yaw = this._walkYaw(); }
      else m.yaw = w.turnFrom + w.turnDelta * smoothstep(0, 1, 1 - w.turn / w.turnTime);
      this._setState('turn');
      return;
    }
    const phase = (m.position.x - w.center.x) * w.axis.x + (m.position.z - w.center.z) * w.axis.z;
    const end = w.dir > 0 ? w.max : -w.min;
    if ((end - phase) * w.dir <= 0.02 || w.min + w.max < 0.1) {
      this._stopInput();
      const T = Math.max(0, w.turnTime);
      if (T > 0) {
        w.turn = T; w.turnTime = T; w.turnFrom = m.yaw;
        const half = wrapAngle((w.faceYaw ?? m.yaw + Math.PI / 2) - m.yaw);
        w.turnDelta = 2 * (Math.abs(half) > 1e-3 ? half : Math.PI / 2);
      } else { w.dir = -w.dir; m.yaw = this._walkYaw(); }
      return;
    }
    m.yaw = this._walkYaw();
    // 걷기 속도 1.6 m/s × 의도 → testRange.walkSpeed (지면·경사는 이동 컴포넌트 규칙대로)
    m.input.move.x = 0;
    m.input.move.z = Math.min(1, w.speed / CONFIG.movement.speed.walk);
    this._setState('walk');
  }

  // ---- 엄폐물로 기어가기 ----------------------------------------------
  _startCrawl() {
    const E = CONFIG.injury.entity;
    const m = this.motor, p = m.position;
    const dist = this.rng.range(E.crawlMin, E.crawlMax);
    const th = this.threat ?? { x: p.x, z: p.z - 30 };
    let best = null, bestD = Infinity;
    const grid = this.query.circleGrid;
    if (grid && typeof grid.forEachNear === 'function') {
      grid.forEachNear(p.x, p.z, E.coverSearch, (c) => {
        if (!c.tags || c.tags.bulletBlock !== 'full' || !c.tags.blocksMovement || c.r < 0.12) return;
        // 쏜 쪽에서 볼 때 줄기 뒤 (줄기 반경 + 0.5m)
        let ux = c.x - th.x, uz = c.z - th.z;
        const ul = Math.hypot(ux, uz) || 1;
        ux /= ul; uz /= ul;
        const tx = c.x + ux * (c.r + 0.5), tz = c.z + uz * (c.r + 0.5);
        const d = Math.hypot(tx - p.x, tz - p.z);
        if (d < bestD && d <= E.coverSearch) { bestD = d; best = { x: tx, z: tz }; }
      });
    }
    let dx, dz;
    if (best) { dx = best.x - p.x; dz = best.z - p.z; } else { dx = p.x - th.x; dz = p.z - th.z; }
    const dl = Math.hypot(dx, dz);
    if (dl < 0.2) { this._setState('down'); return; }
    dx /= dl; dz /= dl;
    const go = Math.min(dist, best ? bestD : dist);
    // 다친 몸으로 기어간다: 엎드릴 수 있으면 엎드려서 (다리·팔·스침은 앉은 채 끌기도 하지만 엄폐는 낮게)
    if (m.stance !== 'prone' && m.stanceAllowed('prone')) m.requestStance('prone');
    this.crawl = { dir: { x: dx, z: dz }, left: go, timeout: go / 0.08 + 6, last: { x: p.x, z: p.z } };
    this._setState('crawl');
  }

  _crawlStep(dt) {
    const c = this.crawl, m = this.motor, p = m.position;
    c.timeout -= dt;
    const moved = Math.hypot(p.x - c.last.x, p.z - c.last.z);
    c.left -= moved;
    c.last.x = p.x; c.last.z = p.z;
    if (c.left <= 0 || c.timeout <= 0) {
      this.crawl = null;
      this._stopInput();
      this._setState('down');
      return;
    }
    m.yaw = yawOf(c.dir.x, c.dir.z);
    m.input.move.x = 0;
    m.input.move.z = m.transitioning ? 0 : 1;
  }
}

/** 쓰러짐 곡선: 처음엔 천천히 기울다 중력으로 빨라지고 땅에 닿을 때 살짝 튐 */
function fallCurve(t) {
  if (t >= 1) return 1;
  const a = t * t * (1.6 - 0.6 * t);   // 가속
  const bounce = t > 0.82 ? Math.sin((t - 0.82) / 0.18 * Math.PI) * 0.035 : 0;
  return Math.min(1.02, a + bounce);
}
