// 6단계 헤드리스 검증 (렌더링 없음) — 부비트랩·밤 전투·몸과 피로
//   node scripts/field-check.mjs   (npm run field)
// 함정 배치(길목 위주·숲속 드묾·오솔길 조우 ≫ 숲) · 적이 자기 함정을 피함 · 걸음걸이별 발견 확률 · 탐침 · 해제 성공/실패 ·
// 철선/구덩이/지뢰 발동 규칙 · 파편 거리별 명중·부상 분류 · 밤 적 발견 거리 감소 · 손전등·총구 화염 · 조명탄 · 암순응 ·
// 밤 작은 소리 가림 · 피로/갈증 비율 · 수통 마시기/채우기 · 총구 막힘 · 덤불 걸림
import { CONFIG } from '../src/config.js';
import { RNG } from '../src/core/rng.js';
import { generateWorld } from '../src/world/WorldGen.js';
import { WorldQuery } from '../src/world/WorldQuery.js';
import { HumanMotor } from '../src/human/HumanMotor.js';
import { computeExposure } from '../src/human/Exposure.js';
import { NoiseEvents } from '../src/core/NoiseEvents.js';
import { CombatSystem } from '../src/combat/CombatSystem.js';
import { BulletWorld, createFlatWorld } from '../src/combat/BulletWorld.js';
import { Injuries } from '../src/combat/Injuries.js';
import { NavGrid } from '../src/ai/NavGrid.js';
import { EnemyManager } from '../src/ai/EnemyManager.js';
import { Soldier } from '../src/ai/Soldier.js';
import { Squad } from '../src/ai/Squad.js';
import { detectionRate } from '../src/ai/Perception.js';
import { analyzeWorld, generateMission, MISSION_TYPES } from '../src/mission/MissionGen.js';
import { TrapField, makeTrap, segCross } from '../src/combat/Traps.js';
import { DarkAdapt, Flares, ambientLight, lampLight } from '../src/world/Night.js';
import { Endurance } from '../src/human/Endurance.js';
import { muzzleBlock, snagDelay } from '../src/combat/Handling.js';
import { GameClock } from '../src/mission/Clock.js';

const DT = 1 / 20;
let failures = 0, passes = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (ok) passes++; else failures++; };
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));
const pct = (v) => `${(v * 100).toFixed(0)}%`;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const t0All = performance.now();

const data = generateWorld(CONFIG.world.seed);
const query = new WorldQuery(data);
const nav = new NavGrid(query, data.layout);
const world = { data, query, nav };
const A = analyzeWorld(world);

/** 장면: 플레이어 + 전투 + 적 관리자 + 함정 */
function makeScene({ x, z, yaw = 0, seed = 1, invulnerable = false, target = true } = {}) {
  const noise = new NoiseEvents();
  const combat = new CombatSystem(query, noise, { world: new BulletWorld(query), rng: new RNG(seed * 7 + 3) });
  const motor = new HumanMotor(query, { x, z, yaw, noise, name: 'player' });
  const inj = new Injuries({ rng: new RNG(seed + 5), motor });
  inj.invulnerable = invulnerable;
  const pose = () => ({ x: motor.position.x, y: motor.position.y, z: motor.position.z, yaw: motor.yaw, stance: motor.stance, stanceFrom: motor.stanceFrom, stanceProgress: motor.stanceProgress, lean: 0, arms: 'rifle', eyeHeight: motor.eyeHeight });
  const person = combat.addPerson({ name: 'player', isPlayer: true, noiseSource: motor, getPose: pose, injuries: inj });
  const sc = { noise, combat, motor, inj, person, time: 0, expo: 0.5 };
  sc.target = { person, motor, injuries: inj, get alive() { return !inj.dead; }, exposure: () => sc.expo, ambient: () => sc.ambient ?? 1, lamp: () => sc.lamp ?? null };
  sc.em = new EnemyManager({ query, combat, noise, layout: data.layout, nav, rng: new RNG(seed * 13 + 1) });
  if (target) sc.em.setTarget(sc.target);
  sc.traps = new TrapField({ query, combat, noise, rng: new RNG(seed * 31 + 9) });
  return sc;
}
function step(sc, seconds, fn = null) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    if (fn && fn(sc, sc.time) === false) return false;
    sc.combat.update(DT);
    sc.motor.update(DT);
    sc.noise.update(DT);
    sc.em.update(DT);
    sc.traps.update(DT, sc.trapCtx ?? {});
    sc.time += DT;
  }
  return true;
}
/** 평지 전투 (파편 거리 검사) */
function flatCombat(seed) {
  return new CombatSystem(null, null, { world: createFlatWorld(0), rng: new RNG(seed) });
}

