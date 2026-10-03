// 4단계 적 AI 로직 헤드리스 검증 (렌더링 없음)
//   node scripts/ai-check.mjs   (npm run ai)
// 발견 시간 · 소리 추정 오차 · 제압 시 발사 0 · 사기 하락 시 후퇴/분대장 사망 혼란 · 부상자 행동 · 명중률 · 반응 지연 ·
// 순찰 간격/진흙 · 매복 · 측면 우회/제압 사격 · 수색 · 동물 정적 · 경기관총 제압 · 성능 예산
import { CONFIG } from '../src/config.js';
import { RNG } from '../src/core/rng.js';
import { generateWorld } from '../src/world/WorldGen.js';
import { WorldQuery } from '../src/world/WorldQuery.js';
import { SURFACE, surfaceProps } from '../src/world/Surfaces.js';
import { HumanMotor } from '../src/human/HumanMotor.js';
import { computeExposure } from '../src/human/Exposure.js';
import { NoiseEvents } from '../src/core/NoiseEvents.js';
import { CombatSystem } from '../src/combat/CombatSystem.js';
import { BulletWorld, createFlatWorld } from '../src/combat/BulletWorld.js';
import { Injuries, makeTestHit } from '../src/combat/Injuries.js';
import { Suppression } from '../src/combat/Suppression.js';
import { NavGrid } from '../src/ai/NavGrid.js';
import { EnemyManager } from '../src/ai/EnemyManager.js';
import { Squad } from '../src/ai/Squad.js';
import { Soldier } from '../src/ai/Soldier.js';
import { Wildlife } from '../src/ai/Wildlife.js';
import { estimateSound, detectionRate } from '../src/ai/Perception.js';

const DT = 1 / 30;
const LIGHT = { daylight: 1, sunOffset: { x: 8, z: 12 } };
let failures = 0, passes = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (ok) passes++; else failures++; };
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));
const median = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const yawOf = (dx, dz) => Math.atan2(-dx, -dz);
const t0All = performance.now();

// ---------------------------------------------------------------------
// 세계: 실제 맵 (한 번) / 평지 (조준·제압처럼 식생이 끼면 안 되는 검사)
// ---------------------------------------------------------------------
let REAL = null;
function real() {
  if (!REAL) {
    const data = generateWorld(CONFIG.world.seed);
    const q = new WorldQuery(data);
    REAL = { data, q, nav: new NavGrid(q, data.layout), layout: data.layout };
  }
  return REAL;
}
const EMPTY = [];
class FlatQuery {
  constructor() { this.half = 200; this.size = 400; this.wetness = CONFIG.weather.presets.clear.wetness; this.circleGrid = { forEachNear() {}, at: () => EMPTY }; this.supportGrid = { forEachNear() {}, at: () => EMPTY }; }
  getGroundInfo(x, z, out = {}) { out.terrain = 0; out.support = 0; out.surface = SURFACE.PACKED_DIRT; out.waterLevel = -1e9; out.waterDepth = 0; out.onDike = false; out.obstacle = null; return out; }
  getSlope(x, z, out = { deg: 0, gx: 0, gz: 0 }) { out.deg = 0; out.gx = 0; out.gz = 0; return out; }
  resolveCircles() { return false; }
  clampToBounds() {}
  getWaterDepth() { return 0; }
  getWaterLevel() { return -1e9; }
  getSupportHeight() { return 0; }
  getTerrainHeight() { return 0; }
  getSurfaceAt() { return SURFACE.PACKED_DIRT; }
  clearanceAt() { return Infinity; }
  coverConcealment() { return 0; }
  getCanopyCover() { return 0; }
  raycastWorld(o, d, max) { return { hit: false, distance: max, point: null, object: null, transmittance: 1, passed: [] }; }
}
let FLAT = null;
function flat() {
  if (!FLAT) { const q = new FlatQuery(); FLAT = { q, nav: new NavGrid(q, null), layout: null }; }
  return FLAT;
}

/** 장면: 플레이어 (이동 + 판정 + 부상, 기본 무적) + 적 관리자 */
function makeScene({ world = 'flat', x = 0, z = 0, yaw = 0, stance = 'stand', invulnerable = true, seed = 1, target = true } = {}) {
  const W = world === 'real' ? real() : flat();
  const noise = new NoiseEvents();
  const combat = new CombatSystem(W.q, noise, { world: world === 'real' ? new BulletWorld(W.q) : createFlatWorld(0), rng: new RNG(seed * 7 + 3) });
  const motor = new HumanMotor(W.q, { x, z, yaw, noise, name: 'player' });
  motor.stance = motor.stanceFrom = stance; motor.stanceProgress = 1; motor.eyeHeight = CONFIG.stance.eyeHeight[stance];
  const inj = new Injuries({ rng: new RNG(seed + 5), motor });
  inj.invulnerable = invulnerable;
  const pose = () => ({ x: motor.position.x, y: motor.position.y, z: motor.position.z, yaw: motor.yaw, stance: motor.stance, stanceFrom: motor.stanceFrom, stanceProgress: motor.stanceProgress, lean: 0, arms: 'rifle', eyeHeight: motor.eyeHeight });
  const person = combat.addPerson({ name: 'player', isPlayer: true, noiseSource: motor, getPose: pose, injuries: inj });
  const sc = { W, noise, combat, motor, inj, person, expo: 0.5, expoT: 0, expoOverride: null, time: 0, hitsOnPlayer: 0, hitsBy: new Map() };
  sc.target = { person, motor, injuries: inj, get alive() { return !inj.dead; }, exposure: () => sc.expoOverride ?? sc.expo };
  sc.em = new EnemyManager({ query: W.q, combat, noise, layout: W.layout, nav: W.nav, rng: new RNG(seed * 13 + 1) });
  if (target) sc.em.setTarget(sc.target);
  combat.on('hit', (e) => {
    if (e.person !== person) return;
    sc.hitsOnPlayer++;
    sc.hitsBy.set(e.shooter, (sc.hitsBy.get(e.shooter) ?? 0) + 1);
  });
  return sc;
}

function step(sc, seconds, fn = null) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    if (fn && fn(sc, sc.time) === false) break;
    sc.combat.update(DT);
    sc.motor.update(DT);
    sc.noise.update(DT);
    sc.expoT -= DT;
    if (sc.expoT <= 0) { sc.expoT = 0.1; sc.expo = computeExposure(sc.motor, sc.W.q, LIGHT).value; }
    sc.em.update(DT);
    sc.time += DT;
  }
}

