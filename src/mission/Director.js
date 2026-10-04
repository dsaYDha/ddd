// =====================================================================
//  Director — 5단계 적 배치 디렉터 (전투의 리듬). 순수 로직 — EnemyManager·NavGrid·WorldQuery 만 쓴다.
//   · 임무 시작: 4단계 순찰 분대·매복조·야영지를 임무 계획대로 둔다. 무한 증원 없음 (임무당 정해진 증원 최대 1번).
//   · 새로 생기는 적은 반드시 플레이어에게서 spawnMinDist(150m) 밖 + 시야 밖 (옆·뒤이거나 앞쪽이면 시야 레이가 막힘).
//     조건이 안 맞으면 다른 자리를 찾거나 조금 뒤에 다시 시도한다.
//   · 첫 교전까지 걷고 살피는 시간: 순찰은 투입 지점에서 멀리 출발해 목표 쪽을 돈다 (MissionGen 이 정한 경로).
//   · 흔적: 진흙에 남은 적 발자국 (Footprints — 미리 나이 든 것), 탄피·꺼진 모닥불·잘린 덩굴 (화면은 runtime 이 그림).
//   · 멀리서 들리는 총성 ('distantFire'), 무전 ('radio' — 적 정보는 늦게 오고 약 30% 틀림).
//   · 매복 임무: 행렬이 5~15분 사이 무작위에 출발 → 기습 성공(사상자) / 놓침(행렬이 지나감), 기습 후 3~6분 뒤 증원.
//   · 습격 임무: 큰 교전(플레이어 사격 수·야영지 사상자)이 벌어지면 3~5분 뒤 근처에서 증원.
//  이벤트: 'radio' {text, kind} · 'distantFire' {x, z, shots:[{t, weapon}]} · 'traces' {list} · 'spawned' {squad, kind}
//          'ambush' {state: 'spawned'|'engaged'|'success'|'missed'} · 'reinforce' {state: 'scheduled'|'spawned', at}
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { RNG } from '../core/rng.js';
import { areaName, dirName } from './MissionGen.js';

const rr = (rng, r) => rng.range(r[0], r[1]);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const DEG = Math.PI / 180;
const AREAS = ['북쪽', '북동쪽', '동쪽', '남동쪽', '남쪽', '남서쪽', '서쪽', '북서쪽'];

export class Director extends EventEmitter {
  /**
   * @param {{ mission, enemies: import('../ai/EnemyManager.js').EnemyManager, world: {query, nav}, footprints?, seed?: number }} o
   */
  constructor(o) {
    super();
    this.m = o.mission;
    this.em = o.enemies;
    this.world = o.world;
    this.footprints = o.footprints ?? null;
    this.rng = new RNG(((o.seed ?? this.m.seed) * 31 + 7) >>> 0);
    this.t = 0;
    this.pending = [];             // { kind, at, data, tries }
    this.spawned = [];             // { squad, kind }
    this.reinforcements = 0;       // 실제로 생긴 증원 수 (상한 1)
    this.reinforceAt = null;
    this.ambush = { state: 'waiting', convoy: [], startCount: 0, engagedAt: -1 };
    this.campSquads = [];
    this.bigFight = false;
    this.firstContact = -1;
    this.nextDistant = rr(this.rng, CONFIG.mission.distantFire.gap) * 0.6;
    this.rejects = 0;              // 시야·거리 조건으로 미룬 생성 수 (검증용)
    this.log = [];                 // 생성 기록 { t, kind, x, z, dPlayer, hidden }
    this._offs = [];
  }