// =====================================================================
console.log('\n[1] 함정 배치: 길목(오솔길·논둑·야영지 접근로) 위주, 숲속은 드물게 — 오솔길로 다니면 숲보다 훨씬 자주 만남');
{
  let total = 0, choke = 0, forest = 0, minGap = Infinity, nearStart = 0, nearObj = 0, approach = 0, raids = 0;
  const kinds = { tripwire: 0, spikePit: 0, mine: 0 };
  const missions = [];
  for (const type of MISSION_TYPES) {
    for (const seed of [11, 22, 33, 44, 55, 66]) {
      const m = generateMission(type, seed, world);
      missions.push(m);
      total += m.traps.length;
      for (const t of m.traps) {
        kinds[t.kind]++;
        if (t.site === 'forest') forest++; else choke++;
        if (dist(t, m.start) < CONFIG.traps.avoidStart - 0.5) nearStart++;
        if (m.objectives.some((o) => dist(t, o) < CONFIG.traps.avoidObjective - 0.5)) nearObj++;
      }
      for (let i = 0; i < m.traps.length; i++) for (let j = i + 1; j < m.traps.length; j++) {
        const a = m.traps[i], b = m.traps[j];
        if (a.site === 'approach' && b.site === 'approach') continue;
        minGap = Math.min(minGap, dist(a, b));
      }
      if (type === 'raid') { raids++; approach += m.traps.filter((t) => t.site === 'approach').length; }
    }
  }
  check(choke / total >= 0.8 && forest > 0 && forest / total <= 0.2,
    `함정 ${total}개 (임무 ${missions.length}개): 길목 ${pct(choke / total)} · 숲속 ${pct(forest / total)} — 철선 ${kinds.tripwire} · 구덩이 ${kinds.spikePit} · 지뢰 ${kinds.mine}`);
  check(minGap >= CONFIG.traps.spacing - 0.01 && nearStart === 0 && nearObj === 0 && approach >= raids * 2,
    `함정끼리 최소 ${f1(minGap)}m (≥ ${CONFIG.traps.spacing}) · 투입 지점 ${CONFIG.traps.avoidStart}m 안 ${nearStart}개 · 목표 바로 옆 ${nearObj}개 · 습격 야영지 접근로 평균 ${f1(approach / raids)}개`);
  // 조우: 오솔길 100m 구간 vs 숲속 100m 직선 — 지나가며 밟거나 걸리는 함정 수 (철선은 가로지르면, 지뢰·구덩이는 반경 + 0.3m 안)
  const rng = new RNG(99);
  const enc = (m, pts) => {
    let n = 0;
    for (const t of m.traps) {
      const tr = makeTrap(t, 0, null);
      let hit = false;
      for (let i = 1; i < pts.length && !hit; i++) {
        const a = pts[i - 1], b = pts[i];
        if (t.kind === 'tripwire') hit = segCross(a.x, a.z, b.x, b.z, tr.a.x, tr.a.z, tr.b.x, tr.b.z);
        else {
          const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
          let u = l2 > 0 ? ((t.x - a.x) * dx + (t.z - a.z) * dz) / l2 : 0;
          u = Math.max(0, Math.min(1, u));
          hit = Math.hypot(a.x + dx * u - t.x, a.z + dz * u - t.z) < tr.r + 0.3;
        }
      }
      if (hit) n++;
    }
    return n;
  };
  let trailEnc = 0, trailN = 0, forestEnc = 0, forestN = 0;
  for (const m of missions) {
    // 오솔길: 임무 지역(투입·목표·회수 지점 둘레 60m) 을 지나는 구간
    const area = [m.start, ...m.objectives, m.extraction];
    const inArea = (p) => area.some((a) => dist(a, p) < 120);
    for (let k = 0; k < 40; k++) {
      const tr = data.layout.trails[rng.int(0, data.layout.trails.length - 1)];
      const L = tr.line.length;
      if (L < 110) continue;
      const s0 = rng.range(0, L - 100);
      const pts = [];
      for (let s = s0; s <= s0 + 100; s += 2) { const [x, z] = tr.line.pointAt(s); pts.push({ x, z }); }
      if (!inArea(pts[25])) continue;
      trailEnc += enc(m, pts); trailN++;
    }
    for (let k = 0, got = 0; k < 400 && got < 40; k++) {
      const c = area[rng.int(0, area.length - 1)];
      const x0 = c.x + rng.range(-90, 90), z0 = c.z + rng.range(-90, 90), a = rng.range(0, Math.PI * 2);
      const pts = [];
      let ok = true;
      for (let s = 0; s <= 100 && ok; s += 2) {
        const x = x0 + Math.cos(a) * s, z = z0 + Math.sin(a) * s;
        if (Math.abs(x) > 185 || Math.abs(z) > 185 || nav.onTrail(x, z) || (data.paddy && data.paddy.signedDistance(x, z) < 2)) ok = false;
        pts.push({ x, z });
      }
      if (!ok) continue;
      got++;
      forestEnc += enc(m, pts); forestN++;
    }
  }
  const te = trailEnc / Math.max(1, trailN), fe = forestEnc / Math.max(1, forestN);
  check(trailN > 200 && forestN > 200 && te >= 0.1 && te > fe * 5,
    `100m 당 함정 조우: 오솔길 ${f2(te)}개 (${trailN}구간) vs 숲속 ${f2(fe)}개 (${forestN}구간) — 약 ${fe > 0 ? f1(te / fe) : '∞'}배`);
}

// =====================================================================
console.log('\n[2] 적 AI: 자기 편 함정 자리를 알고 비켜 감 (지뢰·구덩이는 돌아가고 철선은 넘음 — 하나도 안 터뜨림), 플레이어는 같은 길에서 걸림');
{
  // 막힘(급한 개울 둑 등) 없이 걸을 수 있는 오솔길 110m 구간
  let tr = null, s0 = 0;
  for (const t of data.layout.trails) {
    for (let a = 4; a + 110 < t.line.length - 2 && !tr; a += 6) {
      let ok = true;
      for (let s = a; s <= a + 110 && ok; s += 1.5) { const [x, z] = t.line.pointAt(s); if (!nav.walkable(x, z) || query.getSlope(x, z).deg > 26 || query.getWaterDepth(x, z) > 0.1) ok = false; }
      if (ok) { tr = t; s0 = a; }
    }
    if (tr) break;
  }
  const route = [];
  for (let s = s0; s <= s0 + 110; s += 3) { const [x, z] = tr.line.pointAt(s); route.push({ x, z }); }
  const at = (s) => { const [x, z] = tr.line.pointAt(s); const [x2, z2] = tr.line.pointAt(s + 2); return { x, z, dir: { x: (x2 - x) / Math.hypot(x2 - x, z2 - z), z: (z2 - z) / Math.hypot(x2 - x, z2 - z) } }; };
  const defs = [];
  const sW = s0 + 80;
  const m1 = at(s0 + 30), p1 = at(s0 + 55), w1 = at(sW);
  defs.push({ kind: 'mine', x: m1.x, z: m1.z, site: 'trail' });
  defs.push({ kind: 'spikePit', x: p1.x, z: p1.z, site: 'trail' });
  const ux = -w1.dir.z, uz = w1.dir.x;
  defs.push({ kind: 'tripwire', x: w1.x, z: w1.z, yaw: Math.atan2(-ux, -uz), len: 3.2, site: 'trail' });
  // 플레이어는 멀리 (보지도 듣지도 못하게)
  const far = { x: tr.line.pointAt(10)[0] > 0 ? -150 : 150, z: 150 };
  const sc = makeScene({ x: far.x, z: far.z, seed: 7, invulnerable: true });
  sc.traps.load(defs);
  nav.setHazards(sc.traps.hazards('enemy'));
  const sq = sc.em.spawnPatrol({ near: route[route.length - 1], start: route[0], route, size: 5, mg: false, seed: 12, lamps: 0 });
  sq.oneWay = true;
  let minMine = Infinity, minPit = Infinity, wireCross = 0;
  const prevSide = new Map();
  const T = sc.traps.list;
  step(sc, 400, () => {
    for (const s of sq.members) {
      if (!s.alive) continue;
      const p = s.motor.position;
      minMine = Math.min(minMine, Math.hypot(p.x - T[0].x, p.z - T[0].z));
      minPit = Math.min(minPit, Math.hypot(p.x - T[1].x, p.z - T[1].z));
      const w = T[2];
      const side = Math.sign((w.b.x - w.a.x) * (p.z - w.a.z) - (w.b.z - w.a.z) * (p.x - w.a.x));
      const ps = prevSide.get(s);
      if (ps !== undefined && ps !== side && Math.hypot(p.x - w.x, p.z - w.z) < w.len) wireCross++;
      prevSide.set(s, side);
    }
    if (sq.members.every((s) => !s.alive || tr.line.closestS(s.motor.position.x, s.motor.position.z).s > sW + 2)) return false;
  });
  const passed = sq.members.filter((s) => s.alive && tr.line.closestS(s.motor.position.x, s.motor.position.z).s > sW + 2).length;
  check(sc.traps.stats.triggered === 0 && minMine > T[0].r + 0.05 && minPit > T[1].r + 0.05 && passed >= 4,
    `분대 5명 중 ${passed}명이 함정 세 개를 지나감 (${f1(sc.time)}초) — 발동 ${sc.traps.stats.triggered}회, 지뢰까지 최소 ${f2(minMine)}m · 구덩이 ${f2(minPit)}m (반경 ${T[0].r}/${T[1].r}), 철선 넘기 ${wireCross}회`);
  nav.setHazards([]);
  // 같은 길을 플레이어가 걸으면 (오솔길 가운데를 1.4m/s 로 — 구덩이에 빠지면 빠져나올 때까지 멈춤)
  const sc2 = makeScene({ x: route[0].x, z: route[0].z, seed: 8, invulnerable: true, target: false });
  sc2.traps.load(defs);
  const events = [];
  sc2.traps.on('explode', (e) => events.push(e.trap.kind));
  sc2.traps.on('pit', () => events.push('pit'));
  sc2.traps.on('trip', () => events.push('trip'));
  let sw = s0;
  for (let i = 0; i < 4000 && sw < s0 + 100; i++) {
    if (sc2.traps.stuckLeft(sc2.person) <= 0) sw += 1.4 * DT;
    const [x, z] = tr.line.pointAt(sw);
    sc2.motor.position.x = x; sc2.motor.position.z = z;
    sc2.combat.update(DT); sc2.traps.update(DT, {}); sc2.time += DT;
  }
  check(events.includes('mine') && events.includes('pit') && events.includes('trip'),
    `플레이어가 같은 길을 걸으면: ${events.join(' → ')}`);
}