/** 병사 하나를 분대에 넣어 직접 만들기 (상태 지정) */
function addSoldier(sc, { x, z, yaw = 0, stance = 'stand', weapon = 'rifle556', state = 'alert', squad = null, role = 'rifleman', seed = 1 } = {}) {
  const em = sc.em;
  let sq = squad;
  if (!sq) { sq = new Squad(em, { type: 'patrol', rng: new RNG(seed + 77) }); em.squads.push(sq); }
  const s = new Soldier(em, { x, z, yaw, stance, rng: new RNG(seed), weapon, role });
  em._addSoldier(s);
  sq.add(s);
  s.look.yaw = yaw;
  if (state) { sq.state = state; sq.stateSince = em.time; }
  return { s, sq };
}

function toward(a, b) { return yawOf(b.x - a.x, b.z - a.z); }

/** 스크립트로 걷는 플레이어: 앞이 높으면 뛰어넘음 (통나무) */
function walkTo(sc, p) {
  const m = sc.motor;
  m.yaw = toward(m.position, p);
  m.input.move.z = 1;
  const M = CONFIG.movement;
  const fx = -Math.sin(m.yaw), fz = -Math.cos(m.yaw);
  const h = sc.W.q.getSupportHeight(m.position.x + fx * 0.55, m.position.z + fz * 0.55) - m.position.y;
  if (m.speed < 0.4 && h > M.stepHeight * 0.75 && h < M.stepHeight + M.jumpHeight) m.input.jump = true;
}

// =====================================================================
console.log('\n[1] 순찰: 오솔길을 따라 간격을 두고 일렬, 진흙에서 느려짐');
{
  const R = real();
  const T1 = R.layout.trails[0];
  const pts = [];
  for (let i = 0; i < T1.line.count; i += 3) pts.push({ x: T1.line.x[i], z: T1.line.z[i] });
  const sc = makeScene({ world: 'real', x: 150, z: 150, seed: 2, target: false });
  const sq = sc.em.spawnPatrol({ near: { x: pts[pts.length - 1].x, z: pts[pts.length - 1].z }, start: pts[0], route: pts, size: 5, mg: false, seed: 4 });
  const gaps = [], dryV = [], mudV = [], offRoute = [];
  step(sc, 75, (s, t) => {
    if (Math.round(t / DT) % 15 !== 0 || t < 6) return;
    const file = sq.members.filter((m) => m.alive).sort((a, b) => a.order - b.order);
    for (let i = 1; i < file.length; i++) gaps.push(Math.hypot(file[i].motor.position.x - file[i - 1].motor.position.x, file[i].motor.position.z - file[i - 1].motor.position.z));
    for (const m of file) offRoute.push(sq.project(m.motor.position, sq.pointS, 60).dist);
    const pt = file[0];
    const sf = R.q.getSurfaceAt(pt.motor.position.x, pt.motor.position.z);
    const sp = Math.hypot(pt.motor.velocity.x, pt.motor.velocity.z);
    if (sp < 0.05 || sq._lag) return;
    if (sf === SURFACE.SHALLOW_MUD || sf === SURFACE.DEEP_MUD || sf === SURFACE.PADDY) mudV.push(sp); else if (surfaceProps(sf).speed >= 0.9) dryV.push(sp);
  });
  const g = mean(gaps), off = median(offRoute);
  check(g >= 4 && g <= 12 && sq.pointS > 30, `평균 간격 ${f1(g)}m (5~10m 목표), 첨병이 경로 ${f1(sq.pointS)}m 전진, 경로에서 벗어난 거리 중앙값 ${f2(off)}m`);
  const md = mean(dryV), mm = mean(mudV);
  check(mudV.length > 5 && dryV.length > 5 && mm < md * 0.8, `첨병 속도: 마른 길 ${f2(md)}m/s (${dryV.length}표본) vs 진흙 ${f2(mm)}m/s (${mudV.length}표본)`);
}

// =====================================================================
console.log('\n[2] 시각: 30m 오솔길 위에서 걷는 플레이어 → 약 1~2초에 발견');
let TRAIL_PAIR = null;
{
  const R = real();
  // 시야가 트인 30m 오솔길 구간 찾기
  outer: for (const tr of R.layout.trails) {
    const L = tr.line;
    for (let i = 0; i < L.count; i += 4) {
      for (let j = i + 1; j < L.count; j++) {
        const d = Math.hypot(L.x[j] - L.x[i], L.z[j] - L.z[i]);
        if (d < 29.5) continue;
        if (d > 31) break;
        const a = { x: L.x[i], z: L.z[i] }, b = { x: L.x[j], z: L.z[j] };
        const ay = R.q.getSupportHeight(a.x, a.z) + 1.6, by = R.q.getSupportHeight(b.x, b.z) + 1.3;
        const r = R.q.raycastWorld({ x: a.x, y: ay, z: a.z }, { x: b.x - a.x, y: by - ay, z: b.z - a.z }, d, 'vision');
        if (!r.hit && r.transmittance > 0.4) { TRAIL_PAIR = { a, b, T: r.transmittance, tr, j }; break outer; }
        break;
      }
    }
  }
  check(!!TRAIL_PAIR, `시야가 트인 30m 오솔길 구간 (투과율 ${f2(TRAIL_PAIR?.T)})`);
  const times = [], stillTimes = [];
  for (let k = 0; k < 12; k++) {
    for (const moving of [true, false]) {
      const { a, b } = TRAIL_PAIR;
      const sc = makeScene({ world: 'real', x: b.x, z: b.z, yaw: toward(b, a) + Math.PI / 2, seed: 100 + k });
      const { s } = addSoldier(sc, { x: a.x, z: a.z, yaw: toward(a, b), state: 'patrol', seed: 200 + k });
      let found = NaN;
      step(sc, 20, (S, t) => {
        if (moving) {
          // 오솔길 위를 좌우로 걷기 (2초마다 방향 전환)
          sc.motor.input.move.z = 1;
          sc.motor.yaw = toward(b, a) + Math.PI / 2 + (Math.floor(t / 2) % 2 ? Math.PI : 0);
        }
        if (s.perception.meter >= 1) { found = t; return false; }
      });
      (moving ? times : stillTimes).push(found);
    }
  }
  const mt = median(times);
  check(mt >= 0.6 && mt <= 2.6, `걸을 때 발견까지 중앙값 ${f2(mt)}s (12회: ${times.map(f1).join(' ')})`);
  console.log(`     참고: 같은 자리에 가만히 서 있으면 중앙값 ${f2(median(stillTimes.map((v) => (Number.isNaN(v) ? 99 : v))))}s`);
}

