// =====================================================================
//  Traps — 6단계 부비트랩·지뢰 (순수 로직: three.js·DOM 없음 → Node 테스트 가능)
//   종류 (CONFIG.traps):
//    · tripwire  인계철선 폭발물 — 발목 높이 철선(a→b)을 몸이 가로지르면 '딸깍' 뒤 fuse(1초) 초에 길가 말뚝 폭약이 터짐
//    · spikePit  꼬챙이 구덩이 — 낙엽으로 덮인 반경 r 원에 들어서면 빠짐: 하퇴 부상(3단계) + stuck(4초) 동안 못 움직임
//    · mine      매설 지뢰 — 반경 r 원을 밟으면 즉시 폭발: 밟은 다리 대퇴 중상(동맥 60%) + 둘레 파편
//   폭발은 CombatSystem.explode — 섬광·소리·소음·거리별 제압·파편(저속 탄 규칙으로 부위별 상처)
//   적(faction 'enemy')은 자기 편 함정 자리를 안다: 터뜨리지 않고 (철선은 조심히 넘음), 지뢰·구덩이는 hazards() 로 길찾기·조향에서 비켜 간다.
//   플레이어 발견: update(dt, {observer}) — radius(3m) 안 함정을 걸음걸이·시선·단서·빛·비에 따라 확률로 알아챔 (trap.known)
//   탐침 probe(): 앞 1m 땅을 찔러 지뢰·구덩이 확인 · 해제 disarm(): 알아챈 인계철선 (실패 10% = 폭발)
//  이벤트: 'trip' {trap, person} (철선 걸림 — 딸깍) · 'explode' {trap, point, victim, result} · 'pit' {trap, person, wound}
//          'pitExit' {trap, person} · 'known' {trap, how: 'sight'|'probe'|'trigger'} · 'disarmed' {trap} · 'probe' {found, trap}
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { RNG } from '../core/rng.js';

const DEG = Math.PI / 180;
const CLUE = { tripwire: 'wire', spikePit: 'leaves', mine: 'dirt' };

/** 점 (px,pz) 에서 선분 (ax,az)→(bx,bz) 까지 거리² */
export function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t - px, cz = az + dz * t - pz;
  return cx * cx + cz * cz;
}

