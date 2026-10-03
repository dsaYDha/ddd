// 탄도 — 실제 투사체 (히트스캔 아님). 순수 로직: three.js·DOM 없이 Node 헤드리스 시뮬에서도 같은 결과.
//  적분: 부분 단계 h ≤ ballistics.maxStep (프레임 dt 를 같은 크기로 나눔).
//        속도 = 공기 저항 dv/dt = -k|v|v 의 해 v/(1+k|v|h) (물속이면 k = water.drag, 큰 감속에도 안정) + 중력,
//        위치 = 이전·새 속도 평균 (사다리꼴) → 중력 낙차가 정확하고 프레임레이트와 거의 무관.
//  매 부분 단계 선분마다: 월드(BulletWorld.cast) · 사람 캡슐 → 선분 위에서 가장 먼저 일어나는 일부터 처리하고
//  탄이 계속 날아가면 그 지점에서 새 속도로 남은 시간을 다시 계산한다 (관통 굴절·도탄 뒤의 경로가 정확).
//   · partial (대나무·덩굴 벽·나무고사리 줄기·리아나): 속도 × U(배율), U(굴절각) 무작위 방향으로 꺾임
//   · 물 진입: 얕은 각이면 수면 도탄, 아니면 속도 × entrySpeedMul 후 물속 큰 감속 ('impact' 물보라)
//   · 잎 (bulletBlock 'none'): 지난 '빽빽한 잎'(국소 σ ≥ foliage.denseSigma) 적분 F → 확률 1-exp(-chancePerSigmaM·F) 로
//     U(0, maxDeflectDeg) 무작위 방향 빗나감. 한 탄의 잎 빗나감은 모두 합쳐 maxDeflectDeg 이내 ('0~1° 빗나갈 수 있음' —
//     코끼리풀 수십 m 를 지나도 여러 번이 쌓여 커지지 않음 → F7 이 최악의 잎 빗나감을 정확히 셀 수 있다)
//   · 바위(급경사 지형 포함)에 얕은 각으로 맞으면 도탄, 나머지 단단한 것은 멈춤
//   · 근접 통과/초음속 '딱': 사람의 머리·몸통 캡슐 '표면'까지 최단 거리를 (탄, 사람) 쌍마다 추적해
//     가장 가까운 지점을 지나간 순간 한 번 보낸다 (탄이 그 전에 멈추면 멈출 때).
//  이벤트 (모두 projectile, shooter 포함): 'hit' 'impact' 'partial' 'foliage' 'nearPass' 'flyby' 'end'
//
//  게임 루프 순서: CombatSystem.update(dt)(탄 이동) → 사수 갱신(발사). fire() 는 opts.timeOffset 만큼 탄을 바로 진행시켜
//  이번 프레임 끝 위치에 두므로, 같은 프레임에 update 를 한 번 더 부르면 한 프레임 앞서 간다.
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { DEG } from '../core/math.js';
import { RNG } from '../core/rng.js';
import { WATER_OBJECT } from './BulletWorld.js';
import { hitNormal } from './Hitboxes.js';
import { closestSegSeg, copy, deflect, dot, lerp3, normalize, pointSegDistSq, reflect, segCapsuleRaw, set, v3 } from './geom.js';

const INF = Infinity;
const UP = Object.freeze({ x: 0, y: 1, z: 0 });
const NO_TYPE = Object.freeze({});
const EMPTY = Object.freeze([]);
const MAX_EVENTS_PER_STEP = 8;   // 한 부분 단계 안에서 처리할 관통·도탄 최대 수 (병적인 경우 방지)
const START_AHEAD = 0.01;        // 탄은 발사 원점 바로 앞(1cm)에서 출발 — 원점이 표면에 딱 붙어 있어도 출발점에서 맞지 않게

export class Ballistics extends EventEmitter {
  /**
   * @param {object} world   BulletWorld 또는 createFlatWorld() — cast(a, b, out?, ignore?) 와 half
   * @param {object} people  People (list 의 Person: hitboxes, bounds) 또는 null
   * @param {{rng?: RNG}} opts
   */
  constructor(world, people, opts = {}) {
    super();
    this.world = world;
    this.people = people;
    this.rng = opts.rng ?? new RNG((Math.random() * 4294967296) >>> 0);
    /** 살아 있는 탄 목록 (예광탄 그리기 등은 pos·prev·vel 을 읽으면 된다) */
    this.projectiles = [];
    this._nextId = 1;
    // 작업용 벡터 (부분 단계마다 새 객체를 만들지 않음)
    this._a = v3(); this._b = v3(); this._c = v3(); this._e = v3(); this._d = v3(); this._d2 = v3();
    this._cs = { distSq: 0, s: 0, t: 0 };
    this._hp = null; this._hc = null;
  }

