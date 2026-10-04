// 7단계 헤드리스 검증 (렌더링 없음) — 아군 분대·명령·지원 화력·보급
//   node scripts/squad-check.mjs   (npm run squad)
// 대형 유지 (오솔길 일렬·숲 쐐기, 5~10m) · 첨병 함정 발견 → '정지! 철선!' 분대 정지 · 발견 못 한 함정은 분대원도 밟음 ·
// 수신호 (거리·밤 빛·시야 레이·나를 보고 있나) vs 외치기 (소음 — 적도 들음) · 제압 60 이상 사격 0·이동 명령 거부 ·
// 의무병 처치 시간 (×1/1.5)·플레이어 처치 · 부상자 끌기·업기 · 탄약 던지기 조건 · 적 발견 보고 (시계 방향·거리) · 오인 사격 집계 ·
// 지원 화력 (도착 시간·시험 사격 오차·수정 후 오차·건너뛰기·위험 근접·공중 폭발·횟수 제한·지금 불가·조명탄·헬기 보급·적 박격포) ·
// 무전병 사망 → 무전기 줍기로 요청 가능 · 분대/단독 모드 임무 · 성능 (적 16 + 아군 5)
import { CONFIG } from '../src/config.js';
import { RNG } from '../src/core/rng.js';
import { generateWorld } from '../src/world/WorldGen.js';
import { WorldQuery } from '../src/world/WorldQuery.js';
import { SURFACE } from '../src/world/Surfaces.js';
import { HumanMotor } from '../src/human/HumanMotor.js';
import { computeExposure } from '../src/human/Exposure.js';
import { NoiseEvents } from '../src/core/NoiseEvents.js';
import { CombatSystem } from '../src/combat/CombatSystem.js';
import { BulletWorld, createFlatWorld } from '../src/combat/BulletWorld.js';
import { Injuries, makeTestHit } from '../src/combat/Injuries.js';
import { NavGrid } from '../src/ai/NavGrid.js';
import { EnemyManager } from '../src/ai/EnemyManager.js';
import { Squad } from '../src/ai/Squad.js';
import { Soldier } from '../src/ai/Soldier.js';
import { FriendSquad, makeRoster, iGa } from '../src/ai/FriendSquad.js';
import { TrapField } from '../src/combat/Traps.js';
import { FireSupport } from '../src/combat/FireSupport.js';
import { Flares } from '../src/world/Night.js';
import { analyzeWorld, generateMission, MISSION_TYPES } from '../src/mission/MissionGen.js';
import { MissionRuntime } from '../src/mission/MissionRuntime.js';

const DT = 1 / 20;
const LIGHT = { daylight: 1, sunOffset: { x: 8, z: 12 } };
let failures = 0, passes = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (ok) passes++; else failures++; };
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));
const pct = (v) => `${(v * 100).toFixed(0)}%`;
const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const d2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const yawOf = (dx, dz) => Math.atan2(-dx, -dz);
const t0All = performance.now();

// ---------------------------------------------------------------------
// 세계: 실제 맵 / 평지 (시야 레이를 막을 수 있음)
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
  constructor() { this.half = 200; this.size = 400; this.wetness = 0; this.block = null; this.canopy = 0; this.circleGrid = { forEachNear() {}, at: () => EMPTY }; this.supportGrid = { forEachNear() {}, at: () => EMPTY }; }
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
  getCanopyCover() { return this.canopy; }
  // block: { x } — 이 x 좌표를 가로지르는 시야는 막힘 (덤불 벽)
  raycastWorld(o, d, max) {
    if (this.block) {
      const B = this.block, L = Math.hypot(d.x, d.y, d.z) || 1;
      const ex = o.x + d.x / L * max;
      if ((o.x - B.x) * (ex - B.x) < 0) return { hit: false, distance: max, point: null, object: null, transmittance: 0.05, passed: [] };
    }
    return { hit: false, distance: max, point: null, object: null, transmittance: 1, passed: [] };
  }
}
let FLAT = null;
function flat() {
  if (!FLAT) { const q = new FlatQuery(); FLAT = { q, nav: new NavGrid(q, null), layout: null }; }
  FLAT.q.block = null; FLAT.q.canopy = 0;
  return FLAT;
}

/** 장면: 플레이어 (기본 무적) + 관리자 + 분대 */
function makeScene({ world = 'flat', x = 0, z = 0, yaw = 0, seed = 1, size = 4, invulnerable = true, squad = true, traps = false } = {}) {
  const W = world === 'real' ? real() : flat();
  const noise = new NoiseEvents();
  const combat = new CombatSystem(W.q, noise, { world: world === 'real' ? new BulletWorld(W.q) : createFlatWorld(0), rng: new RNG(seed * 7 + 3) });
  // 게임과 같은 장비 무게 (기본 + 소총·탄창 6개 + 낱발 90 + 수통 2)
  const motor = new HumanMotor(W.q, { x, z, yaw, noise, name: 'player', loadKg: CONFIG.load.baseKg + 4.3 + 3.9 + 0.9 + 2.4 });
  const inj = new Injuries({ rng: new RNG(seed + 5), motor, isPlayer: true });
  inj.invulnerable = invulnerable;
  const pose = () => ({ x: motor.position.x, y: motor.position.y, z: motor.position.z, yaw: motor.yaw, stance: motor.stance, stanceFrom: motor.stanceFrom, stanceProgress: motor.stanceProgress, lean: 0, arms: 'rifle', eyeHeight: motor.eyeHeight });
  const person = combat.addPerson({ name: 'player', isPlayer: true, noiseSource: motor, getPose: pose, injuries: inj });
  const sc = { W, noise, combat, motor, inj, person, expo: 0.5, expoT: 0, time: 0, light: 1 };
  sc.target = { person, motor, injuries: inj, get alive() { return !inj.dead; }, exposure: () => sc.expo, ambient: () => sc.light, lamp: () => null };
  sc.em = new EnemyManager({ query: W.q, combat, noise, layout: W.layout, nav: W.nav, rng: new RNG(seed * 13 + 1) });
  sc.em.setTarget(sc.target);
  sc.em.lightAtGround = () => sc.light;
  sc.em.fieldEnv = { heat: 0, rain: 0, night: 0, wetness: 0 };
  if (traps) { sc.traps = new TrapField({ query: W.q, combat, noise, rng: new RNG(seed * 31 + 9) }); sc.em.traps = sc.traps; }
  if (squad) sc.sq = FriendSquad.spawn(sc.em, makeRoster(seed * 101 + 7, size), { seed, at: motor.position, yaw });
  sc.says = [];
  sc.em.on('say', (e) => sc.says.push({ t: sc.time, who: e.soldier?.name ?? '플레이어', text: e.text, kind: e.kind }));
  return sc;
}

function step(sc, seconds, fn = null) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    if (fn && fn(sc, sc.time) === false) return false;
    sc.combat.update(DT);
    sc.motor.update(DT);
    sc.noise.update(DT);
    sc.expoT -= DT;
    if (sc.expoT <= 0) { sc.expoT = 0.1; sc.expo = computeExposure(sc.motor, sc.W.q, LIGHT).value; }
    sc.em.update(DT);
    if (sc.traps) sc.traps.update(DT, sc.trapCtx ?? {});
    if (sc.fs) sc.fs.update(DT);
    sc.time += DT;
  }
  return true;
}

