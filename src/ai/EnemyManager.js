// =====================================================================
//  EnemyManager — 적 병사·분대 전체 (순수 로직: three.js·DOM 없음 → Node 테스트 가능)
//   · 생성: spawnPatrol (오솔길을 따라 플레이어 쪽으로 지나가는 순찰 분대), spawnAmbush (오솔길 옆 매복조, 일부는 위장 구덩이)
//   · 매 프레임 update(dt):
//       동물 정적(Wildlife) 갱신 → 시각: 병사마다 시야 기하(싸다) + 레이캐스트는 프레임당 raysPerFrame 개까지 돌아가며
//       → 발견 수치 누적 → 늦게 들리는 소리 처리 → 분대 → 병사 (판단은 병사마다 초당 6~9회로 분산) → 끌려가는 부상자 위치
//       → A* 경로 요청 (프레임당 pathsPerFrame 개)
//   · 청각: NoiseEvents 'noise' 를 받아 반경 안 병사에게 거리/음속 뒤에 전달 (같은 편 소리는 총성·고함만)
//   · 총구 화염: 플레이어가 쏘면 (combat 'shot') 시야 안이고 조금이라도 보이는 병사는 즉시 발견
//   · 고함 shout(): 소음 이벤트 + 'shout' 이벤트 (Game 이 3D 음향으로 재생 — 플레이어에게 위치 단서)
//  이벤트: 'shout' {soldier, kind, position} · 'mech' {soldier, kind} · 'footstep' {soldier, evt} · 'spawn' {squad} ·
//          'death' {soldier} · 'squadState' {squad, state, prev} · 'ambushSprung' · 'leaderDown' · 'drag' · 'pitExit' · 'modeChange'
//  target: { person, motor, alive, exposure, ambient?, lamp? } — 플레이어 (4단계에서는 적의 표적이 플레이어 하나)
//  6단계 밤 (night 0~1 · moon 은 MissionRuntime 이 넣음):
//   · 시야: 노출도·하한에 빛 수준 (target.ambient()) — 밤엔 크게 줄고, 소리에 더 의존
//   · 플레이어 손전등 (target.lamp() → {x,y,z,dx,dy,dz}): 빛이 보이는 병사의 발견 수치가 크게 오름 (visible m 까지)
//   · 총구 화염: 밤엔 night.muzzle 거리·시야각까지
//   · 조명탄: 밤에 소리를 듣거나(반경 hearNoiseMin 이상) 교전이 시작되면 분대가 쏨 (requestFlare) — flares (Night.Flares)
//   · 적 손전등: 순찰 분대 일부 병사(hasLamp)가 밤 순찰·수색 중 켬 (lampOn, lampDir) — lampLightAt() 으로 비친 빛
//  이벤트 추가: 'flareLaunch' {flare, soldier}
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { RNG } from '../core/rng.js';
import { NavGrid } from './NavGrid.js';
import { Wildlife } from './Wildlife.js';
import { Squad } from './Squad.js';
import { Soldier } from './Soldier.js';
import { estimateSound } from './Perception.js';
import { Flares, lampLight } from '../world/Night.js';

const yawOf = (dx, dz) => Math.atan2(-dx, -dz);
const rr = (rng, r) => rng.range(r[0], r[1]);
const DEG = Math.PI / 180;
const SHOUT_GAP = 1.4;
const MAX_BODIES = 40;

export class EnemyManager extends EventEmitter {
  /**
   * @param {{ query, combat, noise?, layout?, nav?, wildlife?, rng? }} opts
   */
  constructor(opts) {
    super();
    this.query = opts.query;
    this.combat = opts.combat;
    this.noise = opts.noise ?? null;
    this.layout = opts.layout ?? null;
    this.rng = opts.rng ?? new RNG((Math.random() * 4294967296) >>> 0);
    this.nav = opts.nav ?? new NavGrid(this.query, this.layout);
    this.wildlife = opts.wildlife ?? new Wildlife(this.query.size ?? 400, { rng: this.rng });
    this.footprints = opts.footprints ?? null;   // 5단계: 적도 진흙에 발자국을 남기고, 수색 중엔 플레이어 발자국을 따라감
    this.restQuery = this.query;
    this.soldiers = [];
    this.squads = [];
    this.pits = [];
    this.target = null;
    this.time = 0;
    this._rayCursor = 0;
    this._paths = [];
    this._byMotor = new Map();
    this._due = [];
    this._movers = [];
    this._tgtInfo = { exposure: 0.5, speed: 0, state: 'patrol', suppression: 0, now: 0, ambient: 1, lampRate: 0 };
    // 6단계 밤
    this.night = 0;
    this.moon = 'half';
    this.flares = new Flares({ query: this.query, rng: this.rng });
    this._pendingFlares = [];
    this.stats = { rays: 0, paths: 0, flashes: 0, heard: 0 };
    this._offs = [];
    if (this.noise) this._offs.push(this.noise.on('noise', (e) => this._onNoise(e)));
    if (this.combat) {
      this._offs.push(this.combat.on('shot', (e) => this._onShot(e)));
      this._offs.push(this.combat.on('hit', (e) => this._onHit(e)));
    }
  }

  setTarget(t) { this.target = t; }

  get active() { return this.soldiers.filter((s) => s.alive); }