// =====================================================================
console.log('\n[3] 발견: 3m 안 함정 — 조용히 걷기(X)·앉아 걷기는 크게, 보통 걸음은 가끔, 달리기는 거의 못 봄 · 밤엔 어두워서 거의 못 봄');
const approachDetect = (gait, opts = {}) => {
  const speeds = { quiet: 0.8, crouch: 0.9, walk: 1.6, sprint: 4.5, prone: 0.35 };
  const stance = gait === 'crouch' ? 'crouch' : gait === 'prone' ? 'prone' : 'stand';
  const eyeH = CONFIG.stance.eyeHeight[stance];
  const N = opts.n ?? 500;
  let found = 0;
  for (let i = 0; i < N; i++) {
    const tf = new TrapField({ rng: new RNG(1000 + i * 7 + (opts.seed ?? 0)) });
    tf.load([{ kind: opts.kind ?? 'mine', x: 0, z: 0, yaw: Math.PI / 2, len: 2.8, marker: opts.marker ? { x: 0, z: 3.5, kind: 'grass' } : null }]);
    const motor = { position: { x: 0, y: 0, z: 3.4 }, speed: speeds[gait], gait, stance, eyeHeight: eyeH, yaw: 0 };
    const pitch = -20 * Math.PI / 180;
    const obs = { motor, fwd: { x: 0, y: Math.sin(pitch), z: -Math.cos(pitch) }, light: () => opts.light ?? 1 };
    for (let d = 3.4; d > 0.45; d -= speeds[gait] * 0.2) {
      motor.position.z = d;
      obs.eye = { x: 0, y: eyeH, z: d };
      tf.detectStep(0.2, obs, { rain: opts.rain ?? 0, wetness: opts.rain ?? 0 });
      if (tf.list[0].known) { found++; break; }
    }
  }
  return found / N;
};
{
  const q = approachDetect('quiet'), c = approachDetect('crouch'), w = approachDetect('walk'), s = approachDetect('sprint');
  check(q >= 0.7 && c >= 0.6 && w <= 0.35 && w >= 0.05 && s <= 0.05 && q > w * 3,
    `지뢰에 3.4m 앞에서 다가갈 때 알아챌 확률: 조용히 걷기 ${pct(q)} · 앉아 걷기 ${pct(c)} · 보통 걸음 ${pct(w)} · 달리기 ${pct(s)}`);
  const qn = approachDetect('quiet', { light: 0.03 }), wl = approachDetect('quiet', { kind: 'tripwire', light: 1 }), wr = approachDetect('walk', { kind: 'tripwire', rain: 1 }), wd = approachDetect('walk', { kind: 'tripwire' });
  const mk = approachDetect('walk', { marker: true });
  check(qn < q * 0.4 && wr > wd && mk > w,
    `밤(빛 0.03) 조용히 걷기 ${pct(qn)} (낮 ${pct(q)}) · 철선: 보통 걸음 ${pct(wd)} → 비에 젖으면 ${pct(wr)} · 적 표시(묶은 풀) 있으면 보통 걸음 ${pct(mk)} (없으면 ${pct(w)})`);
}