/** 플레이어를 점 목록을 따라 걷게 (조용히) */
function walker(sc, pts, gait = 'quiet') {
  let wp = 0;
  return () => {
    const m = sc.motor, g = pts[Math.min(wp, pts.length - 1)];
    const dx = g.x - m.position.x, dz = g.z - m.position.z;
    if (Math.hypot(dx, dz) < 1.5 && wp < pts.length - 1) wp++;
    const done = wp >= pts.length - 1 && Math.hypot(dx, dz) < 1.5;
    m.yaw = yawOf(dx, dz);
    m.input.move.z = done ? 0 : 1;
    m.input.quiet = gait === 'quiet';
    m.input.sprint = gait === 'sprint';
  };
}

/** 적 병사 하나 (분대에 넣어) */
function addEnemy(sc, { x, z, yaw = 0, state = 'patrol', seed = 1, squad = null }) {
  let sq = squad;
  if (!sq) { sq = new Squad(sc.em, { type: 'patrol', rng: new RNG(seed * 3 + 1) }); sc.em.squads.push(sq); }
  const s = new Soldier(sc.em, { x, z, yaw, rng: new RNG(seed), weapon: 'rifle556' });
  sc.em._addSoldier(s);
  sq.add(s);
  s.look.yaw = yaw;
  sq.state = state;
  return { s, sq };
}

/** 분대원 다치게 (실제 탄과 같은 경로) */
function wound(s, kind, opts = {}, shooter = null) {
  s.person.refresh();
  const hit = makeTestHit(s.person, kind, opts);
  hit.shooter = shooter;
  const r = s.injuries.applyHit(hit, opts);
  hit.wound = r;
  return r;
}

const byJob = (sq, job) => sq.members.find((m) => m.job === job);
const trailPts = (W, k = 0, stride = 3) => { const T = W.layout.trails[k]; const pts = []; for (let i = 0; i < T.line.count; i += stride) pts.push({ x: T.line.x[i], z: T.line.z[i] }); return pts; };

// =====================================================================
console.log('\n[1] 대형: 오솔길 일렬 · 숲 쐐기 — 5~10m 간격으로 따라옴, 첨병은 앞');
{
  const W = real();
  const pts = trailPts(W, 0);
  const st = pts[10];
  const sc = makeScene({ world: 'real', x: st.x, z: st.z, yaw: yawOf(pts[11].x - st.x, pts[11].z - st.z), seed: 3, size: 4 });
  const walk = walker(sc, pts.slice(11, 60));
  const gaps = [], ahead = [], spacingIn = [];
  let fileSeen = 0, samples = 0;
  step(sc, 70, (s, t) => {
    walk();
    if (t > 25 && Math.round(t / DT) % 20 === 0) {
      samples++;
      if (sc.sq.autoFormation === 'file') fileSeen++;
      const P = sc.motor.position, H = sc.sq._heading;
      const pm = byJob(sc.sq, 'point');
      ahead.push((pm.motor.position.x - P.x) * H.x + (pm.motor.position.z - P.z) * H.z);
      // 뒤따르는 사람들: 플레이어부터 차례로 (지나온 길 위 순서) 이웃 간격
      const rear = sc.sq.members.filter((m) => m.job !== 'point').map((m) => ({ m, d: d2(m.motor.position, P) })).sort((a, b) => a.d - b.d);
      let prev = P;
      for (const r of rear) { const g = d2(r.m.motor.position, prev); gaps.push(g); if (g >= 4 && g <= 11) spacingIn.push(1); else spacingIn.push(0); prev = r.m.motor.position; }
    }
  });
  const inside = mean(spacingIn);
  check(fileSeen / samples > 0.85, `오솔길 위: 자동 대형 '일렬' ${pct(fileSeen / samples)} (표본 ${samples})`);
  check(mean(ahead) > 5 && mean(ahead) < 16, `첨병이 플레이어 앞 평균 ${f1(mean(ahead))}m (목표 ${CONFIG.allies.pointAhead}m 근처)`);
  check(inside >= 0.7, `뒤따르는 이웃 간격 4~11m 안 ${pct(inside)} (평균 ${f1(mean(gaps))}m, 목표 5~10m)`);
  // 숲으로 (오솔길에서 직각으로 벗어남)
  const P = sc.motor.position, H = sc.sq._heading;
  const side = { x: -H.z, z: H.x };
  let tgt = null;
  for (const s of [1, -1]) for (let k = 40; k <= 70 && !tgt; k += 5) {
    const c = { x: P.x + side.x * s * k, z: P.z + side.z * s * k };
    const o = W.nav.nearestOpen(c.x, c.z, 4);
    if (o && !W.nav.onTrail(o.x, o.z)) tgt = o;
  }
  const path = W.nav.findPath({ x: P.x, z: P.z }, tgt, { mode: 'normal', maxNodes: 20000 }) ?? [tgt];
  const walk2 = walker(sc, path.map((q) => ({ x: q.x, z: q.z })), 'walk');
  let wedge = 0, n2 = 0;
  const dists = [];
  step(sc, 45, (s, t) => {
    walk2();
    if (Math.round(t / DT) % 20 === 0 && !W.nav.onTrail(sc.motor.position.x, sc.motor.position.z)) {
      n2++;
      if (sc.sq.autoFormation === 'wedge') wedge++;
      for (const m of sc.sq.members) if (m.job !== 'point') dists.push(d2(m.motor.position, sc.motor.position));
    }
  });
  check(n2 > 5 && wedge / n2 > 0.7, `숲속: 자동 대형 '쐐기' ${pct(wedge / Math.max(1, n2))} (표본 ${n2})`);
  check(dists.length > 0 && mean(dists) > 3 && mean(dists) < 18, `숲속 쐐기: 분대원이 플레이어에서 평균 ${f1(mean(dists))}m`);
}