  // =================================================================
  // 생성
  // =================================================================
  /**
   * 순찰 분대: 플레이어에서 distance m 떨어진 오솔길(없으면 걸을 수 있는 곳)에서 시작해 플레이어 쪽을 지나가는 경로.
   * @param {{ near: {x,z}, yaw?: number, distance?: number, size?: number, mg?: boolean, seed?: number }} o
   */
  spawnPatrol(o) {
    const rng = o.seed !== undefined ? new RNG(o.seed) : new RNG(this.rng.int(1, 2 ** 30));
    const size = this._capSize(o.size ?? 5);
    if (size <= 0) return null;
    const d = o.distance ?? 100;
    const start = o.start ?? this._spawnPoint(o.near, d, rng, true);
    if (!start) return null;
    // 경로: 시작 → 플레이어 근처를 지나 반대쪽까지 (오솔길 선호 A*)
    let ux = o.near.x - start.x, uz = o.near.z - start.z;
    const ul = Math.hypot(ux, uz) || 1;
    ux /= ul; uz /= ul;
    let route = o.route ?? null;
    if (!route) {
      const endRaw = o.end ?? { x: o.near.x + ux * 45, z: o.near.z + uz * 45 };
      const end = this.nav.nearestOpen(endRaw.x, endRaw.z, 8) ?? o.near;
      const path = this.nav.findPath(start, end, { mode: 'patrol', maxNodes: 40000 });
      route = path ? [start, ...path] : [start, end];
    }
    const squad = new Squad(this, { type: 'patrol', route, rng });
    this.squads.push(squad);
    // 첨병 + 분대장 + 소총수 (한 명만 남았으면 분대장 혼자 — 최대 인원 제한으로 잘렸을 때)
    const roles = size >= 2 ? ['point', 'leader'] : ['leader'];
    while (roles.length < size) roles.push('rifleman');
    if (o.mg !== false && size >= 3) roles[size - 2 >= 2 ? size - 2 : size - 1] = 'mg';
    const r0 = squad.routeAt(0), r1 = squad.routeAt(4);
    let dx = r1.x - r0.x, dz = r1.z - r0.z;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl; dz /= dl;
    // 분대원은 첫 지점 뒤쪽 일렬 — 경로를 그만큼 뒤로 늘려 첨병의 경로 위치(pointS)가 그 길이에서 시작
    let total = 0;
    for (let i = 1; i < size; i++) total += squad.spacing[i] = rr(rng, CONFIG.ai.squad.spacing);
    const tail = this.nav.nearestOpen(r0.x - dx * total, r0.z - dz * total, 4);
    if (tail && this.nav.lineWalkable(tail, r0)) {
      squad.setRoute([tail, ...squad.route.pts]);
      squad.pointS = Math.hypot(r0.x - tail.x, r0.z - tail.z);
    }
    let back = 0;
    roles.forEach((role, i) => {
      if (i > 0) back += squad.spacing[i] ?? 0;
      const p = squad.routeAt(Math.max(0, squad.pointS - back)) ?? this.nav.nearestOpen(r0.x - dx * back, r0.z - dz * back, 4) ?? r0;
      const s = new Soldier(this, {
        x: p.x, z: p.z, yaw: yawOf(dx, dz), stance: 'stand', rng: new RNG(rng.int(1, 2 ** 30)), role: role === 'point' ? 'rifleman' : role,
        weapon: role === 'mg' ? 'lmg762' : 'rifle556', variant: rng.int(0, 5),
      });
      if (role === 'point') s.isPoint = true;
      this._addSoldier(s);
      squad.add(s);
    });
    if (!squad.leader) { squad.leader = squad.members[0]; squad.members[0].role = 'leader'; squad.members[0].baseRole = 'leader'; }
    // 6단계: 가린 손전등 (밤 순찰에서만 켬) — 첨병·분대장 쪽부터
    const EL = CONFIG.night.enemyLamp;
    if (o.lamps ?? rng.chance(EL.chance)) {
      const nL = Math.min(squad.members.length, typeof o.lamps === 'number' ? o.lamps : rng.int(EL.count[0], EL.count[1]));
      for (let i = 0; i < nL; i++) squad.members[i].hasLamp = true;
    }
    this.emit('spawn', { squad });
    return squad;
  }

