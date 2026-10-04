// =====================================================================
//  FriendSquad — 7단계 아군 분대 (순수 로직). 플레이어 = 분대장 (병사가 아님 — 플레이어 묘사), 분대원 = Ally.
//   · 대형: 일렬(file — 플레이어가 지나온 길 위 간격) · 쐐기(wedge) · 산개(spread) — 명령이 없으면 자동 (오솔길 위면 일렬, 숲이면 쐐기).
//     첨병은 pointAhead m 앞
//     (오솔길 위면 길을 따라). 무전병은 플레이어 바로 뒤 (지원 화력 요청 거리). 걷는 속도는 플레이어 걸음에 맞춤.
//   · 명령 (issue): 수신호 = 플레이어를 볼 수 있는 분대원만 (거리·밤 빛·시야 레이·나를 보고 있거나 돌아봄) — 소리 없음,
//                   외치기 = 모두 (소음 이벤트 — 근처 적도 들음). 받은 뒤 0.5~2초에 실행 (Ally.queueOrder).
//   · 교전 상태 (calm/contact): 발견·피격·총성·플레이어 사격 → contact, contactHold 초 조용하면 calm.
//   · 적 발견 보고 '적! 2시 방향, 50미터!' (분대 진행 방향 기준 시계, 방향·거리 조금씩 틀림)
//   · 첨병 함정 찾기 (6단계 발견 규칙, 조용히 걸으며 땅을 봄) → '정지! 철선!' + 분대 정지 trapHalt 초
//   · 배정: 의무병 (다친 분대원·플레이어 — 동맥 우선), 부상자 끌기 (교전 중, 제압 낮은 동료), 업기 (이동 중, 걷지 못하는 부상자)
//   · 탄약: '탄약 줘' — 가장 가까운 분대원이 예비 탄창 3개 이상이면 1개 던짐 (날아가는 시간 뒤 'ammoArrive')
//  이벤트 (manager 로): 'say' {soldier, text, kind} · 'orderIssued' {key, method, receivers} · 'ammoArrive' {from, rounds}
//          'trapHalt' {trap, by} · 'report' {soldier, target, text} · 'friendlyFire' {victim, shooter}
// =====================================================================
import { CONFIG } from '../config.js';
import { Ally } from './Ally.js';
import { RNG } from '../core/rng.js';

const rr = (rng, r) => rng.range(r[0], r[1]);
const DEG = Math.PI / 180;
const JOB_ORDER = ['point', 'radio', 'mg', 'medic', 'rifleman'];
const TRAP_WORD = { tripwire: '철선', spikePit: '구덩이', mine: '지뢰' };
export const ORDER_LABELS = {
  follow: '따라와', halt: '정지', moveTo: '저기로 이동', retreat: '후퇴', prone: '엎드려', hold: '그 자리에서 대기',
  file: '일렬', wedge: '쐐기', spread: '산개', holdFire: '사격 금지', freeFire: '자유 사격', onMyShot: '내가 쏘면 사격',
  suppress: '제압 사격', medic: '의무병', ammo: '탄약 줘',
};
const SHOUT_TEXT = {
  follow: '따라와!', halt: '정지!', moveTo: '저기로 이동!', retreat: '후퇴! 후퇴!', prone: '엎드려!', hold: '그 자리에서 대기!',
  file: '일렬로!', wedge: '쐐기 대형!', spread: '산개!', holdFire: '사격 금지!', freeFire: '자유 사격!', onMyShot: '내가 쏘면 쏴라!',
  suppress: '저기 제압해!', medic: '의무병!', ammo: '탄약 줘!',
};