// =====================================================================
console.log('\n[2] 첨병 함정 발견 → "정지! 철선!" 분대 정지 · 발견 못 한 함정은 분대원도 밟음');
{
  const W = real();
  const pts = trailPts(W, 0);
  let found = 0, tries = 0, haltOk = 0, noTrip = 0;
  const lines = [];
  for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
    tries++;
    const st = pts[14];
    const sc = makeScene({ world: 'real', x: st.x, z: st.z, yaw: yawOf(pts[15].x - st.x, pts[15].z - st.z), seed, size: 4, traps: true });
    // 오솔길 앞 ~45m 에 인계철선 (길을 가로질러)
    const tp = pts[14 + 15], tq = pts[14 + 16];
    const tx = tq.x - tp.x, tz = tq.z - tp.z, tl = Math.hypot(tx, tz) || 1;
    sc.traps.load([{ kind: 'tripwire', x: tp.x, z: tp.z, yaw: Math.atan2(-tz / tl, tx / tl), len: 3.2, site: 'trail' }]);
    const trap = sc.traps.list[0];
    const walk = walker(sc, pts.slice(15, 60));
    let haltAt = -1, pMoveDuringHalt = 0, t0 = 0, passed = 0;
    step(sc, 200, (s, t) => {
      if (haltAt < 0 && sc.sq.log.trapHalts > 0) { haltAt = t; t0 = t; }
      // 플레이어도 정지 외침을 들으면 멈춤 (테스트: 멈춤)
      if (haltAt >= 0) { sc.motor.input.move.z = 0; if (t - t0 < 4) for (const m of sc.sq.members) if (m.job !== 'point') pMoveDuringHalt = Math.max(pMoveDuringHalt, m.motor.speed); return t - t0 < 6; }
      walk();
      // 분대가 모두 함정을 지나 15m 넘게 가면 끝
      if (trap.state !== 'armed' || sc.sq.members.every((m) => sc.traps.distanceTo(trap, m.motor.position.x, m.motor.position.z) > 15) && d2(sc.motor.position, pts[14]) > d2(trap, pts[14]) + 15) passed += DT;
      return passed < 1;
    });
    const say = sc.says.find((x) => x.text.startsWith('정지!'));
    if (sc.sq.log.trapHalts > 0) found++;
    if (say && /철선/.test(say.text) && pMoveDuringHalt < 1.6) haltOk++;
    if (trap.state === 'armed') noTrip++;
    lines.push(`${seed}: ${say ? `${say.who} "${say.text}" ${f1(say.t)}s` : '못 찾음'} · 정지 중 최고 속도 ${f2(pMoveDuringHalt)}m/s · 함정 ${trap.state}`);
  }
  console.log('     ' + lines.join('\n     '));
  check(found >= Math.ceil(tries * 0.6), `첨병이 낮에 길 위 인계철선을 찾음 ${found}/${tries} (6단계 규칙 — 조용히 걸으면 약 8할, 놓치면 밟음)`);
  check(haltOk >= found - 1 && haltOk > 0, `"정지! 철선!" 외침 + 분대 정지 (멈춰 섬) ${haltOk}/${found}`);
  check(noTrip >= found - 1, `찾은 함정은 아무도 건드리지 않음 (남은 함정 ${noTrip}개 / 찾은 ${found}개)`);
  // 발견 못 한 지뢰: 분대원이 밟으면 터짐 (분대원도 같은 규칙)
  const sc = makeScene({ world: 'flat', x: 0, z: 0, yaw: 0, seed: 29, size: 4, traps: true });
  step(sc, 2);
  const mg = byJob(sc.sq, 'mg');
  let blew = null, knownBefore = false;
  sc.traps.on('known', (e) => { if (!blew && e.how !== 'trigger') knownBefore = true; });
  sc.traps.on('explode', (e) => { blew = blew ?? e; });
  // 이동 명령 → 기관총수가 갈 자리와 지금 자리 사이에 (밤 — 첨병도 못 봄) 지뢰
  sc.light = 0.02;
  sc.sq.issue('moveTo', 'shout', { point: { x: 0, y: 0, z: -40 }, dir: { x: 0, z: -1 } });
  step(sc, 2.5);
  const sl = sc.sq.slotFor(mg), mp = mg.motor.position;
  sc.traps.load([{ kind: 'mine', x: mp.x + (sl.x - mp.x) * 0.5, z: mp.z + (sl.z - mp.z) * 0.5, site: 'trail' }]);
  step(sc, 30, () => !blew);
  sc.light = 1;
  check(!!blew && !knownBefore, `모르는 지뢰를 분대원이 밟음 → 폭발 (${blew ? '터짐' : '안 터짐'})`);
}

// =====================================================================
console.log('\n[3] 수신호: 거리·밤 빛·시야(레이)·나를 보는가 — 소리 없음 / 외치기: 모두 받고 소음 이벤트 (적도 들음)');
{
  const sc = makeScene({ world: 'flat', x: 0, z: 0, yaw: 0, seed: 31, size: 4 });
  step(sc, 1);
  const sq = sc.sq, P = sc.motor.position;
  const place = (m, x, z, faceMe = true) => { m.motor.teleport(x, z, 0); m.look.yaw = faceMe ? yawOf(P.x - x, P.z - z) : yawOf(x - P.x, z - P.z); m.pendingOrders.length = 0; };
  const flush = () => { for (const m of sq.members) m.pendingOrders.length = 0; };
  const noises = [];
  sc.noise.on('noise', (e) => noises.push(e));
  // 낮 · 8~25m · 나를 봄 → 모두 받음
  sq.members.forEach((m, i) => place(m, 8 + i * 5, 4));
  const n0 = noises.length;
  let r = sq.issue('halt', 'signal', { light: 1 });
  flush();
  check(r.receivers.length === sq.members.length && noises.length === n0, `낮 8~23m, 나를 봄: ${r.receivers.length}/${sq.members.length}명 받음 · 소음 ${noises.length - n0}개`);
  // 30m 밖
  sq.members.forEach((m, i) => place(m, 32 + i * 3, 4));
  r = sq.issue('follow', 'signal', { light: 1 });
  flush();
  check(r.receivers.length === 0, `30m 밖: ${r.receivers.length}명`);
  // 밤 (빛 0.02) — 8m 는 못 보고 4m 는 봄
  sq.members.forEach((m, i) => place(m, i === 0 ? 4 : 8 + i * 2, 1));
  r = sq.issue('prone', 'signal', { light: 0.02 });
  flush();
  const night = CONFIG.allies.signal.range * Math.max(CONFIG.allies.signal.nightMin, Math.sqrt(0.02));
  check(r.receivers.length === 1 && r.receivers[0] === sq.members[0], `밤 (빛 0.02 → ${f1(night)}m): 4m 1명만 받음 (${r.receivers.length}명)`);
  // 시야가 막힘 (덤불 벽)
  sc.W.q.block = { x: 5 };
  sq.members.forEach((m, i) => place(m, 10 + i * 3, 2));
  r = sq.issue('hold', 'signal', { light: 1 });
  flush();
  check(r.receivers.length === 0, `덤불 벽 너머: ${r.receivers.length}명`);
  sc.W.q.block = null;
  // 등을 돌림 → 가끔 돌아봄 (glance 확률)
  let got = 0, tot = 0;
  for (let k = 0; k < 120; k++) {
    sq.members.forEach((m, i) => place(m, 10 + i * 3, 2, false));
    r = sq.issue('file', 'signal', { light: 1 });
    flush();
    got += r.receivers.length; tot += sq.members.length;
  }
  check(Math.abs(got / tot - CONFIG.allies.signal.glance) < 0.12, `등을 돌린 분대원이 돌아봐서 받음 ${pct(got / tot)} (기준 ${pct(CONFIG.allies.signal.glance)})`);
  // 외치기: 등 돌림·벽 너머·50m 까지 모두 받고 소음 반경 60m (적이 들음)
  sc.W.q.block = { x: 5 };
  sq.members.forEach((m, i) => place(m, 15 + i * 10, 2, false));
  const { s: en, sq: esq } = addEnemy(sc, { x: -40, z: -30, yaw: 0, seed: 33 });
  const n1 = noises.length;
  r = sq.issue('halt', 'shout', {});
  flush();
  const ns = noises.slice(n1).filter((e) => e.kind === 'shout' && e.source === sc.motor);
  step(sc, 1.5);
  sc.W.q.block = null;
  check(r.receivers.length === sq.members.length && ns.length === 1 && ns[0].radius === CONFIG.allies.shout.radius,
    `외치기: ${r.receivers.length}/${sq.members.length}명 받음 (등 돌림·벽 너머 포함) · 소음 반경 ${ns[0]?.radius}m`);
  check(esq.state !== 'patrol' || en.memory, `50m 밖 적이 외침을 들음 → 분대 '${esq.state}'`);
  // 실행 지연 0.5~2초
  sq.members.forEach((m, i) => place(m, 6 + i * 3, 2));
  const delays = [];
  let tIssue = 0;
  sc.em.on('orderApplied', (e) => { if (e.order.key === 'freeFire' && e.order.issuedAt === tIssue) delays.push(sc.em.time - e.order.issuedAt); });
  for (let k = 0; k < 10; k++) {
    sq.members.forEach((m, i) => place(m, 6 + i * 3, 2));
    tIssue = sc.em.time;
    sq.issue('freeFire', 'signal', { light: 1 });
    step(sc, 2.4);
  }
  const [lo, hi] = CONFIG.allies.orderDelay;
  check(delays.length >= sq.members.length * 9 && Math.min(...delays) >= lo - 0.06 && Math.max(...delays) <= hi + 0.06,
    `받은 뒤 실행까지 ${f2(Math.min(...delays))}~${f2(Math.max(...delays))}초 (기준 ${lo}~${hi}, ${delays.length}번)`);
}

