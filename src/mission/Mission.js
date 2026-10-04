// =====================================================================
//  Mission — 5단계 임무 진행·성공/실패·결과 집계 (순수 로직)
//   단계: 'active' (목표) → 'extract' (모든 목표 완료, 회수 지점으로) → 'complete' | 'failed'
//   · 정찰 지점 'observe': 25m 안에서 그 지점을 바라보는 동안 (시선 ±coneDeg) 쌓여 5초면 확인 — 무전 자막으로만 알림.
//   · 매복 'ambush': Director 의 기습 판정 (성공 / 놓침 → 실패).
//   · 문서 'documents': 오두막 안에서 F 3초 (runtime 이 docsTaken() 을 부름).
//   · 회수: 반경 안에서 60초 버티면 (밖으로 나가면 멈춤) 헬기 → 'complete'.
//   · 실패: 사망, 제한 시간 초과, 임무 포기, 행렬을 놓침.
//   · 체크포인트 (설정, 1회): 첫 중간 목표 달성 때 'checkpoint' 이벤트 — runtime 이 상태를 저장.
//  결과 stats: 시간, 이동 거리, 발사·명중, 사용·남은 탄약, 입은 부상, 적 사상자 (확인 / 추정)
//  이벤트: 'objective' {o, index} · 'extract' · 'zone' {inside} · 'checkpoint' · 'warn' {min} · 'complete' · 'failed' {reason}
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';

const DEG = Math.PI / 180;
export const FAIL_LABELS = {
  dead: '전사', time: '제한 시간 초과', abort: '임무 포기', missed: '보급 행렬을 놓쳤다',
};

export class Mission extends EventEmitter {
  constructor(def, opts = {}) {
    super();
    this.def = def;
    this.phase = 'active';
    this.t = 0;
    this.reason = null;
    this.checkpointEnabled = !!opts.checkpoint;
    this.checkpointDone = false;
    this.objectives = def.objectives.map((o) => ({ ...o, done: false, progress: 0 }));
    this.hold = 0;
    this.inZone = false;
    this._warned = new Set();
    this.stats = {
      distance: 0, shots: 0, hits: 0, roundsStart: 0, roundsLeft: 0, looseStart: 0, looseLeft: 0, loaded: 0,
      wounds: [], confirmed: 0, estimated: 0, enemyWounded: 0, weapon: '',
    };
  }

  get done() { return this.phase === 'complete' || this.phase === 'failed'; }
  get remaining() { return Math.max(0, this.def.limit - this.t); }
  get current() { return this.objectives.find((o) => !o.done) ?? null; }

  /**
   * ctx: { pos {x,z}, fwd {x,z} (시선 수평), alive, ambush: Director.ambush.state }
   */
  update(dt, ctx) {
    if (this.done) return;
    this.t += dt;
    if (!ctx.alive) { this.fail('dead'); return; }
    if (this.t >= this.def.limit) { this.fail('time'); return; }
    // 남은 시간 무전
    for (const min of CONFIG.mission.warnMin) {
      if (!this._warned.has(min) && this.remaining <= min * 60 && this.def.limit > min * 60 + 60) {
        this._warned.add(min);
        this.emit('warn', { min });
      }
    }
    if (this.phase === 'active') {
      for (let i = 0; i < this.objectives.length; i++) {
        const o = this.objectives[i];
        if (o.done) continue;
        if (o.kind === 'observe') this._observe(o, i, dt, ctx);
        else if (o.kind === 'ambush') {
          if (ctx.ambush === 'success') this._complete(o, i);
          else if (ctx.ambush === 'missed') { this.fail('missed'); return; }
        }
      }
      if (this.objectives.every((o) => o.done)) {
        this.phase = 'extract';
        this.emit('extract', {});
      }
    }
    if (this.phase === 'extract') {
      const ex = this.def.extraction;
      const inside = Math.hypot(ctx.pos.x - ex.x, ctx.pos.z - ex.z) <= ex.r;
      if (inside !== this.inZone) { this.inZone = inside; this.emit('zone', { inside }); }
      if (inside) {
        this.hold += dt;
        if (this.hold >= CONFIG.mission.extraction.hold) { this.phase = 'complete'; this.emit('complete', {}); }
      }
    }
  }

  _observe(o, i, dt, ctx) {
    const O = CONFIG.mission.observe;
    const dx = o.x - ctx.pos.x, dz = o.z - ctx.pos.z, d = Math.hypot(dx, dz);
    let looking = false;
    if (d <= O.radius) {
      if (d < 3) looking = true;
      else {
        const fl = Math.hypot(ctx.fwd.x, ctx.fwd.z) || 1;
        const c = (dx * ctx.fwd.x + dz * ctx.fwd.z) / (d * fl);
        looking = Math.acos(Math.max(-1, Math.min(1, c))) <= O.coneDeg * DEG;
      }
    }
    if (looking) o.progress = Math.min(1, o.progress + dt / O.time);
    else o.progress = Math.max(0, o.progress - dt / (O.time * 3));
    if (o.progress >= 1) this._complete(o, i);
  }

  /** 문서 회수 (runtime) */
  docsTaken() {
    const o = this.objectives.find((x) => x.kind === 'documents' && !x.done);
    if (o) this._complete(o, this.objectives.indexOf(o));
  }

  _complete(o, i) {
    if (o.done) return;
    o.done = true;
    o.progress = 1;
    o.doneAt = this.t;
    this.emit('objective', { o, index: i });
    if (this.checkpointEnabled && !this.checkpointDone) {
      this.checkpointDone = true;
      this.emit('checkpoint', { o });
    }
  }

  fail(reason) {
    if (this.done) return;
    this.phase = 'failed';
    this.reason = reason;
    this.emit('failed', { reason, label: FAIL_LABELS[reason] ?? reason });
  }

  /** 결과 화면 요약 (숫자는 결과 화면에서만) */
  summary() {
    const s = this.stats;
    return {
      success: this.phase === 'complete', reason: this.reason, reasonLabel: FAIL_LABELS[this.reason] ?? '',
      time: this.t, distance: s.distance, shots: s.shots, hits: s.hits,
      used: s.shots, roundsLeft: s.roundsLeft, looseLeft: s.looseLeft, loaded: s.loaded,
      wounds: s.wounds.slice(), confirmed: s.confirmed, estimated: s.estimated, enemyWounded: s.enemyWounded,
      objectives: this.objectives.map((o) => ({ label: o.label, done: o.done })), weapon: s.weapon,
      traps: s.traps ?? null,      // 6단계: 함정 (알아챔·걸림·해제)
      // 7단계 분대 모드: 아군 사상자(이름별) · 오인 사격 · 지원 화력 · 보급
      mode: s.mode ?? 'solo', squad: s.squad ?? null, friendlyFire: s.friendlyFire ?? null, support: s.support ?? null, supply: s.supply ?? null,
    };
  }
}