  /**
   * 발사.
   * @param {{ origin, dir, speed?, shooter?, weapon?, tracer?, collideWorldFrom?, noHit?: Set, timeOffset? }} opts
   * @param {(p) => void} [onSpawn]  탄을 만든 직후·진행시키기 전에 부름 (CombatSystem 'shot' 이 착탄보다 먼저 나가게)
   * @returns projectile { id, pos, vel, speed, time, dist, origin, shooter, weapon, tracer, alive, passed, prev, endReason, ricochets }
   */
  fire(opts, onSpawn = null) {
    const B = CONFIG.ballistics;
    const w = opts.weapon ?? CONFIG.weapons[CONFIG.weapons.default];
    const speed = opts.speed ?? w.muzzleVelocity;
    const d = normalize(v3(), opts.dir);
    const o = opts.origin;
    const p = {
      id: this._nextId++,
      pos: v3(o.x + d.x * START_AHEAD, o.y + d.y * START_AHEAD, o.z + d.z * START_AHEAD),
      vel: v3(d.x * speed, d.y * speed, d.z * speed),
      speed, time: speed > 0 ? START_AHEAD / speed : 0, dist: START_AHEAD,
      origin: v3(o.x, o.y, o.z),
      shooter: opts.shooter ?? null,
      weapon: w,
      tracer: !!opts.tracer,
      alive: true,
      passed: [],                 // 관통한 것 [{objectType, material}]
      prev: v3(o.x, o.y, o.z),    // 마지막 update 시작 위치 (예광 줄) — 처음엔 원점
      endReason: null,
      ricochets: 0,
      deflections: 0,             // 잎에 스쳐 빗나간 횟수 (디버그)
      foliage: 0,                 // 지나온 잎 적분 Σσ·ds (디버그)
      foliageDeflect: 0,          // 그중 빽빽한 잎(국소 σ ≥ foliage.denseSigma) 적분 — 빗나감 확률에 쓴 값 (디버그)
      _leafX: 0, _leafY: 0,       // 잎 빗나감 합 (rad, 진행 방향의 오른쪽·위) — 크기 ≤ maxDeflectDeg
      _k: w.dragK ?? 0,
      _from: Math.max(0, opts.collideWorldFrom ?? 0),
      _noHit: opts.noHit ?? null,
      _inWater: false,
      _near: null,
      _leafAcc: B.foliage.leafFxEvery,   // 빽빽한 잎에 처음 들어가면 바로 잎 효과
      _ignore: null,
      _spent: false,
    };
    this.projectiles.push(p);
    if (onSpawn) onSpawn(p);
    // 이번 프레임 안에서 실제로 쏜 시점부터 프레임 끝까지 미리 진행 (연사 간격이 프레임과 어긋나도 정확)
    const tOff = Math.min(Math.max(opts.timeOffset ?? 0, 0), 0.25);
    if (tOff > 0) {
      const n = Math.max(1, Math.ceil(tOff / B.maxStep - 1e-9));
      const h = tOff / n;
      for (let k = 0; k < n && p.alive; k++) this._step(p, h);
    }
    if (!p.alive) this._compact();
    return p;
  }

  update(dt) {
    if (!(dt > 0)) return;
    const n = Math.max(1, Math.ceil(dt / CONFIG.ballistics.maxStep - 1e-9));
    const h = dt / n;
    const list = this.projectiles;
    const count = list.length;   // 이벤트 처리 중에 새로 쏜 탄은 이번 update 에서 진행하지 않음
    for (let i = 0; i < count; i++) {
      const p = list[i];
      if (!p.alive) continue;
      copy(p.prev, p.pos);
      for (let k = 0; k < n && p.alive; k++) this._step(p, h);
    }
    this._compact();
  }

  /** 모든 탄 제거 (이벤트 없음) */
  clear() {
    for (const p of this.projectiles) p.alive = false;
    this.projectiles.length = 0;
  }