// =====================================================================
console.log('\n[4] 탐침(Y): 앞 1m 땅을 찔러 지뢰·구덩이 확인 · 해제(F): 5초, 실패 10%는 폭발, 팔 부상이면 불가');
{
  const tf = new TrapField({ rng: new RNG(5) });
  tf.load([{ kind: 'mine', x: 0, z: -0.9 }, { kind: 'spikePit', x: 6, z: -2.2 }, { kind: 'tripwire', x: -6, z: -0.8, yaw: Math.PI / 2, len: 3 }]);
  const motor = (x, z, yaw = 0) => ({ position: { x, y: 0, z }, yaw });
  const r1 = tf.probe(motor(0, 0)), r2 = tf.probe(motor(6, 0)), r3 = tf.probe(motor(6, -0.8)), r4 = tf.probe(motor(-6, 0)), r5 = tf.probe(motor(0, 0, Math.PI));
  check(r1.found.length === 1 && r1.found[0].kind === 'mine' && r2.found.length === 0 && r3.found.length === 1 && r4.found.length === 0,
    `지뢰 0.9m 앞 → ${r1.found.map((t) => t.kind).join() || '없음'} · 구덩이 2.2m 앞 → ${r2.found.length ? '찾음' : '못 찾음 (멂)'} · 다가가 1.4m 앞 → ${r3.found.map((t) => t.kind).join() || '없음'} · 철선 → ${r4.found.length ? '찾음' : '탐침으로는 못 찾음 (눈으로)'}`);
  // 해제 1000번
  let ok = 0, failed = 0, boom = 0;
  for (let i = 0; i < 1000; i++) {
    const t = new TrapField({ rng: new RNG(77 + i) });
    t.load([{ kind: 'tripwire', x: 0, z: 0, yaw: 0, len: 3 }]);
    t.list[0].known = true;
    t.on('explode', () => boom++);
    const target = t.disarmTarget({ position: { x: 1.0, y: 0, z: 0.2 } });
    const r = t.disarm(target);
    if (r.ok) ok++;
    if (r.failed) { failed++; t.update(CONFIG.traps.tripwire.fuse + 0.05); }
  }
  const t2 = new TrapField({ rng: new RNG(3) });
  t2.load([{ kind: 'tripwire', x: 0, z: 0, yaw: 0, len: 3 }]);
  const notKnown = t2.disarmTarget({ position: { x: 1, y: 0, z: 0 } });
  t2.list[0].known = true;
  const refused = t2.disarm(t2.list[0], null, { armWounded: true });
  const mineTry = new TrapField({ rng: new RNG(4) });
  mineTry.load([{ kind: 'mine', x: 0, z: 0 }]);
  mineTry.list[0].known = true;
  check(failed >= 70 && failed <= 130 && boom === failed && ok + failed === 1000 && !notKnown && refused.refused === 'arm' && !mineTry.disarmTarget({ position: { x: 0.5, y: 0, z: 0 } }),
    `해제 1000번: 성공 ${ok} · 실패 ${failed} (${pct(failed / 1000)}, 실패는 모두 폭발 ${boom}) · 알아채지 못한 철선은 해제 대상 아님 · 팔 부상 → ${refused.refused === 'arm' ? '불가' : '?'} · 지뢰는 해제 불가`);
}

// =====================================================================
console.log('\n[5] 발동: 철선은 걸리고 1초 뒤 폭발 · 구덩이는 하퇴 부상 + 4초 못 움직임 · 지뢰는 밟은 다리 대퇴 중상 (동맥 약 60%)');
{
  // 철선: 평지 위 플레이어 걸어서 가로지름
  const sc = makeScene({ x: -60, z: -150, yaw: 0, seed: 21 });
  const p0 = sc.motor.position;
  const fz = -Math.cos(sc.motor.yaw), fx = -Math.sin(sc.motor.yaw);
  sc.traps.load([{ kind: 'tripwire', x: p0.x + fx * 2, z: p0.z + fz * 2, yaw: sc.motor.yaw + Math.PI / 2, len: 3 }]);
  let tripT = null, boomT = null, boomD = null;
  sc.traps.on('trip', () => { tripT = sc.time; });
  sc.traps.on('explode', (e) => { boomT = sc.time; boomD = dist(e.point, sc.motor.position); });
  step(sc, 4, () => { if (tripT === null) sc.motor.input.move.z = 1; else sc.motor.input.move.z = 0; });
  check(tripT !== null && boomT !== null && Math.abs(boomT - tripT - CONFIG.traps.tripwire.fuse) < 0.08,
    `철선 걸림 ${f2(tripT)}초 → 폭발 ${f2(boomT)}초 (지연 ${f2(boomT - tripT)}초, 폭약까지 ${f1(boomD)}m) · 부상 ${sc.inj.wounds.length}곳 · 제압 ${f1(sc.person.suppression.value)}`);
  // 구덩이
  const sc2 = makeScene({ x: -60, z: -150, yaw: 0, seed: 22 });
  const q0 = sc2.motor.position;
  sc2.traps.load([{ kind: 'spikePit', x: q0.x + fx * 1.5, z: q0.z + fz * 1.5 }]);
  let pitAt = null, exitAt = null, pitPos = null, maxMove = 0;
  sc2.traps.on('pit', () => { pitAt = sc2.time; pitPos = { ...sc2.motor.position }; });
  sc2.traps.on('pitExit', () => { exitAt = sc2.time; });
  step(sc2, 7, () => {
    sc2.motor.input.move.z = 1;
    if (pitAt !== null && exitAt === null) maxMove = Math.max(maxMove, dist(sc2.motor.position, pitPos));
  });
  const w2 = sc2.inj.wounds[0];
  check(pitAt !== null && w2 && w2.type === 'shin' && Math.abs(exitAt - pitAt - CONFIG.traps.spikePit.stuck) < 0.1 && maxMove < 0.05,
    `구덩이: 빠짐 ${f2(pitAt)}초 → 상처 ${w2 ? w2.label + ' ' + CONFIG.injury.typeLabels[w2.type] : '없음'} · 빠져나옴 ${f2(exitAt - pitAt)}초 뒤 (그동안 이동 ${f2(maxMove)}m)`);
  // 지뢰: 300번 밟기 → 동맥 비율, 밟은 다리
  let art = 0, thigh = 0, legOk = 0, N = 300;
  for (let i = 0; i < N; i++) {
    const combat = flatCombat(500 + i);
    const motor = { position: { x: 0, y: 0, z: 1 }, setRestriction() {}, clearRestriction() {} };
    const inj = new Injuries({ rng: new RNG(900 + i) });
    const pose = { x: 0, y: 0, z: 1, yaw: 0, stance: 'stand', stanceFrom: 'stand', stanceProgress: 1, lean: 0, arms: 'rifle', eyeHeight: 1.65 };
    const person = combat.addPerson({ name: 'p', getPose: () => pose, injuries: inj, noiseSource: motor });
    const tf = new TrapField({ combat, rng: new RNG(1300 + i) });
    const side = i % 2 ? 0.12 : -0.12;     // 몸 오른쪽(+x)/왼쪽 아래 지뢰
    tf.load([{ kind: 'mine', x: side, z: 0 }]);
    tf.update(DT);                           // 이전 위치 기록
    motor.position.z = -0.5; pose.z = -0.5;  // 북쪽(−z)으로 걸어 지뢰를 지나감
    tf.update(DT);
    combat.update(0.05);
    const w = inj.wounds.find((x) => x.type === 'thigh');
    if (w) { thigh++; if (w.arterial) art++; if (w.side === (side > 0 ? 'R' : 'L')) legOk++; }
  }
  check(thigh === N && art / N > 0.5 && art / N < 0.7 && legOk === N,
    `지뢰 ${N}번: 대퇴 중상 ${thigh} · 동맥 출혈 ${pct(art / N)} (기준 ${pct(CONFIG.traps.mine.arterial)}) · 밟은 쪽 다리 ${legOk}/${N}`);
}