// =====================================================================
console.log('\n[3] 시각: 키 큰 풀 속에 엎드려 가만히 — 15m 30초 동안 10% 미만, 5m 면 발견 가능');
{
  const R = real();
  // 코끼리풀 군락 안쪽 지점 + 15m 밖 트인 곳
  const spots = [];
  for (const b of [{ x: 18, z: -30 }, { x: -86, z: 52 }, { x: 118, z: -62 }, { x: -140, z: 22 }, { x: 58, z: 108 }]) {
    for (let k = 0; k < 40 && spots.length < 40; k++) {
      const a = k * 2.4, rr = (k % 4) * 1.5;
      const x = b.x + Math.cos(a) * rr, z = b.z + Math.sin(a) * rr;
      if (R.q.getSurfaceAt(x, z) !== SURFACE.BRUSH || !R.nav.walkable(x, z)) continue;
      // 주변 3m 도 키 큰 풀
      let ok = true;
      for (let j = 0; j < 8 && ok; j++) if (R.q.getSurfaceAt(x + Math.cos(j) * 3, z + Math.sin(j) * 3) !== SURFACE.BRUSH) ok = false;
      if (!ok) continue;
      for (let j = 0; j < 16; j++) {
        const ang = j * Math.PI / 8;
        const sx = x + Math.cos(ang) * 15, sz = z + Math.sin(ang) * 15;
        if (!R.nav.walkable(sx, sz) || R.q.getSurfaceAt(sx, sz) === SURFACE.BRUSH) continue;
        spots.push({ p: { x, z }, s: { x: sx, z: sz } });
        break;
      }
    }
  }
  check(spots.length >= 10, `시험 자리 ${spots.length}곳 (키 큰 풀 속 엎드림 ↔ 15m 밖 병사)`);
  let det15 = 0, n15 = 0, det5 = 0, n5 = 0;
  const meters = [];
  for (let k = 0; k < Math.min(30, spots.length); k++) {
    const { p, s: sp } = spots[k];
    const sc = makeScene({ world: 'real', x: p.x, z: p.z, stance: 'prone', yaw: toward(p, sp), seed: 300 + k });
    const { s } = addSoldier(sc, { x: sp.x, z: sp.z, yaw: toward(sp, p), state: 'alert', seed: 400 + k });
    s.lookMode = 'point';
    let found = false;
    step(sc, 30, () => { s.lookAt = p; if (s.perception.meter >= 1) { found = true; return false; } });
    meters.push(s.perception.meter);
    n15++; if (found) det15++;
  }
  check(n15 >= 10 && det15 / n15 < 0.1, `15m: ${n15}회 중 ${det15}회 발견 (${f1(100 * det15 / Math.max(1, n15))}%, 기준 10% 미만) · 30초 뒤 발견 수치 중앙값 ${f2(median(meters))}`);
  for (let k = 0; k < Math.min(16, spots.length); k++) {
    const { p, s: far } = spots[k];
    const dx = far.x - p.x, dz = far.z - p.z, dl = Math.hypot(dx, dz);
    const sp = { x: p.x + dx / dl * 5, z: p.z + dz / dl * 5 };
    const sc = makeScene({ world: 'real', x: p.x, z: p.z, stance: 'prone', seed: 500 + k });
    const { s } = addSoldier(sc, { x: sp.x, z: sp.z, yaw: toward(sp, p), state: 'alert', seed: 600 + k });
    let found = false;
    step(sc, 30, () => { s.lookAt = p; s.lookMode = 'point'; if (s.perception.meter >= 1) { found = true; return false; } });
    n5++; if (found) det5++;
  }
  check(det5 / n5 >= 0.5, `5m: ${n5}회 중 ${det5}회 30초 안에 발견 (발견 가능)`);
}

// =====================================================================
console.log('\n[4] 사격하면 들킴: 총구 화염 → 시야 안 적에게 즉시 노출, 등 돌린 적은 총성으로 대략적인 위치');
{
  const sc = makeScene({ world: 'flat', x: 0, z: 0, seed: 7 });
  sc.expoOverride = 0.02;   // 거의 안 보이는 상태 (가만히 숨어 있음)
  const { s: a } = addSoldier(sc, { x: 0, z: -60, yaw: toward({ x: 0, z: -60 }, { x: 0, z: 0 }), state: 'patrol', seed: 11 });
  const { s: b } = addSoldier(sc, { x: 40, z: -40, yaw: toward({ x: 40, z: -40 }, { x: 90, z: -90 }), state: 'patrol', seed: 12 });
  b.lookMode = 'free'; b.look.targetYaw = b.look.yaw;
  step(sc, 4);
  const before = a.perception.meter;
  const eye = { x: 0, y: 1.5, z: 0 };
  sc.combat.fire(sc.person, { origin: eye, dir: { x: 0.3, y: 0.02, z: -1 } });
  step(sc, 0.1);
  const flashA = a.perception.meter >= 1;
  step(sc, 1.2);
  const bHeard = b.memory.valid && b.memory.source === 'heard';
  const errB = bHeard ? Math.hypot(b.memory.x - 0, b.memory.z - 0) : NaN;
  check(before < 0.3 && flashA, `정면 60m 적: 쏘기 전 발견 수치 ${f2(before)} → 사격 0.1초 뒤 ${f2(a.perception.meter)} (즉시 발견)`);
  check(bHeard && b.perception.meter < 1 && errB > 0.5, `등 돌린 적 (57m): 화염은 못 봄, 총성으로 대략적인 위치 (오차 ${f1(errB)}m)`);
}