// =====================================================================
console.log('\n[4] 제압 60 이상: 반격 사격 0 · 이동 명령 거부 (내려가면 따름)');
{
  const sc = makeScene({ world: 'flat', x: 0, z: 0, yaw: 0, seed: 41, size: 4 });
  step(sc, 2);
  const a = byJob(sc.sq, 'rifleman') ?? sc.sq.members.find((m) => m.job !== 'point' && m.job !== 'radio');
  a.motor.teleport(3, 0, 0);
  a.injuries.invulnerable = true;   // 검사 동안 죽지 않게 (제압·명령만 봄)
  // 적 2명: 북쪽 45m, 서서 이쪽을 봄
  const { sq: esq } = addEnemy(sc, { x: -3, z: -45, yaw: Math.PI, state: 'engaged', seed: 43 });
  addEnemy(sc, { x: 5, z: -47, yaw: Math.PI, state: 'engaged', seed: 44, squad: esq });
  const sup = (v) => { a.person.suppression.value = v; };
  let shots = 0;
  sc.combat.on('shot', (e) => { if (e.shooter === a.person) shots++; });
  // 다른 분대원 (제압 없음) 은 사격함 — 같은 15초 동안
  const others = sc.sq.members.filter((m) => m !== a && m.job !== 'radio');
  let oshots = 0;
  sc.combat.on('shot', (e) => { if (others.some((m) => m.person === e.shooter)) oshots++; });
  // 제압 80 유지 15초
  sc.sq.issue('moveTo', 'shout', { point: { x: 3, y: 0, z: 30 }, dir: { x: 0, z: 1 } });
  const p0 = { ...a.motor.position };
  step(sc, 15, () => sup(80));
  const moved = d2(a.motor.position, p0);
  check(shots === 0, `제압 80 동안 이 분대원의 사격 ${shots}발 (적 보임: ${a.perception.seesAny ? '예' : '아니오'})`);
  check(a.ord.move !== 'moveTo' && a.pendingOrders.some((o) => o.key === 'moveTo'), `이동 명령 거부 (받은 채 미룸): 지금 명령 '${a.ord.move}', 미룬 명령 ${a.pendingOrders.length}개 · 이동 ${f1(moved)}m`);
  check(oshots > 0, `같은 동안 제압이 낮은 분대원은 보이는 적에 사격 (${oshots}발)`);
  // 적을 치우고 제압이 내려가면 (45 아래) 미룬 이동 명령을 따름
  sc.em.clearEnemies();
  const tRel = sc.time;
  let applied = -1;
  step(sc, 20, (s, t) => { if (a.ord.move === 'moveTo' && applied < 0) applied = t; return applied < 0; });
  check(applied > 0, `제압이 내려가자 미룬 이동 명령 실행 (${f1(applied - tRel)}초 뒤, 제압 ${Math.round(a.suppression)})`);
}

// =====================================================================
console.log('\n[5] 의무병 처치 (플레이어보다 1.5배 빠름) · 플레이어 처치 · 부상자 끌기 · 업기 · 탄약 던지기 조건');
{
  const sc = makeScene({ world: 'flat', x: 0, z: 0, yaw: 0, seed: 51, size: 4 });
  step(sc, 2);
  const md = byJob(sc.sq, 'medic'), mg = byJob(sc.sq, 'mg');
  const ev = [];
  sc.em.on('treat', (e) => ev.push({ t: sc.em.time, ...e }));
  wound(mg, 'forearmL', { forceArterial: false });
  step(sc, 25, () => !ev.some((e) => e.phase === 'done' && e.patient === mg));
  const s0 = ev.find((e) => e.phase === 'start' && e.patient === mg), dn = ev.find((e) => e.phase === 'done' && e.patient === mg);
  const base = CONFIG.injury.aid.bandageTime, want = base / CONFIG.allies.medic.speedMul;
  check(!!s0 && Math.abs(s0.duration - want) < 0.01, `의무병 붕대 시간 ${f2(s0?.duration)}초 (플레이어 ${base}초 ÷ ${CONFIG.allies.medic.speedMul})`);
  check(!!dn && dn.t - s0.t >= want - 0.1 && dn.t - s0.t < want + 1.5 && mg.injuries.wounds.every((w) => w.bandaged || w.type === 'graze'),
    `처치 완료 ${dn ? f2(dn.t - s0.t) : '-'}초 뒤 · 상처 붕대 ${mg.injuries.wounds.filter((w) => w.bandaged).length}/${mg.injuries.wounds.length}`);
  check(sc.says.some((x) => x.who === mg.name && x.text.includes('의무병')), `다친 분대원이 "의무병!" 외침`);
  // 플레이어가 다침 → 의무병이 와서 처치
  sc.inj.invulnerable = false;
  sc.person.refresh();
  const hit = makeTestHit(sc.person, 'thighL', { forceArterial: false });
  hit.shooter = null;
  sc.inj.applyHit(hit, { forceArterial: false });
  sc.inj.invulnerable = true;
  const n0 = ev.length;
  step(sc, 40, () => !ev.slice(n0).some((e) => e.phase === 'done' && e.patient === sc.target));
  const pd = ev.slice(n0).find((e) => e.phase === 'done' && e.patient === sc.target);
  check(!!pd && sc.inj.wounds.some((w) => w.bandaged), `의무병이 플레이어를 처치 (${pd ? `${pd.kind} 완료` : '안 됨'}) — 의무병 물자 붕대 ${md.medKit.bandages}개 남음`);
  // 끌기: 교전 중 쓰러진 분대원 → 제압 낮은 동료가 끌고 감
  const sc2 = makeScene({ world: 'flat', x: 0, z: 0, yaw: 0, seed: 53, size: 4 });
  step(sc2, 2);
  const w = byJob(sc2.sq, 'mg');
  w.motor.teleport(4, -6, 0);
  wound(w, 'thighL', { forceArterial: false });
  wound(w, 'thighR', { forceArterial: false });
  sc2.sq._contact({ x: 0, y: 0, z: -60 }, 4);
  const p0 = { ...w.motor.position };
  let dragger = null;
  step(sc2, 25, () => { sc2.sq.contactAt = sc2.em.time; dragger = dragger ?? sc2.sq.members.find((m) => m.drag?.wounded === w); });
  check(!!dragger && d2(w.motor.position, p0) > 2, `교전 중 쓰러진 ${w.name} → ${dragger ? dragger.name + iGa(dragger.name) : '아무도 안'} 끌고 감 ${f1(d2(w.motor.position, p0))}m`);
  // 업기: 평시 이동 중 걷지 못하는 부상자
  const sc3 = makeScene({ world: 'flat', x: 0, z: 0, yaw: 0, seed: 55, size: 5 });
  step(sc3, 2);
  const v = byJob(sc3.sq, 'rifleman');
  wound(v, 'thighL', { forceArterial: false });
  wound(v, 'thighR', { forceArterial: false });
  v.injuries.bandages = 0; v.injuries.tourniquets = 0;
  for (const wd of v.injuries.wounds) wd.bandaged = true;   // 처치는 끝남 — 걷지는 못함
  sc3.sq.state = 'calm';
  let carrier = null, carriedT = 0;
  const pts = [{ x: 0, z: -80 }];
  const walk = walker(sc3, pts, 'walk');
  const v0 = { ...v.motor.position };
  step(sc3, 50, () => { walk(); sc3.sq.contactAt = -1e9; carrier = carrier ?? sc3.sq.members.find((m) => m.carry?.wounded === v); if (v.carriedBy) carriedT += DT; });
  check(v.cannotWalk && !!carrier && carriedT > 5 && d2(v.motor.position, v0) > 8, `걷지 못하는 ${v.name} → ${carrier ? carrier.name + iGa(carrier.name) : '아무도 안'} 업고 감 (${f1(carriedT)}초, ${f1(d2(v.motor.position, v0))}m) · 업은 사람은 쏘지 않음`);
  // 탄약 던지기: 예비 탄창 3개 이상인 가장 가까운 분대원 / 모자라면 거절
  const sc4 = makeScene({ world: 'flat', x: 0, z: 0, yaw: 0, seed: 57, size: 4 });
  step(sc4, 2);
  const arrive = [];
  sc4.em.on('ammoArrive', (e) => arrive.push({ t: sc4.em.time, ...e }));
  const ri = sc4.sq.members.filter((m) => !m.weaponData.bipod);
  ri.forEach((m, i) => { m.motor.teleport(3 + i * 4, 3, 0); m.look.yaw = yawOf(-m.motor.position.x, -m.motor.position.z); });
  const g0 = ri[0];
  const mags0 = g0.spareMags;
  sc4.sq.issue('ammo', 'shout', {});
  step(sc4, 6);
  check(arrive.length === 1 && arrive[0].from === g0 && g0.spareMags === mags0 - 1, `'탄약 줘': 가장 가까운 ${g0.name}${iGa(g0.name)} (예비 ${mags0}개) 1개 던짐 → 받음 ${arrive.length}개 (${arrive[0]?.rounds}발)`);
  // 모두 예비 탄창 2개뿐 → 거절
  for (const m of ri) { const w = m.shooter.weapon; while (m.spareMags > 2) { const i = w._bestSpareMag(); w.mags.splice(i, 1); if (i < w.magIndex) w.magIndex--; } }
  const n1 = arrive.length;
  sc4.sq.issue('ammo', 'shout', {});
  step(sc4, 6);
  check(arrive.length === n1 && sc4.says.some((x) => x.text.includes('탄창이 얼마 없다')), `예비 탄창 2개 이하: 던지지 않음 ("탄창이 얼마 없다!")`);
  // 기관총수는 던지지 않음 (탄띠)
  const mgs = byJob(sc4.sq, 'mg');
  check(!!mgs && mgs.give === null, `기관총수는 탄창을 주지 않음 (탄띠)`);
}