  // ---------------------------------------------------------------
  // 한 부분 단계
  // ---------------------------------------------------------------
  _step(p, h) {
    const B = CONFIG.ballistics;
    this._sweep(p, this._integrate(p, h));
    if (!p.alive) return;
    const half = this.world?.half ?? INF;
    if (Math.abs(p.pos.x) > half || Math.abs(p.pos.z) > half) this._end(p, 'out');
    else if (p.dist > B.maxRange) this._end(p, 'range');
    else if (p.time > B.maxTime) this._end(p, 'time');
    else if (p._spent || p.speed < B.minSpeed) this._end(p, 'spent');
  }

  /**
   * 속도를 h 초 적분하고 그동안의 끝점을 this._b 에 둔다 (위치 = 사다리꼴).
   * 저항만으로 최소 속도 아래로 떨어지면 그 순간까지만 적분 (1/v = 1/v0 + k·t) — 물속 정지 거리가 정확하게.
   * @returns 실제로 적분한 시간
   */
  _integrate(p, h) {
    const B = CONFIG.ballistics;
    const v = p.vel;
    const k = p._inWater ? B.water.drag : p._k;
    const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    let f = 1 / (1 + k * sp * h);
    if (k > 0 && sp > B.minSpeed && sp * f < B.minSpeed) {
      h = Math.max(0, Math.min(h, (1 / B.minSpeed - 1 / sp) / k));
      f = 1 / (1 + k * sp * h);
      p._spent = true;
    }
    const nvx = v.x * f, nvy = v.y * f - B.gravity * h, nvz = v.z * f;
    set(this._b, p.pos.x + (v.x + nvx) * 0.5 * h, p.pos.y + (v.y + nvy) * 0.5 * h, p.pos.z + (v.z + nvz) * 0.5 * h);
    v.x = nvx; v.y = nvy; v.z = nvz;
    p.speed = Math.sqrt(nvx * nvx + nvy * nvy + nvz * nvz);
    return h;
  }

  /** 현재 위치 → this._b (_integrate 결과) 를 span 초 동안 이동. 선분 위 사건을 순서대로 처리 */
  _sweep(p, span) {
    const from = this._a, to = this._b;
    copy(from, p.pos);
    for (let iter = 0; iter < MAX_EVENTS_PER_STEP && p.alive; iter++) {
      const sx = to.x - from.x, sy = to.y - from.y, sz = to.z - from.z;
      const segLen = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (segLen < 1e-9) { p.time += span; break; }

      // 월드 (collideWorldFrom 이전 구간은 건너뜀 — 먼 가상 사수의 탄이 숲에 다 막히지 않게).
      // 충돌이 켜지는 지점이 땅속이면(사수와 사이의 언덕을 직선이 '관통') 땅 위로 나올 때까지 미룬다
      let cast = null, u0 = 0;
      if (this.world && p.dist + segLen > p._from) {
        if (p.dist < p._from) u0 = (p._from - p.dist) / segLen;
        const cs = lerp3(this._c, from, to, u0);
        if (u0 > 0 && this.world.isInsideSolid && this.world.isInsideSolid(cs)) p._from = p.dist + segLen + 1e-6;
        else cast = this.world.cast(cs, to, undefined, p._ignore);
      }
      p._ignore = null;
      const uStop = cast && cast.hit ? u0 + cast.t * (1 - u0) : INF;
      const part = cast && cast.partials.length ? cast.partials[0] : null;
      const uPart = part ? u0 + part.t * (1 - u0) : INF;
      const uPerson = this._personHit(p, from, sx, sy, sz);
      const uEvt = Math.min(uStop, uPart, uPerson);
      const uEnd = uEvt === INF ? 1 : uEvt;

      // 근접 통과 (사건 지점까지) — 이 선분에서 맞을 사람은 '근접 통과'가 아니다
      this._nearPasses(p, from, to, uEnd, span, uEvt === uPerson && uEvt < INF ? this._hp : null);

      // 잎 (월드 구간)
      if (cast && cast.foliage > 0) {
        let F = cast.foliage, dense = cast.foliageDense, Fd = cast.foliageDeflect ?? 0;
        if (uEvt === INF) { /* 선분 전체 */ } else if (uEvt === uPart) { F = part.foliage; dense = part.foliageDense; Fd = part.foliageDeflect ?? 0; } else if (uEvt === uPerson) {
          const full = (uStop < INF ? uStop : 1) - u0;
          const frac = full > 1e-9 ? Math.max(0, uEnd - u0) / full : 0;
          F *= frac; dense *= frac; Fd *= frac;
        }
        if (F > 0) {
          let fp = cast.foliagePoint;
          // 사건 지점 뒤의 잎이면 지나온 구간 가운데로 (효과 위치만)
          if (fp && uEvt < INF && ((fp.x - from.x) * sx + (fp.y - from.y) * sy + (fp.z - from.z) * sz) / (segLen * segLen) > uEnd) fp = lerp3(this._e, from, to, (u0 + uEnd) * 0.5);
          this._foliage(p, F, dense, Fd, fp);
        }
      }

      // 사건 지점까지 이동
      lerp3(p.pos, from, to, uEnd);
      p.dist += segLen * uEnd;
      p.time += span * uEnd;
      if (uEvt === INF) {
        p._inWater = cast ? cast.endInWater : false;
        break;
      }
      const rest = span * (1 - uEnd);
      if (uEvt === uPerson) { this._hitPerson(p); break; }
      if (uEvt === uPart) this._partial(p, part);
      else this._impact(p, cast);
      if (!p.alive) break;
      // 남은 시간은 새 속도로 다시 적분 (관통·도탄·물 진입 지점에서 출발 — 물속이면 물 저항)
      copy(from, p.pos);
      p._spent = false;
      span = this._integrate(p, rest);
    }
  }