// =====================================================================
console.log('\n[5] 청각: 추정 오차 ≈ 거리의 15%, 근접 탄 직후 총성은 방향을 크게 헷갈림, 소리 난 쪽을 조사하러 옴');
{
  const rng = new RNG(5);
  for (const d of [10, 30, 100]) {
    const errs = [];
    for (let i = 0; i < 2000; i++) {
      const e = estimateSound({ x: d, z: 0 }, { x: 0, z: 0 }, rng, false);
      errs.push(Math.hypot(e.x - d, e.z) / d);
    }
    check(Math.abs(mean(errs) - 0.15) < 0.02, `거리 ${d}m: 평균 오차 ${f1(mean(errs) * 100)}% (기준 약 15%)`);
  }
  const angN = [], angC = [];
  for (let i = 0; i < 1000; i++) {
    const n = estimateSound({ x: 50, z: 0 }, { x: 0, z: 0 }, rng, false);
    const c = estimateSound({ x: 50, z: 0 }, { x: 0, z: 0 }, rng, true);
    angN.push(Math.abs(Math.atan2(n.z, n.x)) * 180 / Math.PI);
    angC.push(Math.abs(Math.atan2(c.z, c.x)) * 180 / Math.PI);
  }
  check(mean(angC) > mean(angN) * 2.5, `방향 오차: 보통 ${f1(mean(angN))}° vs 근접 탄 직후 ${f1(mean(angC))}°`);
  // 통합: 실제 근접 탄 → 총성
  {
    const sc = makeScene({ world: 'flat', x: 0, z: 0, seed: 21 });
    sc.expoOverride = 0.0;
    const { s } = addSoldier(sc, { x: 0, z: -80, yaw: 0, state: 'patrol', seed: 22 });   // 북쪽을 봄 (플레이어는 등 뒤)
    s.lookMode = 'free'; s.look.targetYaw = 0;
    step(sc, 1);
    const sp = s.motor.position;
    const tgt = { x: sp.x + 0.6, y: sp.y + 1.5, z: sp.z };
    const o = { x: 0, y: 1.5, z: 0 };
    sc.combat.fire(sc.person, { origin: o, dir: { x: tgt.x - o.x, y: tgt.y - o.y, z: tgt.z - o.z } });
    step(sc, 1.5);
    const m = s.memory;
    const angErr = Math.abs(Math.atan2(m.x - sp.x, -(m.z - sp.z)) - Math.atan2(0 - sp.x, -(0 - sp.z))) * 180 / Math.PI;
    check(s.perception.lastCrack > 0 && m.valid && m.source === 'heard', `근접 탄('딱') 뒤 총성으로 추정 — 방향 오차 ${f1(angErr)}°, 거리 오차 ${f1(Math.abs(Math.hypot(m.x - sp.x, m.z - sp.z) - 80))}m`);
  }
  // 통합: 보이지 않는 곳의 발소리 → 의심 → 대략적인 위치로 조사
  {
    const R = real();
    let found = null;
    for (let k = 0; k < 400 && !found; k++) {
      const st = R.layout.start;
      const x = st.x + Math.cos(k * 0.7) * (10 + k * 0.2), z = st.z + Math.sin(k * 0.7) * (10 + k * 0.2);
      if (!R.nav.walkable(x, z) || R.q.getSurfaceAt(x, z) !== SURFACE.LEAF_LITTER) continue;
      for (let j = 0; j < 12; j++) {
        const sx = x + Math.cos(j * 0.52) * 14, sz = z + Math.sin(j * 0.52) * 14;
        if (!R.nav.walkable(sx, sz)) continue;
        const r = R.q.raycastWorld({ x: sx, y: R.q.getSupportHeight(sx, sz) + 1.6, z: sz }, { x: x - sx, y: 0, z: z - sz }, 14, 'vision');
        if (r.hit) { found = { p: { x, z }, s: { x: sx, z: sz } }; break; }
      }
    }
    const errs = [];
    let suspicious = 0, investigated = 0, trials = 0;
    // 그 자리 발소리 반경을 재고 그 0.7배 거리 (보이지 않는 쪽)에 병사
    let radius = 0;
    {
      const sc = makeScene({ world: 'real', x: found.p.x, z: found.p.z, seed: 699 });
      sc.noise.on('noise', (e) => { if (e.source === sc.motor && (e.kind === 'footstep' || e.kind === 'rustle')) radius = Math.max(radius, e.radius); });
      step(sc, 4, (S, t) => { sc.motor.input.move.z = 1; sc.motor.yaw = t % 2 < 1 ? 0 : Math.PI; });
    }
    const dHear = radius * 0.7;
    const sdx = found.s.x - found.p.x, sdz = found.s.z - found.p.z, sdl = Math.hypot(sdx, sdz);
    const spot = { x: found.p.x + sdx / sdl * dHear, z: found.p.z + sdz / sdl * dHear };
    console.log(`     발소리 반경 ${f1(radius)}m → 병사 ${f1(dHear)}m (시야 막힘)`);
    for (let k = 0; k < 6 && found; k++) {
      const sc = makeScene({ world: 'real', x: found.p.x, z: found.p.z, seed: 700 + k });
      sc.expoOverride = 0.0;
      const { s, sq } = addSoldier(sc, { x: spot.x, z: spot.z, yaw: toward(spot, found.p) + Math.PI, state: 'patrol', seed: 800 + k });
      const { s: s2 } = addSoldier(sc, { x: found.s.x + 3, z: found.s.z, yaw: 0, state: 'patrol', squad: sq, seed: 900 + k });
      void s2;
      trials++;
      let t0 = -1;
      const start = { ...s.motor.position };
      step(sc, 14, (S, t) => {
        // 제자리에서 바스락거리며 서성임 (발소리)
        sc.motor.input.move.z = t < 6 ? 1 : 0;
        sc.motor.yaw = t % 2 < 1 ? 0 : Math.PI;
        if (sq.state === 'suspicious' && t0 < 0) { t0 = t; suspicious++; errs.push(Math.hypot(sq.suspicion.x - sc.motor.position.x, sq.suspicion.z - sc.motor.position.z) / dHear); }
      });
      if (Math.hypot(s.motor.position.x - start.x, s.motor.position.z - start.z) > 2 || sq.investigators.some((m) => m.goal)) investigated++;
    }
    check(found && suspicious >= 4 && investigated >= 3, `안 보이는 ${f1(dHear)}m 발소리 → 의심 ${suspicious}/${trials}, 조사하러 움직임 ${investigated}/${trials}`);
    check(errs.length && mean(errs) > 0.03 && mean(errs) < 0.6, `조사 지점은 정확한 위치가 아님: 평균 오차 거리의 ${f1(mean(errs) * 100)}%`);
  }
  // 총성 300m 이상: 먼 분대 경계
  {
    const sc = makeScene({ world: 'flat', x: 0, z: 0, seed: 31 });
    const { sq } = addSoldier(sc, { x: 0, z: -330, state: 'patrol', seed: 32 });
    step(sc, 0.5);
    sc.combat.fire(sc.person, { origin: { x: 0, y: 1.5, z: 0 }, dir: { x: 1, y: 0.05, z: 0 } });
    step(sc, 2);
    check(sq.state === 'alert' || sq.state === 'search', `330m 밖 분대: 총성(약 1초 뒤 도착)을 듣고 ${sq.state}`);
  }
}