// =====================================================================
console.log('\n[6] 교전: 적 발견 보고 (분대 진행 방향 기준 시계·거리, 가끔 틀림) · 스스로 엄폐·사격 · 오인 사격');
{
  const sc = makeScene({ world: 'flat', x: 0, z: 0, yaw: 0, seed: 61, size: 4 });
  // 진행 방향 = 북(−Z): 걷기
  const walk = walker(sc, [{ x: 0, z: -15 }], 'walk');
  step(sc, 6, walk);
  sc.motor.input.move.z = 0;
  const H = sc.sq._heading;
  // 시계 방향 계산: 앞(12시)·오른쪽(3시)·뒤(6시)·왼쪽(9시)
  const P = { x: 0, z: 0 };
  const right = { x: -H.z, z: H.x };
  const c12 = sc.sq.clockOf(P, { x: H.x * 50, z: H.z * 50 }), c3 = sc.sq.clockOf(P, { x: right.x * 50, z: right.z * 50 });
  const c6 = sc.sq.clockOf(P, { x: -H.x * 50, z: -H.z * 50 }), c9 = sc.sq.clockOf(P, { x: -right.x * 50, z: -right.z * 50 });
  check(c12 === 12 && c3 === 3 && c6 === 6 && c9 === 9, `시계 방향 (진행 방향 기준): 앞 ${c12}시 · 오른쪽 ${c3}시 · 뒤 ${c6}시 · 왼쪽 ${c9}시`);
  // 보고 오차: 1000번
  const rng = new RNG(5);
  let wrong = 0, dErr = [];
  const m0 = sc.sq.members[0];
  const tp = { x: m0.motor.position.x + right.x * 40 + H.x * 23, z: m0.motor.position.z + right.z * 40 + H.z * 23 };   // 약 2시, 46m
  const trueH = sc.sq.clockOf(m0.motor.position, tp), trueD = d2(m0.motor.position, tp);
  for (let k = 0; k < 1000; k++) {
    const t = sc.sq.reportText(m0, tp, rng);
    const mm = /적! (\d+)시 방향, (\d+)미터!/.exec(t);
    if (+mm[1] !== trueH) wrong++;
    dErr.push(Math.abs(+mm[2] - trueD) / trueD);
  }
  check(Math.abs(wrong / 1000 - CONFIG.allies.report.dirError) < 0.05 && mean(dErr) < 0.2,
    `보고 "적! ${trueH}시 방향, ${Math.round(trueD / 10) * 10}미터!" — 한 시간 틀림 ${pct(wrong / 1000)} · 거리 오차 평균 ${pct(mean(dErr))}`);
  // 실제 교전: 북쪽 60m 적 2명 (보고·사격·엄폐)
  const { sq: esq } = addEnemy(sc, { x: -5, z: -70, yaw: Math.PI, state: 'patrol', seed: 63 });
  addEnemy(sc, { x: 6, z: -72, yaw: Math.PI, state: 'patrol', seed: 64, squad: esq });
  let fShots = 0;
  sc.combat.on('shot', (e) => { if (sc.sq.members.some((m) => m.person === e.shooter)) fShots++; });
  step(sc, 30);
  const rep = sc.says.find((x) => x.kind === 'contactReport');
  check(!!rep && /적! \d+시 방향, \d+미터!/.test(rep.text), `적 발견 보고: ${rep ? `${rep.who} "${rep.text}"` : '없음'}`);
  check(fShots > 0 && sc.sq.state === 'contact', `분대원 스스로 사격 ${fShots}발 · 분대 상태 '${sc.sq.state}'`);
  // 오인 사격: 플레이어 탄이 분대원에게 → 기록 + "사격 중지! 아군이다!"
  const sc2 = makeScene({ world: 'flat', x: 0, z: 0, yaw: 0, seed: 65, size: 4 });
  step(sc2, 2);
  const v = byJob(sc2.sq, 'rifleman') ?? byJob(sc2.sq, 'mg');
  v.motor.teleport(0, -12, 0);
  step(sc2, 0.5);
  v.person.refresh();
  const c = v.person.hitboxes.chest;
  const dir = { x: c.x - 0, y: c.y - 1.5, z: c.z - 0 }, dl = Math.hypot(dir.x, dir.y, dir.z);
  sc2.combat.ballistics.fire({ origin: { x: 0, y: 1.5, z: 0 }, dir: { x: dir.x / dl, y: dir.y / dl, z: dir.z / dl }, speed: 700, shooter: sc2.person, weapon: CONFIG.weapons.rifle762 });
  step(sc2, 2.5);
  check(v.friendlyHits === 1 && sc2.sq.log.friendlyFire === 1 && sc2.says.some((x) => x.who === v.name && x.text.includes('아군')),
    `플레이어 탄 → ${v.name}: 아군 피격 ${v.friendlyHits} · 분대 기록 ${sc2.sq.log.friendlyFire} · "사격 중지! 아군이다!"`);
  // 결과 집계 (MissionRuntime._friendlyFire 를 그대로 — 같은 사수·피해자 3초 안 연발은 한 건)
  const fake = { squadMode: true, _ff: { incidents: 0, hits: 0, list: [], last: new Map() }, g: { playerPerson: sc2.person, enemies: sc2.em, onFriendlyFire: null } };
  const ffe = (shooter, person) => MissionRuntime.prototype._friendlyFire.call(fake, { shooter, person, wound: null });
  const other = sc2.sq.members.find((m) => m !== v);
  ffe(sc2.person, v.person); ffe(sc2.person, v.person); ffe(other.person, sc2.person);
  ffe({ isShell: true, faction: 'friend', name: '박격포' }, v.person);
  ffe({ isShell: true, faction: 'enemy', name: '적 박격포' }, v.person);
  check(fake._ff.incidents === 3 && fake._ff.hits === 4, `오인 사격 집계: ${fake._ff.incidents}건 (${fake._ff.list.join(' · ')}) · 명중 ${fake._ff.hits} — 적 포탄은 제외`);
}