// =====================================================================
console.log('\n[6] 폭발 파편: 여러 개의 작은 탄 → 가까울수록 많이 맞음, 3단계 저속 탄 규칙 (치명 부위 → 가슴 중상, 나머지 → 스침)');
{
  const dists = [2, 4, 8, 15];
  const res = {};
  let limbTypes = 0, chestFromLethal = 0, total = 0;
  const parts = new Set();
  for (const d of dists) {
    let hits = 0;
    const N = 40;
    for (let k = 0; k < N; k++) {
      const combat = flatCombat(k * 31 + 7 + d * 1000);
      const inj = new Injuries({ rng: new RNG(k + 3) });
      const pose = { x: d, y: 0, z: 0, yaw: Math.PI / 2, stance: 'stand', stanceFrom: 'stand', stanceProgress: 1, lean: 0, arms: 'rifle', eyeHeight: 1.65 };
      combat.addPerson({ name: 't', getPose: () => pose, injuries: inj });
      combat.on('hit', (e) => {
        hits++; total++;
        parts.add(e.part);
        const t = e.wound?.type;
        if (t && t !== 'graze' && t !== 'chest') limbTypes++;
        if (t === 'chest' && e.wound.lowSpeed) chestFromLethal++;
      });
      combat.people.refresh();
      const T = CONFIG.traps.tripwire;
      combat.explode({ x: 0, y: T.chargeHeight, z: 0 }, { fragments: T.fragments, speed: T.speed, elev: T.elev, kind: 'tripwire' });
      for (let i = 0; i < 12; i++) combat.update(0.02);
    }
    res[d] = hits / N;
  }
  check(res[2] > res[4] && res[4] > res[8] && res[8] >= res[15] && res[2] >= 2 && res[15] < 0.2,
    `철선 폭약 파편 평균 명중: ${dists.map((d) => `${d}m ${f2(res[d])}발`).join(' · ')}`);
  check(limbTypes === 0 && total > 50 && parts.size >= 6,
    `명중 ${total}발 모두 저속 탄 판정 (팔다리 관통상 ${limbTypes}건 — 스침 또는 치명 부위의 가슴 중상 ${chestFromLethal}건), 맞은 부위 ${parts.size}종`);
  // 폭발 제압: 거리별
  const sup = [2, 6, 12, 30].map((d) => {
    const combat = flatCombat(5);
    const pose = { x: d, y: 0, z: 0, yaw: 0, stance: 'stand', stanceFrom: 'stand', stanceProgress: 1, lean: 0, arms: 'rifle', eyeHeight: 1.65 };
    const p = combat.addPerson({ name: 's', getPose: () => pose });
    combat.people.refresh();
    combat.explode({ x: 0, y: 0.3, z: 0 }, { fragments: 0 });
    return p.suppression.value;
  });
  check(sup[0] >= 85 && sup[1] > sup[2] && sup[2] > sup[3] && sup[3] === 0,
    `폭발 제압 (2단계 Suppression): 2m ${f1(sup[0])} · 6m ${f1(sup[1])} · 12m ${f1(sup[2])} · 30m ${f1(sup[3])}`);
}