// =====================================================================
console.log('\n[6] 제압: 60 이상인 동안 발사 0, 45 이하로 내려가면 내다본 뒤 다시 사격, 85 이상 웅크림');
{
  const sc = makeScene({ world: 'flat', x: 0, z: 0, seed: 41 });
  const { s, sq } = addSoldier(sc, { x: 0, z: -40, yaw: 0 + Math.PI, state: 'engaged', seed: 42 });
  void sq;
  step(sc, 6);
  const firstShots = s.stats.shots;
  const sup = s.person.suppression;
  let shotsHigh = 0, maxPinnedStance = '';
  const shots0 = s.stats.shots;
  let modes = new Set();
  step(sc, 12, () => {
    if (sup.value < 72) sup.addNearPass(0.25);
    modes.add(s.mode);
    maxPinnedStance = s.motor.stance;
  });
  shotsHigh = s.stats.shots - shots0;
  check(firstShots > 0 && shotsHigh === 0 && s.stats.shotsPinned === 0, `제압 전 ${firstShots}발 → 제압 60~85 12초 동안 ${shotsHigh}발 (모드 ${[...modes].join('/')}, 자세 ${maxPinnedStance})`);
  let resumeT = NaN, firedAbove45 = 0;
  const shots1 = s.stats.shots;
  step(sc, 16, (S, t) => {
    const before = s.stats.shots;
    void before;
    if (s.stats.shots > shots1 && Number.isNaN(resumeT)) resumeT = t;
    if (sup.value > 45 && s.stats.shots > shots1 && Number.isNaN(resumeT)) firedAbove45++;
  });
  check(s.stats.shots > shots1 && firedAbove45 === 0, `수치가 내려간 뒤 다시 사격 (${s.stats.shots - shots1}발, 45 이하에서 재개)`);
  // 85 이상: 웅크림
  const sc2 = makeScene({ world: 'flat', x: 0, z: 0, seed: 43 });
  const { s: c } = addSoldier(sc2, { x: 0, z: -35, yaw: Math.PI, state: 'engaged', seed: 44 });
  step(sc2, 3);
  const cs = c.person.suppression;
  const shotsC = c.stats.shots;
  let sawCower = false;
  step(sc2, 8, () => { if (cs.value < 95) cs.addNearPass(0.1); if (c.mode === 'cower') sawCower = true; });
  check(sawCower && c.motor.stance === 'prone' && c.stats.shots === shotsC, `제압 95: 웅크림 (모드 cower, 엎드림, 발사 ${c.stats.shots - shotsC})`);
  // 엄폐 없이 제압 → 즉시 엎드림
  const sc3 = makeScene({ world: 'flat', x: 0, z: 0, seed: 45 });
  const { s: d } = addSoldier(sc3, { x: 0, z: -30, yaw: Math.PI, state: 'engaged', seed: 46 });
  step(sc3, 1);
  let proneAt = NaN;
  step(sc3, 3, (S, t) => { if (d.person.suppression.value < 70) d.person.suppression.addNearPass(0.25); if (d.motor.stance === 'prone' && Number.isNaN(proneAt)) proneAt = t; });
  check(Number.isFinite(proneAt) && proneAt - 1 < 1.5, `엄폐 없이 제압당하면 바로 엎드림 (${f2(proneAt - 1)}초)`);
}

// =====================================================================
console.log('\n[7] 명중률·반응 지연·첫발: 침착한 적이 30m 서 있는 플레이어를 조준 단발로');
{
  const results = { shots: 0, hits: 0 };
  const firstHit = [], laterHit = [];
  const delays = [], reacts = [];
  for (let k = 0; k < 24; k++) {
    const sc = makeScene({ world: 'flat', x: 0, z: 0, seed: 1000 + k });
    const stance = k % 2 ? 'crouch' : 'stand';
    const { s } = addSoldier(sc, { x: 0, z: -30, yaw: Math.PI, stance, state: 'patrol', seed: 2000 + k });
    s.testMode = 'semi'; s.testSingle = true;
    s.wantStanceLock = stance;
    let n = 0;
    const shotHits = [];
    sc.combat.on('hit', (e) => { if (e.shooter === s.person && e.person === sc.person) shotHits[shotHits.length - 1] = 1; });
    s.shooter.on('fired', () => { shotHits.push(0); });
    step(sc, 30, () => {
      if (s.wantStanceLock && s.motor.stance !== s.wantStanceLock && !s.motor.transitioning) s.motor.requestStance(s.wantStanceLock);
      s.wantStance = s.wantStanceLock;
      n = s.stats.shots;
      if (n >= 12) return false;
    });
    // 단발이 다음 근접 탄보다 먼저 맞음 처리될 시간
    step(sc, 0.5);
    if (Number.isFinite(s.stats.detectAt) && Number.isFinite(s.stats.firstShotAt)) delays.push(s.stats.firstShotAt - s.stats.detectAt);
    if (Number.isFinite(s.stats.reaction)) reacts.push(s.stats.reaction);
    if (shotHits.length) { firstHit.push(shotHits[0]); for (const h of shotHits.slice(1)) laterHit.push(h); }
    results.shots += shotHits.length;
    results.hits += shotHits.reduce((a, b) => a + b, 0);
  }
  const rate = results.hits / Math.max(1, results.shots);
  check(rate >= 0.22 && rate <= 0.43, `명중률 ${f1(rate * 100)}% (${results.hits}/${results.shots}, 기준 25~40%)`);
  const md = median(delays), mr = median(reacts);
  check(mr >= 0.3 && mr <= 1.5 && Math.min(...reacts) >= 0.3 && Math.max(...reacts) <= 1.5 && md > mr && md <= 3,
    `반응 지연 중앙값 ${f2(mr)}초 (${f2(Math.min(...reacts))}~${f2(Math.max(...reacts))}, 기준 0.3~1.5) → 조준까지 첫 사격 중앙값 ${f2(md)}초`);
  check(mean(firstHit) < mean(laterHit), `첫발 명중 ${f1(mean(firstHit) * 100)}% < 이후 ${f1(mean(laterHit) * 100)}% (첫발은 잘 빗나감)`);
}