  /**
   * 매복조: 플레이어가 바라보는 쪽 오솔길 위 distance m 지점(kill zone) 옆 7~16m 에 엎드리거나 구덩이에 숨음.
   * @param {{ near: {x,z}, yaw: number, distance?: number, size?: number, mg?: boolean, seed?: number, killZone?: {x,z} }} o
   */
  spawnAmbush(o) {
    const rng = o.seed !== undefined ? new RNG(o.seed) : new RNG(this.rng.int(1, 2 ** 30));
    const A = CONFIG.ai.ambush;
    const size = this._capSize(o.size ?? 4);
    if (size <= 0) return null;
    const kz = o.killZone ?? this._killZone(o.near, o.yaw ?? 0, o.distance ?? 100);
    if (!kz) return null;
    const q = this.query;
    // 오솔길을 따라 (굽은 길도) along m 떨어진 기준점 — 양수 = 플레이어에서 먼 쪽
    const ref = (along) => (kz.line ? this._trailWalk(kz.line, kz.i, kz.sign, along)
      : { x: kz.x + kz.dir.x * along, z: kz.z + kz.dir.z * along, dir: kz.dir });
    const c0 = ref(0);
    // 숨기 좋은 쪽 (은폐가 짙은 쪽)
    let side = 1, bestSide = -1;
    for (const sgn of [1, -1]) {
      let c = 0;
      for (let k = 0; k < 6; k++) {
        const off = 3 + k;
        c += this.nav.concealAt(c0.x - c0.dir.z * sgn * off, c0.z + c0.dir.x * sgn * off);
      }
      if (c > bestSide) { bestSide = c; side = sgn; }
    }
    const squad = new Squad(this, { type: 'ambush', rng });
    squad.setAmbush({ x: c0.x, y: q.getSupportHeight(c0.x, c0.z), z: c0.z });
    this.squads.push(squad);
    const spread = rr(rng, A.spread);
    const targets = A.viewTargets.map((a) => ref(a));
    for (let i = 0; i < size; i++) {
      const along = (i - (size - 1) / 2) * spread;
      const r = ref(along);
      const n = { x: -r.dir.z * side, z: r.dir.x * side };
      // 분대장은 관측자 (웅크려 접근로를 봄), 기관총은 엎드려 거치, 나머지는 반쯤 구덩이
      const role = i === 0 ? 'leader' : (o.mg !== false && i === size - 1 && size >= 3) ? 'mg' : 'rifleman';
      const kind = i === 0 ? 'observe' : role === 'mg' ? 'prone' : rng.chance(A.pitChance) ? 'pit' : 'prone';
      const pit = kind === 'pit';
      const spot = this._ambushSpot(r, n, targets, kind, rng) ?? this.nav.nearestOpen(r.x + n.x * 5, r.z + n.z * 5, 4);
      if (!spot) continue;
      const look = ref(Math.min(along, 0) - 10);
      const s = new Soldier(this, {
        x: spot.x, z: spot.z, yaw: yawOf(look.x - spot.x, look.z - spot.z), stance: pit ? 'stand' : kind === 'observe' ? 'crouch' : 'prone',
        rng: new RNG(rng.int(1, 2 ** 30)), role, weapon: role === 'mg' ? 'lmg762' : 'rifle556', variant: rng.int(0, 5), pit,
      });
      s.ambushLook = { x: look.x, z: look.z };
      s.ambushKind = kind;
      s.ambushView = spot.view ?? 0;
      s.look.yaw = s.motor.yaw;
      if (pit) this.pits.push({ x: spot.x, y: q.getTerrainHeight(spot.x, spot.z), z: spot.z, soldier: s });
      this._addSoldier(s);
      squad.add(s);
    }
    if (!squad.leader && squad.members.length) { squad.leader = squad.members[0]; squad.members[0].role = 'leader'; }
    this.emit('spawn', { squad });
    return squad;
  }

  /**
   * 5단계 야영지: 한 분대(type 'camp') — 보초는 바깥 둘레(13~17m)에서 바깥을 살피고, 쉬는 병사는 모닥불 곁(2~3m)에 앉아 있다.
   * 경계 전에는 자리를 지키고(mode 'post'), 경계·교전이 시작되면 4단계 분대처럼 엄폐·사격·측면·수색.
   * @param {{ center:{x,z}, sentries:number, rest:number, seed?:number, mg?:boolean, watch?:{x,z} }} o  watch: 보초 하나가 보는 쪽 (접근로)
   */
  spawnCamp(o) {
    const rng = o.seed !== undefined ? new RNG(o.seed) : new RNG(this.rng.int(1, 2 ** 30));
    const want = (o.sentries ?? 2) + (o.rest ?? 3);
    const size = this._capSize(want);
    if (size <= 0) return null;
    const squad = new Squad(this, { type: 'camp', rng });
    this.squads.push(squad);
    const c = o.center;
    const nS = Math.min(o.sentries ?? 2, size), nR = size - nS;
    const a0 = o.watch ? Math.atan2(o.watch.z - c.z, o.watch.x - c.x) : rng.range(0, Math.PI * 2);
    for (let i = 0; i < size; i++) {
      const sentry = i < nS;
      let a, r;
      if (sentry) { a = a0 + i * (Math.PI * 2 / Math.max(1, nS)) + rng.range(-0.3, 0.3); r = rng.range(13, 17); }
      else { a = ((i - nS) / Math.max(1, nR)) * Math.PI * 2 + rng.range(-0.25, 0.25); r = rng.range(2.2, 3.2); }
      const p = this.nav.nearestOpen(c.x + Math.cos(a) * r, c.z + Math.sin(a) * r, 3) ?? { x: c.x + Math.cos(a) * r, z: c.z + Math.sin(a) * r };
      const look = sentry ? { x: c.x + Math.cos(a) * (r + 35), z: c.z + Math.sin(a) * (r + 35) } : { x: c.x, z: c.z };
      const role = i === nS ? 'leader' : (o.mg && i === nS + 1) ? 'mg' : 'rifleman';
      const s = new Soldier(this, {
        x: p.x, z: p.z, yaw: yawOf(look.x - p.x, look.z - p.z), stance: sentry ? 'stand' : 'crouch', rng: new RNG(rng.int(1, 2 ** 30)),
        role, weapon: role === 'mg' ? 'lmg762' : 'rifle556', variant: rng.int(0, 5),
      });
      s.post = { x: p.x, z: p.z, look };
      s.postRole = sentry ? 'sentry' : 'rest';
      s.look.yaw = s.motor.yaw;
      this._addSoldier(s);
      squad.add(s);
    }
    if (!squad.leader && squad.members.length) { squad.leader = squad.members[0]; squad.members[0].role = 'leader'; }
    this.emit('spawn', { squad });
    return squad;
  }

  _capSize(n) {
    const left = CONFIG.ai.maxActive - this.active.length;
    return Math.max(0, Math.min(n, left));
  }