  /** 선분(from + s·d)과 사람 캡슐의 첫 교차 비율 (사수·noHit 제외), 없으면 Infinity. 맞은 사람·캡슐은 _hp/_hc */
  _personHit(p, from, sx, sy, sz) {
    const list = this.people ? this.people.list : EMPTY;
    let best = INF;
    this._hp = null; this._hc = null;
    const e = this._e;
    set(e, from.x + sx, from.y + sy, from.z + sz);
    for (let i = 0; i < list.length; i++) {
      const person = list[i];
      if (person === p.shooter || (p._noHit && p._noHit.has(person))) continue;
      const b = person.bounds;
      if (b.radius < 0) continue;
      if (pointSegDistSq(b.center, from, e) > b.radius * b.radius) continue;
      const caps = person.hitboxes;
      for (let k = 0; k < caps.length; k++) {
        const c = caps[k];
        const t = segCapsuleRaw(from.x, from.y, from.z, sx, sy, sz, c.a.x, c.a.y, c.a.z, c.b.x, c.b.y, c.b.z, c.r);
        if (t >= 0 && t < best) { best = t; this._hp = person; this._hc = c; }
      }
    }
    return best;
  }

  /** (탄, 사람) 쌍마다 머리·몸통 캡슐 표면까지 최단 거리 추적 → 가장 가까운 지점을 지나면 'nearPass'·'flyby' */
  _nearPasses(p, from, to, uEnd, span, skip) {
    const list = this.people ? this.people.list : EMPTY;
    if (!list.length) return;
    const B = CONFIG.ballistics;
    const R = Math.max(B.nearPassRadius, B.crackRadius);
    const end = lerp3(this._e, from, to, uEnd);
    const ex = end.x - from.x, ey = end.y - from.y, ez = end.z - from.z;
    const len = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (len < 1e-9) return;
    const cs = this._cs;
    for (let i = 0; i < list.length; i++) {
      const person = list[i];
      if (person === p.shooter || person === skip) continue;
      let st = p._near ? p._near.get(person) : undefined;
      if (st && st.done) continue;
      const b = person.bounds;
      if (b.radius < 0) continue;
      if (!st && Math.sqrt(pointSegDistSq(b.center, from, end)) - b.radius > R) continue;
      let best = INF, bestS = 0;
      const caps = person.hitboxes;
      for (let k = 0; k < caps.length; k++) {
        const c = caps[k];
        if (!c.near) continue;
        closestSegSeg(from, end, c.a, c.b, cs);
        const d = Math.sqrt(cs.distSq) - c.r;
        if (d < best) { best = d; bestS = cs.s; }
      }
      if (best === INF) continue;
      if (best < 0) best = 0;
      if (!st) {
        st = { min: INF, point: v3(), dir: v3(), speed: 0, time: 0, done: false };
        (p._near || (p._near = new Map())).set(person, st);
      }
      if (best < st.min) {
        st.min = best;
        lerp3(st.point, from, end, bestS);
        set(st.dir, ex / len, ey / len, ez / len);
        st.speed = p.speed;
        st.time = p.time + span * uEnd * bestS;
      }
      // 가장 가까운 점이 선분 안쪽 = 이미 지나감 (끝점이면 아직 다가오는 중)
      if (bestS < 1 - 1e-9) this._finishNear(p, person, st);
    }
  }