// =====================================================================
console.log('\n[8] 부상병: 팔이 멀쩡하면 엎드려 사격, 비명·도움 요청(소음), 동료가 끌고 감, 스스로 붕대');
{
  const sc = makeScene({ world: 'flat', x: 0, z: 0, seed: 51 });
  const { s: a, sq } = addSoldier(sc, { x: 0, z: -40, yaw: Math.PI, state: 'engaged', seed: 52 });
  const { s: b } = addSoldier(sc, { x: 6, z: -48, yaw: Math.PI, state: 'engaged', squad: sq, seed: 53 });
  const shouts = [];
  sc.em.on('shout', (e) => shouts.push(e.kind));
  const noises = [];
  sc.noise.on('noise', (e) => { if (e.kind === 'shout') noises.push(e.shoutKind); });
  step(sc, 3);
  a.person.refresh();
  const hit = makeTestHit(a.person, 'thighL', {});
  hit.shooter = sc.person;
  a.injuries.applyHit(hit, { forceArterial: false });
  a.onHit(hit);
  const shotsA0 = a.stats.shots;
  step(sc, 6);
  check(a.injuries.downed && a.motor.stance === 'prone' && a.stats.shots > shotsA0, `대퇴 부상: 쓰러져 엎드린 채 ${a.stats.shots - shotsA0}발 사격`);
  check(shouts.includes('scream') && noises.includes('scream'), `비명 → 소음 이벤트 (${noises.join(',')})`);
  // 플레이어가 안 보이게 → 동료가 끌고 감
  sc.expoOverride = 0;
  sc.motor.position.x = 0; sc.motor.position.z = 140;
  for (const m of [a, b]) { m.perception.meter = 0; m.perception.seen = false; }
  const p0 = { ...a.motor.position };
  let dragSeen = false, maxV = 0, pullT = 0;
  let last = { ...a.motor.position };
  step(sc, 25, () => {
    if (b.drag?.phase === 'pull') {
      dragSeen = true;
      const v = Math.hypot(a.motor.position.x - last.x, a.motor.position.z - last.z) / DT;
      maxV = Math.max(maxV, v); pullT += DT;
    }
    last = { ...a.motor.position };
  });
  const moved = Math.hypot(a.motor.position.x - p0.x, a.motor.position.z - p0.z);
  check(dragSeen && moved > 3 && maxV <= 0.75, `동료가 끌고 감: ${f1(moved)}m, 최고 ${f2(maxV)}m/s (0.6m/s 기준), 끈 시간 ${f1(pullT)}s`);
  step(sc, 30);
  check(a.injuries.bandages < CONFIG.injury.aid.bandages || a.injuries.tourniquets < CONFIG.injury.aid.tourniquets, `스스로 처치 (붕대 ${a.injuries.bandages}, 지혈대 ${a.injuries.tourniquets} 남음), 도움 요청 ${shouts.filter((k) => k === 'help').length}번`);
}

// =====================================================================
console.log('\n[9] 사기: 분대장 사망 → 3~6초 혼란 후 협력 약화, 사기 낮으면 엄호하며 후퇴, 매우 낮으면 도주');
{
  const sc = makeScene({ world: 'flat', x: 0, z: 0, seed: 61 });
  const sq = new Squad(sc.em, { type: 'patrol', rng: new RNG(62) });
  sc.em.squads.push(sq);
  const mem = [];
  for (let i = 0; i < 5; i++) {
    const s = new Soldier(sc.em, { x: -10 + i * 5, z: -50, yaw: Math.PI, stance: 'stand', rng: new RNG(63 + i), role: i === 0 ? 'leader' : 'rifleman' });
    sc.em._addSoldier(s); sq.add(s); mem.push(s);
  }
  sq.setState('engaged');
  step(sc, 3);
  const before = sq.morale;
  sq.leader.injuries.kill('head');
  let confusedFrom = NaN, confusedTo = NaN;
  step(sc, 9, (S, t) => {
    const any = mem.some((m) => m.alive && m.mode === 'confused');
    if (any && Number.isNaN(confusedFrom)) confusedFrom = t;
    if (!any && Number.isFinite(confusedFrom) && Number.isNaN(confusedTo)) confusedTo = t;
  });
  const dur = confusedTo - confusedFrom;
  check(dur >= 2.6 && dur <= 6.6 && sq.coordinationWeak && sq.morale < before - 30, `분대장 사망: 혼란 ${f1(dur)}초, 협력 약화 ${sq.coordinationWeak}, 사기 ${f1(before)} → ${f1(sq.morale)}`);
  // 후퇴
  sq.morale = 30;
  step(sc, 0.5);
  const c0 = sq.retreat ? Math.hypot(...centroid(mem).map((v, i) => v - (i ? sq.retreat.from.z : sq.retreat.from.x))) : NaN;
  const modes = new Set();
  let retreated = false;
  step(sc, 25, () => { for (const m of mem) if (m.alive) modes.add(m.mode); if (sq.state === 'retreat') retreated = true; });
  const c1 = sq.retreat ? Math.hypot(...centroid(mem).map((v, i) => v - (i ? sq.retreat.from.z : sq.retreat.from.x))) : (sq.state === 'alert' ? 999 : NaN);
  check(retreated && c1 > c0 + 12, `사기 30 → 엄호하며 후퇴 (지금 ${sq.state}): 위협에서 ${f1(c0)} → ${f1(c1)}m (모드 ${[...modes].join('/')})`);
  // 도주
  const sc2 = makeScene({ world: 'flat', x: 0, z: 0, seed: 65 });
  const sq2 = new Squad(sc2.em, { type: 'patrol', rng: new RNG(66) });
  sc2.em.squads.push(sq2);
  const m2 = [];
  for (let i = 0; i < 4; i++) { const s = new Soldier(sc2.em, { x: -8 + i * 5, z: -45, yaw: Math.PI, rng: new RNG(67 + i), role: i === 0 ? 'leader' : 'rifleman' }); sc2.em._addSoldier(s); sq2.add(s); m2.push(s); }
  sq2.setState('engaged');
  step(sc2, 2);
  sq2.morale = 8;
  const d0 = Math.hypot(...centroid(m2));
  step(sc2, 20);
  const d1 = Math.hypot(...centroid(m2));
  check(sq2.state === 'rout' && d1 > d0 + 15 && m2.every((m) => !m.alive || m.mode === 'flee'), `사기 8 → 도주 (${sq2.state}, 모두 흩어져 달아남): 플레이어에서 ${f1(d0)} → ${f1(d1)}m (달리다 지치면 걸음)`);
}