  _addSoldier(s) {
    this.soldiers.push(s);
    this._byMotor.set(s.motor, s);
    // 화면·소리 쪽 (Game) 이 병사마다 구독하지 않게 다시 보냄: 신음·핏자국·쓰러짐·식물 헤치는 소리
    for (const ev of ['vocal', 'bleed', 'fall']) s.on(ev, (e) => this.emit(ev, { ...e, soldier: s }));
    s.motor.on('rustle', (e) => this.emit('rustle', { soldier: s, evt: e }));
    s.motor.on('footstep', (e) => { if (this.footprints) this.footprints.step(s.motor, e, 'enemy'); });
    // 시체가 너무 많으면 오래된 것부터 치움
    const dead = this.soldiers.filter((x) => !x.alive);
    if (this.soldiers.length > MAX_BODIES && dead.length) this._remove(dead[0]);
  }

  _remove(s) {
    s.dispose();
    this._byMotor.delete(s.motor);
    const i = this.soldiers.indexOf(s);
    if (i >= 0) this.soldiers.splice(i, 1);
    this.pits = this.pits.filter((p) => p.soldier !== s);
  }

  /** 5단계: 분대 하나를 맵에서 치움 (보급 행렬이 맵 가장자리로 빠져나감 — 플레이어 시야 밖일 때만 부름) */
  removeSquad(sq) {
    for (const s of sq.members.slice()) this._remove(s);
    const i = this.squads.indexOf(sq);
    if (i >= 0) this.squads.splice(i, 1);
  }

  /** 모두 제거 */
  clear() {
    for (const s of this.soldiers.slice()) this._remove(s);
    this.squads.length = 0;
    this.pits.length = 0;
    this._paths.length = 0;
    this.flares.clear();
    this._pendingFlares.length = 0;
    this.emit('clear', {});
  }

  dispose() {
    this.clear();
    for (const off of this._offs) off?.();
  }

  /** 시작 지점: 플레이어에서 d m 떨어진 오솔길 칸 (없으면 걸을 수 있는 칸) */
  _spawnPoint(near, d, rng, preferTrail) {
    const nav = this.nav;
    let best = null, bs = -Infinity;
    for (let k = 0; k < 72; k++) {
      const a = rng.range(0, Math.PI * 2);
      const dd = d * rng.range(0.9, 1.1);
      const x = near.x + Math.cos(a) * dd, z = near.z + Math.sin(a) * dd;
      if (Math.abs(x) > nav.half - 12 || Math.abs(z) > nav.half - 12) continue;
      if (!nav.walkable(x, z)) continue;
      let s = rng.range(0, 1);
      if (preferTrail && nav.onTrail(x, z)) s += 3;
      if (s > bs) { bs = s; best = { x, z }; }
    }
    if (!best) return null;
    return nav.nearestOpen(best.x, best.z, 3) ?? best;
  }

  /** 매복 지점: 바라보는 쪽 가까운 오솔길을 따라 d m (없으면 바라보는 방향 d m) */
  _killZone(near, yaw, d) {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    let best = null, bd = 40;
    for (const tr of this.layout?.trails ?? []) {
      const L = tr.line;
      for (let i = 0; i < L.count; i += 2) {
        const dd = Math.hypot(L.x[i] - near.x, L.z[i] - near.z);
        if (dd < bd) { bd = dd; best = { tr, i }; }
      }
    }
    if (best) {
      const L = best.tr.line;
      // 바라보는 쪽으로 오솔길을 따라감
      const i0 = best.i, ia = Math.min(L.count - 1, i0 + 2), ib = Math.max(0, i0 - 2);
      const dirF = (L.x[ia] - L.x[ib]) * fx + (L.z[ia] - L.z[ib]) * fz >= 0 ? 1 : -1;
      let acc = 0, i = i0;
      while (acc < d && i + dirF >= 0 && i + dirF < L.count) {
        acc += Math.hypot(L.x[i + dirF] - L.x[i], L.z[i + dirF] - L.z[i]);
        i += dirF;
      }
      if (acc > d * 0.6) {
        const j = Math.max(0, Math.min(L.count - 1, i + dirF * 2));
        let tx = L.x[j] - L.x[i], tz = L.z[j] - L.z[i];
        const tl = Math.hypot(tx, tz) || 1;
        return { x: L.x[i], z: L.z[i], dir: { x: tx / tl, z: tz / tl }, line: L, i, sign: dirF };
      }
    }
    const p = this.nav.nearestOpen(near.x + fx * d, near.z + fz * d, 6);
    return p ? { x: p.x, z: p.z, dir: { x: fx, z: fz } } : null;
  }

  /** 오솔길 선 L 의 i 번째 점에서 sign 방향으로 along m (음수면 반대로) 따라간 점과 그 방향 */
  _trailWalk(L, i, sign, along) {
    const st = along >= 0 ? sign : -sign;
    let left = Math.abs(along), k = i;
    while (left > 0 && k + st >= 0 && k + st < L.count) {
      const seg = Math.hypot(L.x[k + st] - L.x[k], L.z[k + st] - L.z[k]);
      if (seg >= left) {
        const f = left / (seg || 1);
        const x = L.x[k] + (L.x[k + st] - L.x[k]) * f, z = L.z[k] + (L.z[k + st] - L.z[k]) * f;
        return { x, z, dir: this._trailDir(L, k, sign) };
      }
      left -= seg;
      k += st;
    }
    return { x: L.x[k], z: L.z[k], dir: this._trailDir(L, k, sign) };
  }