// =====================================================================
console.log('\n[7] 밤 시야: 적 발견 거리가 크게 줄고, 손전등·총구 화염은 위치를 드러냄 · 소리에 더 의존 (조명탄)');
{
  // 트인 곳 (논둑) · 숲속 각각, 서 있는 플레이어를 5초 안에 알아챌 최대 거리
  const spots = [];
  const pd = data.paddy;
  { const [x, z] = pd.toWorld(0, -pd.halfV + pd.mainDikeRow * pd.cellH); spots.push({ name: '논둑(트인 곳)', x, z }); }
  { const c = A.camps.slice().sort((a, b) => b.canopy - a.canopy)[0]; spots.push({ name: '캐노피 숲', x: c.x, z: c.z }); }
  const lines = [];
  let dayMin = Infinity, nightMax = 0, openNight = 0, forestNight = 0;
  for (const sp of spots) {
    const motor = new HumanMotor(query, { x: sp.x, z: sp.z });
    const canopy = query.getCanopyCover(sp.x, sp.z);
    const res = {};
    for (const [label, dayL, moon] of [['낮', 1, 'half'], ['보름 밤', 0, 'full'], ['그믐 밤', 0, 'new']]) {
      const amb = ambientLight(dayL, moon, canopy);
      const e = computeExposure(motor, query, { daylight: dayL ? 1 : 0.1, sunOffset: { x: 8, z: 12 }, ambient: amb }).value;
      let far = 0;
      for (let d = 2; d <= 160; d += 1) {
        const r = detectionRate({ distance: d, exposure: e, visibility: 0.85, speed: 0, angleDeg: 10, state: 'patrol', ambient: amb });
        if (r * 5 >= 1) far = d;
      }
      res[label] = far;
    }
    lines.push(`${sp.name}: 낮 ${res['낮']}m · 보름 ${res['보름 밤']}m · 그믐 ${res['그믐 밤']}m`);
    dayMin = Math.min(dayMin, res['낮']);
    nightMax = Math.max(nightMax, res['그믐 밤']);
    if (sp.name.startsWith('논')) openNight = res['보름 밤']; else forestNight = res['보름 밤'];
  }
  check(nightMax < dayMin * 0.35 && openNight > forestNight,
    `서 있는 사람을 5초 안에 알아채는 최대 거리 — ${lines.join(' / ')}`);
  // 손전등·총구 화염: 실제 병사 (야영지 보초처럼 제자리에서 플레이어 쪽을 봄) — 80~100m 밖에서 플레이어 손 높이(불빛)가 트여 보이는 자리
  const pick = () => {
    const homes = [...A.extractions, ...A.starts].map((p) => ({ x: p.x, z: p.z }));
    for (let u = -1; u <= 1; u++) for (let v = -1; v <= 1; v++) { const [x, z] = data.paddy.toWorld(u * data.paddy.halfU * 0.6, v * data.paddy.halfV * 0.6); homes.push({ x, z }); }
    for (const d of [120, 110, 100]) for (const h of homes) {
      if (query.getSlope(h.x, h.z).deg > 10) continue;
      const hy = query.getSupportHeight(h.x, h.z);
      const lp = { x: h.x, y: hy + 1.45, z: h.z };
      for (let k = 0; k < 72; k++) {
        const a = (k / 72) * Math.PI * 2;
        const x = h.x + Math.cos(a) * d, z = h.z + Math.sin(a) * d;
        if (Math.abs(x) > 185 || Math.abs(z) > 185 || !nav.walkable(x, z) || query.getSlope(x, z).deg > 16) continue;
        const eye = { x, y: query.getSupportHeight(x, z) + 1.65, z };
        const r = query.raycastWorld(eye, { x: lp.x - x, y: lp.y - eye.y, z: lp.z - z }, d - 0.5, 'vision');
        if (!r.hit && r.transmittance > 0.1) return { home: h, spot: { x, z } };
      }
    }
    return null;
  };
  const pk = pick();
  const sc = makeScene({ x: pk.home.x, z: pk.home.z, yaw: 0, seed: 31, invulnerable: true });
  sc.em.night = 1;
  const pm = sc.motor.position;
  const lampPos = { x: pm.x, y: pm.y + 1.45, z: pm.z };
  const spot = pk.spot;
  const sq = new Squad(sc.em, { type: 'camp', rng: new RNG(5) });
  sc.em.squads.push(sq);
  const s = new Soldier(sc.em, { x: spot.x, z: spot.z, yaw: Math.atan2(-(pm.x - spot.x), -(pm.z - spot.z)), rng: new RNG(41) });
  s.post = { x: spot.x, z: spot.z, look: { x: pm.x, z: pm.z } }; s.postRole = 'sentry';
  sc.em._addSoldier(s); sq.add(s); s.look.yaw = s.motor.yaw;
  const dd = dist(spot, pm);
  sc.expo = 0.02; sc.ambient = 0.02;
  // 손전등 꺼짐: 20초
  sc.lamp = null;
  let tOff = null;
  step(sc, 20, () => { if (s.perception.meter >= 1 && tOff === null) tOff = sc.time; });
  const meterOff = s.perception.meter;
  // 손전등 켬 (병사 쪽으로)
  s.perception.meter = 0;
  const lampAt = () => { const dx = s.eye.x - lampPos.x, dy = s.eye.y - lampPos.y, dz = s.eye.z - lampPos.z, l = Math.hypot(dx, dy, dz); return { ...lampPos, dx: dx / l, dy: dy / l, dz: dz / l }; };
  let tOn = null;
  const t0 = sc.time;
  step(sc, 10, () => { sc.lamp = lampAt(); if (s.perception.meter >= 1 && tOn === null) tOn = sc.time - t0; });
  check(tOff === null && tOn !== null && tOn < 6,
    `밤 ${f1(dd)}m: 손전등 끔 → 20초 동안 발견 수치 ${f2(meterOff)} (못 봄) · 켬 → ${tOn !== null ? f1(tOn) + '초 만에 발견' : '발견 못 함'}`);
  // 총구 화염: 밤 400m / 낮 400m
  const flashTest = (night) => {
    const em = sc.em;
    em.night = night;
    s.perception.meter = 0; s.perception.seen = false;
    const origin = { x: s.eye.x + (pm.x - s.eye.x) / dd * 400, y: s.eye.y, z: s.eye.z + (pm.z - s.eye.z) / dd * 400 };
    const before = em.stats.flashes;
    // 400m 떨어진 곳의 가상 플레이어 사격 — 시야 레이는 실제 지형을 지나므로, 가림이 없는 높이에서 쏜다고 가정 (총구 화염 규칙만)
    const q0 = em.query;
    em.query = { raycastWorld: () => ({ hit: false, transmittance: 0.3 }) };
    em._onShot({ shooter: sc.person, origin, dir: { x: 0, y: 0, z: 1 } });
    em.query = q0;
    return em.stats.flashes > before;
  };
  const nightFlash = flashTest(1), dayFlash = flashTest(0);
  check(nightFlash && !dayFlash, `400m 밖 총구 화염: 밤 → ${nightFlash ? '보임 (즉시 발견)' : '안 보임'} · 낮 → ${dayFlash ? '보임' : '안 보임 (낮 한계 220m)'}`);
  // 소리 → 조명탄
  const sc3 = makeScene({ x: -60, z: -150, seed: 33, invulnerable: true });
  sc3.em.night = 1;
  const sq3 = new Squad(sc3.em, { type: 'patrol', rng: new RNG(6) });
  sc3.em.squads.push(sq3);
  const s3 = new Soldier(sc3.em, { x: -60, z: -180, yaw: 0, rng: new RNG(7) });
  sc3.em._addSoldier(s3); sq3.add(s3); sq3.leader = s3; sq3.state = 'patrol';
  let launched = 0;
  sc3.em.on('flareLaunch', () => launched++);
  // 30m 밖에서 걷는 발소리 (반경 12m 는 못 들음) → 15m 안 발소리 (들음)
  sc3.noise.emitNoise({ x: -60, y: 0, z: -150 }, 12, 'footstep', sc3.motor);
  step(sc3, 6);
  const quietLaunch = launched;
  sc3.noise.emitNoise({ x: -60, y: 0, z: -170 }, 12, 'footstep', sc3.motor);
  step(sc3, 8);
  const fl = sc3.em.flares.list[0];
  check(quietLaunch === 0 && launched === 1 && fl && (fl.phase === 'burn' || fl.phase === 'rise'),
    `밤 순찰: 30m 밖 발소리 → 조명탄 ${quietLaunch}발 · 10m 안 발소리 → ${launched}발 (높이 ${fl ? f1(fl.y - fl.ground) : '-'}m, ${fl?.phase})`);
  // 밤 작은 소리 가림
  const ne = new NoiseEvents();
  ne.nightMask = 1;
  const small = ne.emitNoise({ x: 0, y: 0, z: 0 }, 12, 'footstep').radius, big = ne.emitNoise({ x: 0, y: 0, z: 0 }, 900, 'gunshot').radius;
  check(small < 12 * 0.85 && big === 900, `밤 개구리·벌레 소리: 발소리 반경 12 → ${f1(small)}m · 총성 900 → ${f1(big)}m (가리지 않음)`);
  // 적 손전등 빛
  s3.hasLamp = true; s3.squad.state = 'patrol';
  sc3.em._updateLamps();
  const f3 = { x: -Math.sin(s3.look.yaw), z: -Math.cos(s3.look.yaw) }, p3 = s3.motor.position;
  const lit = sc3.em.lampLightAt(p3.x + f3.x * 6, query.getTerrainHeight(p3.x + f3.x * 6, p3.z + f3.z * 6) + 0.5, p3.z + f3.z * 6);
  const behind = sc3.em.lampLightAt(p3.x - f3.x * 6, p3.y + 0.5, p3.z - f3.z * 6);
  check(s3.lampOn && lit > 0.1 && behind === 0, `적 손전등 (가린 불빛): 켜짐 ${s3.lampOn} · 앞 6m 빛 ${f2(lit)} · 뒤 ${f2(behind)}`);
}