  _finishNear(p, person, st) {
    st.done = true;
    const B = CONFIG.ballistics;
    if (st.min <= B.nearPassRadius) {
      this.emit('nearPass', { projectile: p, shooter: p.shooter, person, distance: st.min, point: { ...st.point }, dir: { ...st.dir }, speed: st.speed, time: st.time });
    }
    if (st.min <= B.crackRadius && st.speed > B.speedOfSound) {
      this.emit('flyby', { projectile: p, shooter: p.shooter, person, distance: st.min, point: { ...st.point }, dir: { ...st.dir }, speed: st.speed, time: st.time });
    }
  }

  // ---------------------------------------------------------------
  // 사건 처리
  // ---------------------------------------------------------------
  _hitPerson(p) {
    const person = this._hp, cap = this._hc;
    const point = { ...p.pos };
    const normal = hitNormal(cap, point, v3());
    const dir = normalize(v3(), p.vel);
    const incidenceDeg = Math.acos(Math.min(1, Math.abs(dot(dir, normal)))) / DEG;
    const st = p._near ? p._near.get(person) : undefined;
    if (st) st.done = true; else (p._near || (p._near = new Map())).set(person, { min: 0, done: true });
    const o = p.origin;
    this.emit('hit', {
      projectile: p, shooter: p.shooter, person, part: cap.part, point, normal, dir, speed: p.speed, incidenceDeg,
      distance: Math.hypot(point.x - o.x, point.y - o.y, point.z - o.z), timeOfFlight: p.time,
      penetrated: p.passed.map((e) => e.objectType), ricochets: p.ricochets,
    });
    this._end(p, 'stopped');
  }

  _partial(p, e) {
    if (e.objectType === 'water') { this._water(p); return; }
    const B = CONFIG.ballistics;
    const T = B.partialByType[e.objectType] || NO_TYPE;
    const sm = T.speedMul || B.partial.speedMul, dd = T.deflectDeg || B.partial.deflectDeg;
    const mul = this.rng.range(sm[0], sm[1]);
    const ang = this.rng.range(dd[0], dd[1]);
    const inDir = normalize(v3(), p.vel);
    const d = deflect(inDir, ang * DEG, this.rng.range(0, Math.PI * 2), this._d);
    const before = p.speed, after = before * mul;
    set(p.vel, d.x * after, d.y * after, d.z * after);
    p.speed = after;
    p.passed.push({ objectType: e.objectType, material: e.material });
    p._ignore = e.object;   // 다시 출발할 때 같은 물체에 또 들어가지 않게
    this.emit('partial', {
      projectile: p, shooter: p.shooter, point: { ...p.pos }, normal: { ...e.normal }, material: e.material, objectType: e.objectType,
      dir: inDir, speedBefore: before, speedAfter: after, deflectDeg: ang,
    });
    if (after < B.minSpeed) this._end(p, 'spent');
  }

  _water(p) {
    const B = CONFIG.ballistics, W = B.water;
    const inDir = normalize(v3(), p.vel);
    const graze = Math.asin(Math.min(1, Math.abs(inDir.y))) / DEG;
    const before = p.speed;
    const ricochet = graze < W.ricochetDeg;
    this.emit('impact', {
      projectile: p, shooter: p.shooter, point: { ...p.pos }, normal: { x: 0, y: 1, z: 0 }, material: 'water', objectType: 'water',
      dir: inDir, speed: before, ricochet, underwater: false,
    });
    if (ricochet) {
      // 수면에서 튕김: 반사 + 약간 흩어짐, 계속 위로 (다시 수면에 박히지 않게)
      const d = reflect(this._d, inDir, UP);
      deflect(d, this.rng.range(0, W.ricochetScatterDeg ?? 3) * DEG, this.rng.range(0, Math.PI * 2), d);
      if (d.y < 0.02) { d.y = 0.02; normalize(d, d); }
      const after = before * W.ricochetSpeedMul;
      set(p.vel, d.x * after, d.y * after, d.z * after);
      p.speed = after;
      p.ricochets++;
      p.pos.y += 0.001;
    } else {
      const after = before * W.entrySpeedMul;
      p.vel.x *= W.entrySpeedMul; p.vel.y *= W.entrySpeedMul; p.vel.z *= W.entrySpeedMul;
      p.speed = after;
      p._inWater = true;
      p._ignore = WATER_OBJECT;
      p.passed.push({ objectType: 'water', material: 'water' });
    }
    if (p.speed < B.minSpeed) this._end(p, 'spent');
  }