// =====================================================================
console.log('\n[7] 지원 화력: 도착 시간 · 시험 사격 오차 → 수정 후 오차 · 건너뛰기 · 위험 근접 · 공중 폭발 · 횟수 · 지금 불가');
{
  const S = CONFIG.support;
  const unav = S.unavailable;
  S.unavailable = 0;   // 결정적 검사 (불가 확률은 아래에서 따로)
  const q = new FlatQuery();
  const mk = (seed, friendlies = [{ x: 0, z: 0 }], combat = null, flares = null) => new FireSupport({ query: q, rng: new RNG(seed), friendlies: () => friendlies, combat, flares });
  const run = (fs, sec, fn) => { for (let t = 0; t < sec; t += 0.1) { fs.update(0.1); if (fn && fn() === false) break; } };
  // 도착 시간 (요청 → 첫 탄착)
  const arr = { mortar: [], artillery: [] };
  for (const kind of ['mortar', 'artillery']) {
    for (let k = 0; k < 40; k++) {
      const fs = mk(100 + k);
      const r = fs.request(kind, { x: 0, z: -400 }, { mode: 'ffe' });
      let first = -1;
      fs.on('impact', () => { if (first < 0) first = fs.time; });
      run(fs, 300, () => first < 0);
      arr[kind].push(first - r.mission.requestedAt);
    }
  }
  const inR = (a, r) => a.every((v) => v >= r[0] - 0.5 && v <= r[1] + 0.5);
  check(inR(arr.mortar, S.mortar.arrive), `박격포 도착 ${f1(Math.min(...arr.mortar))}~${f1(Math.max(...arr.mortar))}초 (기준 ${S.mortar.arrive.join('~')})`);
  check(inR(arr.artillery, S.artillery.arrive), `포병 도착 ${f1(Math.min(...arr.artillery))}~${f1(Math.max(...arr.artillery))}초 (기준 ${S.artillery.arrive.join('~')})`);
  // 시험 사격 → 수정 → 효력 사격
  const spotE = [], centerE = [], roundsN = [], spread = [];
  const target = { x: 50, z: -400 };
  for (let k = 0; k < 60; k++) {
    const fs = mk(300 + k);
    const r = fs.request('mortar', target, { mode: 'adjust' });
    const imp = [];
    fs.on('impact', (e) => imp.push(e));
    run(fs, 200, () => !imp.length);
    spotE.push(d2(imp[0].point, target));
    // 플레이어가 탄착을 보고 원래 표적 그대로 다시 지정 (완벽한 수정)
    fs.adjust(r.mission, target);
    run(fs, 200, () => !r.mission.done);
    const ffe = imp.slice(1);
    roundsN.push(ffe.length);
    centerE.push(d2(r.mission.aim, target));
    for (const e of ffe) spread.push(d2(e.point, r.mission.aim));
  }
  check(Math.min(...spotE) >= S.spotError[0] - 0.01 && Math.max(...spotE) <= S.spotError[1] + 0.01, `시험 사격 오차 ${f1(Math.min(...spotE))}~${f1(Math.max(...spotE))}m (평균 ${f1(mean(spotE))}, 기준 ${S.spotError.join('~')})`);
  check(Math.min(...centerE) >= S.adjustError[0] - 0.01 && Math.max(...centerE) <= S.adjustError[1] + 0.01, `수정 뒤 효력 사격 중심 오차 ${f1(Math.min(...centerE))}~${f1(Math.max(...centerE))}m (기준 ${S.adjustError.join('~')})`);
  check(roundsN.every((n) => n === S.mortar.rounds) && Math.max(...spread) <= S.spread + 0.01, `효력 사격 ${S.mortar.rounds}발 · 중심에서 최대 ${f1(Math.max(...spread))}m 흩어짐 (기준 ${S.spread}m)`);
  // 시험 사격 건너뛰기 → 원래 오차
  const skipE = [];
  for (let k = 0; k < 60; k++) {
    const fs = mk(500 + k);
    const r = fs.request('artillery', target, { mode: 'ffe' });
    run(fs, 300, () => !r.mission.aim);
    skipE.push(d2(r.mission.aim, target));
  }
  check(Math.min(...skipE) >= S.spotError[0] - 0.01 && mean(skipE) > mean(centerE) * 1.8, `건너뛰기 (바로 효력 사격): 중심 오차 평균 ${f1(mean(skipE))}m — 수정한 경우 ${f1(mean(centerE))}m 의 ${f1(mean(skipE) / mean(centerE))}배`);
  // 지도에 잘못 찍은 점 → 엉뚱한 곳 (진짜 적은 150m 옆)
  {
    const fs = mk(700);
    const enemy = { x: 0, z: -400 }, wrongP = { x: 150, z: -400 };
    const r = fs.request('mortar', wrongP, { mode: 'ffe' });
    const imp = [];
    fs.on('impact', (e) => imp.push(e));
    run(fs, 200, () => !r.mission.done);
    const near = Math.min(...imp.map((e) => d2(e.point, enemy)));
    check(near > 150 - S.spotError[1] - S.spread - 1, `잘못 찍은 지점 (적에서 150m): 탄착이 적에게 가장 가까운 ${f1(near)}m — 엉뚱한 곳`);
  }
  // 위험 근접: 아군 150m 안 → 경고, 확인해야 사격 / 확인 안 하면 취소 / 200m 는 바로
  {
    const fs = mk(800, [{ x: 0, z: 0 }, { x: 10, z: -20 }]);
    const radio = [];
    fs.on('radio', (e) => radio.push(e.text));
    const r = fs.request('mortar', { x: 0, z: -120 }, { mode: 'ffe' });
    run(fs, 30, () => r.mission.state === 'radio');
    const warned = r.mission.state === 'dangerClose' && fs.pendingConfirm === r.mission && radio.some((t) => t.includes('위험 근접'));
    const leftBefore = fs.left.mortar;
    fs.confirm(r.mission);
    const imp = [];
    fs.on('impact', (e) => imp.push(e));
    run(fs, 200, () => !r.mission.done);
    check(warned && imp.length === S.mortar.rounds && leftBefore === S.mortar.count, `아군에서 ~100m 지점: 위험 근접 경고 → 확인 → 사격 ${imp.length}발 (경고 단계에서 횟수 차감 없음)`);
    const r2 = fs.request('mortar', { x: 0, z: -110 }, { mode: 'ffe' });
    run(fs, 30 + S.confirmWindow + 5);
    check(r2.mission.state === 'cancelled', `확인 안 하면 ${S.confirmWindow}초 뒤 취소 ('${r2.mission.state}')`);
    const fs2 = mk(801, [{ x: 0, z: 0 }]);
    const r3 = fs2.request('mortar', { x: 0, z: -200 }, { mode: 'ffe' });
    run(fs2, 30, () => r3.mission.state === 'radio');
    check(r3.mission.state === 'ffe', `200m 지점: 경고 없이 효력 사격 ('${r3.mission.state}')`);
  }
  // 공중 폭발: 캐노피 짙으면 나무에 걸려 터짐 (높이·파편 아래로), 트인 곳은 땅
  {
    const noise = new NoiseEvents();
    const combat = new CombatSystem(null, noise, { world: createFlatWorld(0), rng: new RNG(9) });
    const air = (canopy, n = 200) => {
      q.canopy = canopy;
      const fs = mk(900 + Math.round(canopy * 100), [{ x: 0, z: 0 }], combat);
      let ab = 0, tot = 0, hOk = true, frag = 0;
      fs.on('impact', (e) => { tot++; if (e.airburst) { ab++; if (e.point.y < S.airburst.height[0] - 0.1) hOk = false; } frag += e.result?.fragments ?? 0; });
      for (let k = 0; k < n / S.mortar.rounds; k++) { fs.resetCounts(); const r = fs.request('mortar', { x: 0, z: -500 }, { mode: 'ffe' }); run(fs, 200, () => !r.mission.done); combat.ballistics.clear(); }
      return { rate: ab / tot, hOk, frag: frag / tot };
    };
    const dense = air(0.9), open = air(0.1);
    q.canopy = 0;
    const want = Math.pow(0.9, S.airburst.exp) * S.airburst.chanceMul;
    check(Math.abs(dense.rate - want) < 0.1 && dense.hOk && open.rate === 0 && dense.frag >= S.mortar.fragments - 1,
      `공중 폭발: 캐노피 0.9 → ${pct(dense.rate)} (기준 ${pct(want)}, 높이 ${S.airburst.height.join('~')}m) · 트인 곳 ${pct(open.rate)} · 파편 ${Math.round(dense.frag)}개/발`);
  }
  // 횟수 제한 (실제로 쏠 때 차감 — 거절은 차감 없음)
  {
    const fs = mk(1000);
    const res = [];
    for (let k = 0; k < S.mortar.count + 1; k++) {
      const r = fs.request('mortar', { x: 0, z: -400 }, { mode: 'ffe' });
      res.push(r.ok ? 'ok' : r.reason);
      if (r.ok) run(fs, 200, () => !r.mission.done);
    }
    const a1 = fs.request('artillery', { x: 0, z: -400 }, { mode: 'ffe' });
    run(fs, 300, () => !a1.mission.done);
    const a2 = fs.request('artillery', { x: 0, z: -400 }, { mode: 'ffe' });
    check(res.slice(0, S.mortar.count).every((v) => v === 'ok') && res[S.mortar.count] === 'none' && a1.ok && !a2.ok && a2.reason === 'none',
      `횟수: 박격포 ${res.join(' / ')} (임무당 ${S.mortar.count}) · 포병 ${a1.ok ? 'ok' : a1.reason} / ${a2.ok ? 'ok' : a2.reason} (임무당 ${S.artillery.count})`);
    fs.resetCounts();
    check(fs.left.mortar === S.mortar.count && fs.left.artillery === S.artillery.count, `디버그 초기화 → 박격포 ${fs.left.mortar} · 포병 ${fs.left.artillery}`);
  }
  // 지금 불가 (약 15%) — 거절은 횟수 차감 없음
  S.unavailable = unav;
  {
    let denied = 0, n = 0;
    const fs = mk(1100);
    for (let k = 0; k < 400; k++) {
      fs.resetCounts();
      const r = fs.request('mortar', { x: 0, z: -400 }, { mode: 'ffe' });
      run(fs, 25, () => r.mission.state === 'radio');
      n++;
      if (r.mission.state === 'denied') { denied++; if (fs.left.mortar !== S.mortar.count) denied = -1e9; }
      fs.cancel(r.mission);
      fs.shells.length = 0;
    }
    check(Math.abs(denied / n - unav) < 0.05, `"지금은 불가" ${pct(denied / n)} (기준 ${pct(unav)}) — 거절은 횟수 차감 없음`);
  }
  S.unavailable = 0;
  // 무전 응답 지연 10~20초
  {
    const lags = [];
    for (let k = 0; k < 40; k++) {
      const fs = mk(1200 + k);
      let t1 = -1;
      fs.on('radio', () => { if (t1 < 0) t1 = fs.time; });
      fs.request('mortar', { x: 0, z: -400 }, { mode: 'adjust' });
      run(fs, 30, () => t1 < 0);
      lags.push(t1);
    }
    check(inR(lags, S.radioLag), `무전 응답 ${f1(Math.min(...lags))}~${f1(Math.max(...lags))}초 뒤 (기준 ${S.radioLag.join('~')})`);
  }
  // 조명탄 (밤만, 3발) · 헬기 보급 (개활지·3~5분·소음·상자) · 적 박격포
  {
    const flares = new Flares({ rng: new RNG(3) });
    const fs = mk(1300, [{ x: 0, z: 0 }], null, flares);
    const day = fs.request('illum', { x: 0, z: -200 }, { night: 0 });
    const r = fs.request('illum', { x: 0, z: -200 }, { night: 1 });
    let launched = 0;
    const L0 = flares.launch.bind(flares);
    flares.launch = (...a) => { launched++; return L0(...a); };
    run(fs, 120, () => !r.mission.done);
    check(!day.ok && day.reason === 'day' && r.ok && launched === S.illum.rounds, `조명탄: 낮 '${day.reason}' · 밤 ${launched}발 (기준 ${S.illum.rounds})`);
    q.canopy = 0.8;
    const fsH = mk(1400);
    const closed = fsH.request('resupply', { x: 0, z: -100 });
    q.canopy = 0.05;
    const noise = new NoiseEvents();
    fsH.noise = noise;
    const heard = [];
    noise.on('noise', (e) => heard.push(e));
    const rh = fsH.request('resupply', { x: 30, z: -100 });
    let drop = null;
    fsH.on('drop', (e) => { drop = e.crate; });
    run(fsH, 400, () => { noise.update(0.1); return !drop; });
    const U = CONFIG.supply;
    const big = heard.filter((e) => e.radius >= U.heli.noise - 1);
    check(!closed.ok && closed.reason === 'open' && rh.ok && drop && fsH.time - rh.mission.requestedAt >= U.heli.arrive[0] - 0.5 && fsH.time - rh.mission.requestedAt <= U.heli.arrive[1] + 0.5,
      `헬기 보급: 숲 위 '${closed.reason}' · 트인 곳 ${f1((fsH.time - rh.mission.requestedAt) / 60)}분 뒤 상자 (기준 ${U.heli.arrive.map((v) => v / 60).join('~')}분), 지점에서 ${f1(drop ? d2(drop, { x: 30, z: -100 }) : -1)}m`);
    check(big.length >= 2 && drop.mags === U.crate.mags && drop.loose === U.crate.loose && drop.bandages === U.crate.bandages && drop.tourniquets === U.crate.tourniquets,
      `헬기 소리 반경 ${U.heli.noise}m 소음 ${big.length}번 (접근·투하) · 상자: 탄창 ${drop.mags} · 낱발 ${drop.loose} · 붕대 ${drop.bandages} · 지혈대 ${drop.tourniquets} · 물`);
    q.canopy = 0;
    const fsE = mk(1500);
    const imp = [], launches = [];
    fsE.on('impact', (e) => imp.push(e));
    fsE.on('enemyLaunch', (e) => launches.push(e));
    const n = fsE.enemyBarrage({ x: 0, z: -300 }, { x: 0, z: 0 });
    run(fsE, 80);
    const E = S.enemyMortar;
    const errs = imp.map((e) => d2(e.point, { x: 0, z: 0 }));
    check(n >= E.rounds[0] && n <= E.rounds[1] && imp.length === n && launches.length === n && Math.max(...errs) <= E.error[1] + 0.1 && Math.min(...errs) >= E.error[0] - 0.1,
      `적 박격포: ${n}발 (발사음 ${launches.length}) · 플레이어 쪽에서 ${f1(Math.min(...errs))}~${f1(Math.max(...errs))}m (부정확 — 기준 ${E.error.join('~')}m)`);
  }
  S.unavailable = unav;
}