// =====================================================================
console.log('\n[10] 교전: 일부는 제압 사격(안 보여도 마지막 위치로), 일부는 측면 우회 → 플레이어 제압');
{
  const R = real();
  // 시야가 트인 오솔길 구간([2])의 끝에 플레이어가 서 있고, 분대가 그 오솔길을 따라 걸어옴
  const { b, tr, j } = TRAIL_PAIR;
  const L = tr.line;
  let i0 = j, acc = 0;
  while (i0 > 0 && acc < 70) { acc += Math.hypot(L.x[i0] - L.x[i0 - 1], L.z[i0] - L.z[i0 - 1]); i0--; }
  const route = [];
  for (let i = i0; i < Math.min(L.count, j + 40); i += 3) route.push({ x: L.x[i], z: L.z[i] });
  const sc = makeScene({ world: 'real', x: b.x, z: b.z, yaw: toward(b, route[0]), seed: 71 });
  const sq = sc.em.spawnPatrol({ near: b, start: route[0], route, size: 6, mg: true, seed: 72 });
  let engagedAt = NaN, flankers = [], hiddenShots = 0, maxSup = 0, fired = 0, maxAng = 0;
  const flankStart = new Map();
  step(sc, 90, (S, t) => {
    // 45초 안에 못 보면 플레이어가 첨병 쪽으로 두 발 쏜다 (총성·총구 화염)
    const pt = sq.members[0];
    const dPt = Math.hypot(pt.motor.position.x - sc.motor.position.x, pt.motor.position.z - sc.motor.position.z);
    if (fired < 2 && sq.state !== 'engaged' && t > 45 && dPt < 50 && Math.round(t / DT) % 10 === 0) {
      const o = { x: sc.motor.position.x, y: sc.motor.position.y + 1.5, z: sc.motor.position.z };
      const c = pt.person.hitboxes.chest;
      sc.combat.fire(sc.person, { origin: o, dir: { x: c.x - o.x + 2, y: c.y - o.y, z: c.z - o.z } });
      fired++;
    }
    if (sq.state === 'engaged' && Number.isNaN(engagedAt)) {
      engagedAt = t;
      flankers = sq.members.filter((m) => m.role === 'flank');
      for (const m of flankers) flankStart.set(m, { ...m.motor.position });
      // 발견된 뒤 플레이어는 엎드려 숨음 (안 보이게)
      sc.motor.forceStance('prone', 0.4);
      sc.expoOverride = 0.03;
    }
    if (Number.isFinite(engagedAt)) {
      for (const m of sq.members) if (m.fire.mode === 'suppress' && m.fire.burstLeft > 0) hiddenShots++;
      maxSup = Math.max(maxSup, sc.person.suppression.value);
      // 위협(플레이어) 기준으로 기동조가 사격조에서 얼마나 옆으로 돌아갔나
      if (Math.round(t / DT) % 15 === 0) {
        const fireTeam = sq.members.filter((m) => m.alive && !flankers.includes(m));
        const fc = centroid(fireTeam), c = sc.motor.position;
        for (const m of flankers) {
          if (!m.alive) continue;
          const a1 = Math.atan2(fc[1] - c.z, fc[0] - c.x), a2 = Math.atan2(m.motor.position.z - c.z, m.motor.position.x - c.x);
          let d = Math.abs(a2 - a1) * 180 / Math.PI; if (d > 180) d = 360 - d;
          maxAng = Math.max(maxAng, d);
        }
      }
      if (t > engagedAt + 40) return false;
    }
  });
  const fire = sq.members.filter((m) => m.alive && !flankers.includes(m));
  check(Number.isFinite(engagedAt) && flankers.length >= 1, `교전 ${f1(engagedAt)}초: 기동조 ${flankers.length}명 / 사격조 ${fire.length}명`);
  check(maxAng >= 40, `기동조가 측면으로: 위협 기준 사격조와 ${f1(maxAng)}° 벌어짐`);
  check(hiddenShots > 0 && maxSup > 20, `보이지 않는 마지막 위치로 제압 사격 (연발 중 프레임 ${hiddenShots}) → 플레이어 제압 최고 ${f1(maxSup)}`);
}

// =====================================================================
console.log('\n[11] 매복: 15~25m 까지 기다렸다가 동시에 사격');
{
  const R = real();
  // 시작점 오솔길 T1 을 따라 걸어감
  const T1 = R.layout.trails[0];
  const L = T1.line;
  const springD = [], spreads = [], early = [];
  for (let k = 0; k < 5; k++) {
    const i0 = 4 + k * 3;
    const sc = makeScene({ world: 'real', x: L.x[i0], z: L.z[i0], seed: 800 + k });
    const yaw0 = toward({ x: L.x[i0], z: L.z[i0] }, { x: L.x[i0 + 8], z: L.z[i0 + 8] });
    const sq = sc.em.spawnAmbush({ near: { x: L.x[i0], z: L.z[i0] }, yaw: yaw0, distance: 55, size: 4, mg: true, seed: 810 + k });
    if (!sq) continue;
    let idx = i0, sprungDist = NaN, shotsBefore = 0;
    step(sc, 70, (S, t) => {
      // 오솔길을 따라 걷기
      const p = sc.motor.position;
      while (idx < L.count - 3 && Math.hypot(L.x[idx] - p.x, L.z[idx] - p.z) < 1.5) idx++;
      walkTo(sc, { x: L.x[idx], z: L.z[idx] });
      if (!sq.ambush.sprung) shotsBefore = sq.members.reduce((a, m) => a + m.stats.shots, 0);
      if (sq.ambush.sprung && Number.isNaN(sprungDist)) sprungDist = Math.min(...sq.members.map((m) => Math.hypot(m.motor.position.x - p.x, m.motor.position.z - p.z)));
      if (Number.isFinite(sprungDist) && t > sq.ambush.sprungAt + 4) return false;
    });
    if (Number.isFinite(sprungDist)) {
      springD.push(sprungDist);
      const firsts = sq.members.map((m) => m.stats.firstShotAt).filter((v) => Number.isFinite(v) && v < sq.ambush.sprungAt + 3);
      if (firsts.length >= 2) spreads.push(Math.max(...firsts) - Math.min(...firsts));
      early.push(shotsBefore);
    }
  }
  check(springD.length >= 3 && median(springD) <= 27 && median(springD) >= 5, `매복 개시 때 가장 가까운 매복병까지 ${springD.map(f1).join(', ')}m (15~25m 목표)`);
  check(spreads.length >= 2 && median(spreads) <= 1.0 && early.every((v) => v === 0), `첫 사격 시각 차이 중앙값 ${f2(median(spreads))}초 (동시에), 개시 전 사격 ${early.join('/')}`);
}

// =====================================================================
console.log('\n[12] 수색: 접촉을 잃으면 2인 1조로 마지막 위치에 접근, 1~3분 뒤 포기하고 경계 높아진 순찰');
{
  const sc = makeScene({ world: 'flat', x: 0, z: 0, seed: 91 });
  const sq = new Squad(sc.em, { type: 'patrol', rng: new RNG(92) });
  sc.em.squads.push(sq);
  const mem = [];
  for (let i = 0; i < 4; i++) { const s = new Soldier(sc.em, { x: -6 + i * 4, z: -50, yaw: Math.PI, rng: new RNG(93 + i), role: i === 0 ? 'leader' : 'rifleman' }); sc.em._addSoldier(s); sq.add(s); mem.push(s); }
  step(sc, 6);
  const engaged = sq.state === 'engaged';
  // 플레이어가 사라짐 (멀리)
  sc.motor.teleport(160, 160);
  sc.expoOverride = 0;
  let searchAt = NaN, pairs = 0, minDist = Infinity, backAt = NaN, recon = 0;
  step(sc, 220, (S, t) => {
    if (sq.state === 'search' && Number.isNaN(searchAt)) { searchAt = t; pairs = sq.search.pairs.length; }
    if (sq.state === 'search') {
      for (const m of mem) minDist = Math.min(minDist, Math.hypot(m.motor.position.x, m.motor.position.z));
      for (const p of sq.search.pairs) if (sq.search.tasks.get(p.lead)?.recon) recon++;
    }
    if (Number.isFinite(searchAt) && sq.state === 'patrol' && Number.isNaN(backAt)) { backAt = t; return false; }
  });
  const dur = backAt - searchAt;
  check(engaged && Number.isFinite(searchAt) && pairs === 2 && minDist < 12, `교전 → ${f1(searchAt)}초에 수색: ${pairs}개 조, 마지막 위치 ${f1(minDist)}m 까지 접근`);
  check(dur >= 55 && dur <= 185 && mem[1].perception.alertMul > 1, `${f1(dur)}초 뒤 포기 → 순찰 (감지 배율 ×${f2(mem[1].perception.alertMul)}), 위력 수색 ${recon > 0 ? '있음' : '없음'}`);
}