  // -----------------------------------------------------------------
  start(ctx) {
    const m = this.m, E = m.enemies;
    for (const p of E.patrols) this.pending.push({ kind: 'patrol', at: p.delay ?? 0, data: p, tries: 0 });
    for (const a of E.ambushes) this.pending.push({ kind: 'ambush', at: 0, data: a, tries: 0 });
    if (E.camp) this.pending.push({ kind: 'camp', at: 0, data: E.camp, tries: 0 });
    if (E.convoy) this.pending.push({ kind: 'convoy', at: E.convoy.delay, data: E.convoy, tries: 0 });
    // 사건 구독
    this._offs.push(this.em.on('death', (e) => this._onDeath(e)));
    this._offs.push(this.em.on('squadState', (e) => this._onSquadState(e)));
    this._offs.push(this.em.on('routeEnd', (e) => this._onRouteEnd(e)));
    this._placeTraces();
    this.update(0, ctx);
    this._radio(startText(m), 'start', 1.5);
  }

  dispose() { for (const off of this._offs) off?.(); this._offs.length = 0; }

  // -----------------------------------------------------------------
  /** ctx: { pos {x,z}, eye {x,y,z}, fwd {x,z}, alive, shots (플레이어 누적 발사 수) } */
  update(dt, ctx) {
    this.t += dt;
    this._ctx = ctx;
    // 생성 대기열
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (this.t < p.at) continue;
      const done = this._spawn(p, ctx);
      if (done) this.pending.splice(i, 1);
      else { p.at = this.t + 6; p.tries++; this.rejects++; }
    }
    // 매복 판정
    if (this.ambush.state === 'spawned' || this.ambush.state === 'engaged') this._checkAmbush(ctx);
    // 맵 가장자리에 닿은 행렬은 플레이어 시야 밖(90m 밖)이면 치움
    for (const sq of this.ambush.convoy) {
      if (sq.gone && !sq.removed && sq.state === 'patrol' && this.hiddenFrom(sq.members[0]?.motor.position ?? { x: 0, z: 0 }, ctx, -60)) {
        sq.removed = true;
        this.em.removeSquad(sq);
      }
    }
    // 습격: 큰 교전 → 증원
    if (this.m.type === 'raid' && !this.bigFight && this.campSquads.length) this._checkBigFight(ctx);
    // 7단계: 적 박격포 — 야영지가 아는 플레이어 쪽 위치 (마지막 접촉) 로
    if (this.mortarAt != null && !this.mortarFired && this.t >= this.mortarAt) {
      this.mortarFired = true;
      const sq = this.mortarSquad;
      const c = sq?.contact ?? sq?.threat ?? (ctx ? { x: ctx.pos.x, z: ctx.pos.z } : null);
      if (c) this.emit('enemyMortar', { from: { x: this.m.enemies.mortar.x, z: this.m.enemies.mortar.z }, target: { x: c.x, z: c.z } });
    }
    // 멀리서 들리는 총성 (첫 교전 전 자주, 뒤에는 드물게)
    this.nextDistant -= dt;
    if (this.nextDistant <= 0) {
      const G = CONFIG.mission.distantFire;
      this.nextDistant = rr(this.rng, G.gap) * (this.firstContact >= 0 ? 2.2 : 1);
      this._distantFire(ctx);
    }
    // 무전 대기열
    if (this._radioQ) {
      for (let i = this._radioQ.length - 1; i >= 0; i--) {
        const r = this._radioQ[i];
        if (this.t >= r.at) { this._radioQ.splice(i, 1); this.emit('radio', { text: r.text, kind: r.kind }); }
      }
    }
  }

  /** 증원 예약 (임무 계획에 있을 때 한 번만) */
  scheduleReinforce(reason) {
    const R = this.m.enemies.reinforce;
    if (!R || this.reinforceAt !== null) return false;
    this.reinforceAt = this.t + R.delay;
    this.pending.push({ kind: 'reinforce', at: this.reinforceAt, data: R, tries: 0 });
    this.emit('reinforce', { state: 'scheduled', at: this.reinforceAt, reason });
    return true;
  }

  // -----------------------------------------------------------------
  // 생성
  // -----------------------------------------------------------------
  /** 플레이어에게서 충분히 멀고 시야 밖인가 */
  hiddenFrom(p, ctx, margin = 0) {
    const M = CONFIG.mission;
    if (!ctx) return true;
    const d = dist(p, ctx.pos);
    if (d < M.spawnMinDist + margin) return false;
    const dx = p.x - ctx.pos.x, dz = p.z - ctx.pos.z;
    const fl = Math.hypot(ctx.fwd.x, ctx.fwd.z) || 1;
    const c = (dx * ctx.fwd.x + dz * ctx.fwd.z) / (d * fl);
    if (Math.acos(Math.max(-1, Math.min(1, c))) / DEG > M.spawnHideDeg) return true;
    const q = this.world.query;
    const ty = q.getSupportHeight(p.x, p.z) + 1.4;
    const dir = { x: dx, y: ty - ctx.eye.y, z: dz };
    const L = Math.hypot(dir.x, dir.y, dir.z);
    const r = q.raycastWorld(ctx.eye, dir, Math.max(0.1, L - 0.5), 'vision');
    return r.hit || r.transmittance < 0.05;
  }

  _record(kind, p, ctx, squad) {
    const d = ctx ? dist(p, ctx.pos) : Infinity;
    this.log.push({ t: this.t, kind, x: p.x, z: p.z, dPlayer: d, hidden: this.hiddenFrom(p, ctx) });
    if (squad) {
      this.spawned.push({ squad, kind });
      squad.directorKind = kind;
      this.emit('spawned', { squad, kind });
    }
  }

  /** 경유점들을 잇는 경로 (순찰 모드 A* — 오솔길 선호) */
  routeThrough(points) {
    const nav = this.world.nav;
    const out = [{ x: points[0].x, z: points[0].z }];
    for (let i = 1; i < points.length; i++) {
      const path = nav.findPath(points[i - 1], points[i], { mode: 'patrol', maxNodes: 60000 });
      if (!path) continue;
      for (const p of path) out.push({ x: p.x, z: p.z });
    }
    return out.length >= 2 ? out : null;
  }

  _spawn(p, ctx) {
    const em = this.em, d = p.data;
    if (p.kind === 'camp') {
      const sq = em.spawnCamp({ center: d.center, sentries: d.sentries, rest: d.rest, seed: this.rng.int(1, 1e9), mg: false, watch: this._campWatch() });
      if (sq) { this.campSquads.push(sq); this._record('camp', d.center, ctx, sq); }
      return true;
    }
    if (p.kind === 'ambush') {
      const kz = d.killZone;
      const sq = em.spawnAmbush({ near: kz, yaw: Math.atan2(-kz.dir.x, -kz.dir.z), distance: 0, size: d.size, mg: d.mg, seed: this.rng.int(1, 1e9), killZone: kz });
      if (sq) {
        if (d.camp) this.campSquads.push(sq);
        this._record('ambush', kz, ctx, sq);
      }
      return true;
    }
    if (p.kind === 'patrol') {
      const route = this.routeThrough(d.waypoints);
      if (!route) return true;
      const st = this._hiddenStart(route, ctx);
      if (!st) return p.tries > 30;   // 계속 안 되면 포기
      const sq = em.spawnPatrol({ near: route[route.length - 1], start: st.start, route: st.route, size: d.size, mg: d.mg, seed: this.rng.int(1, 1e9) });
      if (sq) { this._record('patrol', st.start, ctx, sq); this._enemyIntel(sq, '적 분대 이동 중'); }
      return true;
    }
    if (p.kind === 'convoy') return this._spawnConvoy(p, ctx);
    if (p.kind === 'reinforce') return this._spawnReinforce(p, ctx);
    return true;
  }

  /** 경로 앞쪽부터 시야 밖·150m 밖인 첫 점에서 시작 (그 앞 경로는 잘라냄) */
  _hiddenStart(route, ctx) {
    for (let i = 0; i < route.length; i++) {
      // 분대원은 출발점 뒤쪽으로 줄지어 서므로 여유 30m
      if (this.hiddenFrom(route[i], ctx, 30)) {
        const rest = route.slice(i);
        if (rest.length < 2) return null;
        return { start: rest[0], route: rest };
      }
    }
    return null;
  }

  _spawnConvoy(p, ctx) {
    const d = p.data, em = this.em;
    if (!p.route) {
      const r = this.routeThrough([d.from, d.via, d.to]);
      if (!r) return true;
      p.route = r;
    }
    if (!this.hiddenFrom(p.route[0], ctx, 30)) return false;
    const sqIdx = p.squadIdx ?? 0;
    const sd = d.squads[sqIdx];
    const sq = em.spawnPatrol({ near: d.via, start: p.route[0], route: p.route, size: sd.size, mg: sd.mg, seed: this.rng.int(1, 1e9) });
    if (sq) {
      sq.oneWay = true;
      sq.convoy = true;
      sq.viaS = sq.route ? sq.project(d.via, 0, Infinity).s : 0;   // 경로 위 매복 구간 위치
      // 보급 행렬: 짐이 무거워 느림 (1단계 장비 무게 규칙)
      for (const s of sq.members) s.motor.loadKg += 14;
      this.ambush.convoy.push(sq);
      this.ambush.startCount += sq.members.length;
      this._record('convoy', p.route[0], ctx, sq);
      if (this.ambush.state === 'waiting') {
        this.ambush.state = 'spawned';
        this.emit('ambush', { state: 'spawned' });
        this._radio(`보급 행렬 출발 확인 — ${this._maybeWrongArea(p.route[0])}에서 오솔길로 (추정).`, 'intel', rr(this.rng, CONFIG.mission.radio.lag));
      }
    }
    // 다음 분대는 조금 뒤에
    if (sqIdx + 1 < d.squads.length) {
      this.pending.push({ kind: 'convoy', at: this.t + d.squads[sqIdx + 1].gap, data: d, tries: 0, route: p.route, squadIdx: sqIdx + 1 });
    }
    return true;
  }

  _spawnReinforce(p, ctx) {
    if (this.reinforcements >= 1) return true;     // 무한 증원 없음
    const d = p.data, em = this.em, nav = this.world.nav;
    // 출발점 후보: 계획된 곳(행렬 출발점) → 사건 현장 둘레 160~230m (플레이어 반대쪽 우선)
    const cands = [];
    if (d.from) cands.push(d.from);
    const to = d.to;
    const ax = ctx ? to.x - ctx.pos.x : 0, az = ctx ? to.z - ctx.pos.z : 1;
    const base = Math.atan2(az, ax);
    for (let k = 0; k < 24; k++) {
      const a = base + this.rng.range(-1.6, 1.6), r = this.rng.range(160, 230);
      const x = to.x + Math.cos(a) * r, z = to.z + Math.sin(a) * r;
      if (Math.abs(x) > 185 || Math.abs(z) > 185) continue;
      const q = nav.nearestOpen(x, z, 4);
      if (q) cands.push(q);
    }
    for (const c of cands) {
      if (!this.hiddenFrom(c, ctx, 30)) continue;
      const route = this.routeThrough([c, to]);
      if (!route) continue;
      const sq = em.spawnPatrol({ near: to, start: route[0], route, size: d.size, mg: true, seed: this.rng.int(1, 1e9) });
      if (!sq) return true;
      sq.reinforce = { x: to.x, z: to.z };
      sq.paceMul = 1.45;
      sq.alertLevel = 2;
      for (const s of sq.members) s.perception.alertMul = 1.35 * 1.35;
      this.reinforcements++;
      this._record('reinforce', c, ctx, sq);
      this.emit('reinforce', { state: 'spawned', at: this.t });
      this._radio(`적 증원이 ${this._maybeWrongArea(c)}에서 접근 중 — 서둘러 철수하라.`, 'intel', rr(this.rng, [8, 30]));
      return true;
    }
    return false;
  }

  _campWatch() {
    const a = this.m.enemies.ambushes.find((x) => x.camp);
    return a ? a.killZone : null;
  }

  // -----------------------------------------------------------------
  // 판정
  // -----------------------------------------------------------------
  _checkAmbush(ctx) {
    const A = this.ambush;
    if (!A.convoy.length) return;
    let dead = 0, engaged = false, routed = false;
    for (const sq of A.convoy) {
      for (const s of sq.members) if (!s.alive || s.injuries.downed) dead++;
      if (sq.state === 'engaged' || sq.state === 'alert' || sq.state === 'search' || sq.state === 'retreat' || sq.state === 'rout') engaged = true;
      if (sq.state === 'rout' || sq.state === 'retreat') routed = true;
      // 매복 구간을 한참 지나감 (경로로 110m) — 기습 없이 지나간 분대
      if (sq.state === 'patrol' && sq.pointS > (sq.viaS ?? Infinity) + 110) sq.passed = true;
    }
    if (A.state === 'spawned' && this._convoyAllOut()) {
      A.state = 'missed';
      this.emit('ambush', { state: 'missed' });
      return;
    }
    if (A.state === 'spawned' && (engaged || dead > 0)) {
      A.state = 'engaged';
      A.engagedAt = this.t;
      if (this.firstContact < 0) this.firstContact = this.t;
      this.emit('ambush', { state: 'engaged' });
      this.scheduleReinforce('ambush');
    }
    const need = Math.max(2, Math.ceil(A.startCount * 0.4));
    if (A.state === 'engaged' && (dead >= need || (routed && dead >= 1))) {
      A.state = 'success';
      this.emit('ambush', { state: 'success', dead });
      this._radio('기습 확인. 적 증원이 소리를 들었을 것이다 — 지금 철수하라.', 'progress', 4);
    }
  }

  _onRouteEnd(e) {
    const A = this.ambush, sq = e.squad;
    if (!sq.convoy) return;
    // 행렬이 그냥 지나감 → (기습 전이면) 놓침, 그리고 맵 가장자리에서 사라짐 (플레이어 시야 밖이면 치움)
    sq.gone = true;
    if (A.state === 'spawned' && this._convoyAllOut()) {
      A.state = 'missed';
      this.emit('ambush', { state: 'missed' });
    }
  }

  /** 계획된 행렬 분대가 모두 나왔고, 모두 지나갔거나 사라졌거나 전멸 */
  _convoyAllOut() {
    const A = this.ambush, plan = this.m.enemies.convoy;
    if (!plan || A.convoy.length < plan.squads.length) return false;
    return A.convoy.every((s) => s.gone || s.passed || !s.alive.length);
  }

  _checkBigFight(ctx) {
    let cas = 0, alerted = false;
    for (const sq of this.campSquads) {
      if (sq.state !== 'patrol' && sq.state !== 'ambush') alerted = true;
      for (const s of sq.members) if (!s.alive || s.injuries.downed) cas++;
    }
    if (alerted && this.firstContact < 0) this.firstContact = this.t;
    if (!alerted && cas === 0) { this._shots0 = ctx?.shots ?? 0; return; }
    const R = CONFIG.mission.raid;
    const shots = (ctx?.shots ?? 0) - (this._shots0 ?? 0);
    if (cas >= R.bigFightCasualties || shots >= R.bigFightShots) {
      this.bigFight = true;
      this.scheduleReinforce('bigFight');
    }
  }

  _onDeath(e) {
    if (e?.soldier?.faction === 'friend') return;   // 7단계: 아군 전사는 디렉터의 첫 접촉이 아님
    if (this.firstContact < 0) this.firstContact = this.t;
  }
  _onSquadState(e) {
    if ((e.state === 'engaged' || e.state === 'alert') && this.firstContact < 0) this.firstContact = this.t;
    // 7단계: 야영지 분대가 교전을 시작하면 약 2분 뒤 적 박격포 (분대 모드 습격)
    if (e.state === 'engaged' && this.m.enemies.mortar && this.mortarAt == null && this.campSquads.includes(e.squad)) {
      this.mortarAt = this.t + rr(this.rng, CONFIG.support.enemyMortar.delay);
      this.mortarSquad = e.squad;
    }
  }

  // -----------------------------------------------------------------
  // 흔적 · 먼 총성 · 무전
  // -----------------------------------------------------------------
  _placeTraces() {
    const fp = this.footprints, q = this.world.query;
    const props = [];
    for (const tr of this.m.traces) {
      if (tr.kind === 'prints' && fp) {
        const rng = new RNG(tr.seed);
        let x = tr.x, z = tr.z, yaw = tr.yaw;
        const fx = () => -Math.sin(yaw), fz = () => -Math.cos(yaw);
        for (let i = 0; i < tr.n; i++) {
          const side = i % 2 ? 1 : -1;
          const rx = Math.cos(yaw), rz = -Math.sin(yaw);
          const px = x + rx * 0.11 * side, pz = z + rz * 0.11 * side;
          fp.add(px, q.getTerrainHeight(px, pz), pz, yaw, side > 0 ? 'R' : 'L', 'enemy', q.getSurfaceAt(px, pz), { age: tr.age, depth: 0.05 });
          x += fx() * 0.68; z += fz() * 0.68;
          yaw += rng.range(-0.12, 0.12);
        }
      } else props.push(tr);
    }
    this.emit('traces', { list: props });
  }

  _distantFire(ctx) {
    if (!ctx) return;
    const G = CONFIG.mission.distantFire;
    const a = this.rng.range(0, Math.PI * 2), d = rr(this.rng, G.dist);
    const x = ctx.pos.x + Math.cos(a) * d, z = ctx.pos.z + Math.sin(a) * d;
    const shots = [];
    const bursts = this.rng.int(1, 3);
    let t = 0;
    const weapon = this.rng.chance(0.5) ? 'rifle556' : this.rng.chance(0.5) ? 'lmg762' : 'rifle762';
    const rpm = CONFIG.weapons[weapon].rpm;
    for (let b = 0; b < bursts; b++) {
      const n = weapon === 'lmg762' ? this.rng.int(4, 9) : this.rng.int(1, 5);
      for (let i = 0; i < n; i++) { shots.push({ t, weapon }); t += 60 / rpm * this.rng.range(0.95, 1.4); }
      t += this.rng.range(0.6, 2.5);
    }
    this.emit('distantFire', { x, z, distance: d, shots });
    if (this.rng.chance(0.25)) this._radio(`${dirName(Math.cos(a), Math.sin(a))}쪽 먼 곳에서 총성 — 우리 쪽 아님.`, 'intel', rr(this.rng, [6, 20]));
  }

  /** 적 정보 무전: 늦게 오고, 약 30% 는 위치가 틀림 */
  _enemyIntel(sq, what) {
    const p = sq.members[0]?.motor.position;
    if (!p) return;
    this._radio(`${this._maybeWrongArea(p)} 일대에서 ${what} — 추정.`, 'intel', rr(this.rng, CONFIG.mission.radio.lag));
  }

  _maybeWrongArea(p) {
    const right = areaName(p.x, p.z);
    if (!this.rng.chance(CONFIG.mission.radio.wrong)) return right;
    const others = AREAS.filter((a) => a !== right);
    return this.rng.pick(others);
  }

  _radio(text, kind = 'info', delay = 0) {
    (this._radioQ || (this._radioQ = [])).push({ text, kind, at: this.t + delay });
  }

  /** 외부(임무 진행)에서 무전 */
  radio(text, kind = 'progress', delay = 0) { this._radio(text, kind, delay); }
}

function startText(m) {
  if (m.type === 'recon') return `정찰조, 작전 개시. 확인 지점 ${m.objectives.length}곳 — 끝나면 회수 지점으로. 교전은 피하라.`;
  if (m.type === 'ambush') return '매복조, 작전 개시. 지정 구간에서 대기하라. 행렬 출발 시각은 아직 모른다.';
  return '습격조, 작전 개시. 야영지는 표시한 범위 안 어딘가에 있다. 문서를 회수하고 빠져나와라.';
}