// =====================================================================
console.log('\n[8] 무전: 무전병 10m 안이어야 요청 가능 · 무전병이 쓰러지면 무전기를 주워 어디서든 요청');
{
  const sc = makeScene({ world: 'flat', x: 0, z: 0, yaw: 0, seed: 81, size: 4 });
  step(sc, 2);
  const ro = byJob(sc.sq, 'radio'), P = sc.motor.position;
  ro.motor.teleport(P.x + 6, P.z + 2, 0);
  const a1 = sc.sq.radioAccess(P, false);
  ro.motor.teleport(P.x + 25, P.z + 2, 0);
  const a2 = sc.sq.radioAccess(P, false);
  check(a1.ok && !a2.ok && a2.reason === 'far', `무전병 6m: ${a1.ok ? '가능' : a1.reason} · 25m: ${a2.ok ? '가능' : a2.reason}`);
  // 무전병 전사
  sc.inj.invulnerable = true;
  wound(ro, 'head', {});
  step(sc, 1);
  ro.motor.teleport(P.x + 1, P.z, 0);
  const a3 = sc.sq.radioAccess(P, false);
  const notYet = sc.sq.takeRadio(byJob(sc.sq, 'medic'));
  const took = sc.sq.takeRadio(ro);
  const a4 = sc.sq.radioAccess({ x: P.x + 300, z: P.z }, took);
  check(!ro.alive && !a3.ok && a3.reason === 'down' && !notYet && took && !ro.hasRadio && a4.ok,
    `무전병 전사 → 요청 불가 ('${a3.reason}') → 무전기 줍기 ${took ? '성공' : '실패'} (산 사람 것은 못 가져감) → 300m 밖에서도 요청 ${a4.ok ? '가능' : '불가'}`);
  check(CONFIG.allies.radioKg > 0, `무전기 무게 ${CONFIG.allies.radioKg}kg (주우면 장비 무게에 더함 — Game)`);
}