// =====================================================================
console.log('\n[8] 조명탄·암순응: 40초 동안 흔들리며 천천히 내려옴 (땅이 밝아짐), 어둠 30~60초면 더 잘 보임, 밝은 빛을 보면 깨짐');
{
  const fls = new Flares({ query, rng: new RNG(8) });
  const f = fls.launch({ x: 0, y: 2, z: 0 }, { x: 0, z: -100 });
  const xs = [], ys = [], lights = [];
  let ignite = null, out = null;
  fls.on('ignite', () => { ignite = fls.time; });
  fls.on('out', () => { out = fls.time; });
  for (let t = 0; t < 50; t += 0.1) {
    fls.update(0.1);
    if (f.phase === 'burn') { xs.push(f.x); ys.push(f.y); lights.push(fls.lightAt(f.x, f.z, 0)); }
  }
  const burn = out - ignite, fall = (ys[0] - ys[ys.length - 1]) / Math.max(1, burn);
  const swayX = Math.max(...xs) - Math.min(...xs);
  const mid = lights[Math.floor(lights.length / 2)];
  const farLight = fls.lightAt(f.x + 500, f.z, 0);
  check(burn > 36 && burn < 41 && fall > 2.5 && fall < 4.5 && swayX > 3 && mid > 0.6,
    `조명탄: 불이 붙어 ${f1(burn)}초 탐 · ${f1(fall)}m/s 로 내려옴 · 좌우 흔들림 ${f1(swayX)}m · 바로 아래 빛 ${f2(mid)} (500m 밖 ${f2(farLight)})`);
  const fl2 = new Flares({ query, rng: new RNG(9) });
  const g = fl2.launch({ x: 0, y: 2, z: 0 });
  for (let i = 0; i < 60; i++) fl2.update(0.1);
  const flick = [];
  for (let i = 0; i < 40; i++) { fl2.update(0.05); flick.push(g.intensity); }
  check(Math.max(...flick) - Math.min(...flick) > 0.05, `조명탄 빛 깜빡임 폭 ${f2(Math.max(...flick) - Math.min(...flick))} (그림자도 같이 깜빡임)`);
  const ad = new DarkAdapt();
  const lv = {};
  for (let t = 0; t <= 60.01; t += 0.1) { ad.update(0.1, 0.03); if (Math.abs(t - 30) < 0.05) lv[30] = ad.level; if (Math.abs(t - 10) < 0.05) lv[10] = ad.level; }
  lv[60] = ad.level;
  const mul60 = ad.exposureMul;
  ad.flash(CONFIG.night.adapt.ownShot);
  const afterShot = ad.level;
  for (let t = 0; t < 1.5; t += 0.1) ad.update(0.1, 0.03, CONFIG.night.adapt.flareLook);
  const afterFlare = ad.level;
  check(lv[10] < 0.6 && lv[30] >= 0.8 && lv[60] >= 0.95 && afterShot < lv[60] * 0.8 && afterFlare < 0.15,
    `암순응: 10초 ${f2(lv[10])} · 30초 ${f2(lv[30])} · 60초 ${f2(lv[60])} (화면 노출 ×${f2(mul60)}) → 내 사격 ${f2(afterShot)} → 조명탄 1.5초 바라봄 ${f2(afterFlare)}`);
  // 손전등 원뿔 빛
  const lamp = { x: 0, y: 1.5, z: 0, dx: 0, dy: -0.3, dz: -0.954, range: 38, angle: 24, light: 0.9 };
  const inBeam = lampLight(lamp, 0, 0.3, -5), outBeam = lampLight(lamp, 6, 0.3, -5), farBeam = lampLight(lamp, 0, -10, -40);
  check(inBeam > 0.5 && outBeam === 0 && farBeam === 0, `손전등 빛: 앞 5m ${f2(inBeam)} · 옆 ${f2(outBeam)} · 40m 밖 ${f2(farBeam)}`);
  // 시계: 밤 임무는 24시를 넘어도 밤
  const ck = new GameClock(21.4);
  ck.update(3600 * 2 / CONFIG.mission.timeScale * 1.5);
  const b = ck.todBlend();
  check(b.light < 0.05 && b.nightAmb > 0.9 && ck.label.startsWith('00'), `시계: 21:24 시작 → ${ck.label} 밤 (낮 빛 ${f2(b.light)}, 밤 환경음 ${f2(b.nightAmb)})`);
}