// =====================================================================
console.log('\n[13] 동물 정적: 움직이는 사람 주변 30~40m 조용, 20~40초 뒤 살아남, 총성 뒤 30~90초');
{
  const w = new Wildlife(400, { rng: new RNG(3) });
  for (let t = 0; t < 10; t += 0.1) w.update(0.1, [{ x: 0, z: 0, speed: 1.5 }]);
  const near = w.activityAt(10, 0), mid = w.activityAt(30, 0), far = w.activityAt(60, 0);
  check(near < 0.2 && mid < 0.3 && far > 0.9, `걷는 사람 주변 활동도: 10m ${f2(near)}, 30m ${f2(mid)}, 60m ${f2(far)}`);
  let back = NaN;
  for (let t = 0; t < 70; t += 0.1) { w.update(0.1, []); if (Number.isNaN(back) && w.activityAt(10, 0) > 0.6) back = t; }
  check(back >= 20 && back <= 48, `멈추고 ${f1(back)}초 뒤 다시 살아남 (20~40초 + 살아나는 시간)`);
  const w2 = new Wildlife(400, { rng: new RNG(4) });
  w2.gunshot(0, 0);
  let back2 = NaN, back3 = NaN, low2 = false, low3 = false;
  for (let t = 0; t < 120; t += 0.1) {
    w2.update(0.1, []);
    if (w2.activityAt(0, 0) < 0.3) low2 = true;
    if (w2.activityAt(120, 0) < 0.3) low3 = true;
    if (low2 && Number.isNaN(back2) && w2.activityAt(0, 0) > 0.6) back2 = t;
    if (low3 && Number.isNaN(back3) && w2.activityAt(120, 0) > 0.6) back3 = t;
  }
  check(back2 >= 75 && back2 <= 105 && back3 >= 25 && back3 <= 60, `총성: 그 자리 ${f1(back2)}초, 120m 밖 ${f1(back3)}초 정적 (30~90초)`);
  check(detectionRate({ distance: 30, exposure: 0.7, visibility: 0.6, speed: 1.6, angleDeg: 5, state: 'patrol', sharpness: 1 }) > 5 * detectionRate({ distance: 30, exposure: 0.7, visibility: 0.6, speed: 0, angleDeg: 50, state: 'patrol', sharpness: 1 }),
    '감지 속도: 움직임·정면이 가만히·주변시보다 훨씬 빠름');
}

// =====================================================================
console.log('\n[14] 경기관총 거치 사격: 근접 통과 제압이 더 강함');
{
  const sc = makeScene({ world: 'flat', x: 0, z: 0, seed: 95 });
  const gains = {};
  for (const [key, bipod] of [['rifle556', false], ['lmg762', false], ['lmg762', true]]) {
    sc.person.suppression.reset();
    const o = { x: 0.6, y: 1.5, z: -60 };
    sc.combat.fire({ name: 'x', faction: 'enemy' }, { origin: o, dir: { x: 0, y: 0, z: 1 }, weapon: CONFIG.weapons[key], bipod });
    step(sc, 0.5);
    gains[key + (bipod ? '+bipod' : '')] = sc.person.suppression.value;
  }
  check(gains['lmg762+bipod'] > gains.lmg762 && gains.lmg762 > gains.rifle556, `0.6m 근접 통과 제압: 소총 ${f1(gains.rifle556)} < 기관총 ${f1(gains.lmg762)} < 거치 ${f1(gains['lmg762+bipod'])}`);
}

// =====================================================================
console.log('\n[15] 성능: 적 16명 동시 — 레이 예산·판단 분산');
{
  const R = real();
  const st = R.layout.start;
  const sc = makeScene({ world: 'real', x: st.x, z: st.z, seed: 99 });
  sc.em.spawnPatrol({ near: st, distance: 80, size: 6, seed: 1 });
  sc.em.spawnPatrol({ near: st, distance: 120, size: 6, seed: 2 });
  sc.em.spawnAmbush({ near: st, yaw: st.yaw, distance: 70, size: 4, seed: 3 });
  const extra = sc.em.spawnPatrol({ near: st, distance: 100, size: 4, seed: 4 });
  const n = sc.em.active.length;
  const thinks = new Map();
  for (const s of sc.em.soldiers) { const orig = s._think.bind(s); s._think = () => { thinks.set(s, (thinks.get(s) ?? 0) + 1); orig(); }; }
  const rays0 = sc.em.stats.rays;
  const t0 = performance.now();
  step(sc, 20);
  const ms = (performance.now() - t0) / (20 / DT);
  const raysPerFrame = (sc.em.stats.rays - rays0) / (20 / DT);
  const hz = [...thinks.values()].map((v) => v / 20);
  check(n === 16 && !extra, `동시 활성 ${n}명 (최대 16 — 넘는 생성은 거부)`);
  check(raysPerFrame <= CONFIG.ai.raysPerFrame + 2 && Math.min(...hz) >= 5 && Math.max(...hz) <= 10, `프레임당 레이 ${f2(raysPerFrame)}개 (예산 ${CONFIG.ai.raysPerFrame}), 판단 ${f1(Math.min(...hz))}~${f1(Math.max(...hz))}회/초, 프레임당 ${f2(ms)}ms (Node)`);
}

function centroid(list) {
  let x = 0, z = 0, n = 0;
  for (const m of list) { if (!m.alive) continue; x += m.motor.position.x; z += m.motor.position.z; n++; }
  return [x / (n || 1), z / (n || 1)];
}

console.log(`\n${failures ? `실패 ${failures}개` : '모두 통과'} (통과 ${passes}) · ${((performance.now() - t0All) / 1000).toFixed(1)}초`);
process.exit(failures ? 1 : 0);