  _impact(p, cast) {
    const B = CONFIG.ballistics, R = B.ricochet;
    const n = cast.normal;
    const inDir = normalize(v3(), p.vel);
    const ricochet = cast.material === 'rock' && Math.asin(Math.min(1, Math.abs(dot(inDir, n)))) / DEG < R.rockDeg;
    this.emit('impact', {
      projectile: p, shooter: p.shooter, point: { ...p.pos }, normal: { x: n.x, y: n.y, z: n.z }, material: cast.material,
      objectType: cast.objectType, dir: inDir, speed: p.speed, ricochet, underwater: !!cast.underwater,
    });
    if (!ricochet) { this._end(p, 'stopped'); return; }
    // 도탄: 반사 + 무작위 흩어짐, 면에서 벗어나는 쪽 유지
    const d = reflect(this._d, inDir, n);
    deflect(d, this.rng.range(0, R.scatterDeg) * DEG, this.rng.range(0, Math.PI * 2), d);
    const dn = dot(d, n);
    if (dn < 0.02) { d.x += n.x * (0.02 - dn); d.y += n.y * (0.02 - dn); d.z += n.z * (0.02 - dn); normalize(d, d); }
    const after = p.speed * R.speedMul;
    set(p.vel, d.x * after, d.y * after, d.z * after);
    p.speed = after;
    p.ricochets++;
    p.pos.x += n.x * 0.001; p.pos.y += n.y * 0.001; p.pos.z += n.z * 0.001;
    p._ignore = cast.objectType === 'terrain' ? null : cast.object;
    if (after < B.minSpeed) this._end(p, 'spent');
  }

  /** 잎 적분 F (그중 빽빽한 잎 Fd) 만큼 지남: 빗나감 확률 (빽빽한 잎만), 잎 효과 이벤트 (dense = 우거진 잎 속 길이 m) */
  _foliage(p, F, dense, Fd, point) {
    const FO = CONFIG.ballistics.foliage;
    p.foliage += F;
    if (Fd > 0) {
      p.foliageDeflect += Fd;
      if (this.rng.chance(1 - Math.exp(-FO.chancePerSigmaM * Fd))) this._leafDeflect(p, FO.maxDeflectDeg * DEG);
    }
    if (dense > 0 && point) {
      p._leafAcc += dense;
      if (p._leafAcc >= FO.leafFxEvery) {
        p._leafAcc = Math.min(p._leafAcc - FO.leafFxEvery, FO.leafFxEvery * 0.5);
        this.emit('foliage', { projectile: p, shooter: p.shooter, point: { ...point }, dir: normalize(v3(), p.vel) });
      }
    }
  }

  /**
   * 잎 빗나감 한 번: U(0, max) 를 무작위 방향으로 더하되, 이 탄의 잎 빗나감 합(진행 방향 기준 오른쪽·위 각)은 반경 max 원 안으로.
   * 여러 번 빗나가도 처음 방향에서 max 이상 벗어나지 않는다 (작은 각이라 합 = 회전 합).
   */
  _leafDeflect(p, max) {
    const a = this.rng.range(0, max), az = this.rng.range(0, Math.PI * 2);
    let x = p._leafX + a * Math.cos(az), y = p._leafY + a * Math.sin(az);
    const l = Math.hypot(x, y);
    if (l > max) { x *= max / l; y *= max / l; }
    const ex = x - p._leafX, ey = y - p._leafY;
    const step = Math.hypot(ex, ey);
    p._leafX = x; p._leafY = y;
    p.deflections++;
    if (step < 1e-12) return;
    const sp = p.speed;
    const d = deflect(normalize(this._d2, p.vel), step, Math.atan2(ey, ex), this._d2);
    set(p.vel, d.x * sp, d.y * sp, d.z * sp);
  }

