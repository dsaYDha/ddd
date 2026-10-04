// =====================================================================
//  Squad — 적 분대 (순수 로직): 분대원 3~6명 + 분대장. 상태·역할·사기·의사소통을 정하고, 병사(Soldier)는 그걸 보고 움직인다.
//   상태: patrol (순찰) → suspicious (의심: 1~2명이 조사, 나머지 정지) → alert (경계: 엄폐하고 그쪽을 봄)
//         → engaged (교전: 사격조 + 기동조) → search (수색: 2인 1조, 위력 수색) → patrol (경계 수준이 높아진 순찰)
//         retreat (사기 저하: 엄호하며 단계적 후퇴) · rout (사기 붕괴: 흩어져 도주) · ambush (매복 대기 → 동시에 사격 → 치고 빠지기)
//   순찰: 경로(오솔길 위 A* 경로)를 따라 5~10m 간격 일렬, 첨병이 앞장. 뒤처지면 첨병이 기다림 → 진흙·논에서는 분대 전체가 느려짐.
//   사기: 사상자·오래 제압당함·분대장 사망이면 하락, 수적 우세면 상승. 낮으면 후퇴, 매우 낮으면 도주.
//   분대장 사망: 3~6초 우왕좌왕 (confusedUntil), 이후 협력 약화 (측면 우회 없음, 고함이 멀리 안 닿음).
//   의사소통: 짧은 고함 (EnemyManager.shout — 소음 이벤트, 플레이어에게도 들림)으로 접촉 위치를 나눔.
// =====================================================================
import { CONFIG } from '../config.js';

const rr = (rng, r) => rng.range(r[0], r[1]);
const DEG = Math.PI / 180;

let nextSquad = 1;

export class Squad {
  /**
   * @param {import('./EnemyManager.js').EnemyManager} manager
   * @param {{ type?: 'patrol'|'ambush', route?: Array<{x,z}>, rng }} opts
   */
  constructor(manager, opts = {}) {
    const Q = CONFIG.ai.squad;
    this.id = nextSquad++;
    this.manager = manager;
    this.rng = opts.rng;
    this.type = opts.type ?? 'patrol';
    this.members = [];
    this.leader = null;
    this.state = this.type === 'ambush' ? 'ambush' : 'patrol';
    this.stateSince = 0;
    this.morale = Q.morale.start + this.rng.range(-5, 5);
    this.alertLevel = 0;
    this.contact = null;            // { x, y, z, time, uncertainty }
    this.threat = null;             // 경계 방향 (대략)
    this.suspicion = null;
    this.investigators = [];
    this.confusedUntil = -Infinity;
    this.coordinationWeak = false;
    this.retreat = null;
    this.search = null;
    this.ambush = null;
    this.casualties = 0;
    this.until = Infinity;
    this._shareAt = -Infinity;
    this._dragAt = 0;
    this.route = null;
    this.pointS = 0;
    this.spacing = [];
    if (opts.route) this.setRoute(opts.route);
  }

  get alive() { return this.members.filter((m) => m.alive); }
  get able() { return this.members.filter((m) => m.alive && !m.injuries.downed && !m.draggedBy); }
  get now() { return this.manager.time; }

  add(s) {
    s.squad = this;
    s.order = this.members.length;
    s.baseRole = s.role;
    this.members.push(s);
    if (s.role === 'leader') this.leader = s;
    const Q = CONFIG.ai.squad;
    if (this.spacing.length < this.members.length) this.spacing.push(this.members.length === 1 ? 0 : rr(this.rng, Q.spacing));
  }