// =====================================================================
console.log('\n[9] 피로·갈증: 오래 걷기·짐·진흙·한낮 더위로 쌓임, 앉아 쉬면 조금 회복 · 수통 마시기 +15, 개울에서 채우기');
{
  const fake = (o = {}) => ({ speed: 0, gait: 'idle', stance: 'stand', sink: 0, surface: 'packedDirt', ...o });
  const run = (minutes, motor, ctx) => {
    const e = new Endurance();
    for (let t = 0; t < minutes * 60; t += 0.5) e.update(0.5, { motor, ...ctx });
    return e;
  };
  const walk = fake({ speed: 1.4, gait: 'walk' });
  const noonWalk = run(30, walk, { heat: 1, loadKg: 38 });
  const nightWalk = run(30, walk, { heat: 0, loadKg: 38, night: 1, rain: 0.6 });
  const heavyMud = run(30, fake({ speed: 0.6, gait: 'walk', sink: 0.2, surface: 'shallowMud' }), { heat: 1, loadKg: 45 });
  const idle = run(30, fake(), { heat: 0 });
  check(noonWalk.thirst < 40 && nightWalk.thirst > noonWalk.thirst + 20 && heavyMud.fatigue > noonWalk.fatigue && noonWalk.fatigue > idle.fatigue + 15,
    `30분 뒤 — 한낮 걷기: 갈증 ${f1(noonWalk.thirst)} · 피로 ${f1(noonWalk.fatigue)} | 비 오는 밤 걷기: 갈증 ${f1(nightWalk.thirst)} · 피로 ${f1(nightWalk.fatigue)} | 한낮 진흙·무거운 짐: 피로 ${f1(heavyMud.fatigue)} | 가만히: 갈증 ${f1(idle.thirst)} · 피로 ${f1(idle.fatigue)}`);
  // 쉬기
  const e = new Endurance({ fatigue: 60 });
  for (let t = 0; t < 600; t += 0.5) e.update(0.5, { motor: fake({ stance: 'crouch' }), heat: 0 });
  const rest = 60 - e.fatigue;
  const es = new Endurance({ fatigue: 60 });
  for (let t = 0; t < 600; t += 0.5) es.update(0.5, { motor: fake({ stance: 'stand' }), heat: 0 });
  check(rest > 8 && rest < 25 && es.fatigue >= 60, `피로 60 에서 10분: 앉아 쉬면 −${f1(rest)} (천천히) · 서 있으면 ${f1(es.fatigue)}`);
  // 효과
  const fx0 = new Endurance().effects(), fxF = new Endurance({ fatigue: 100 }).effects(), fxT = new Endurance({ thirst: 20 }).effects();
  check(fxF.staminaMaxMul < 0.7 && fxF.regenMul < 0.6 && fxF.swayMul > 1.2 && fxT.swayMul > 1.1 && fxT.regenMul < 0.9 && fxT.pulse > 0 && fx0.pulse === 0 && fx0.swayMul === 1,
    `효과 — 피로 100: 스태미나 상한 ×${f2(fxF.staminaMaxMul)} · 회복 ×${f2(fxF.regenMul)} · 흔들림 ×${f2(fxF.swayMul)} | 갈증 20: 흔들림 ×${f2(fxT.swayMul)} · 회복 ×${f2(fxT.regenMul)} · 맥박 시야 ${f2(fxT.pulse)}`);
  // 탈수 → 피로 급상승
  const ec = new Endurance({ thirst: 8, fatigue: 20 });
  for (let t = 0; t < 180; t += 0.5) ec.update(0.5, { motor: fake(), heat: 0 });
  check(ec.fatigue >= 95, `갈증 10 아래: 3분 만에 피로 20 → ${f1(ec.fatigue)}`);
  // HumanMotor 연결: 피로 100 → 스태미나 상한, 회복 감소
  const motor = new HumanMotor(query, { x: -60, z: -150 });
  const en = new Endurance({ fatigue: 100 });
  en.apply(motor, null);
  motor.stamina = 20;
  for (let i = 0; i < 100; i++) motor.update(0.05);
  const capped = motor.stamina;
  for (let i = 0; i < 400; i++) motor.update(0.05);
  const motor2 = new HumanMotor(query, { x: -60, z: -150 });
  motor2.stamina = 20;
  for (let i = 0; i < 100; i++) motor2.update(0.05);
  check(motor.stamina <= 100 * 0.66 && capped < motor2.stamina - 20,
    `HumanMotor: 피로 100 이면 5초 회복 ${f1(capped - 20)} (보통 ${f1(motor2.stamina - 20)}) · 상한 ${f1(motor.stamina)}`);
  // 수통
  const d = new Endurance({ thirst: 40 });
  d.startDrink();
  for (let t = 0; t < 3.05; t += 0.05) d.update(0.05, { motor: fake() });
  const drank = d.thirst - 40 + (d.rates.thirst * 3 / 60), water1 = d.water;
  const d2 = new Endurance({ thirst: 40 });
  d2.startDrink();
  for (let t = 0; t < 1; t += 0.05) d2.update(0.05, { motor: fake() });
  for (let t = 0; t < 1; t += 0.05) d2.update(0.05, { motor: fake({ speed: 1.4, gait: 'walk' }) });
  const cancelled = !d2.busy && d2.water === 2;
  let sips = 0;
  const d3 = new Endurance({ thirst: 0 });
  for (let k = 0; k < 20; k++) { if (!d3.startDrink()) break; for (let t = 0; t < 3.05; t += 0.05) d3.update(0.05, { motor: fake() }); sips++; }
  const refusedAtDry = !d3.startRefill(false);
  const ok = d3.startRefill(true);
  for (let t = 0; t < 10.05; t += 0.05) d3.update(0.05, { motor: fake({ stance: 'crouch' }), atWater: true });
  check(Math.abs(drank - 15) < 0.6 && Math.abs(water1 - 1.75) < 1e-6 && cancelled && sips === 8 && refusedAtDry && ok && Math.abs(d3.water - 2) < 1e-6,
    `수통: 3초 마시면 갈증 +${f1(drank)} (물 ${f2(water1)}L 남음) · 움직이면 중단 ${cancelled} · 2L 로 ${sips}번 · 물가 아니면 못 채움 · 개울에서 10초 → ${f2(d3.water)}L`);
}

// =====================================================================
console.log('\n[10] 몸과 총: 총구가 나무에 닿으면 막힘 (사격 불가), 빽빽한 덤불에서는 가끔 조준이 0.3초 늦음');
{
  // 큰 나무 찾기 (트인 곳 쪽에서)
  const trees = (data.placements.bigTree ?? []).filter((t) => Math.abs(t.x) < 150 && Math.abs(t.z) < 150);
  let res = null;
  for (const t of trees) {
    const r = t.r ?? t.radius ?? 0.5;
    const dx = 1, dz = 0;
    const px = t.x - dx * (r + 0.55), pz = t.z - dz * (r + 0.55);
    if (!nav.walkable(px, pz)) continue;
    const eye = { x: px, y: query.getSupportHeight(px, pz) + 1.5, z: pz };
    const start = { x: eye.x, y: eye.y - 0.08, z: eye.z };
    const into = muzzleBlock(query, start, { x: dx, y: 0, z: dz });
    const away = muzzleBlock(query, start, { x: -dx, y: 0, z: -dz });
    if (into.k > 0) { res = { into, away, r }; break; }
  }
  check(res && res.into.k > CONFIG.handling.muzzle.blockFire && res.away.k < 0.1,
    `나무 줄기 앞 0.55m: 줄기 쪽 막힘 ${res ? f2(res.into.k) : '-'} (${res?.into.type}, ${res ? f2(res.into.free) : '-'}m 에서 닿음 → 사격 불가) · 반대쪽 ${res ? f2(res.away.k) : '-'}`);
  const rng = new RNG(4);
  let n = 0;
  for (let i = 0; i < 2000; i++) if (snagDelay(1.2, rng) > 0) n++;
  const none = snagDelay(0.2, rng);
  check(Math.abs(n / 2000 - CONFIG.handling.snag.chance) < 0.04 && none === 0,
    `빽빽한 덤불(σ 1.2) 조준 시작: ${pct(n / 2000)} 확률로 ${CONFIG.handling.snag.delay}초 걸림 · 트인 곳(σ 0.2) 걸림 없음`);
}

console.log(`\n${failures ? 'FAIL' : 'PASS'}: ${passes} 통과, ${failures} 실패 (${((performance.now() - t0All) / 1000).toFixed(1)}초)`);
process.exit(failures ? 1 : 0);