  _end(p, reason) {
    if (!p.alive) return;
    p.alive = false;
    p.endReason = reason;
    // 다가오다 멈춘 탄도 가까이 왔다면 근접 통과 (멈춘 곳이 가장 가까운 점)
    if (p._near) {
      const B = CONFIG.ballistics;
      for (const [person, st] of p._near) if (!st.done && st.min <= Math.max(B.nearPassRadius, B.crackRadius)) this._finishNear(p, person, st);
    }
    this.emit('end', { projectile: p, shooter: p.shooter, reason, point: { ...p.pos } });
  }

  _compact() {
    const list = this.projectiles;
    let j = 0;
    for (let i = 0; i < list.length; i++) if (list[i].alive) list[j++] = list[i];
    list.length = j;
  }

  // ---------------------------------------------------------------
  // 정적 도우미 (같은 적분식 — 실제 탄과 결과가 같다)
  // ---------------------------------------------------------------
  /** 조준선(총열 위 sightHeight)을 zeroRange 에서 다시 지나도록 총열이 조준선보다 들린 각 (rad) */
  static computeZeroAngle(weaponData) {
    const R = weaponData.zeroRange, sh = weaponData.sightHeight;
    let th = Math.atan2(sh, R);
    for (let i = 0; i < 12; i++) {
      const f = flight(weaponData, R, th);
      if (!f.reached) break;
      const err = f.y - sh;     // 총열 기준 높이 - 조준선 높이
      if (Math.abs(err) < 1e-7) break;
      const c = Math.cos(th);
      th -= (err * c * c) / R;  // dy/dθ ≈ R / cos²θ
    }
    return th;
  }

  /**
   * 평지 직사 확인용: 수평에서 angle(rad) 들어 쏴서 수평 거리 range 까지.
   * @returns {{tof, drop, speed, height, reached}} drop = 총열 연장선 아래로 떨어진 높이 (m), height = 총구 기준 높이
   */
  static simulate(weaponData, range, angle = 0) {
    const f = flight(weaponData, range, angle);
    return { tof: f.t, drop: range * Math.tan(angle) - f.y, speed: f.speed, height: f.y, reached: f.reached };
  }

  /** 수평 거리 distance, 높이 차 heightDiff(목표 - 총구) 를 맞히는 발사 앙각 (rad, 수평 기준) — F7 가상 사수용 */
  static solveElevation(weaponData, distance, heightDiff) {
    if (!(distance > 0)) return heightDiff >= 0 ? Math.PI / 2 : -Math.PI / 2;
    let th = Math.atan2(heightDiff, distance);
    for (let i = 0; i < 12; i++) {
      const f = flight(weaponData, distance, th);
      if (!f.reached) break;
      const err = heightDiff - f.y;
      if (Math.abs(err) < 1e-6) break;
      const c = Math.cos(th);
      th += (err * c * c) / distance;
    }
    return th;
  }
}

// 2D 탄도 적분 (수평 x, 수직 y) — Ballistics._step 과 같은 식, 간격 maxStep
const FL = { t: 0, y: 0, speed: 0, reached: false };
function flight(w, X, theta) {
  const B = CONFIG.ballistics;
  const h = B.maxStep, g = B.gravity, k = w.dragK ?? 0;
  const v0 = w.muzzleVelocity;
  let vx = v0 * Math.cos(theta), vy = v0 * Math.sin(theta);
  let x = 0, y = 0, t = 0;
  FL.reached = false;
  if (!(X > 0)) { FL.t = 0; FL.y = 0; FL.speed = v0; FL.reached = true; return FL; }
  while (t < B.maxTime) {
    const sp = Math.sqrt(vx * vx + vy * vy);
    if (sp < B.minSpeed || vx <= 0) break;
    const f = 1 / (1 + k * sp * h);
    const nvx = vx * f, nvy = vy * f - g * h;
    const nx = x + (vx + nvx) * 0.5 * h, ny = y + (vy + nvy) * 0.5 * h;
    if (nx >= X) {
      const a = (X - x) / (nx - x);
      FL.t = t + h * a;
      FL.y = y + (ny - y) * a;
      FL.speed = sp + (Math.sqrt(nvx * nvx + nvy * nvy) - sp) * a;
      FL.reached = true;
      return FL;
    }
    x = nx; y = ny; vx = nvx; vy = nvy; t += h;
  }
  FL.t = t; FL.y = y; FL.speed = Math.sqrt(vx * vx + vy * vy);
  return FL;
}