  _trailDir(L, k, sign) {
    const a = Math.max(0, Math.min(L.count - 1, k + sign * 2)), b = Math.max(0, Math.min(L.count - 1, k - sign * 2));
    const tx = L.x[a] - L.x[b], tz = L.z[a] - L.z[b];
    const tl = Math.hypot(tx, tz) || 1;
    return { x: tx / tl, z: tz / tl };
  }

  /**
   * 매복 자리 고르기: 오솔길 기준점 r 에서 옆(n)으로 offset m — 그 자세의 눈높이(관측 웅크림 1.05m, 구덩이 ≈0.6m, 엎드림 0.32m)에서
   * kill zone 의 오솔길 점들(targets)이 실제로 보이는지 (시야 투과율) × viewWeight + 은폐.
   * 풀 바닥층에 눈이 묻히면 아무것도 못 보니, 보이는 자리가 숨기 좋은 자리보다 우선.
   */
  _ambushSpot(r, n, targets, kind, rng) {
    const A = CONFIG.ai.ambush, nav = this.nav, q = this.query, E = CONFIG.stance.eyeHeight;
    const eh = kind === 'pit' ? E.stand - A.pitDepth : kind === 'observe' ? E.crouch : E.prone;
    const offs = kind === 'pit' ? A.pitOffset : A.offset;
    const tries = kind === 'observe' ? A.candidates * 2 : A.candidates;
    let best = null, bs = -Infinity;
    for (let k = 0; k < tries; k++) {
      const off = rr(rng, offs), al = rng.range(-3, 3);
      const x = r.x + n.x * off + r.dir.x * al, z = r.z + n.z * off + r.dir.z * al;
      if (!nav.walkable(x, z)) continue;
      const ey = q.getSupportHeight(x, z) + eh;
      let vis = 0;
      for (const tp of targets) {
        const dir = { x: tp.x - x, y: q.getSupportHeight(tp.x, tp.z) + 1.2 - ey, z: tp.z - z };
        const L = Math.hypot(dir.x, dir.y, dir.z);
        const ray = q.raycastWorld({ x, y: ey, z }, dir, Math.max(0.1, L - 0.3), 'vision');
        vis += ray.hit ? 0 : ray.transmittance;
      }
      vis /= targets.length || 1;
      const sc = Math.min(1, vis * 2.5) * A.viewWeight + nav.concealAt(x, z) + rng.range(0, 0.2);
      if (sc > bs) { bs = sc; best = { x, z, view: vis }; }
    }
    return best;
  }

  // =================================================================
  // 프레임
  // =================================================================
  update(dt) {
    if (!(dt > 0)) return;
    this.time += dt;
    this._dt = dt;
    // 동물 정적: 움직이는 사람들
    const mv = this._movers;
    mv.length = 0;
    const t = this.target;
    if (t && t.motor) mv.push({ x: t.motor.position.x, z: t.motor.position.z, speed: t.motor.speed });
    for (const s of this.soldiers) if (s.alive) mv.push({ x: s.motor.position.x, z: s.motor.position.z, speed: s.motor.speed });
    this.wildlife.update(dt, mv);
    this._updateFlares(dt);
    if (!this.soldiers.length) return;
    this._updateLamps();
    this._perceive(dt);
    // 늦게 들리는 소리
    for (const s of this.soldiers) {
      if (!s.alive || !s.perception.pending.length) continue;
      for (const e of s.perception.due(this.time, this._due)) s.onSound(e);
    }
    for (const sq of this.squads) sq.update(dt);
    for (const s of this.soldiers) s.update(dt);
    this._syncDrags();
    this._servePaths();
  }

  // ---- 시각 -----------------------------------------------------------
  _perceive(dt) {
    const t = this.target, V = CONFIG.ai.vision, now = this.time;
    const alive = this.soldiers.filter((s) => s.alive);
    if (!t || !t.alive || !t.person.hitboxes.length) {
      for (const s of alive) { s.perception.inView = false; s.perception.accumulate(dt, this._tgtInfo); }
      return;
    }
    const caps = t.person.hitboxes;
    const chest = caps.chest;
    const info = this._tgtInfo;
    info.exposure = typeof t.exposure === 'function' ? t.exposure() : (t.exposure ?? 0.5);
    info.speed = Math.hypot(t.motor.velocity.x, t.motor.velocity.z);
    info.fogD = this.fogDensity ?? 0;   // 5단계: 안개·비 (Game 이 대기 안개 밀도를 넣음)
    info.now = now;
    info.ambient = typeof t.ambient === 'function' ? t.ambient() : (t.ambient ?? 1);   // 6단계: 그 자리 빛 수준
    const lamp = typeof t.lamp === 'function' ? t.lamp() : (t.lamp ?? null);
    for (const s of alive) s.perception.geometry(s.eye, s.look.yaw, chest);
    // 레이 예산: 시야 안 병사를 돌아가며 (오래된 것부터)
    let budget = CONFIG.ai.raysPerFrame;
    const n = alive.length;
    for (let k = 0; k < n && budget > 0; k++) {
      const s = alive[(this._rayCursor + k) % n];
      const P = s.perception;
      if (!P.inView || P.visibilityAge < 0.12) continue;
      budget -= this._visibility(s, caps, 2);
    }
    this._rayCursor = (this._rayCursor + 1) % Math.max(1, n);
    for (const s of alive) {
      const P = s.perception;
      info.state = PSTATE[s.squad?.state] ?? 'patrol';
      // 야영지에서 쉬는 병사는 잘 못 봄 (이야기·불·쉼), 보초는 보통보다 조금 더 살핌
      if (s.mode === 'post') info.state = s.postRole === 'rest' ? 'rest' : 'sentry';
      info.suppression = s.suppression;
      info.lampRate = lamp ? this._lampRate(s, lamp) : 0;
      const fresh = P.accumulate(dt, info);
      if (fresh) s.onDetect();
      // 반쯤 알아챔 → 의심 (그쪽을 조사) — 대략적인 위치만
      if (!fresh && P.meter >= V.suspicious && P.meter < 1 && s.squad && now > (s._suspAt ?? -Infinity)) {
        s._suspAt = now + 5;
        const err = (1 - P.meter) * 8 + 2;
        const a = s.rng.range(0, Math.PI * 2);
        const p = t.motor.position;
        s.squad.onSuspicious(s, { x: p.x + Math.cos(a) * err, z: p.z + Math.sin(a) * err, error: err, distance: P.distance }, 'glimpse');
      }
    }
  }