/** 받침에 따라 이/가 (한글 이름) */
export function iGa(name) {
  const c = name.charCodeAt(name.length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0 ? '이' : '가';
}

/** 이름 만들기 (임무 시드마다 같음) */
export function makeRoster(seed, size = CONFIG.allies.size) {
  const A = CONFIG.allies, rng = new RNG((seed * 2654435761) >>> 0 || 7);
  const n = Math.max(3, Math.min(5, size));
  const used = new Set();
  const out = [];
  for (let i = 0; i < n; i++) {
    let name = '';
    for (let k = 0; k < 20; k++) {
      name = rng.pick(A.names.family) + rng.pick(A.names.given) + rng.pick(A.names.given);
      if (!used.has(name) && name[1] !== name[2]) break;
    }
    used.add(name);
    out.push({ name, job: A.roles[i], voice: (i + rng.range(0.1, 0.9)) / n, variant: rng.int(0, 5) });
  }
  // 3명이면 첨병·무전병·의무병 (기관총 없음) — roles 순서대로라 point·radio·mg → mg 대신 의무병
  if (n === 3) out[2].job = 'medic';
  return out;
}

export class FriendSquad {
  /**
   * @param {import('./EnemyManager.js').EnemyManager} manager
   * @param {{ rng?: RNG }} opts
   */
  constructor(manager, opts = {}) {
    this.manager = manager;
    this.rng = opts.rng ?? new RNG(99);
    this.type = 'friend';
    this.members = [];
    this.leader = null;            // (플레이어는 병사가 아님 — 적 분대 코드 호환용)
    this.state = 'calm';
    this.stateSince = 0;
    this.contact = null;
    this.threat = null;
    this.suspicion = null;
    this.investigators = [];
    this.confusedUntil = -Infinity;
    this.coordinationWeak = false;
    this.morale = 70;
    this.ambush = null;
    this.flankAxis = null;
    this.retreat = null;
    this.search = null;
    this.casualties = 0;
    this.playerFiredAt = -Infinity;
    this.contactAt = -Infinity;
    this.haltUntil = -Infinity;
    this.haltTrap = null;
    this.knownHazards = [];
    this.flights = [];             // 날아가는 탄창 { from, rounds, at }
    this.log = { orders: 0, signals: 0, shouts: 0, received: 0, reports: 0, trapHalts: 0, treated: 0, ammoThrown: 0, friendlyFire: 0 };
    this._trail = [];              // 플레이어가 지나온 점 (2m 간격, 최근 → 오래된 순)
    this._heading = { x: 0, z: -1 };
    this._slots = new Map();
    this._slotT = -1;
    this.autoFormation = 'file';   // 대형 명령이 없을 때 (오솔길 → 일렬, 숲 → 쐐기)
    this._fmT = 0;
    this._offTrail = 0;
    this._assignT = 0;
    this._pointT = 0;
    this._reportAt = -Infinity;
    this._reported = new Map();    // 표적 → 마지막 보고 시각
    this._lastPlayerGait = 'idle';
    this._timers = [];
    this._offs = [];
    const c = manager.combat;
    if (c) this._offs.push(c.on('shot', (e) => { if (e.shooter === manager.player?.person) this.onPlayerShot(e); }));
  }

  get now() { return this.manager.time; }
  get alive() { return this.members.filter((m) => m.alive); }
  get able() { return this.members.filter((m) => m.alive && !m.injuries.downed && !m.draggedBy && !m.carriedBy); }
  get playerRef() { return this.manager.player; }
  get radioman() { return this.members.find((m) => m.job === 'radio') ?? null; }
  get medic() { return this.members.find((m) => m.job === 'medic' && m.alive) ?? null; }

  add(s) {
    s.squad = this;
    s.order = this.members.length;
    s.baseRole = s.role;
    this.members.push(s);
  }

  dispose() { for (const off of this._offs) off?.(); this._offs.length = 0; }

  // =================================================================
  // 생성
  // =================================================================
  /**
   * 분대원 생성: 플레이어 뒤로 일렬 (걸을 수 있는 칸). roster: makeRoster 결과
   * @returns {FriendSquad}
   */
  static spawn(manager, roster, opts = {}) {
    const sq = new FriendSquad(manager, { rng: new RNG(opts.seed ?? 4242) });
    manager.friendSquad?.dispose?.();
    manager.friendSquad = sq;
    const pl = manager.player;
    const p0 = opts.at ?? (pl ? pl.motor.position : { x: 0, z: 0 });
    const yaw = opts.yaw ?? (pl ? pl.motor.yaw : 0);
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const nav = manager.nav;
    roster.slice(0, CONFIG.allies.maxActive).forEach((r, i) => {
      // 첨병은 앞, 나머지는 뒤로
      const back = r.job === 'point' ? -CONFIG.allies.pointAhead : 4 + i * 4;
      const want = { x: p0.x - fx * back + (i % 2 ? 1.2 : -1.2), z: p0.z - fz * back };
      const q = nav.nearestOpen(want.x, want.z, 6) ?? want;
      const a = new Ally(manager, { x: q.x, z: q.z, yaw, rng: new RNG((opts.seed ?? 4242) + i * 977), job: r.job, name: r.name, voice: r.voice, variant: r.variant });
      a.look.yaw = yaw;
      manager._addSoldier(a);
      sq.add(a);
    });
    sq._heading = { x: fx, z: fz };
    sq._trail = [];
    return sq;
  }

  // =================================================================
  // 프레임
  // =================================================================
  update(dt) {
    const now = this.now;
    this._trackPlayer();
    // 교전 상태
    const seeing = this.members.some((m) => m.alive && m.perception.seesAny);
    if (seeing) this.contactAt = now;
    if (this.state === 'contact' && now - this.contactAt > CONFIG.allies.contactHold) this._setState('calm');
    else if (this.state !== 'contact' && now - this.contactAt < 1) this._setState('contact');
    // 알아챈 함정 (비켜 갈 자리)
    const T = this.manager.traps;
    if (T) this.knownHazards = T.knownHazards();
    // 자동 대형 (0.5초마다 — 길에서 1초 넘게 벗어나면 쐐기, 길에 오르면 일렬)
    this._fmT -= dt;
    if (this._fmT <= 0) { this._fmT = 0.5; this._updateAutoFormation(); }
    // 첨병 함정 찾기
    this._pointT -= dt;
    if (this._pointT <= 0) { this._pointT = CONFIG.allies.pointDetect.tick; this._pointScan(); }
    // 배정 (1초마다)
    this._assignT -= dt;
    if (this._assignT <= 0) { this._assignT = 1; this._assignMedic(); this._assignDrags(); this._assignCarries(); }
    // 탄창 날아감
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      if (now < f.at) continue;
      this.flights.splice(i, 1);
      this.manager.emit('ammoArrive', { from: f.from, rounds: f.rounds });
    }
    // 미뤄 둔 말 (대답·보고)
    const TM = this._timers;
    for (let i = TM.length - 1; i >= 0; i--) if (now >= TM[i].at) { const f = TM[i].fn; TM.splice(i, 1); f(); }
  }

  _updateAutoFormation() {
    const pl = this.playerRef, nav = this.manager.nav;
    if (!pl || !nav?.onTrail) return;
    const P = pl.motor.position, H = this._heading;
    const on = nav.onTrail(P.x, P.z) || nav.onTrail(P.x + H.z * 1.5, P.z - H.x * 1.5) || nav.onTrail(P.x - H.z * 1.5, P.z + H.x * 1.5);
    if (on) { this._offTrail = 0; this.autoFormation = 'file'; } else if (++this._offTrail >= 2) this.autoFormation = 'wedge';
  }

  _setState(s) {
    if (s === this.state) return;
    const prev = this.state;
    this.state = s;
    this.stateSince = this.now;
    if (s === 'calm') { this.threat = null; for (const m of this.members) m.cover = null; }
    this.manager.emit('friendState', { squad: this, state: s, prev });
  }

  /** 플레이어가 지나온 길 (일렬 대형) · 진행 방향 */
  _trackPlayer() {
    const pl = this.playerRef;
    if (!pl) return;
    const p = pl.motor.position, v = pl.motor.velocity;
    const sp = Math.hypot(v.x, v.z);
    if (sp > 0.3) {
      const k = 0.08;
      const hx = this._heading.x + (v.x / sp - this._heading.x) * k, hz = this._heading.z + (v.z / sp - this._heading.z) * k;
      const hl = Math.hypot(hx, hz) || 1;
      this._heading.x = hx / hl; this._heading.z = hz / hl;
    }
    const tr = this._trail;
    if (!tr.length || Math.hypot(tr[0].x - p.x, tr[0].z - p.z) >= 2) {
      tr.unshift({ x: p.x, z: p.z });
      if (tr.length > 40) tr.length = 40;
    }
  }

  /** 지나온 길 위 d m 뒤 점 (모자라면 진행 반대 방향으로 늘림) */
  _trailAt(d) {
    const pl = this.playerRef, tr = this._trail;
    let prev = { x: pl.motor.position.x, z: pl.motor.position.z }, acc = 0;
    for (let i = 0; i < tr.length; i++) {
      const q = tr[i], seg = Math.hypot(q.x - prev.x, q.z - prev.z);
      if (acc + seg >= d && seg > 1e-6) {
        const f = (d - acc) / seg;
        return { x: prev.x + (q.x - prev.x) * f, z: prev.z + (q.z - prev.z) * f };
      }
      acc += seg; prev = q;
    }
    const left = d - acc;
    return { x: prev.x - this._heading.x * left, z: prev.z - this._heading.z * left };
  }

  // =================================================================
  // 대형 자리
  // =================================================================
  /** 분대원 자리 { x, z, pace, intent, stance, hold, still, look } */
  slotFor(m) {
    if (this._slotT !== this.now) { this._slotT = this.now; this._slots.clear(); this._computeSlots(); }
    return this._slots.get(m) ?? null;
  }

  _computeSlots() {
    const pl = this.playerRef, A = CONFIG.allies, F = A.formation, now = this.now;
    if (!pl) return;
    const P = pl.motor.position, H = this._heading;
    const R = { x: -H.z, z: H.x };
    const nav = this.manager.nav;
    // 플레이어 걸음 → 분대 걸음
    const pm = pl.motor;
    const moving = pm.speed > 0.25;
    const gait = pm.gait;
    const pace = !moving ? 'walk' : gait === 'sprint' ? 'run' : gait === 'quiet' ? 'quiet' : (gait === 'crouch' || gait === 'prone') ? 'sneak' : 'walk';
    const intent = moving ? Math.min(1, Math.max(0.35, pm.speed / CONFIG.movement.speed.walk + 0.1)) : 1;
    // 다친 사람이 있으면 분대가 느려짐 (업힌·끌려가는·절뚝이는 사람)
    let slow = 1;
    for (const m of this.members) {
      if (!m.alive) continue;
      if (m.carriedBy || m.draggedBy || m.carry) slow = Math.min(slow, 0.6);
      else if (m.injuries.hasWounds && m.injuries.effects().limp) slow = Math.min(slow, 0.7);
    }
    const order = this.members.filter((m) => m.alive && !m.carriedBy && !m.draggedBy && !m.cannotWalk)
      .sort((a, b) => JOB_ORDER.indexOf(a.job) - JOB_ORDER.indexOf(b.job) || a.order - b.order);
    const halted = now < this.haltUntil;
    let rank = 0;
    for (const m of order) {
      const o = m.ord;
      let x, z, look = null, stance = 'stand', hold = false, still = !moving, sp = pace, it = intent * slow, scanAmp = 0.7;
      let mv = o.move;
      if (halted && (mv === 'follow' || mv === 'moveTo')) mv = 'trapHalt';
      if (mv === 'halt' || mv === 'hold' || mv === 'trapHalt') {
        const hp = mv === 'trapHalt' ? { x: m.motor.position.x, z: m.motor.position.z } : (o.holdPos ?? { x: m.motor.position.x, z: m.motor.position.z });
        x = hp.x; z = hp.z; hold = true; stance = 'crouch';
        look = mv === 'trapHalt' && this.haltTrap ? { x: this.haltTrap.x, z: this.haltTrap.z } : this._sectorLook(m, x, z, H, R);
      } else if (mv === 'moveTo' || mv === 'retreat') {
        const Q = o.point ?? P;
        const D = o.dir ?? H;
        const DR = { x: -D.z, z: D.x };
        if (m.job === 'point') { x = Q.x + D.x * 6; z = Q.z + D.z * 6; }
        else {
          const side = rank % 2 ? 1 : -1, k = Math.ceil(rank / 2) || 1;
          x = Q.x - D.x * F.wedgeBack * k + DR.x * side * F.wedgeSide * k;
          z = Q.z - D.z * F.wedgeBack * k + DR.z * side * F.wedgeSide * k;
        }
        sp = mv === 'retreat' ? 'run' : 'walk'; it = slow; still = false;
        const arrived = Math.hypot(m.motor.position.x - x, m.motor.position.z - z) < 2.5;
        if (arrived) { stance = 'crouch'; hold = true; still = true; }
        look = mv === 'retreat' ? { x: x - D.x * 30, z: z - D.z * 30 } : { x: x + D.x * 30, z: z + D.z * 30 };
        if (mv === 'retreat' && arrived && o.move === 'retreat') { o.move = 'hold'; o.holdPos = { x, z }; }
      } else {
        // 따라와 — 대형
        if (m.job === 'point') {
          const ahead = this._pointAhead(P, H, A.pointAhead);
          x = ahead.x; z = ahead.z;
          // 첨병: 플레이어가 천천히 오면 조용히 걸으며 땅을 살핌 (빠르게 오면 따라 빨라짐 — 그만큼 함정을 덜 봄)
          sp = pace === 'run' ? 'run' : (pace === 'walk' && pm.speed > 1.1) ? 'walk' : 'quiet';
          it = slow;
          look = { x: x + H.x * 6, z: z + H.z * 6 }; scanAmp = 0.9;
          still = false;
          // 플레이어가 멈춰 있으면 첨병도 멈춤
          if (!moving && Math.hypot(m.motor.position.x - x, m.motor.position.z - z) < 4) { still = true; hold = true; stance = 'crouch'; }
        } else {
          const fm = o.formation === 'auto' ? this.autoFormation : o.formation;
          if (m.job !== 'radio') rank++;   // 무전병은 플레이어 곁 (아래) — 나머지가 대형 순번
          if (fm === 'file') {
            // 지나온 길 위: 무전병 4m, 그 뒤로 fileGap 간격 (무전병이 없으면 4.5m 부터)
            const hasRadio = order.some((o2) => o2.job === 'radio' && o2 !== m);
            const q = this._trailAt(hasRadio || m.job === 'radio' ? 4 + rank * F.fileGap : 4.5 + (rank - 1) * F.fileGap);
            x = q.x; z = q.z;
          } else if (fm === 'wedge') {
            const side = rank % 2 ? -1 : 1, k = Math.ceil(rank / 2);
            x = P.x - H.x * F.wedgeBack * k + R.x * side * F.wedgeSide * k;
            z = P.z - H.z * F.wedgeBack * k + R.z * side * F.wedgeSide * k;
          } else {
            const side = rank % 2 ? -1 : 1, k = Math.ceil(rank / 2);
            x = P.x - H.x * 2 + R.x * side * F.spreadSide * k;
            z = P.z - H.z * 2 + R.z * side * F.spreadSide * k;
          }
          // 무전병은 플레이어 곁에 붙음 (지원 화력 거리)
          if (m.job === 'radio') { const q = fm === 'file' ? this._trailAt(4) : { x: P.x - H.x * 4 + R.x * 2, z: P.z - H.z * 4 + R.z * 2 }; x = q.x; z = q.z; }
          look = this._sectorLook(m, x, z, H, R);
          if (!moving) { stance = Math.hypot(m.motor.position.x - x, m.motor.position.z - z) < 3 ? 'crouch' : 'stand'; hold = true; }
        }
      }
      // 걸을 수 있는 칸 + 알아챈 함정에서 비킴
      const q = nav.nearestOpen(x, z, 4) ?? { x, z };
      const s = this._offHazard(q);
      this._slots.set(m, { x: s.x, z: s.z, pace: sp, intent: it, stance, hold, still, look, scanAmp });
    }
  }

  /** 첨병 자리: 플레이어 앞 d m (오솔길 위 + 진행 방향이 길과 비슷하면 길을 따라) */
  _pointAhead(P, H, d) {
    const L = this.manager.layout;
    let best = null, bd = 5;
    for (const tr of L?.trails ?? []) {
      const ln = tr.line;
      for (let i = 0; i < ln.count; i += 2) {
        const dd = Math.hypot(ln.x[i] - P.x, ln.z[i] - P.z);
        if (dd < bd) { bd = dd; best = { ln, i }; }
      }
    }
    if (best) {
      const { ln, i } = best;
      const ia = Math.min(ln.count - 1, i + 2), ib = Math.max(0, i - 2);
      const tx = ln.x[ia] - ln.x[ib], tz = ln.z[ia] - ln.z[ib], tl = Math.hypot(tx, tz) || 1;
      const dot = (tx * H.x + tz * H.z) / tl;
      if (Math.abs(dot) > 0.5) {
        const dir = dot > 0 ? 1 : -1;
        let acc = 0, k = i;
        while (acc < d && k + dir >= 0 && k + dir < ln.count) { acc += Math.hypot(ln.x[k + dir] - ln.x[k], ln.z[k + dir] - ln.z[k]); k += dir; }
        if (acc > d * 0.6) return { x: ln.x[k], z: ln.z[k] };
      }
    }
    return { x: P.x + H.x * d, z: P.z + H.z * d };
  }

  /** 맡은 경계 방향: 첨병 앞 · 맨 뒤는 뒤 · 나머지는 좌우 */
  _sectorLook(m, x, z, H, R) {
    const n = this.members.length;
    const i = this.members.indexOf(m);
    let dx, dz;
    if (m.job === 'point') { dx = H.x; dz = H.z; }
    else if (i === n - 1) { dx = -H.x; dz = -H.z; }
    else { const s = i % 2 ? 1 : -1; dx = R.x * s + H.x * 0.3; dz = R.z * s + H.z * 0.3; }
    return { x: x + dx * 25, z: z + dz * 25 };
  }

  _offHazard(q) {
    for (const h of this.knownHazards) {
      const ox = q.x - h.x, oz = q.z - h.z, ol = Math.hypot(ox, oz);
      const R = h.r + 1.1;
      if (ol < R) {
        if (ol < 1e-3) return { x: h.x + R, z: h.z };
        return { x: h.x + ox / ol * R, z: h.z + oz / ol * R };
      }
    }
    return q;
  }

  // =================================================================
  // 명령 (플레이어 → 분대)
  // =================================================================
  /**
   * @param {string} key  ORDER_LABELS 의 키
   * @param {'signal'|'shout'} method
   * @param {{ point?: {x,y,z}, dir?: {x,z}, light?: number (플레이어 자리 빛 수준 0~1), eye?: {x,y,z} }} ctx
   * @returns {{ receivers: Ally[], giver?: Ally|null }}
   */
  issue(key, method, ctx = {}) {
    const A = CONFIG.allies, now = this.now, pl = this.playerRef;
    if (!pl) return { receivers: [] };
    this.log.orders++;
    if (method === 'signal') this.log.signals++; else this.log.shouts++;
    const receivers = [];
    const P = pl.motor.position;
    for (const m of this.members) {
      if (!m.alive || m.unconscious) continue;
      const d = Math.hypot(m.motor.position.x - P.x, m.motor.position.z - P.z);
      if (method === 'shout') { if (d <= A.shout.radius) receivers.push(m); }
      else if (this.canSeeSignal(m, ctx)) receivers.push(m);
    }
    this.log.received += receivers.length;
    // 외치기: 소음 (적도 들음) — 내 목소리
    if (method === 'shout') {
      const head = { x: P.x, y: P.y + 1.6, z: P.z };
      this.manager.noise?.emitNoise(head, A.shout.radius, 'shout', pl.motor, { shoutKind: 'order', order: key });
      this.manager.emit('say', { soldier: null, player: true, text: SHOUT_TEXT[key] ?? ORDER_LABELS[key], kind: 'order' });
    }
    // 후퇴 지점: 지정 방향 (시선) 으로 retreatDistance m
    let point = ctx.point ?? null;
    let dir = ctx.dir ? { x: ctx.dir.x, z: ctx.dir.z } : null;
    if (dir) { const l = Math.hypot(dir.x, dir.z) || 1; dir.x /= l; dir.z /= l; }
    if (key === 'retreat') {
      const D = dir ?? { x: -this._heading.x, z: -this._heading.z };
      const want = { x: P.x + D.x * A.retreatDistance, z: P.z + D.z * A.retreatDistance };
      point = this.manager.nav.nearestOpen(want.x, want.z, 8) ?? want;
      dir = D;
    } else if (key === 'moveTo' && point) {
      const dx = point.x - P.x, dz = point.z - P.z, dl = Math.hypot(dx, dz) || 1;
      dir = { x: dx / dl, z: dz / dl };
      point = this.manager.nav.nearestOpen(point.x, point.z, 6) ?? point;
    }
    // 탄약: 받은 사람 중 가장 가까운 사람
    let giver = null;
    if (key === 'ammo') {
      let bd = Infinity;
      for (const m of receivers) {
        if (m.injuries.downed || m.carry || m.carriedBy || m.weaponData?.bipod) continue;   // 기관총 탄띠는 소총에 안 맞음
        const d = Math.hypot(m.motor.position.x - P.x, m.motor.position.z - P.z);
        if (d < bd) { bd = d; giver = m; }
      }
    }
    const order = { key, point, dir, issuedAt: now, giver, method };
    for (const m of receivers) m.queueOrder(order, rr(m.rng, A.orderDelay));
    // 외친 명령엔 가끔 대답 (소리 — 적도 들음)
    if (method === 'shout' && receivers.length && this.rng.chance(0.55)) {
      const r = receivers[this.rng.int(0, receivers.length - 1)];
      this._later(rr(this.rng, [0.6, 1.4]), () => r.say(key === 'medic' && r.job === 'medic' ? '간다!' : '알겠다!', 'ack', { gap: 0.5 }));
    }
    this.manager.emit('orderIssued', { key, method, receivers, giver });
    return { receivers, giver };
  }

  /**
   * 수신호가 이 분대원에게 보이나: 거리 (밤엔 빛 수준만큼 짧게) · 시야가 트였나 (레이) · 나를 보고 있거나 돌아봄
   * ctx: { light (플레이어 자리 빛 0~1), eye (플레이어 눈·손) }
   */
  canSeeSignal(m, ctx = {}) {
    const S = CONFIG.allies.signal, pl = this.playerRef;
    if (!m.alive || m.unconscious || m.injuries.stunned) return false;
    const P = pl.motor.position;
    const light = Math.max(0, Math.min(1, ctx.light ?? 1));
    const range = S.range * Math.max(S.nightMin, Math.min(1, Math.sqrt(light)));
    const mp = m.motor.position;
    const e = { x: mp.x, y: mp.y + m.motor.eyeHeight, z: mp.z };
    const hand = ctx.eye ?? { x: P.x, y: P.y + 1.55, z: P.z };
    const dx = hand.x - e.x, dy = hand.y - e.y, dz = hand.z - e.z, d = Math.hypot(dx, dy, dz);
    if (d > range) return false;
    // 나를 보고 있나 (시야각) — 아니면 가끔 돌아봄 (교전 중엔 덜)
    const fx = -Math.sin(m.look.yaw), fz = -Math.cos(m.look.yaw), hd = Math.hypot(dx, dz) || 1;
    const ang = Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / hd))) / DEG;
    if (ang > S.fovDeg / 2) {
      const glance = S.glance * (this.state === 'contact' ? 0.5 : 1);
      if (!m.rng.chance(glance)) return false;
    }
    if (d < 1.5) return true;
    const r = this.manager.query.raycastWorld({ x: e.x, y: e.y, z: e.z }, { x: dx, y: dy, z: dz }, Math.max(0.1, d - 0.3), 'vision');
    this.manager.stats.rays++;
    const vis = r.hit ? 0 : r.transmittance;
    return vis >= S.losMin;
  }

  /**
   * 무전 (지원 요청) 가능한가: 플레이어가 무전기를 멨거나, 무전병이 살아 있고 의식이 있으며 radioRange m 안
   * @returns {{ ok: boolean, reason: null|'none'|'down'|'far', ro: Ally|null }}
   */
  radioAccess(playerPos, carried = false) {
    if (carried) return { ok: true, reason: null, ro: null };
    const ro = this.members.find((a) => a.hasRadio) ?? null;
    if (!ro) return { ok: false, reason: 'none', ro: null };
    if (!ro.alive || ro.unconscious) return { ok: false, reason: 'down', ro };
    const p = ro.motor.position;
    if (Math.hypot(p.x - playerPos.x, p.z - playerPos.z) > CONFIG.support.radioRange) return { ok: false, reason: 'far', ro };
    return { ok: true, reason: null, ro };
  }

  /** 쓰러진 (죽거나 의식 없는) 무전병의 무전기를 플레이어가 멤 — 성공하면 true */
  takeRadio(ally) {
    if (!ally?.hasRadio || (ally.alive && !ally.unconscious)) return false;
    ally.hasRadio = false;
    return true;
  }

  /** delay 초 뒤 (대답·보고 — 분대 갱신 때 처리) */
  _later(delay, fn) { this._timers.push({ at: this.now + delay, fn }); }

  /** 의무병을 플레이어에게 */
  medicToPlayer(medic) {
    const pl = this.playerRef;
    if (!pl?.injuries || !pl.alive) return;
    if (pl.injuries.treatmentKind(true)) medic.assignTreat(pl);
    else {
      // 처치할 상처가 없으면 곁으로만 와서 확인
      medic.say('어디 다쳤나?', 'ack', { gap: 2 });
    }
  }

  /** 이 환자에게 오고 있는 의무병 */
  medicFor(patient) {
    const md = this.medic;
    return md && md.treat?.patient === patient ? md : null;
  }

  // =================================================================
  // 배정
  // =================================================================
  _assignMedic() {
    const md = this.medic;
    if (!md || md.injuries.downed || md.carriedBy || md.draggedBy || md.carry || md.drag) return;
    if (md.suppression >= CONFIG.allies.medic.maxSuppression) return;
    if (!md.medKit || (!md.medKit.bandages && !md.medKit.tourniquets)) return;
    if (md.treat && md.treat.patient?.alive && md.treat.patient.injuries?.treatmentKind(md.medKit.tourniquets > 0)) return;
    if (md.treat) md._endTreat();
    // 환자: 피를 흘리는 분대원·플레이어 (동맥 → 출혈 많은 순), 의무병 자신은 스스로
    let best = null, bs = 0;
    const consider = (pat, inj) => {
      if (!inj || inj.dead) return;
      const kind = inj.treatmentKind(md.medKit.tourniquets > 0);
      if (!kind) return;
      const art = inj.wounds.some((w) => w.arterial && !w.tourniquet);
      const sc = inj.bleedRate + (art ? 100 : 0) + (pat === this.playerRef ? 2 : 0);
      if (sc > bs) { bs = sc; best = pat; }
    };
    for (const m of this.members) if (m !== md && m.alive) consider(m, m.injuries);
    const pl = this.playerRef;
    if (pl && pl.alive && pl.injuries && pl.injuries.bleedRate > 0.3) consider(pl, pl.injuries);
    if (best) {
      md.assignTreat(best);
      if (best !== this.playerRef && best.injuries.downed) this._later(0.5, () => md.say(`${best.name}, 간다!`, 'ack', { gap: 2 }));
      this.log.treated++;
    }
  }

  /** 교전 중: 쓰러진 분대원을 엄폐까지 끌고 감 (4단계 규칙 — 제압이 낮은 동료) */
  _assignDrags() {
    if (this.state !== 'contact') return;
    const W = CONFIG.ai.wounded;
    for (const w of this.members) {
      if (!w.alive || !w.injuries.downed || w.draggedBy || w.carriedBy) continue;
      if (this.members.some((m) => m.drag && m.drag.wounded === w)) continue;
      if (w.cover && Math.hypot(w.cover.hideX - w.motor.position.x, w.cover.hideZ - w.motor.position.z) < 1.4) continue;
      let best = null, bd = W.dragRange;
      for (const m of this.able) {
        if (m === w || m.drag || m.carry || m.treat || m.injuries.hasWounds) continue;
        if (m.suppression >= W.dragMaxSuppression || m.pinned) continue;
        const d = Math.hypot(m.motor.position.x - w.motor.position.x, m.motor.position.z - w.motor.position.z);
        if (d < bd) { bd = d; best = m; }
      }
      if (best) {
        best.drag = { wounded: w, phase: 'approach', dest: null };
        best.goal = null;
        best.say(`${w.name} 끌고 간다! 엄호해!`, 'cover', { gap: 2 });
      }
    }
  }

  /** 이동 중 (교전 아님): 걷지 못하는 부상자를 업음 (첨병·의무병 말고 — 쏠 수 없게 됨) */
  _assignCarries() {
    if (this.state === 'contact') return;
    for (const w of this.members) {
      if (!w.alive || !w.cannotWalk || w.carriedBy || w.draggedBy) continue;
      if (w.beingTreated) continue;   // 처치 먼저
      if (this.members.some((m) => m.carry && m.carry.wounded === w)) continue;
      const moving = this.members.some((m) => m.alive && m !== w && (m.ord.move === 'follow' || m.ord.move === 'moveTo' || m.ord.move === 'retreat'));
      if (!moving) continue;
      let best = null, bd = 60;
      for (const m of this.able) {
        if (m === w || m.carry || m.drag || m.treat || m.give || m.injuries.hasWounds) continue;
        const pen = m.job === 'point' ? 25 : m.job === 'medic' ? 15 : m.job === 'mg' ? 8 : 0;
        const d = Math.hypot(m.motor.position.x - w.motor.position.x, m.motor.position.z - w.motor.position.z) + pen;
        if (d < bd) { bd = d; best = m; }
      }
      if (best) {
        best.assignCarry(w);
        best.say(`${w.name} 내가 업는다!`, 'cover', { gap: 2 });
      }
    }
  }

  dragDestination(w) {
    const W = CONFIG.ai.wounded, nav = this.manager.nav;
    const th = this.contact ?? this.threat;
    const p = w.motor.position;
    if (th) {
      const cov = nav.findCover(p, th, { radius: 14, max: 3, away: true, taken: this.manager.takenCover(w) })[0];
      if (cov) { w.cover = cov; return { x: cov.hideX, z: cov.hideZ }; }
      let ux = p.x - th.x, uz = p.z - th.z;
      const ul = Math.hypot(ux, uz) || 1;
      const d = rr(this.rng, W.dragDistance);
      return nav.nearestOpen(p.x + ux / ul * d, p.z + uz / ul * d, 4);
    }
    return nav.nearestOpen(p.x - this._heading.x * 6, p.z - this._heading.z * 6, 4);
  }

  retreatPointFor(soldier) { return this.slotFor(soldier); }
  fleePointFor(soldier) { return this.slotFor(soldier); }
  searchTaskFor() { return null; }

  // =================================================================
  // 탄약 던져주기
  // =================================================================
  ammoThrown(from, rounds) {
    this.flights.push({ from, rounds, at: this.now + CONFIG.allies.giveAmmo.flight });
    this.log.ammoThrown++;
    this.manager.emit('ammoThrow', { from, rounds, flight: CONFIG.allies.giveAmmo.flight });
  }

  // =================================================================
  // 첨병 함정 찾기 (6단계 규칙 — 그 걸음걸이·시선·빛)
  // =================================================================
  _pointScan() {
    const T = this.manager.traps;
    if (!T || !T.list.length) return;
    const pm = this.members.find((m) => m.job === 'point' && m.alive && !m.injuries.downed && !m.carry && !m.carriedBy);
    if (!pm) return;
    const P = CONFIG.allies.pointDetect;
    const pitch = P.lookPitch, yaw = pm.look.yaw;
    const obs = {
      motor: pm.motor, eye: pm.eye,
      fwd: { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) },
      light: (x, y, z) => this.manager.lightAtGround?.(x, y, z) ?? (pm.ambient?.() ?? 1),
    };
    const env = this.manager.fieldEnv ?? {};
    const found = T.detectStep(P.tick, obs, { rain: env.rain ?? 0, wetness: env.wetness ?? 0 }, 'ally', pm);
    for (const t of found) this.onTrapFound(t, pm);
  }

  /** 첨병이 함정을 찾음: '정지! 철선!' — 분대 정지 */
  onTrapFound(trap, by) {
    this.haltUntil = this.now + CONFIG.allies.trapHalt;
    this.haltTrap = trap;
    this.log.trapHalts++;
    const w = TRAP_WORD[trap.kind] ?? '함정';
    by.say(`정지! ${w}!`, 'halt', { force: true });
    this.manager.emit('trapHalt', { trap, by });
  }

  // =================================================================
  // 적 발견 보고: '적! 2시 방향, 50미터!'
  // =================================================================
  report(m, target) {
    const R = CONFIG.allies.report, now = this.now;
    if (!target || !target.motor) return;
    if (now - this._reportAt < R.gap) return;
    // 같은 분대 (또는 같은 표적) 는 perTargetGap 동안 한 번만
    const key = target.squad ?? target;
    if (now - (this._reported.get(key) ?? -Infinity) < R.perTargetGap) return;
    this._reported.set(key, now);
    this._reportAt = now;
    const text = this.reportText(m, target.motor.position);
    this.log.reports++;
    m.say(text, 'contactReport', { force: true });
    this.manager.emit('report', { soldier: m, target, text });
  }

  /** 시계 방향·거리 (분대 진행 방향 기준, 조금씩 틀림) */
  reportText(m, tp, rng = m.rng) {
    const R = CONFIG.allies.report;
    const p = m.motor.position, H = this._heading;
    const dx = tp.x - p.x, dz = tp.z - p.z, d = Math.hypot(dx, dz);
    // 진행 방향 H 기준 시계 방향 각 (오른쪽 +)
    const fwd = dx * H.x + dz * H.z, right = dx * -H.z + dz * H.x;
    let ang = Math.atan2(right, fwd) / DEG;
    if (ang < 0) ang += 360;
    let hour = Math.round(ang / 30) % 12;
    if (rng.chance(R.dirError)) hour = (hour + (rng.chance(0.5) ? 1 : 11)) % 12;
    if (hour === 0) hour = 12;
    const dd = Math.max(10, Math.round(d * (1 + rng.range(-R.distError, R.distError)) / 10) * 10);
    return `적! ${hour}시 방향, ${dd}미터!`;
  }

  /** 시계 방향 (보고 없이 — 테스트) */
  clockOf(p, tp) {
    const H = this._heading;
    const dx = tp.x - p.x, dz = tp.z - p.z;
    const fwd = dx * H.x + dz * H.z, right = dx * -H.z + dz * H.x;
    let ang = Math.atan2(right, fwd) / DEG;
    if (ang < 0) ang += 360;
    const h = Math.round(ang / 30) % 12;
    return h === 0 ? 12 : h;
  }

  // =================================================================
  // 사건 (분대원·플레이어)
  // =================================================================
  _contact(pos, unc = 4) {
    this.contactAt = this.now;
    if (pos) { this.contact = { x: pos.x, y: pos.y ?? 0, z: pos.z, time: this.now, uncertainty: unc }; this.threat = this.contact; }
    if (this.state !== 'contact') this._setState('contact');
  }

  onSighting(soldier, pos) {
    this._contact(pos, 0);
    const R = CONFIG.ai.hearing.shoutRadius;
    for (const m of this.members) {
      if (m === soldier || !m.alive) continue;
      const d = Math.hypot(m.motor.position.x - soldier.motor.position.x, m.motor.position.z - soldier.motor.position.z);
      if (d > R) continue;
      m.told(pos.x, pos.y, pos.z, 1.5 + d * 0.04);
    }
  }

  onDetect(soldier) {
    const t = soldier.target;
    if (t?.motor) this._contact(t.motor.position, 1);
  }

  onSuspicious(soldier, est) {
    // 움직임·소리 — 그쪽을 봄 (교전 아님)
    this.threat = { x: est.x, y: 0, z: est.z, time: this.now, uncertainty: est.error ?? 8 };
    if (this.state === 'calm' && this.now - (this._suspSayAt ?? -Infinity) > 20) {
      this._suspSayAt = this.now;
      soldier.say('저쪽에 뭔가 있다…', 'suspicious', { gap: 4 });
    }
  }

  onHeardShot(soldier, est) { this._contact(est, (est.error ?? 5) * 1.5 + 3); }
  onAlliedAlarm(soldier, evt) {
    // 같은 편 총성·폭발 (플레이어 사격은 onPlayerShot) → 경계
    if (evt.kind === 'explosion' || evt.kind === 'gunshot') { this.contactAt = this.now; if (this.state !== 'contact') this._setState('contact'); }
  }

  onUnderFire(soldier, e) {
    let pos = null;
    if (e && e.dir) { const p = soldier.motor.position; pos = { x: p.x - e.dir.x * 40, y: p.y, z: p.z - e.dir.z * 40 }; }
    this._contact(pos ?? this.contact, 25);
  }

  onWounded(soldier) {
    this.contactAt = this.now;
    if (this.state !== 'contact') this._setState('contact');
    this._later(rr(this.rng, [0.4, 1.2]), () => { if (soldier.alive) soldier.say('의무병!', 'help', { force: true }); });
  }

  onKilled(soldier) {
    this.casualties++;
    const other = this.able.find((m) => m !== soldier);
    if (other) this._later(rr(this.rng, [0.5, 1.5]), () => other.say(`${soldier.name}${iGa(soldier.name)} 당했다!`, 'manDown', { force: true }));
  }

  onFriendlyFire(victim, e) {
    this.log.friendlyFire++;
    this.manager.emit('friendlyFire', { victim, shooter: e.shooter, wound: e.wound });
  }

  /** 플레이어가 쏨: 경계·'내가 쏘면 사격' 개시, 보이는 적이 없으면 그쪽을 봄 */
  onPlayerShot(e) {
    const now = this.now;
    this.playerFiredAt = now;
    if (e?.origin && e.dir && !this.members.some((m) => m.alive && m.perception.seesAny)) {
      const o = e.origin;
      const pt = { x: o.x + e.dir.x * 50, y: o.y + e.dir.y * 50, z: o.z + e.dir.z * 50 };
      this.threat = { x: pt.x, y: pt.y, z: pt.z, time: now, uncertainty: 18 };
    }
    this.contactAt = now;
    if (this.state !== 'contact') this._setState('contact');
  }
}