// =====================================================================
console.log('\n[9] 임무: 분대 모드 (기본) — 명단·적 증강·브리핑 / 단독 모드 — 6단계와 같음');
{
  const W = real();
  const world = { data: W.data, query: W.q, nav: W.nav };
  analyzeWorld(world);
  let okRoster = 0, okScale = 0, okSolo = 0, n = 0;
  const names = [];
  for (const type of MISSION_TYPES) {
    for (const seed of [11, 22]) {
      n++;
      const solo = generateMission(type, seed, world, { mode: 'solo' });
      const squad = generateMission(type, seed, world, { mode: 'squad' });
      if (squad.squad && squad.squad.length >= 3 && squad.squad.length <= 5 && new Set(squad.squad.map((r) => r.name)).size === squad.squad.length && squad.briefing.squad?.length === squad.squad.length) okRoster++;
      const cnt = (m) => (m.enemies.patrols ?? []).reduce((s, p) => s + (p.size ?? 0), 0) + (m.enemies.camp?.guards?.length ?? 0) + (m.enemies.ambushes ?? []).reduce((s, a) => s + (a.size ?? 0), 0);
      if (cnt(squad) >= cnt(solo)) okScale++;
      if (!solo.squad && solo.mode === 'solo' && !solo.briefing.squad) okSolo++;
      if (type === 'raid' && seed === 11) names.push(...squad.squad.map((r) => `${r.name}(${CONFIG.allies.roleLabels[r.job]})`));
    }
  }
  check(okRoster === n, `분대 모드 명단 3~5명, 이름 겹치지 않음, 브리핑에 이름·역할: ${okRoster}/${n} — 예: ${names.join(' · ')}`);
  check(okScale === n, `분대 모드 적 규모 ≥ 단독 (×${CONFIG.allies.enemyScale}): ${okScale}/${n}`);
  check(okSolo === n, `단독 모드: 분대 없음 ${okSolo}/${n}`);
  const r3 = makeRoster(5, 3);
  check(r3.length === 3 && r3.map((r) => r.job).join(',') === 'point,radio,medic', `3명 분대 역할: ${r3.map((r) => CONFIG.allies.roleLabels[r.job]).join(' · ')}`);
}

// =====================================================================
console.log('\n[10] 성능: 적 16 + 아군 5 — 레이 예산 그대로, 판단 분산');
{
  const W = real();
  const pts = trailPts(W, 0);
  const st = pts[20];
  const sc = makeScene({ world: 'real', x: st.x, z: st.z, yaw: 0, seed: 101, size: 5 });
  let n = 0;
  for (let k = 0; k < 4 && n < 16; k++) {
    const sq = sc.em.spawnPatrol({ near: { x: st.x, z: st.z }, distance: 60 + k * 20, size: 4, mg: k === 0 });
    if (sq) n += sq.members.length;
  }
  const rays0 = sc.em.stats.rays;
  let think0 = 0;
  for (const s of sc.em.soldiers) think0 += s.stats?.thinks ?? 0;
  const t0 = performance.now();
  const frames = Math.round(20 / DT);
  step(sc, 20);
  const ms = (performance.now() - t0) / frames;
  const rays = (sc.em.stats.rays - rays0) / frames;
  const act = sc.em.active.length, fr = sc.em.friends.length;
  check(act <= CONFIG.ai.maxActive && fr === 5, `적 ${act}명 (최대 ${CONFIG.ai.maxActive}) + 아군 ${fr}명`);
  check(rays <= CONFIG.ai.raysPerFrame + 1.2, `시야 레이 프레임당 ${f2(rays)}개 (예산 ${CONFIG.ai.raysPerFrame} + 수신호·첨병 몇 개) · 프레임당 ${f2(ms)}ms (Node)`);
}

const secs = ((performance.now() - t0All) / 1000).toFixed(1);
console.log(`\n${failures ? 'FAIL' : '모두 통과'} (통과 ${passes}${failures ? ` · 실패 ${failures}` : ''}) · ${secs}초`);
process.exit(failures ? 1 : 0);