  /**
   * 6단계: 플레이어 손전등이 이 병사에게 보이는 정도 → 발견 비율 (/s). 빛이 시야각 안이고 (가림 = 마지막 시야 투과율),
   * visible m 안이면 거리에 반비례, 불빛이 이쪽을 향하면 × beamMul. 밤이 아니면 거의 0 (낮엔 손전등이 눈에 안 띔)
   */
  _lampRate(s, lamp) {
    const FL = CONFIG.night.flashlight, V = CONFIG.ai.vision;
    if (this.night < 0.2) return 0;
    const eye = s.eye;
    const dx = lamp.x - eye.x, dy = lamp.y - eye.y, dz = lamp.z - eye.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > FL.visible || d < 0.3) return 0;
    const fx = -Math.sin(s.look.yaw), fz = -Math.cos(s.look.yaw), hd = Math.hypot(dx, dz) || 1;
    const ang = Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / hd))) / DEG;
    if (ang > V.fovDeg / 2 + 15) return 0;
    // 불빛까지 시야 (병사마다 0.3초에 한 번 레이 — 빛은 잎 틈으로도 새어 보여 투과율의 제곱근)
    if (!(s._lampVisT > this.time - 0.3)) {
      s._lampVisT = this.time + this.rng.range(0, 0.1);
      const r = this.query.raycastWorld({ x: eye.x, y: eye.y, z: eye.z }, { x: dx, y: dy, z: dz }, Math.max(0.1, d - 0.3), 'vision');
      this.stats.rays++;
      s._lampVis = r.hit ? 0 : Math.sqrt(r.transmittance);
    }
    const vis = s._lampVis ?? 0;
    if (vis < V.visibleMin) return 0;
    // 불빛이 이쪽을 비추나 (손전등 원뿔 반각 × 1.6 안)
    const c = -(dx * lamp.dx + dy * lamp.dy + dz * lamp.dz) / d;
    const beam = Math.acos(Math.max(-1, Math.min(1, c))) / DEG < FL.angle * 1.6 ? FL.beamMul : 1;
    const periph = ang > V.centralDeg / 2 ? 0.6 : 1;
    return FL.detectRate * Math.min(4, 30 / d) * vis * beam * periph * this.night;
  }

  /** 적 손전등 빛 (0~1) 이 점 (x,y,z) 를 비추는 정도 (가장 밝은 것) */
  lampLightAt(x, y, z) {
    let best = 0;
    for (const s of this.soldiers) {
      if (!s.lampOn || !s.alive) continue;
      const v = lampLight(s.lamp, x, y, z);
      if (v > best) best = v;
    }
    return best;
  }

  /** 6단계: 밤 순찰·수색 중이면 손전등 켬 (교전·경계 중엔 끔) — 방향은 보는 쪽 아래로 */
  _updateLamps() {
    const EL = CONFIG.night.enemyLamp;
    for (const s of this.soldiers) {
      if (!s.hasLamp) continue;
      const st = s.squad?.state;
      const on = s.alive && this.night > 0.5 && (st === 'patrol' || st === 'suspicious' || st === 'search') && s.mode !== 'post';
      s.lampOn = on;
      if (!on) continue;
      const L = s.lamp || (s.lamp = { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0, range: EL.range, angle: EL.angle, light: EL.light });
      const e = s.eye, yaw = s.look.yaw;
      // 발 앞 pool m 를 비춤 (아래로 기울임)
      const ey = e.y - s.motor.position.y, pitch = -Math.atan2(ey, EL.pool);
      L.x = e.x; L.y = e.y - 0.35; L.z = e.z;
      L.dx = -Math.sin(yaw) * Math.cos(pitch); L.dy = Math.sin(pitch); L.dz = -Math.cos(yaw) * Math.cos(pitch);
    }
  }

  /**
   * 6단계: 분대가 조명탄을 쏘려 함 (밤·남은 조명탄·쿨다운). at = 확인하려는 대략적인 위치
   * @returns {boolean} 쏘기로 했나 (delay 뒤 발사)
   */
  requestFlare(squad, at) {
    const F = CONFIG.night.flare;
    if (this.night < 0.5 || !squad || !at) return false;
    if (squad.flaresLeft === undefined) squad.flaresLeft = F.perSquad;
    if (squad.flaresLeft <= 0) return false;
    if (this.time < (squad.flareAt ?? -Infinity) + F.cooldown) return false;
    if (this._pendingFlares.some((p) => p.squad === squad)) return false;
    squad.flaresLeft--;
    squad.flareAt = this.time;
    this._pendingFlares.push({ at: this.time + rr(this.rng, F.delay), squad, toward: { x: at.x, z: at.z } });
    return true;
  }

  _updateFlares(dt) {
    const pf = this._pendingFlares;
    for (let i = pf.length - 1; i >= 0; i--) {
      const r = pf[i];
      if (this.time < r.at) continue;
      pf.splice(i, 1);
      const sq = r.squad;
      const shooter = sq.leader?.alive ? sq.leader : sq.members?.find((m) => m.alive && !m.injuries?.effects?.().downed);
      if (!shooter) continue;
      const p = shooter.motor.position;
      const f = this.flares.launch({ x: p.x, y: p.y + 1.5, z: p.z }, r.toward, { squad: sq });
      this.emit('flareLaunch', { flare: f, soldier: shooter });
    }
    this.flares.update(dt);
  }

  /** 레이 최대 maxRays 개로 투과율 (가슴 → 머리 → 골반 중 가장 잘 보이는 값). 쓴 레이 수를 돌려줌 */
  _visibility(s, caps, maxRays) {
    const q = this.query, eye = s.eye;
    let best = 0, used = 0;
    const pts = [caps.chest, partCenter(caps, 'head'), partCenter(caps, 'pelvis')];
    for (const p of pts) {
      if (!p || used >= maxRays) break;
      const dir = { x: p.x - eye.x, y: p.y - eye.y, z: p.z - eye.z };
      const L = Math.hypot(dir.x, dir.y, dir.z);
      if (L < 0.3) { best = 1; break; }
      const r = q.raycastWorld({ x: eye.x, y: eye.y, z: eye.z }, dir, Math.max(0.1, L - 0.25), 'vision');
      used++;
      const v = r.hit ? 0 : r.transmittance;
      if (v > best) best = v;
      if (best > 0.5) break;
    }
    s.perception.setVisibility(best);
    this.stats.rays += used;
    return used;
  }

  // ---- 소리 -----------------------------------------------------------
  _onNoise(e) {
    if (e.kind === 'gunshot' || e.kind === 'explosion') this.wildlife.gunshot(e.x, e.z);
    if (!this.soldiers.length) return;
    const H = CONFIG.ai.hearing;
    if (H.ignoreKinds.includes(e.kind)) return;
    const t = this.target;
    const fromTarget = t && e.source === t.motor;
    const fromSoldier = this._byMotor.get(e.source) ?? null;
    if (!fromTarget && !fromSoldier) return;
    if (fromSoldier && e.kind !== 'gunshot' && e.kind !== 'shout') return;   // 같은 편 발소리는 무시
    if (fromSoldier) e.squad = fromSoldier.squad;
    // 5단계: 플레이어가 주운 적 소총으로 쏘면 — 소리만 들은 적은 잠깐 아군 총성으로 착각 (첫 반응이 1~2초 늦음)
    const confused = fromTarget && e.kind === 'gunshot' && e.family === 'enemy';
    for (const s of this.soldiers) {
      if (!s.alive || s === fromSoldier) continue;
      const d = Math.hypot(e.x - s.motor.position.x, e.z - s.motor.position.z);
      if (d > e.radius) continue;
      if (fromSoldier && fromSoldier.squad === s.squad) continue;
      const extra = confused && !s.perception.seen ? this.rng.range(CONFIG.ammo.confusion[0], CONFIG.ammo.confusion[1]) : 0;
      s.perception.hear(e, d / H.speedOfSound + extra, this.time);
      this.stats.heard++;
    }
  }

  /** 들은 소리 → 대략적인 위치 (Perception.estimateSound) */
  estimate(evt, listener, rng, crack) {
    return estimateSound(evt, listener, rng, crack);
  }

  // ---- 총구 화염·명중 ----------------------------------------------------
  _onShot(e) {
    const t = this.target;
    if (!t || e.shooter !== t.person) return;
    const V = CONFIG.ai.vision, q = this.query, NM = CONFIG.night.muzzle;
    const o = e.origin;
    // 6단계: 밤엔 총구 화염이 훨씬 멀리·넓게 보이고, 잎에 가려도 새어 보임
    const nk = Math.min(1, Math.max(0, this.night));
    const range = V.flashRange + (NM.range - V.flashRange) * nk;
    const halfFov = (V.fovDeg + (NM.fovDeg - V.fovDeg) * nk) / 2;
    const visMin = V.flashVisibleMin + (NM.visibleMin - V.flashVisibleMin) * nk;
    for (const s of this.soldiers) {
      if (!s.alive || s.perception.seen) continue;
      const eye = s.eye;
      const dx = o.x - eye.x, dy = o.y - eye.y, dz = o.z - eye.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > range) continue;
      const fx = -Math.sin(s.look.yaw), fz = -Math.cos(s.look.yaw);
      const hd = Math.hypot(dx, dz) || 1;
      const ang = Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / hd))) / DEG;
      if (ang > halfFov) continue;
      const r = q.raycastWorld({ x: eye.x, y: eye.y, z: eye.z }, { x: dx, y: dy, z: dz }, Math.max(0.1, d - 0.3), 'vision');
      this.stats.rays++;
      const v = r.hit ? 0 : r.transmittance;
      if (v < visMin) continue;
      this.stats.flashes++;
      if (s.perception.flash(this.time)) s.onDetect(false);
    }
  }

  _onHit(e) {
    const s = e.person?.entity;
    if (s && s instanceof Soldier) s.onHit(e);
  }

  // =================================================================
  // 병사가 부르는 것들
  // =================================================================
  /** 고함 (분대 의사소통·비명·도움 요청) — 소음 이벤트 + 'shout' (3D 음향) */
  shout(s, kind, force = false) {
    if (!s || !s.alive && kind !== 'scream') return;
    const now = this.time;
    if (!force && now - (s._shoutAt ?? -Infinity) < SHOUT_GAP) return;
    s._shoutAt = now;
    const H = CONFIG.ai.hearing;
    const p = s.motor.position;
    const pos = { x: p.x, y: p.y + 1.5 - (s.pitDepth || 0), z: p.z };
    const radius = kind === 'scream' || kind === 'help' ? H.screamRadius : H.shoutRadius;
    if (this.noise) this.noise.emitNoise(pos, radius, 'shout', s.motor, { shoutKind: kind });
    this.emit('shout', { soldier: s, kind, position: pos });
  }

  requestPath(s, mode) {
    const i = this._paths.findIndex((r) => r.s === s);
    const req = { s, goal: s.goal, mode };
    if (i >= 0) this._paths[i] = req; else this._paths.push(req);
  }

  _servePaths() {
    let budget = CONFIG.ai.pathsPerFrame;
    while (budget > 0 && this._paths.length) {
      const r = this._paths.shift();
      if (!r.s.alive || r.goal !== r.s.goal || !r.goal) continue;
      const d = Math.hypot(r.goal.x - r.s.motor.position.x, r.goal.z - r.s.motor.position.z);
      const opts = { mode: r.mode, maxNodes: Math.min(CONFIG.ai.nav.maxNodes, 400 + d * d * 1.2) };
      let path = this.nav.findPath(r.s.motor.position, r.goal, opts);
      // 6단계: 함정 둘레 비용 때문에 노드 예산 안에 못 찾으면 비용 없이 다시 (함정은 조향으로 비켜 감)
      if (!path && this.nav.hazards.length) path = this.nav.findPath(r.s.motor.position, r.goal, { ...opts, ignoreHazards: true });
      this.stats.paths++;
      r.s.setPath(r.goal, path);
      budget--;
    }
  }

  /** 다른 병사들이 쓰는 엄폐 점 (겹치지 않게) */
  takenCover(me) {
    const out = [];
    for (const s of this.soldiers) {
      if (s === me || !s.alive || !s.cover) continue;
      out.push({ x: s.cover.hideX, z: s.cover.hideZ });
    }
    return out;
  }

  /** 사선에 아군이 있나 (가슴이 사선에서 clearance 안, 내 앞쪽) */
  friendlyInLine(me, from, to) {
    const Fc = CONFIG.ai.fire;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const L = Math.hypot(dx, dy, dz);
    if (L < 1) return false;
    const ux = dx / L, uy = dy / L, uz = dz / L;
    for (const s of this.soldiers) {
      if (s === me || !s.alive) continue;
      const c = s.person.hitboxes.chest ?? s.motor.position;
      const px = c.x - from.x, py = c.y - from.y, pz = c.z - from.z;
      const t = px * ux + py * uy + pz * uz;
      if (t < 0.8 || t > L + 1.5) continue;
      const qx = px - ux * t, qy = py - uy * t, qz = pz - uz * t;
      if (Math.hypot(qx, qy, qz) < Fc.friendlyClearance) return true;
    }
    return false;
  }

  onSoldierFired(s, e) { this.emit('fired', { soldier: s, e }); }

  onSoldierDeath(s) { this.emit('death', { soldier: s }); }

  /** 끌려가는 부상자: 끄는 사람 앞 0.9m 에 붙여 둠 (둘 다 노출) */
  _syncDrags() {
    for (const s of this.soldiers) {
      const d = s.drag;
      if (!d || d.phase !== 'pull' || !d.wounded.alive) continue;
      const w = d.wounded, p = s.motor.position;
      const fx = -Math.sin(s.look.yaw), fz = -Math.cos(s.look.yaw);
      const wm = w.motor;
      // 끄는 사람 앞 0.9m 로 — 처음 붙잡을 때 튀지 않게 초당 dragSpeed 로만 따라감
      const tx = p.x + fx * 0.9, tz = p.z + fz * 0.9;
      const ex = tx - wm.position.x, ez = tz - wm.position.z, el = Math.hypot(ex, ez);
      const maxStep = (CONFIG.ai.wounded.dragSpeed + 0.05) * this._dt;
      if (el > maxStep) { wm.position.x += ex / el * maxStep; wm.position.z += ez / el * maxStep; } else { wm.position.x = tx; wm.position.z = tz; }
      wm.velocity.x = 0; wm.velocity.z = 0;
      wm.yaw = yawOf(p.x - wm.position.x, p.z - wm.position.z);
      w.look.yaw = wm.yaw;
    }
  }

  /** F2 디버그·테스트: 병사 요약 */
  debugList() {
    return this.soldiers.map((s) => s.debugInfo());
  }
}

const PSTATE = { patrol: 'patrol', suspicious: 'suspicious', alert: 'alert', engaged: 'engaged', search: 'search', ambush: 'ambush', retreat: 'alert', rout: 'alert' };

function partCenter(caps, part) {
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    if (c.part === part) return { x: (c.a.x + c.b.x) / 2, y: (c.a.y + c.b.y) / 2, z: (c.a.z + c.b.z) / 2 };
  }
  return null;
}