/** 두 선분 (p0→p1), (q0→q1) 이 교차하나 (2D) */
export function segCross(p0x, p0z, p1x, p1z, q0x, q0z, q1x, q1z) {
  const rx = p1x - p0x, rz = p1z - p0z, sx = q1x - q0x, sz = q1z - q0z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return false;
  const qpx = q0x - p0x, qpz = q0z - p0z;
  const t = (qpx * sz - qpz * sx) / den, u = (qpx * rz - qpz * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** 함정 하나 만들기 (MissionGen 계획 → 실제 상태). def: { kind, x, z, yaw, len?, site, marker? } */
export function makeTrap(def, id, query = null) {
  const T = CONFIG.traps;
  const t = {
    id, kind: def.kind, site: def.site ?? 'trail', x: def.x, z: def.z, yaw: def.yaw ?? 0,
    y: query ? query.getTerrainHeight(def.x, def.z) : 0,
    r: def.kind === 'mine' ? T.mine.radius : def.kind === 'spikePit' ? T.spikePit.radius : 0,
    faction: def.faction ?? 'enemy', clue: CLUE[def.kind], marker: def.marker ? { ...def.marker } : null,
    state: 'armed', fuse: 0, known: false, knownHow: null, knownAt: -Infinity, victim: null, seed: def.seed ?? id * 7919,
  };
  if (t.kind === 'tripwire') {
    // 철선 방향 = yaw (yaw 0 = −Z 쪽) — 오솔길을 가로지름. 폭약은 a 쪽 말뚝 옆
    const len = def.len ?? (T.tripwire.length[0] + T.tripwire.length[1]) / 2;
    const ux = -Math.sin(t.yaw), uz = -Math.cos(t.yaw);
    t.len = len;
    t.a = { x: t.x - ux * len / 2, z: t.z - uz * len / 2 };
    t.b = { x: t.x + ux * len / 2, z: t.z + uz * len / 2 };
    const ay = query ? query.getTerrainHeight(t.a.x, t.a.z) : 0;
    t.charge = { x: t.a.x - ux * 0.15, y: ay + T.tripwire.chargeHeight, z: t.a.z - uz * 0.15 };
  }
  return t;
}

export class TrapField extends EventEmitter {
  /** @param {{ query?, combat?, noise?, rng? }} opts */
  constructor(opts = {}) {
    super();
    this.query = opts.query ?? null;
    this.combat = opts.combat ?? null;
    this.noise = opts.noise ?? null;
    this.rng = opts.rng ?? new RNG((Math.random() * 4294967296) >>> 0);
    this.list = [];
    this.time = 0;
    this._prev = new Map();     // person → {x, z}
    this._stuck = [];           // { person, motor, trap, left }
    this._tick = 0;
    this._ver = 0;              // 상태가 바뀔 때마다 (화면이 다시 그림)
    this.stats = { triggered: 0, exploded: 0, known: 0, byEnemy: 0 };
  }

  /** 임무 계획 (m.traps) 으로 채움 */
  load(defs = []) {
    this.clear();
    defs.forEach((d, i) => this.list.push(makeTrap(d, i + 1, this.query)));
    this._ver++;
  }

  clear() {
    for (const s of this._stuck) s.motor?.clearRestriction?.('trapPit');
    this.list.length = 0;
    this._prev.clear();
    this._stuck.length = 0;
    this.stats = { triggered: 0, exploded: 0, known: 0, byEnemy: 0 };
    this._ver++;
  }

  get version() { return this._ver; }

  /** 아직 터지지 않은 함정 */
  get armed() { return this.list.filter((t) => t.state === 'armed'); }

  /** 적이 비켜 갈 자리 (지뢰·구덩이 — 철선은 넘어 다님): [{x, z, r}] */
  hazards(faction = 'enemy') {
    const out = [];
    for (const t of this.list) {
      if (t.faction !== faction || t.kind === 'tripwire') continue;
      if (t.state === 'armed' || (t.kind === 'spikePit' && t.state === 'sprung')) out.push({ x: t.x, z: t.z, r: t.r, kind: t.kind, id: t.id });
    }
    return out;
  }

  /** 점 근처 함정 (반경 r) */
  near(x, z, r) {
    const out = [];
    for (const t of this.list) {
      const d = this.distanceTo(t, x, z);
      if (d <= r) out.push({ trap: t, distance: d });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }

  /** 함정까지 수평 거리 (철선은 선분까지) */
  distanceTo(t, x, z) {
    if (t.kind === 'tripwire') return Math.sqrt(segDist2(x, z, t.a.x, t.a.z, t.b.x, t.b.z));
    return Math.hypot(t.x - x, t.z - z);
  }

  // =================================================================
  // 프레임
  // =================================================================
  /**
   * @param {number} dt
   * @param {{ observer?: { motor, person?, eye?:{x,y,z}, fwd?:{x,y,z}, light?: (x,y,z)=>number }, rain?: number, wetness?: number }} ctx
   */
  update(dt, ctx = {}) {
    if (!(dt > 0)) return;
    this.time += dt;
    // 철선 지연
    for (const t of this.list) {
      if (t.state !== 'fuse') continue;
      t.fuse -= dt;
      if (t.fuse <= 0) this._explode(t, t.victim, null);
    }
    // 구덩이에서 빠져나옴
    for (let i = this._stuck.length - 1; i >= 0; i--) {
      const s = this._stuck[i];
      s.left -= dt;
      if (s.left <= 0 || s.person?.injuries?.dead) {
        s.motor?.clearRestriction?.('trapPit');
        this._stuck.splice(i, 1);
        this.emit('pitExit', { trap: s.trap, person: s.person });
      }
    }
    // 밟음·걸림
    if (this.combat && this.list.length) {
      const people = this.combat.people.list;
      for (let i = 0; i < people.length; i++) this._checkPerson(people[i]);
    }
    // 플레이어 발견
    const obs = ctx.observer;
    if (obs && obs.motor && this.list.length) {
      this._tick -= dt;
      if (this._tick <= 0) {
        const step = CONFIG.traps.detect.tick;
        this._tick += step;
        if (this._tick < 0) this._tick = step;
        this.detectStep(step, obs, ctx);
      }
    }
  }

  _checkPerson(person) {
    const m = person.noiseSource;
    if (!m || !m.position) return;
    const p = m.position;
    let prev = this._prev.get(person);
    if (!prev) { this._prev.set(person, { x: p.x, z: p.z }); return; }
    const px = prev.x, pz = prev.z;
    prev.x = p.x; prev.z = p.z;
    const mx = p.x - px, mz = p.z - pz;
    if (mx * mx + mz * mz < 1e-8) return;
    if (person.injuries?.dead) return;
    // 같은 편 함정은 안다 (철선은 조심히 넘고, 지뢰·구덩이는 비켜 감 — 조향이 실패해 들어서도 밟지 않게 발을 옮김)
    const faction = person.faction ?? (person.isPlayer ? 'player' : 'neutral');
    // 7단계: 아군 분대원은 알아챈 철선을 조심히 넘는다 (뛰고 있지 않으면)
    const carefulAI = !person.isPlayer && faction === 'friend' && m.gait !== 'sprint';
    for (const t of this.list) {
      if (t.state !== 'armed') continue;
      if (t.faction === faction) continue;
      if (carefulAI && t.known && t.kind === 'tripwire') continue;
      // 빠른 거르기
      const reach = t.kind === 'tripwire' ? t.len / 2 + 1 : t.r + 1;
      if (Math.abs(p.x - t.x) > reach + Math.abs(mx) || Math.abs(p.z - t.z) > reach + Math.abs(mz)) continue;
      if (t.kind === 'tripwire') {
        if (m.grounded === false && (m.position.y - (this.query ? this.query.getSupportHeight(p.x, p.z) : m.position.y)) > CONFIG.traps.tripwire.height + 0.15) continue;
        if (segCross(px, pz, p.x, p.z, t.a.x, t.a.z, t.b.x, t.b.z)) this.trigger(t, person, 'step');
      } else if (segDist2(t.x, t.z, px, pz, p.x, p.z) <= t.r * t.r) {
        // 디딘 다리: 움직이는 방향의 어느 쪽에 함정이 있나 (오른쪽 = R)
        const side = (mx * (t.z - pz) - mz * (t.x - px)) > 0 ? 'R' : 'L';
        this.trigger(t, person, 'step', side);
      }
    }
  }

  /**
   * 발동. how: 'step' | 'disarm' | 'debug'. leg: 'L'|'R' (구덩이·지뢰를 디딘 다리)
   */
  trigger(t, person = null, how = 'step', leg = null) {
    if (t.state !== 'armed') return null;
    const T = CONFIG.traps;
    this.stats.triggered++;
    if (person && person.faction === 'enemy') this.stats.byEnemy++;
    t.victim = person;
    t.triggeredHow = how;
    t.triggeredAt = this.time;
    if (!t.known) this._know(t, 'trigger');
    this._ver++;
    leg = leg ?? (this.rng.chance(0.5) ? 'L' : 'R');
    if (t.kind === 'tripwire') {
      t.state = 'fuse';
      t.fuse = T.tripwire.fuse;
      this.emit('trip', { trap: t, person });
      if (this.noise && person?.noiseSource) this.noise.emitNoise({ x: t.x, y: t.y + 0.2, z: t.z }, 6, 'trap', person.noiseSource, { trap: t });
      return { kind: 'tripwire', fuse: t.fuse };
    }
    if (t.kind === 'spikePit') {
      t.state = 'sprung';
      const inj = person?.injuries;
      const wound = inj ? inj.applyHit({ part: `shin${leg}`, point: null, dir: null, retained: 1, trap: t, person }, {}) : null;
      const m = person?.noiseSource;
      if (m && m.setRestriction) {
        m.setRestriction('trapPit', { maxSpeedMultiplier: 0, canSprint: false, canJump: false });
        if (m.position) { m.position.x = t.x; m.position.z = t.z; }
        if (m.velocity) { m.velocity.x = 0; m.velocity.z = 0; }
        this._stuck.push({ person, motor: m, trap: t, left: T.spikePit.stuck });
        const pv = this._prev.get(person);
        if (pv) { pv.x = t.x; pv.z = t.z; }
      }
      if (this.noise && m) this.noise.emitNoise({ x: t.x, y: t.y, z: t.z }, 22, 'trap', m, { trap: t });
      this.emit('pit', { trap: t, person, wound, leg });
      return { kind: 'spikePit', wound };
    }
    // 지뢰: 밟은 다리 대퇴 중상 + 파편 (밟은 사람은 파편 대신)
    return this._explode(t, person, leg);
  }

  /** 지금 갇힌 사람이면 남은 시간 (s), 아니면 0 */
  stuckLeft(person) {
    const s = this._stuck.find((x) => x.person === person);
    return s ? s.left : 0;
  }

  _explode(t, victim = null, leg = null) {
    const T = CONFIG.traps;
    t.state = 'exploded';
    this.stats.exploded++;
    this._ver++;
    const spec = t.kind === 'mine' ? T.mine : T.tripwire;
    const point = t.kind === 'tripwire' ? { ...t.charge } : { x: t.x, y: t.y + 0.05, z: t.z };
    let wound = null;
    const noHit = new Set();
    if (t.kind === 'mine' && victim) {
      noHit.add(victim);
      const inj = victim.injuries;
      if (inj) wound = inj.applyHit({ part: `thigh${leg ?? 'R'}`, point: null, dir: null, retained: 1, trap: t, person: victim }, { forceArterial: this.rng.chance(T.mine.arterial) });
    }
    const result = this.combat ? this.combat.explode(point, {
      fragments: spec.fragments, speed: spec.speed, elev: spec.elev, noHit, kind: t.kind, trap: t,
      source: victim?.noiseSource ?? null, victim,
    }) : null;
    this.emit('explode', { trap: t, point, victim, wound, leg, result });
    return { kind: t.kind, wound, result };
  }

  // =================================================================
  // 플레이어: 발견 · 탐침 · 해제
  // =================================================================
  /**
   * 함정 하나를 이번 dt 동안 알아챌 비율 (/s). obs: { motor, eye, fwd, light }, env: { rain, wetness }
   * 순수 계산 (상태를 바꾸지 않음) — 테스트가 직접 부른다.
   */
  detectRate(t, obs, env = {}) {
    const D = CONFIG.traps.detect;
    const m = obs.motor, p = m.position;
    const d = this.distanceTo(t, p.x, p.z);
    if (d > D.radius) return 0;
    const gait = m.gait && m.speed > 0.15 ? m.gait : 'idle';
    let rate = D.rate[gait] ?? D.rate.walk;
    rate *= Math.max(0, 1 - d / D.radius);
    // 시선: 카메라 정면과 함정 사이 각
    const eye = obs.eye ?? { x: p.x, y: p.y + (m.eyeHeight ?? 1.6), z: p.z };
    const fwd = obs.fwd ?? { x: -Math.sin(m.yaw), y: -0.35, z: -Math.cos(m.yaw) };
    let tx = t.x, tz = t.z;
    if (t.kind === 'tripwire') {
      // 철선에서 가장 가까운 점
      const dx = t.b.x - t.a.x, dz = t.b.z - t.a.z, l2 = dx * dx + dz * dz;
      let u = l2 > 0 ? ((p.x - t.a.x) * dx + (p.z - t.a.z) * dz) / l2 : 0;
      u = Math.max(0, Math.min(1, u));
      tx = t.a.x + dx * u; tz = t.a.z + dz * u;
    }
    const ty = (this.query ? this.query.getTerrainHeight(tx, tz) : t.y) + (t.kind === 'tripwire' ? CONFIG.traps.tripwire.height : 0.03);
    const vx = tx - eye.x, vy = ty - eye.y, vz = tz - eye.z, vl = Math.hypot(vx, vy, vz) || 1;
    const fl = Math.hypot(fwd.x, fwd.y, fwd.z) || 1;
    const ang = Math.acos(Math.max(-1, Math.min(1, (vx * fwd.x + vy * fwd.y + vz * fwd.z) / (vl * fl)))) / DEG;
    const view = ang <= D.centerDeg ? 1 : ang <= D.edgeDeg ? D.edgeMul : D.outMul;
    rate *= view;
    // 단서
    rate *= D.clue[t.clue] ?? 1;
    if (t.marker && Math.hypot(t.marker.x - p.x, t.marker.z - p.z) < D.markerRange) rate *= D.marker;
    // 빛 (밤엔 거의 못 봄) — 가까이서 빛을 받은 철선은 반짝임
    const light = obs.light ? Math.max(0, Math.min(1, obs.light(tx, ty, tz))) : 1;
    rate *= D.darkMul + (1 - D.darkMul) * light;
    if (t.kind === 'tripwire') {
      if (d < D.glintRange && light >= D.glintLight) rate *= D.glint;
      if ((env.wetness ?? 0) > 0.4 || (env.rain ?? 0) > 0.2) rate *= D.rainWire;
    }
    return rate;
  }

  /** 발견 한 번 (tick 초 분) — 알아챈 함정 목록. 7단계: how 'ally' = 아군 첨병이 찾음 (by: 그 병사) */
  detectStep(dtStep, obs, env = {}, how = 'sight', by = null) {
    const out = [];
    for (const t of this.list) {
      if (t.known || t.state !== 'armed') continue;
      const r = this.detectRate(t, obs, env);
      if (r <= 0) continue;
      if (this.rng.chance(1 - Math.exp(-r * dtStep))) { this._know(t, how, by); out.push(t); }
    }
    return out;
  }

  _know(t, how, by = null) {
    if (t.known) return;
    t.known = true;
    t.knownHow = how;
    t.knownAt = this.time;
    this.stats.known++;
    if (how === 'ally') this.stats.byAlly = (this.stats.byAlly ?? 0) + 1;
    this._ver++;
    this.emit('known', { trap: t, how, by });
  }

  /** 7단계: 알아챈 지뢰·구덩이 (아군이 비켜 갈 자리) [{x, z, r}] */
  knownHazards() {
    const out = [];
    for (const t of this.list) {
      if (!t.known || t.kind === 'tripwire') continue;
      if (t.state === 'armed' || (t.kind === 'spikePit' && t.state === 'sprung')) out.push({ x: t.x, z: t.z, r: t.r, kind: t.kind, id: t.id });
    }
    return out;
  }

  /**
   * 탐침: 발 앞 from~reach m 땅을 좌우 sweep m 로 찔러 지뢰·구덩이를 찾음 (철선은 찔러서 못 찾음 — 눈으로).
   * @returns {{ found: Array<trap>, point: {x,z} }}
   */
  probe(motor, yaw = motor.yaw) {
    const P = CONFIG.traps.probe;
    const p = motor.position;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const cx = p.x + fx * P.reach, cz = p.z + fz * P.reach;
    const found = [];
    for (const t of this.list) {
      if (t.kind === 'tripwire' || t.state !== 'armed') continue;
      const d2 = segDist2(t.x, t.z, p.x + fx * P.from, p.z + fz * P.from, cx, cz);
      if (d2 <= (P.sweep + t.r) * (P.sweep + t.r)) {
        found.push(t);
        this._know(t, 'probe');
      }
    }
    this.emit('probe', { found, point: { x: cx, z: cz } });
    return { found, point: { x: cx, z: cz } };
  }

  /** 해제할 수 있는 인계철선: 알아챘고 아직 걸리지 않은 것 중 range 안 가장 가까운 것 */
  disarmTarget(motor) {
    const R = CONFIG.traps.disarm.range;
    let best = null, bd = Infinity;
    for (const t of this.list) {
      if (t.kind !== 'tripwire' || t.state !== 'armed' || !t.known) continue;
      const d = this.distanceTo(t, motor.position.x, motor.position.z);
      if (d <= R && d < bd) { bd = d; best = t; }
    }
    return best;
  }

  /**
   * 해제 완료 판정 (Game 이 5초 동작을 마친 뒤 부름). opts.armWounded → 불가. opts.forceFail (테스트)
   * @returns {{ ok: boolean, failed: boolean, refused?: string }}
   */
  disarm(t, person = null, opts = {}) {
    if (!t || t.kind !== 'tripwire' || t.state !== 'armed') return { ok: false, failed: false, refused: 'none' };
    if (opts.armWounded) return { ok: false, failed: false, refused: 'arm' };
    const fail = opts.forceFail ?? this.rng.chance(CONFIG.traps.disarm.failChance);
    if (fail) {
      this.trigger(t, person, 'disarm');
      return { ok: false, failed: true };
    }
    t.state = 'disarmed';
    this._ver++;
    this.emit('disarmed', { trap: t });
    return { ok: true, failed: false };
  }

  // ---- 체크포인트 ----------------------------------------------------
  snapshot() {
    return this.list.map((t) => ({ id: t.id, state: t.state === 'fuse' ? 'exploded' : t.state, known: t.known, knownHow: t.knownHow }));
  }

  restore(snap) {
    if (!snap) return;
    for (const s of snap) {
      const t = this.list.find((x) => x.id === s.id);
      if (!t) continue;
      t.state = s.state; t.known = s.known; t.knownHow = s.knownHow; t.fuse = 0;
    }
    for (const st of this._stuck) st.motor?.clearRestriction?.('trapPit');
    this._stuck.length = 0;
    this._prev.clear();
    this._ver++;
  }
}