  // =================================================================
  // 순찰 경로
  // =================================================================
  setRoute(points) {
    const pts = [];
    // 2m 간격으로 촘촘히
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (i > 0) {
        const a = points[i - 1];
        const d = Math.hypot(p.x - a.x, p.z - a.z);
        const n = Math.max(1, Math.round(d / 2));
        for (let k = 1; k < n; k++) pts.push({ x: a.x + (p.x - a.x) * k / n, z: a.z + (p.z - a.z) * k / n });
      }
      pts.push({ x: p.x, z: p.z });
    }
    const s = new Float32Array(pts.length);
    for (let i = 1; i < pts.length; i++) s[i] = s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    this.route = { pts, s, length: s[s.length - 1] || 0 };
    this.pointS = 0;
  }

  routeAt(s, out = { x: 0, z: 0 }) {
    const R = this.route;
    if (!R || !R.pts.length) return null;
    s = Math.max(0, Math.min(R.length, s));
    let lo = 0, hi = R.pts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (R.s[mid] <= s) lo = mid; else hi = mid; }
    const span = R.s[hi] - R.s[lo];
    const t = span > 0 ? (s - R.s[lo]) / span : 0;
    out.x = R.pts[lo].x + (R.pts[hi].x - R.pts[lo].x) * t;
    out.z = R.pts[lo].z + (R.pts[hi].z - R.pts[lo].z) * t;
    return out;
  }

  /** 경로 위 투영 (s0 근처 ±win 에서) */
  project(p, s0, win = 14) {
    const R = this.route;
    let best = Infinity, bs = s0;
    for (let i = 0; i < R.pts.length - 1; i++) {
      if (R.s[i + 1] < s0 - win || R.s[i] > s0 + win) continue;
      const a = R.pts[i], b = R.pts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z);
      const sc = R.s[i] + (R.s[i + 1] - R.s[i]) * t;
      // 같은 길을 되짚는 경로 (U턴) 에서는 거의 같은 거리면 앞쪽 구간을 고른다 (진행이 멈추지 않게)
      if (d < best - 0.35 || (d < best + 0.35 && sc > bs)) { best = Math.min(best, d); bs = sc; }
    }
    return { s: bs, dist: best };
  }

  /** 순찰 중 분대원 자리: 첨병은 경로 앞쪽, 나머지는 경로 위 첨병 뒤 간격만큼 (뒤처지면 첨병이 기다림) */
  slotFor(soldier) {
    if (!this.route) return null;
    const file = this._file || this._buildFile();
    const idx = file.indexOf(soldier);
    if (idx < 0) return null;
    const Q = CONFIG.ai.squad;
    const intent = (Q.patrolSpeed / CONFIG.movement.speed.walk) * (this.paceMul ?? 1);
    const p = soldier.motor.position;
    if (idx === 0) {
      const skip = this._skip ?? 0;
      const ahead = this._offHazard(this.routeAt(this.pointS + 4 + skip));
      const end = this.pointS >= this.route.length - 1.5;
      return { x: ahead.x, z: ahead.z, pace: 'walk', intent, arrive: 0.6, hold: this._lag || end, farFromRoute: this._pointOff > 6 || skip > 0 };
    }
    let back = 0;
    for (let i = 1; i <= idx; i++) back += this.spacing[file[i].order] || 6;
    const s = Math.max(0, this.pointS - back);
    const q = this._offHazard(this.routeAt(s));
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    return { x: q.x, z: q.z, pace: 'walk', intent: d > 4 ? 1 : intent, arrive: 1.0, hold: d < 1.2, farFromRoute: d > 10 };
  }

  /** 6단계: 경로 위 자리가 자기 편 지뢰·구덩이 바로 옆이면 옆으로 비킨 자리 (적은 함정 자리를 안다) */
  _offHazard(q) {
    const h = q && this.manager.nav?.nearHazard?.(q.x, q.z, 0.9);
    if (!h) return q;
    let ox = q.x - h.x, oz = q.z - h.z;
    const ol = Math.hypot(ox, oz);
    if (ol < 1e-3) { ox = 1; oz = 0; } else { ox /= ol; oz /= ol; }
    const R = h.r + 1.1;
    return { x: h.x + ox * R, z: h.z + oz * R };
  }

  _buildFile() {
    this._file = this.able.slice().sort((a, b) => a.order - b.order);
    return this._file;
  }

  _updatePatrol() {
    const file = this._buildFile();
    if (!file.length || !this.route) return;
    const pt = file[0];
    const pr = this.project(pt.motor.position, this.pointS + (this._skip ?? 0) * 0.5, 14 + (this._skip ?? 0));
    this._pointOff = pr.dist;
    if (pr.dist < 6) this.pointS = Math.max(this.pointS, pr.s);
    // 5단계: 첨병이 12초 넘게 앞으로 못 나가면 (비탈의 큰 줄기·어린 나무 덤불에 걸림) 목표를 경로 앞쪽으로 더 밀고 길찾기로 돌아감
    if (this.pointS > (this._progS ?? -1) + 1) { this._progS = this.pointS; this._progT = this.now; this._skip = 0; }
    else if (!this._lag && this.now - (this._progT ?? this.now) > 12) { this._skip = Math.min(24, (this._skip ?? 0) + 6); this._progT = this.now; }
    // 뒤처진 분대원이 있으면 첨병이 기다림 (진흙에서 분대 전체가 느려짐)
    let lag = false, back = 0;
    for (let i = 1; i < file.length; i++) {
      back += this.spacing[file[i].order] || 6;
      const want = Math.max(0, this.pointS - back);
      const q = this.project(file[i].motor.position, want, 30);
      if (want - q.s > 7 || q.dist > 8) lag = true;
    }
    // 5단계: 한 사람이 오래 막혀 있으면 (30초) 더 기다리지 않고 간다 — 막힌 사람은 경로를 다시 찾아 따라옴
    if (lag) { this._lagSince ??= this.now; if (this.now - this._lagSince > 30) lag = false; }
    else this._lagSince = null;
    this._lag = lag;
    // 5단계: 증원은 경로 끝(사건 현장)에 닿으면 그 근처를 수색, 행렬은 경로 끝에서 사라질 준비 (manager 가 정리)
    if (this.pointS >= this.route.length - 1.5 && !lag && this.reinforce) {
      const r = this.reinforce;
      this.reinforce = null;
      this.contact = { x: r.x, y: 0, z: r.z, time: this.now, uncertainty: 22 };
      this.threat = this.contact;
      this.setState('search');
      return;
    }
    if (this.pointS >= this.route.length - 8 && this.oneWay) {
      if (!this.arrived) { this.arrived = this.now; this.manager.emit('routeEnd', { squad: this }); }
      return;
    }
    // 경로 끝: 돌아서 거꾸로 (맨 뒤가 새 첨병)
    if (this.pointS >= this.route.length - 1.5 && !lag) {
      const rp = this.route.pts.slice().reverse();
      this.setRoute(rp);
      const p0 = this.project(file[file.length - 1].motor.position, 0, 40);
      this.pointS = p0.s;
      const ord = file.map((m) => m.order).reverse();
      file.forEach((m, i) => { m.order = ord[i]; });
      this._file = null;
    }
  }

  // =================================================================
  // 프레임
  // =================================================================
  update(dt) {
    const now = this.now;
    const alive = this.alive;
    if (!alive.length) return;
    this._updateMorale(dt);
    this._file = null;
    switch (this.state) {
      case 'patrol': this._updatePatrol(); break;
      case 'suspicious':
        if (now > this.until) this._backToPatrol(true);
        break;
      case 'alert':
        if (this.contact && now - this.stateSince > 5 && this.contact.uncertainty < 40) this.setState('search');
        else if (now > this.until) this._backToPatrol(true);
        break;
      case 'engaged': {
        // 기동조가 아직 돌아가는 중이면 (제한 시간 안) 접촉을 잃어도 수색으로 넘어가지 않음 — 사격조는 마지막 위치를 계속 제압
        const flanking = now < (this.flankAxis?.until ?? 0) && this.members.some((m) => m.alive && m.role === 'flank' && !m._flankDone);
        if (this.contact && now - this.contact.time > this._lostAfter && !flanking) {
          if (this.type === 'ambush') this.setState('retreat');
          else this.setState('search');
        }
        if (this.type === 'ambush' && this.ambush?.sprung) {
          const A = CONFIG.ai.ambush;
          if ((this.casualties > 0 && now - this.ambush.sprungAt > 6) || this.morale < A.hitAndRunMorale) this.setState('retreat', { scatter: true });
        }
        break;
      }
      case 'search':
        this._updateSearch(dt);
        if (now > this.until) this._backToPatrol(true);
        break;
      case 'retreat': this._updateRetreat(); break;
      case 'rout':
        if (now - this.stateSince > 70) this._backToPatrol(false);
        break;
      case 'ambush': this._checkAmbush(); break;
      default: break;
    }
    if (now > this._dragAt) { this._dragAt = now + 1; this._assignDrags(); }
  }

  setState(s, opts = {}) {
    if (s === this.state && !opts.force) return;
    const prev = this.state, now = this.now;
    this.state = s;
    this.stateSince = now;
    const T = CONFIG.ai.states;
    if (s === 'suspicious') this.until = now + rr(this.rng, T.suspiciousTime);
    else if (s === 'alert') this.until = now + rr(this.rng, T.alertTime);
    else if (s === 'search') this._startSearch();
    else if (s === 'engaged') this._startEngage(prev, opts);
    else if (s === 'retreat') this._startRetreat(opts.scatter);
    else if (s === 'rout') { for (const m of this.members) m.fleePoint = null; this.manager.shout(this.leader?.alive ? this.leader : this.alive[0], 'retreat'); }
    if (s !== 'engaged') for (const m of this.members) { if (m.role === 'flank') { m.role = m.baseRole; m.flankPoint = null; } }
    if (s !== 'suspicious') this.investigators = [];
    this.manager.emit('squadState', { squad: this, state: s, prev });
  }

  _backToPatrol(raiseAlert) {
    if (raiseAlert) this.alertLevel = Math.min(2, this.alertLevel + 1);
    const mul = Math.pow(CONFIG.ai.states.patrolAlertMul, this.alertLevel);
    for (const m of this.members) m.perception.alertMul = mul;
    this.contact = null;
    this.suspicion = null;
    if (this.route) {
      // 가장 가까운 경로 지점부터 다시 (분대원이 흩어져 있으면 자리로 돌아감)
      const pt = this._buildFile()[0];
      if (pt) this.pointS = this.project(pt.motor.position, this.route.length / 2, this.route.length).s;
    }
    this.setState(this.type === 'ambush' && !this.ambush?.sprung ? 'ambush' : 'patrol');
  }

  // =================================================================
  // 사기
  // =================================================================
  _updateMorale(dt) {
    const M = CONFIG.ai.squad.morale;
    const able = this.able;
    if (this.state === 'engaged' || this.state === 'retreat') {
      if (able.length >= M.superiorityCount) this.morale += M.superiorityRate * dt;
      let sup = 0;
      for (const m of able) sup += m.suppression;
      if (able.length && sup / able.length > 50) this.morale += M.pinnedRate * dt;
    } else if (this.state !== 'rout') {
      this.morale += (M.start - this.morale) * Math.min(1, dt * 0.01);
    }
    this.morale = Math.max(0, Math.min(M.max, this.morale));
    if (this.state === 'rout') return;
    if (this.morale < M.rout && (this.state === 'engaged' || this.state === 'retreat' || this.state === 'search' || this.state === 'alert')) this.setState('rout');
    else if (this.morale < M.retreat && (this.state === 'engaged' || this.state === 'search')) this.setState('retreat');
  }

  // =================================================================
  // 사건 (분대원이 알림)
  // =================================================================
  onSighting(soldier, pos) {
    const now = this.now;
    this.contact = { x: pos.x, y: pos.y, z: pos.z, time: now, uncertainty: 0 };
    this.threat = this.contact;
    if (now - this._shareAt < 0.5) return;
    this._shareAt = now;
    const C = CONFIG.ai.squad.comms;
    const R = CONFIG.ai.hearing.shoutRadius;
    for (const m of this.members) {
      if (m === soldier || !m.alive) continue;
      const d = Math.hypot(m.motor.position.x - soldier.motor.position.x, m.motor.position.z - soldier.motor.position.z);
      if (d > R) continue;
      if (this.coordinationWeak && d > C.leaderlessRange && this.rng.chance(C.leaderlessMiss)) continue;
      m.told(pos.x, pos.y, pos.z, 1.5 + d * 0.04);
    }
  }

  onDetect(soldier, surprised) {
    // 6단계: 밤에 교전이 시작되면 조명탄 (7단계: 이 병사가 발견한 표적 쪽으로)
    const tp = (soldier?.target ?? this.manager.player)?.motor?.position;
    if (tp && this.manager.night > 0.5) this.manager.requestFlare?.(this, tp);
    if (this.state === 'ambush') { this._checkAmbush(); return; }
    this.manager.shout(soldier, 'contact');
    if (this.state !== 'engaged') this.setState('engaged', { surprised });
  }

  onSuspicious(soldier, est, kind) {
    const now = this.now;
    if (this.state === 'patrol') {
      this.suspicion = { x: est.x, y: 0, z: est.z, time: now };
      // 알아챈 병사 + 가장 가까운 동료 하나가 조사
      const sp = soldier.motor.position;
      const others = this.able.filter((m) => m !== soldier).sort((a, b) => dist(a, sp) - dist(b, sp));
      this.investigators = [soldier, ...(others[0] ? [others[0]] : [])];
      this.setState('suspicious');
    } else if (this.state === 'suspicious') {
      this.suspicion = { x: est.x, y: 0, z: est.z, time: now };
    } else if (this.state === 'ambush') {
      // 매복 중에는 kill zone 안의 움직임·발소리 = 적. 가까우면 (trigger 안) 바로 개시
      if (this.ambush && !this.ambush.sprung && (est.distance ?? Infinity) <= this.ambush.trigger) this.spring(kind === 'glimpse' ? 'close' : 'heard', est);
    } else if ((this.state === 'alert' || this.state === 'search') && (!this.contact || now - this.contact.time > 4)) {
      this.contact = { x: est.x, y: 0, z: est.z, time: now, uncertainty: est.error * 1.5 + 2 };
      this.threat = this.contact;
    }
  }

  onHeardShot(soldier, est, evt) {
    const now = this.now;
    const unc = est.error * 1.5 + (est.crack ? est.distance * 0.3 : 3);
    if (this.state === 'ambush') {
      if (est.distance < 50) this.spring('shot');
      return;
    }
    if (!this.contact || now - this.contact.time > 3 || this.contact.uncertainty > unc) {
      this.contact = { x: est.x, y: evt.y, z: est.z, time: now, uncertainty: unc };
    }
    this.threat = this.contact;
    if (this.state === 'patrol' || this.state === 'suspicious') this.setState('alert');
  }

  onAlliedAlarm(soldier, evt) {
    if (this.state === 'patrol' || this.state === 'suspicious') {
      this.threat = { x: evt.x, y: evt.y, z: evt.z, time: this.now, uncertainty: 30 };
      this.setState('alert');
    }
  }

  onUnderFire(soldier, e) {
    if (this.state === 'ambush') { this.spring('discovered'); return; }
    if (this.state === 'patrol' || this.state === 'suspicious') {
      if (e && e.dir && !this.threat) {
        const p = soldier.motor.position;
        this.threat = { x: p.x - e.dir.x * 40, y: p.y, z: p.z - e.dir.z * 40, time: this.now, uncertainty: 25 };
      }
      this.setState('alert');
    }
  }

  onWounded(soldier, wound) {
    const M = CONFIG.ai.squad.morale;
    this.morale += M.wounded;
    if (this.state === 'ambush') this.spring('discovered');
    else if (this.state === 'patrol' || this.state === 'suspicious') this.setState('alert');
  }

  onKilled(soldier) {
    const M = CONFIG.ai.squad.morale, now = this.now;
    this.casualties++;
    this.morale += M.killed;
    if (soldier === this.leader) {
      this.morale += M.leaderKilled;
      this.confusedUntil = now + rr(this.rng, CONFIG.ai.squad.confusion);
      this.coordinationWeak = true;
      const next = this.able.sort((a, b) => a.order - b.order)[0] ?? null;
      this.leader = next;
      if (next) { next.role = 'leader'; next.baseRole = 'leader'; }
      const crier = this.able[0];
      if (crier) this.manager.shout(crier, 'confused', true);
      this.manager.emit('leaderDown', { squad: this });
    } else if (this.able.length) {
      this.manager.shout(this.able[0], 'manDown');
    }
    if (this.state === 'ambush') this.spring('discovered');
    else if (this.state === 'patrol' || this.state === 'suspicious') this.setState('alert');
    this._file = null;
  }

  // =================================================================
  // 교전: 사격조 + 기동조
  // =================================================================
  _startEngage(prev, opts) {
    const Q = CONFIG.ai.squad, T = CONFIG.ai.states;
    this._lostAfter = rr(this.rng, T.lostContact);
    for (const m of this.members) { m._flankDone = false; m.role = m.baseRole; }
    if (this.type === 'ambush') return;
    const able = this.able;
    const c = this.contact;
    if (!c || able.length < Q.flankMinSize || this.coordinationWeak) return;
    const riflemen = able.filter((m) => m.role !== 'leader' && !m.weaponData.bipod);
    const nFlank = Math.min(3, Math.max(1, Math.floor(riflemen.length / 2)));
    // 기동조: 위협에서 먼 순 (뒤쪽 분대원이 돌아감)
    riflemen.sort((a, b) => dist(b, c) - dist(a, c));
    const flankers = riflemen.slice(0, nFlank);
    const fire = able.filter((m) => !flankers.includes(m));
    let fx = 0, fz = 0;
    for (const m of fire) { fx += m.motor.position.x; fz += m.motor.position.z; }
    fx /= fire.length || 1; fz /= fire.length || 1;
    let ux = fx - c.x, uz = fz - c.z;
    const ul = Math.hypot(ux, uz) || 1;
    ux /= ul; uz /= ul;
    const nav = this.manager.nav;
    let best = null;
    for (const sgn of [1, -1]) {
      const a = sgn * rr(this.rng, Q.flankOffsetDeg) * DEG;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = ux * ca - uz * sa, dz = ux * sa + uz * ca;
      const dd = rr(this.rng, Q.flankDistance);
      const p = nav.nearestOpen(c.x + dx * dd, c.z + dz * dd, 4);
      if (!p) continue;
      let gx = 0, gz = 0;
      for (const m of flankers) { gx += m.motor.position.x; gz += m.motor.position.z; }
      gx /= flankers.length; gz /= flankers.length;
      const score = nav.concealAt(p.x, p.z) * 10 - Math.hypot(p.x - gx, p.z - gz) * 0.15;
      if (!best || score > best.score) best = { p, score, dx, dz };
    }
    if (!best) return;
    // 측면 기준: 위협에서 사격조 쪽 방향 — 기동조는 여기서 45° 이상 돌아가야 '측면'
    this.flankAxis = { x: c.x, z: c.z, ux, uz, until: this.now + Q.flankTimeout };
    flankers.forEach((m, i) => {
      const off = (i - (flankers.length - 1) / 2) * 4;
      const q = nav.nearestOpen(best.p.x - best.dz * off, best.p.z + best.dx * off, 3) ?? best.p;
      m.role = 'flank';
      m.flankPoint = { x: q.x, z: q.z };
      m._flankDone = false;
    });
    if (this.leader?.alive) this.manager.shout(this.leader, 'flank');
  }

  // =================================================================
  // 수색: 2인 1조로 마지막 확인 위치에 조심스럽게, 가끔 위력 수색
  // =================================================================
  _startSearch() {
    const S = CONFIG.ai.search, T = CONFIG.ai.states;
    this.until = this.now + rr(this.rng, T.searchTime);
    const able = this.able.sort((a, b) => a.order - b.order);
    const tasks = new Map();
    const pairs = [];
    for (let i = 0; i < able.length; i += 2) {
      const lead = able[i];
      const pair = { lead, followers: [], point: null, reconAt: this.now + rr(this.rng, [2, S.reconEvery]) };
      tasks.set(lead, { point: null, recon: null });
      for (const f of able.slice(i + 1, i + 2)) { pair.followers.push(f); tasks.set(f, { follow: lead }); }
      pairs.push(pair);
    }
    // 홀수면 마지막 사람은 마지막 조에 셋째로
    this.search = { tasks, pairs };
    pairs.forEach((p, k) => this._nextSearchPoint(p, k, pairs.length));
    if (this.leader?.alive) this.manager.shout(this.leader, 'search');
  }

  _nextSearchPoint(pair, k, n) {
    const c = this.contact ?? this.threat;
    if (!c) return;
    const nav = this.manager.nav;
    const r = Math.min(18, 4 + (c.uncertainty ?? 5));
    const a = (k / Math.max(1, n)) * Math.PI * 2 + this.rng.range(-0.8, 0.8);
    const d = this.rng.range(0.2, 1) * r;
    const p = nav.nearestOpen(c.x + Math.cos(a) * d, c.z + Math.sin(a) * d, 4) ?? { x: c.x, z: c.z };
    pair.point = p;
    this.search.tasks.get(pair.lead).point = p;
  }

  _updateSearch() {
    const S = CONFIG.ai.search, now = this.now;
    if (!this.search) return;
    const n = this.search.pairs.length;
    this.search.pairs.forEach((pair, k) => {
      if (!pair.lead.alive) return;
      const task = this.search.tasks.get(pair.lead);
      // 5단계: 플레이어의 발자국을 찾으면 따라감 (진흙·젖은 흙 — 더 새 발자국 쪽으로)
      if (this._trackPrints(pair, task, now)) return;
      if (pair.lead.goal?.done) this._nextSearchPoint(pair, k, n);
      if (now > pair.reconAt) {
        pair.reconAt = now + S.reconEvery * this.rng.range(0.7, 1.3);
        if (this.rng.chance(S.reconChance)) {
          const spot = this._suspiciousBush();
          if (spot) task.recon = { point: spot, until: now + 1.6 };
        }
      }
    });
  }

  /**
   * 발자국 추적: 조장 발밑 findRadius 안에 플레이어의 아직 진한 발자국이 있으면 '발견' → followRadius 안의 더 새 발자국으로
   * 계속 옮겨 가며 따라간다 (따라가는 동안 수색을 포기하지 않음, 분대 접촉 위치도 그 발자국). 끊기면 보통 수색으로.
   * @returns 추적 중이면 true
   */
  _trackPrints(pair, task, now) {
    const fp = this.manager.footprints, F = CONFIG.footprints;
    if (!fp) return false;
    const lp = pair.lead.motor.position;
    if (!pair.track) {
      const found = fp.newestNear(lp.x, lp.z, F.findRadius, 'player', pair.lastTrackId ?? 0, 0.2);
      if (!found) return false;
      pair.track = found;
      this.manager.emit('trackFound', { squad: this, soldier: pair.lead, print: found });
    }
    const tr = pair.track;
    const there = Math.hypot(lp.x - tr.x, lp.z - tr.z) < 3;
    const nxt = fp.newestNear(tr.x, tr.z, F.followRadius, 'player', tr.id, 0.12);
    if (nxt && (there || nxt.id > tr.id + 6)) pair.track = nxt;
    else if (there && !nxt) {
      // 흔적이 끊김 → 그 근처를 보통 수색
      pair.lastTrackId = tr.id;
      pair.track = null;
      this.contact = { x: tr.x, y: tr.y, z: tr.z, time: now, uncertainty: 10 };
      return false;
    }
    const t = pair.track;
    pair.point = { x: t.x, z: t.z };
    task.point = pair.point;
    task.tracking = true;
    this.contact = { x: t.x, y: t.y, z: t.z, time: now, uncertainty: 6 };
    this.until = Math.max(this.until, now + 30);
    return true;
  }

  /** 마지막 확인 위치 근처의 의심 가는 수풀 (몸높이 은폐가 짙은 곳) */
  _suspiciousBush() {
    const c = this.contact ?? this.threat;
    if (!c) return null;
    const nav = this.manager.nav, q = this.manager.query;
    let best = null, bv = 0.35;
    for (let i = 0; i < 10; i++) {
      const a = this.rng.range(0, Math.PI * 2), d = this.rng.range(0, Math.min(15, 3 + (c.uncertainty ?? 5)));
      const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
      const v = nav.concealAt(x, z);
      if (v > bv) { bv = v; best = { x, y: q.getSupportHeight(x, z) + 0.5, z }; }
    }
    return best;
  }

  searchTaskFor(soldier) { return this.search?.tasks.get(soldier) ?? null; }

  // =================================================================
  // 후퇴·도주
  // =================================================================
  _startRetreat(scatter = false) {
    const c = this.contact ?? this.threat;
    let cx = 0, cz = 0;
    const alive = this.alive;
    for (const m of alive) { cx += m.motor.position.x; cz += m.motor.position.z; }
    cx /= alive.length || 1; cz /= alive.length || 1;
    let ux = c ? cx - c.x : 1, uz = c ? cz - c.z : 0;
    const ul = Math.hypot(ux, uz) || 1;
    this.retreat = { dir: { x: ux / ul, z: uz / ul }, phase: 0, phaseId: 1, phaseUntil: this.now + 7, scatter, from: c ? { x: c.x, z: c.z } : { x: cx - ux, z: cz - uz } };
    for (const m of this.members) m.retreatPoint = null;
    const caller = this.leader?.alive ? this.leader : alive[0];
    if (caller) this.manager.shout(caller, 'retreat');
  }

  _updateRetreat() {
    const r = this.retreat, now = this.now;
    if (!r) return;
    const movers = this.able.filter((m) => r.scatter || (m.order % 2) === r.phase);
    const arrived = movers.every((m) => !m.goal || m.goal.done);
    if (!r.scatter && (now > r.phaseUntil || (arrived && now - (r.phaseUntil - 7) > 2))) {
      r.phase = 1 - r.phase; r.phaseId++; r.phaseUntil = now + 7;
    }
    // 위협에서 충분히 멀어지면 끝
    let cx = 0, cz = 0;
    const alive = this.alive;
    for (const m of alive) { cx += m.motor.position.x; cz += m.motor.position.z; }
    cx /= alive.length || 1; cz /= alive.length || 1;
    const d = Math.hypot(cx - r.from.x, cz - r.from.z);
    if (d > CONFIG.ai.squad.retreatDistance || (r.scatter && arrived && now - this.stateSince > 8)) {
      this.morale = Math.max(this.morale, CONFIG.ai.squad.morale.retreat + 5);
      this.type = 'patrol';
      this.setState('alert');
      this.until = now + 25;
      this.contact = null;
    }
  }

  retreatPointFor(soldier, th) {
    const r = this.retreat, Q = CONFIG.ai.squad;
    const nav = this.manager.nav;
    const p = soldier.motor.position;
    let dx = r.dir.x, dz = r.dir.z;
    let step = rr(this.rng, Q.retreatStep);
    if (r.scatter) {
      const a = this.rng.range(-50, 50) * DEG, ca = Math.cos(a), sa = Math.sin(a);
      const x = dx * ca - dz * sa, z = dx * sa + dz * ca;
      dx = x; dz = z;
      step = this.rng.range(40, 70);
    }
    const bx = p.x + dx * step + this.rng.range(-3, 3), bz = p.z + dz * step + this.rng.range(-3, 3);
    const cov = nav.findCover({ x: bx, z: bz }, th, { radius: 8, max: 2, away: true, taken: this.manager.takenCover(soldier) })[0];
    const q = cov ? { x: cov.hideX, z: cov.hideZ } : nav.nearestOpen(bx, bz, 5);
    if (!q) return null;
    soldier.cover = cov ?? null;
    return { x: q.x, z: q.z, phaseId: r.phaseId };
  }

  fleePointFor(soldier) {
    const nav = this.manager.nav, c = this.contact ?? this.threat;
    const p = soldier.motor.position;
    let ux = c ? p.x - c.x : this.rng.range(-1, 1), uz = c ? p.z - c.z : this.rng.range(-1, 1);
    const ul = Math.hypot(ux, uz) || 1;
    ux /= ul; uz /= ul;
    const a = this.rng.range(-60, 60) * DEG, ca = Math.cos(a), sa = Math.sin(a);
    const dx = ux * ca - uz * sa, dz = ux * sa + uz * ca;
    const d = this.rng.range(60, 100);
    return nav.nearestOpen(p.x + dx * d, p.z + dz * d, 6);
  }

  // =================================================================
  // 부상자 끌기 배정 (제압이 낮을 때 동료가 끌고 감)
  // =================================================================
  _assignDrags() {
    if (this.state === 'rout') return;
    const W = CONFIG.ai.wounded;
    for (const w of this.members) {
      if (!w.alive || !w.injuries.downed || w.draggedBy || w._dragged) continue;
      if (this.members.some((m) => m.drag && m.drag.wounded === w)) continue;
      // 이미 엄폐 뒤면 끌 필요 없음. 팔이 멀쩡하고 적이 보여 엎드려 싸우는 중이면 그대로 둠
      if (w.cover && Math.hypot(w.cover.hideX - w.motor.position.x, w.cover.hideZ - w.motor.position.z) < 1.4) continue;
      const armHurt = w.injuries.wounds.some((x) => x.type === 'upperArm' || x.type === 'forearm');
      if (w.perception.seen && !armHurt && !w.injuries.weaponDropped) continue;
      let best = null, bd = W.dragRange;
      for (const m of this.able) {
        if (m === w || m.drag || m.draggedBy || m.injuries.hasWounds) continue;
        if (m.suppression >= W.dragMaxSuppression || m.pinned) continue;
        if (m.role === 'flank' && !m._flankDone) continue;
        const d = dist(m, w.motor.position);
        if (d < bd) { bd = d; best = m; }
      }
      if (best) {
        best.drag = { wounded: w, phase: 'approach', dest: null };
        best.goal = null;
        this.manager.shout(best, 'cover');
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
    return nav.nearestOpen(p.x + this.rng.range(-8, 8), p.z + this.rng.range(-8, 8), 4);
  }

  // =================================================================
  // 매복
  // =================================================================
  /** 매복 설정: killZone (오솔길 위 점), 방아쇠 거리 */
  setAmbush(killZone) {
    const A = CONFIG.ai.ambush;
    this.ambush = { killZone: { x: killZone.x, y: killZone.y ?? 0, z: killZone.z }, trigger: rr(this.rng, A.trigger), sprung: false, sprungAt: -Infinity, reason: '' };
  }

  _checkAmbush() {
    const a = this.ambush;
    if (!a || a.sprung) return;
    for (const m of this.members) {
      if (!m.alive) continue;
      // 7단계: 병사마다 주목하는 표적 (플레이어 또는 아군 분대원)
      const t = m.target;
      if (!t || !t.alive) continue;
      const d = dist(m, t.motor.position);
      // 가까이 왔고 (보고 있거나 거의 알아챘으면) → 동시에 사격
      if (m.perception.meter >= 1 && d <= a.trigger) { this.spring('close'); return; }
      if (m.perception.meter >= 0.5 && d <= a.trigger * 0.8) { this.spring('close'); return; }
      if (m.suppression > 10 || m.injuries.hasWounds) { this.spring('discovered'); return; }
    }
  }

  /** 매복 개시: 모두 0.15~0.45초 안에 사격 (반응 지연은 짧게 — 이미 보고 있었다) */
  spring(reason, est = null) {
    const a = this.ambush;
    if (!a || a.sprung) return;
    const now = this.now, A = CONFIG.ai.ambush;
    a.sprung = true;
    a.sprungAt = now;
    a.reason = reason;
    // 7단계: 가장 잘 알아챈 병사가 주목하는 표적 (없으면 플레이어)
    let t = this.manager.player, bm = -1;
    for (const m of this.members) if (m.alive && m.target?.alive && m.perception.meter > bm) { bm = m.perception.meter; t = m.target; }
    if (est) {
      // 소리로 개시: 대략적인 위치로 (보이는 병사는 곧 정확히 겨눔)
      this.contact = { x: est.x, y: t ? t.motor.position.y : 0, z: est.z, time: now, uncertainty: (est.error ?? 2) * 1.5 + 1 };
    } else if (t) {
      const p = t.motor.position;
      this.contact = { x: p.x, y: p.y, z: p.z, time: now, uncertainty: 1 };
    }
    for (const m of this.members) {
      if (!m.alive) continue;
      m.fire.reactionUntil = now + rr(this.rng, A.springDelay);
      m._acquire(this.rng.range(0.8, 2.0), this.rng.range(0.4, 0.9));
      if (this.contact) m.told(this.contact.x, this.contact.y, this.contact.z, this.contact.uncertainty);
    }
    const caller = this.leader?.alive ? this.leader : this.alive[0];
    if (caller) this.manager.shout(caller, 'fire', true);
    this.setState('engaged');
    this.manager.emit('ambushSprung', { squad: this, reason });
  }
}

function dist(a, p) {
  const q = a.motor ? a.motor.position : a;
  return Math.hypot(q.x - p.x, q.z - p.z);
}
