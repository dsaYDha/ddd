// 5단계 임무 로직 헤드리스 검증 (렌더링 없음)
//   node scripts/mission-check.mjs   (npm run mission)
// 임무 생성(목표·회수 지점 도달 가능) · 디렉터(시야 밖·150m 밖 생성, 무한 증원 없음) · 매복 행렬 시점·증원 ·
// 지도(등고선·개울·길이 지형과 일치) · 탄약(채우기 시간·중단 시 부분 장전·부상 배율·비호환·적 소총 줍기) ·
// 발자국(생성·소멸·비·적이 따라옴) · 날씨 전환·천둥 · 시간 제한 · 결과 집계
import { CONFIG, SURFACE_KEYS } from '../src/config.js';
import { RNG } from '../src/core/rng.js';
import { generateWorld } from '../src/world/WorldGen.js';
import { WorldQuery } from '../src/world/WorldQuery.js';
import { HumanMotor } from '../src/human/HumanMotor.js';
import { computeExposure } from '../src/human/Exposure.js';
import { NoiseEvents } from '../src/core/NoiseEvents.js';
import { CombatSystem } from '../src/combat/CombatSystem.js';
import { BulletWorld } from '../src/combat/BulletWorld.js';
import { Injuries, makeTestHit } from '../src/combat/Injuries.js';
import { Weapon } from '../src/combat/Weapon.js';
import { Shooter } from '../src/combat/Shooter.js';
import { AmmoPouch } from '../src/combat/AmmoPouch.js';
import { NavGrid } from '../src/ai/NavGrid.js';
import { EnemyManager } from '../src/ai/EnemyManager.js';
import { Squad } from '../src/ai/Squad.js';
import { Soldier } from '../src/ai/Soldier.js';
import { Footprints } from '../src/world/Footprints.js';
import { analyzeWorld, generateMission, pathLength, MISSION_TYPES } from '../src/mission/MissionGen.js';
import { Director } from '../src/mission/Director.js';
import { Mission } from '../src/mission/Mission.js';
import { WeatherCycle } from '../src/mission/Weather.js';
import { GameClock } from '../src/mission/Clock.js';
import { buildMapData } from '../src/mission/MapData.js';

const DT = 1 / 20;
const LIGHT = { daylight: 1, sunOffset: { x: 8, z: 12 } };
let failures = 0, passes = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (ok) passes++; else failures++; };
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const t0All = performance.now();

const data = generateWorld(CONFIG.world.seed);
const query = new WorldQuery(data);
const nav = new NavGrid(query, data.layout);
const world = { data, query, nav };

/** 장면: 플레이어 + 전투 + 적 관리자 (+ 발자국) */
function makeScene({ x, z, yaw = 0, seed = 1, invulnerable = true } = {}) {
  const noise = new NoiseEvents();
  const combat = new CombatSystem(query, noise, { world: new BulletWorld(query), rng: new RNG(seed * 7 + 3) });
  const motor = new HumanMotor(query, { x, z, yaw, noise, name: 'player' });
  const inj = new Injuries({ rng: new RNG(seed + 5), motor });
  inj.invulnerable = invulnerable;
  const pose = () => ({ x: motor.position.x, y: motor.position.y, z: motor.position.z, yaw: motor.yaw, stance: motor.stance, stanceFrom: motor.stanceFrom, stanceProgress: motor.stanceProgress, lean: 0, arms: 'rifle', eyeHeight: motor.eyeHeight });
  const person = combat.addPerson({ name: 'player', isPlayer: true, noiseSource: motor, getPose: pose, injuries: inj });
  const footprints = new Footprints();
  const sc = { noise, combat, motor, inj, person, footprints, expo: 0.5, expoT: 0, time: 0 };
  sc.target = { person, motor, injuries: inj, get alive() { return !inj.dead; }, exposure: () => sc.expoOverride ?? sc.expo };
  sc.em = new EnemyManager({ query, combat, noise, layout: data.layout, nav, rng: new RNG(seed * 13 + 1), footprints });
  sc.em.setTarget(sc.target);
  motor.on('footstep', (e) => footprints.step(motor, e, 'player'));
  return sc;
}
function ctxOf(sc) {
  const m = sc.motor;
  return { pos: m.position, eye: { x: m.position.x, y: m.position.y + m.eyeHeight, z: m.position.z }, fwd: { x: -Math.sin(m.yaw), z: -Math.cos(m.yaw) }, alive: !sc.inj.dead, shots: sc.combat.stats(sc.person).shots };
}
function step(sc, seconds, fn = null) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    if (fn && fn(sc, sc.time) === false) return false;
    sc.combat.update(DT);
    sc.motor.update(DT);
    sc.noise.update(DT);
    sc.footprints.update(DT, 0);
    sc.expoT -= DT;
    if (sc.expoT <= 0) { sc.expoT = 0.2; sc.expo = computeExposure(sc.motor, query, LIGHT).value; }
    sc.em.update(DT);
    if (sc.director) sc.director.update(DT, ctxOf(sc));
    sc.time += DT;
  }
  return true;
}

// =====================================================================
console.log('\n[1] 임무 생성: 3종 × 시드 6개 — 목표·회수 지점에 실제로 걸어서 닿음, 적 규모 ±30%, (6단계) 밤 시작·해질녘 제한 해제');
{
  const A = analyzeWorld(world);
  check(A.landmarks.length >= 15 && A.starts.length >= 4 && A.extractions.length >= 4 && A.camps.length >= 3,
    `지형지물 ${A.landmarks.length}곳 · 투입 후보 ${A.starts.length} · 회수 후보 ${A.extractions.length} · 야영지 후보 ${A.camps.length}`);
  let ok = 0, total = 0, unreachable = [], estOk = 0, dusk = 0, duskLong = 0, night = 0;
  const seeds = [11, 22, 33, 44, 55, 66];
  for (const type of MISSION_TYPES) {
    for (const seed of seeds) {
      total++;
      const m = generateMission(type, seed, world);
      let prev = m.start, good = true;
      for (const o of m.objectives) { if (!Number.isFinite(pathLength(world, prev, o.approach))) good = false; prev = o.approach; }
      if (!Number.isFinite(pathLength(world, prev, m.extraction))) good = false;
      if (!Number.isFinite(pathLength(world, m.start, m.extraction))) good = false;
      if (good) ok++; else unreachable.push(`${type}/${seed}`);
      if (Math.abs(m.estimate - m.trueCount) <= Math.ceil(m.trueCount * 0.3) + 1) estOk++;
      if (m.tod === 'dusk') { dusk++; if (m.limit >= CONFIG.mission.limitMin[type][0] * 60) duskLong++; }
      if (m.tod === 'night') night++;
    }
  }
  check(ok === total, `목표·회수 지점 도달 가능 ${ok}/${total}${unreachable.length ? ' (안 됨: ' + unreachable.join(', ') + ')' : ''}`);
  check(estOk === total, `브리핑 적 규모 오차 ±30% 안 ${estOk}/${total}`);
  check(duskLong === dusk && night > 0, `6단계: 밤 시작 임무 ${night}개 · 해질녘 임무 ${dusk}개 모두 제한 시간이 잘리지 않음 (밤까지 이어짐, ${duskLong}/${dusk})`);
  const m2 = generateMission('recon', 5, world), m3 = generateMission('recon', 6, world);
  check(m2.objectives.map((o) => o.label).join() !== m3.objectives.map((o) => o.label).join() || m2.start.label !== m3.start.label,
    `시드마다 배치가 다름 (5: ${m2.objectives.map((o) => o.label).join(' / ')} | 6: ${m3.objectives.map((o) => o.label).join(' / ')})`);
}

// =====================================================================
console.log('\n[2] 디렉터: 새 적은 150m 밖·시야 밖에서만, 무한 증원 없음, 첫 교전 전 걷는 시간');
{
  const logs = [];
  let minD = Infinity, hiddenAll = true, reinf = 0, maxAlive = 0, quiet = 0, nearest = Infinity, nearestEarly = Infinity;
  for (const [type, seed] of [['recon', 101], ['raid', 102], ['ambush', 103]]) {
    const m = generateMission(type, seed, world);
    const sc = makeScene({ x: m.start.x, z: m.start.z, yaw: m.start.yaw, seed });
    sc.director = new Director({ mission: m, enemies: sc.em, world, footprints: sc.footprints });
    sc.director.start(ctxOf(sc));
    // 플레이어는 첫 목표 쪽으로 천천히 걸어감 (경로 따라)
    const path = nav.findPath(m.start, m.objectives[0].approach, { mode: 'normal', maxNodes: 60000 }) ?? [];
    let k = 0;
    step(sc, 240, () => {
      const p = path[k];
      if (p) {
        const mp = sc.motor.position;
        if (Math.hypot(p.x - mp.x, p.z - mp.z) < 1.5) k++;
        sc.motor.yaw = Math.atan2(-(p.x - mp.x), -(p.z - mp.z));
        sc.motor.input.move.z = 0.6;
      } else sc.motor.input.move.z = 0;
      maxAlive = Math.max(maxAlive, sc.em.active.length);
      for (const e of sc.em.active) {
        const d = dist(e.motor.position, sc.motor.position);
        nearest = Math.min(nearest, d);
        if (sc.time < 150) nearestEarly = Math.min(nearestEarly, d);
      }
    });
    if (sc.director.firstContact < 0 || sc.director.firstContact >= CONFIG.mission.firstContactMin) quiet++;
    for (const L of sc.director.log) { minD = Math.min(minD, L.dPlayer); if (!L.hidden) hiddenAll = false; logs.push(`${type}:${L.kind}@${f1(L.dPlayer)}m`); }
    // 증원은 한 번만
    sc.director.scheduleReinforce('test');
    const again = sc.director.scheduleReinforce('test2');
    reinf += again ? 1 : 0;
  }
  check(minD >= CONFIG.mission.spawnMinDist && hiddenAll, `생성 ${logs.length}건 — 최소 거리 ${f1(minD)}m, 모두 시야 밖 ${hiddenAll} (${logs.slice(0, 8).join(' ')}…)`);
  check(reinf === 0 && maxAlive <= CONFIG.ai.maxActive, `증원 예약은 임무당 1번만 (두 번째 예약 거부), 동시 활성 최대 ${maxAlive}명 (상한 ${CONFIG.ai.maxActive})`);
  check(quiet === 3 && nearestEarly > 60, `첫 4분 걷는 동안 교전·발각 없음 ${quiet}/3 임무, 처음 2분 반 동안 가장 가까운 적 ${f1(nearestEarly)}m (4분 안 ${f1(nearest)}m)`);
}

// =====================================================================
console.log('\n[3] 매복: 행렬이 5~15분 사이 무작위 시점에 오고, 기습 뒤 3~6분에 증원이 옴 / 그냥 보내면 놓침');
{
  const delays = [];
  for (const seed of [201, 202, 203, 204, 205, 206]) delays.push(generateMission('ambush', seed, world).enemies.convoy.delay);
  const spread = Math.max(...delays) - Math.min(...delays);
  check(delays.every((d) => d >= 300 && d <= 900) && spread > 120, `행렬 출발 시점 ${delays.map((d) => (d / 60).toFixed(1) + '분').join(', ')} (모두 5~15분, 매번 다름)`);
  // 실제 진행: 행렬을 기다렸다가 쏨 → 증원
  const m = generateMission('ambush', 207, world);
  m.enemies.convoy.delay = 30;                 // 검사 시간 단축 (출발 시점 자체는 위에서 확인)
  m.enemies.patrols.length = 0;
  const site = m.ambushSite;
  const nx = -site.dir.z, nz = site.dir.x;
  const hide = nav.nearestOpen(site.x + nx * 9, site.z + nz * 9, 4);
  const sc = makeScene({ x: hide.x, z: hide.z, seed: 207 });
  sc.motor.forceStance('prone', 0.1);
  sc.expoOverride = 0.05;
  sc.motor.yaw = Math.atan2(-(site.x - hide.x), -(site.z - hide.z));
  sc.director = new Director({ mission: m, enemies: sc.em, world, footprints: sc.footprints });
  sc.director.start(ctxOf(sc));
  let spawnedAt = NaN, engagedAt = NaN, successAt = NaN, reinfAt = NaN, shots = 0;
  sc.director.on('ambush', (e) => { if (e.state === 'spawned') spawnedAt = sc.time; if (e.state === 'engaged') engagedAt = sc.time; if (e.state === 'success') successAt = sc.time; });
  sc.director.on('reinforce', (e) => { if (e.state === 'spawned') reinfAt = sc.time; });
  step(sc, 900, () => {
    // 행렬 첨병이 25m 안에 오면 쏨 (몇 발씩)
    const cv = sc.director.ambush.convoy;
    if (cv.length && Number.isNaN(successAt)) {
      const tgt = cv.flatMap((q) => q.members).filter((s) => s.alive && !s.injuries.downed)
        .sort((a, b) => dist(a.motor.position, sc.motor.position) - dist(b.motor.position, sc.motor.position))[0];
      if (tgt && dist(tgt.motor.position, sc.motor.position) < 28 && Math.round(sc.time / DT) % 8 === 0) {
        const o = { x: sc.motor.position.x, y: sc.motor.position.y + 0.35, z: sc.motor.position.z };
        tgt.person.refresh();
        const hit = makeTestHit(tgt.person, 'heart', {});
        hit.shooter = sc.person;
        sc.combat.fire(sc.person, { origin: o, dir: { x: hit.point.x - o.x, y: hit.point.y - o.y, z: hit.point.z - o.z }, weapon: CONFIG.weapons.rifle762, speed: 715 });
        shots++;
      }
    }
    if (Number.isFinite(reinfAt)) return false;
  });
  const lag = reinfAt - engagedAt;
  check(Number.isFinite(spawnedAt) && Number.isFinite(engagedAt) && Number.isFinite(successAt),
    `행렬 등장 ${f1(spawnedAt)}s → 교전 ${f1(engagedAt)}s → 기습 성공 ${f1(successAt)}s (플레이어 사격 ${shots}발)`);
  const R = CONFIG.mission.reinforce.ambush;
  check(Number.isFinite(lag) && lag >= R[0] - 1 && lag <= R[1] + 20, `기습 뒤 증원 도착 ${f1(lag)}s (기준 ${R[0]}~${R[1]}s), 증원 생성 위치 ${f1(sc.director.log.find((l) => l.kind === 'reinforce')?.dPlayer)}m`);
  // 그냥 보냄 → 놓침
  const m2 = generateMission('ambush', 208, world);
  m2.enemies.convoy.delay = 10;
  m2.enemies.patrols.length = 0;
  const far = nav.nearestOpen(m2.start.x, m2.start.z, 4);
  const sc2 = makeScene({ x: far.x, z: far.z, seed: 208 });
  sc2.expoOverride = 0.02;
  sc2.motor.forceStance('prone', 0.1);
  sc2.director = new Director({ mission: m2, enemies: sc2.em, world, footprints: sc2.footprints });
  sc2.director.start(ctxOf(sc2));
  const mission2 = new Mission(m2);
  step(sc2, 1100, () => {
    mission2.update(DT, { pos: sc2.motor.position, fwd: { x: 0, z: -1 }, alive: true, ambush: sc2.director.ambush.state });
    if (mission2.done) return false;
  });
  check(sc2.director.ambush.state === 'missed' && mission2.phase === 'failed' && mission2.reason === 'missed', `행렬을 그냥 보내면 놓침 → 임무 실패 (${sc2.director.ambush.state}, ${mission2.reason}, ${f1(sc2.time)}s)`);
}

// =====================================================================
console.log('\n[4] 지도: 등고선·개울·오솔길이 실제 지형과 일치');
{
  const md = buildMapData(data, query, { step: 2, interval: 2 });
  let n = 0, err = 0, maxErr = 0;
  for (const c of md.contours) {
    for (let i = 0; i < c.segs.length; i += 4 * 7) {
      const x = (c.segs[i] + c.segs[i + 2]) / 2, z = (c.segs[i + 1] + c.segs[i + 3]) / 2;
      const e = Math.abs(query.getTerrainHeight(x, z) - c.level);
      err += e; n++; maxErr = Math.max(maxErr, e);
    }
  }
  check(n > 200 && err / n < 0.35, `등고선 ${md.contours.length}개 높이 (${f1(md.hmin)}~${f1(md.hmax)}m) — 선 위 표본 ${n}개 실제 높이와 평균 오차 ${f2(err / n)}m (최대 ${f2(maxErr)}m)`);
  let wet = 0, ws = 0;
  for (const st of md.streams) for (const [x, z] of st) { ws++; if (data.waterKind[cellS(x, z)] === 1 || query.getWaterLevel(x, z) > -1000) wet++; }
  check(wet / ws > 0.9, `지도의 개울 선 위 ${ws}점 중 ${(wet / ws * 100).toFixed(0)}% 가 실제 물 (개울)`);
  const trailSurf = new Set(['packedDirt', 'wetEarth', 'shallowMud', 'deepMud'].map((k) => SURFACE_KEYS.indexOf(k)));
  let tr = 0, ts = 0;
  for (const t of md.trails) for (const [x, z] of t) { ts++; if (trailSurf.has(query.getSurfaceAt(x, z)) || nav.onTrail(x, z)) tr++; }
  check(tr / ts > 0.9, `지도의 오솔길 선 위 ${ts}점 중 ${(tr / ts * 100).toFixed(0)}% 가 실제 오솔길 (흙길·진흙)`);
}
function cellS(x, z) {
  const i = Math.floor((x + data.half) / data.sRes), j = Math.floor((z + data.half) / data.sRes);
  return j * data.sN + i;
}

// =====================================================================
console.log('\n[5] 탄약: 탄창 채우기 0.4초/발 · 중단하면 넣은 만큼만 · 팔 부상 ×2 · 양팔 불가 · 적 탄 비호환 · 적 소총 줍기');
{
  const S = (o = {}) => ({ held: true, stance: 'crouch', transitioning: false, speed: 0, suppression: 0, armsWounded: 0, ...o });
  // 빈 예비 탄창 하나를 30발 채우는 시간
  const w = new Weapon(CONFIG.weapons.rifle762, { rng: new RNG(1) });
  w.mags[1].rounds = 0;
  const pouch = new AmmoPouch();
  let t = 0, stopped = null;
  pouch.on('stop', (e) => { stopped = e; });
  while (w.mags[1].rounds < 30 && t < 30) { pouch.update(DT, w, S()); t += DT; }
  check(Math.abs(t - 12) < 0.3 && pouch.loose === 60, `빈 탄창 30발 채우기 ${f1(t)}초 (기준 12초), 낱발 90 → ${pouch.loose}`);
  // 가장 적게 남은 탄창부터
  const w2 = new Weapon(CONFIG.weapons.rifle762, { rng: new RNG(2) });
  w2.mags[1].rounds = 20; w2.mags[2].rounds = 5; w2.mags[3].rounds = 12;
  const p2 = new AmmoPouch();
  let first = -1;
  p2.on('round', (e) => { if (first < 0) first = e.mag; });
  for (let i = 0; i < 20; i++) p2.update(DT, w2, S());
  check(first === 2, `가장 적게 남은 탄창(5발)부터 채움 (처음 넣은 탄창 #${first})`);
  // 중단: 손을 떼면 넣은 만큼만
  const w3 = new Weapon(CONFIG.weapons.rifle762, { rng: new RNG(3) });
  w3.mags[1].rounds = 0;
  const p3 = new AmmoPouch();
  let reason = null;
  p3.on('stop', (e) => { reason = e.reason; });
  for (let i = 0; i < Math.round(2.1 / DT); i++) p3.update(DT, w3, S());
  p3.update(DT, w3, S({ held: false }));
  const afterRelease = w3.mags[1].rounds;
  for (let i = 0; i < 20; i++) p3.update(DT, w3, S({ held: false }));
  check(afterRelease === 5 && w3.mags[1].rounds === 5 && reason === 'release' && p3.loose === 85, `2.1초 뒤 손을 뗌 → 5발만 들어감 (탄창 ${w3.mags[1].rounds}발, 낱발 ${p3.loose}, 이유 ${reason})`);
  // 움직이면·제압 60 이상이면 중단
  const w4 = new Weapon(CONFIG.weapons.rifle762, { rng: new RNG(4) });
  w4.mags[1].rounds = 0;
  const p4 = new AmmoPouch();
  const reasons = [];
  p4.on('stop', (e) => reasons.push(e.reason));
  for (let i = 0; i < 20; i++) p4.update(DT, w4, S());
  p4.update(DT, w4, S({ speed: 0.8 }));
  p4.update(DT, w4, S({ held: false }));
  for (let i = 0; i < 20; i++) p4.update(DT, w4, S());
  p4.update(DT, w4, S({ suppression: 65 }));
  const blockedStand = new AmmoPouch().blockReason(w4, S({ stance: 'stand' }));
  check(reasons[0] === 'move' && reasons[1] === 'suppressed' && blockedStand === 'stance', `중단: 움직임 → '${reasons[0]}', 제압 65 → '${reasons[1]}', 서서는 시작 불가 ('${blockedStand}')`);
  // 팔 부상 ×2, 양팔 불가
  const w5 = new Weapon(CONFIG.weapons.rifle762, { rng: new RNG(5) });
  w5.mags[1].rounds = 0;
  const p5 = new AmmoPouch();
  let t5 = 0;
  while (w5.mags[1].rounds < 10 && t5 < 30) { p5.update(DT, w5, S({ armsWounded: 1 })); t5 += DT; }
  const both = new AmmoPouch().blockReason(w5, S({ armsWounded: 2 }));
  check(Math.abs(t5 - 8) < 0.3 && both === 'arms', `팔 하나 부상: 10발 ${f1(t5)}초 (×2 = 8초), 양팔 부상: 시작 불가 ('${both}')`);
  // 적 탄 비호환 + 적 소총 줍기 시 탄창 이전
  const noise = new NoiseEvents();
  const combat = new CombatSystem(query, noise, { world: new BulletWorld(query) });
  const person = combat.addPerson({ name: 'p', getPose: () => ({ x: 0, y: 0, z: 0, yaw: 0, stance: 'stand', arms: 'rifle' }) });
  const sh = new Shooter(combat, person, CONFIG.weapons.rifle762);
  const enemyW = new Weapon(CONFIG.weapons.rifle556, { rng: new RNG(9) });
  enemyW.mags[0].rounds = 17; enemyW.mags[3].rounds = 4;
  const snap = enemyW.snapshot();
  const own = sh.weapon.snapshot();
  sh.setWeapon(CONFIG.weapons.rifle556, snap);
  const incompatible = new AmmoPouch().blockReason(sh.weapon, S());
  const mags = sh.weapon.mags.map((m) => m.rounds).join(',');
  sh.setWeapon(CONFIG.weapons.rifle762, own);
  check(incompatible === 'caliber' && mags === snap.mags.join(',') && sh.weapon.data.caliber === '7.62x39' && sh.weapon.totalRounds === 180,
    `적 5.56 소총: 낱발 7.62 탄 안 맞음 ('${incompatible}'), 주우면 그 적의 탄창이 따라옴 (${mags}), 다시 내 소총으로 → ${sh.weapon.totalRounds}발`);
}

// =====================================================================
console.log('\n[6] 발자국: 진흙·젖은 흙에만 남고, 10분에 걸쳐 흐려지며 비가 오면 빨리 사라짐 · 수색 중인 적이 따라옴');
{
  const fp = new Footprints();
  const mud = SURFACE_KEYS.indexOf('shallowMud'), dirt = SURFACE_KEYS.indexOf('packedDirt'), wetE = SURFACE_KEYS.indexOf('wetEarth');
  const a = fp.add(0, 0, 0, 0, 'L', 'player', mud), b = fp.add(1, 0, 0, 0, 'R', 'player', dirt), c = fp.add(2, 0, 0, 0, 'L', 'enemy', wetE);
  check(!!a && !b && !!c, `진흙 ○ · 흙길 × · 젖은 흙 ○`);
  for (let i = 0; i < 300; i++) fp.update(1, 0);
  const half = a.strength;
  for (let i = 0; i < 301; i++) fp.update(1, 0);
  check(Math.abs(half - 0.5) < 0.02 && fp.list.length === 0, `맑은 날: 5분 뒤 진하기 ${f2(half)}, 10분 뒤 모두 사라짐`);
  const fr = new Footprints();
  fr.add(0, 0, 0, 0, 'L', 'player', mud);
  let tr = 0;
  while (fr.list.length && tr < 1000) { fr.update(1, 1); tr++; }
  check(tr <= 130, `폭우(비 1): ${tr}초 만에 사라짐 (×${1 + CONFIG.footprints.rainMul} 빠름)`);
  // 실제 맵: 진흙 오솔길 T1 을 걸으면 발자국, 수색 중인 적이 따라옴
  const T1 = data.layout.trails[0].line;
  let i0 = -1;
  for (let i = 0; i < T1.count; i += 2) { if (query.getSurfaceAt(T1.x[i], T1.z[i]) === mud) { i0 = i; break; } }
  const sc = makeScene({ x: T1.x[Math.max(0, i0 - 10)], z: T1.z[Math.max(0, i0 - 10)], seed: 301 });
  let idx = Math.max(0, i0 - 10);
  step(sc, 40, () => {
    const p = sc.motor.position;
    while (idx < T1.count - 3 && Math.hypot(T1.x[idx] - p.x, T1.z[idx] - p.z) < 1.5) idx++;
    sc.motor.yaw = Math.atan2(-(T1.x[idx] - p.x), -(T1.z[idx] - p.z));
    sc.motor.input.move.z = 0.7;
  });
  sc.motor.input.move.z = 0;
  const prints = sc.footprints.list.filter((p) => p.who === 'player');
  check(prints.length >= 8, `진흙 오솔길을 걸은 플레이어 발자국 ${prints.length}개`);
  // 수색 분대를 가장 오래된 발자국 근처에 두고 플레이어는 멀리 숨음
  const oldest = prints[0];
  sc.expoOverride = 0;
  sc.motor.teleport(sc.motor.position.x, sc.motor.position.z, 0);
  sc.motor.forceStance('prone', 0.1);
  const sq = new Squad(sc.em, { type: 'patrol', rng: new RNG(302) });
  sc.em.squads.push(sq);
  for (let k = 0; k < 2; k++) {
    const p = nav.nearestOpen(oldest.x + k * 2, oldest.z + 2, 3);
    const s = new Soldier(sc.em, { x: p.x, z: p.z, yaw: 0, rng: new RNG(303 + k) });
    sc.em._addSoldier(s); sq.add(s);
  }
  sq.contact = { x: oldest.x + 15, y: 0, z: oldest.z + 15, time: 0, uncertainty: 15 };
  sq.setState('search');
  let found = false, follow = 0;
  sc.em.on('trackFound', () => { found = true; });
  const d0 = Math.min(...sq.members.map((s) => dist(s.motor.position, sc.motor.position)));
  step(sc, 45, () => { for (const p of sq.search?.pairs ?? []) if (p.track) follow = Math.max(follow, p.track.id); });
  const d1 = Math.min(...sq.members.filter((s) => s.alive).map((s) => dist(s.motor.position, sc.motor.position)));
  check(found && follow > oldest.id && d1 < d0 - 5, `수색 분대가 발자국 발견 → 더 새 발자국으로 따라옴 (플레이어까지 ${f1(d0)} → ${f1(d1)}m)`);
}

// =====================================================================
console.log('\n[7] 날씨: 맑음 → 흐림 → 비 → 폭우 → 그침(안개) 흐름 · 천둥이 총성을 가림 · 젖음도·소음 반경 연동');
{
  const rng = new RNG(401);
  const plan = WeatherCycle.makePlan(1800, rng);
  const wc = new WeatherCycle(plan, rng);
  const seen = [];
  let maxRain = 0, thunders = 0, maxMask = 0, maxFog = 0;
  wc.on('thunder', () => thunders++);
  for (let t = 0; t < 2000; t += 1) {
    const P = wc.update(1);
    if (seen[seen.length - 1] !== P.kind) seen.push(P.kind);
    maxRain = Math.max(maxRain, P.rain); maxMask = Math.max(maxMask, wc.thunderMask);
    if (P.kind === 'clearing') maxFog = Math.max(maxFog, P.fogAdd);
  }
  const order = ['clear', 'overcast', 'rain', 'storm', 'clearing'];
  const okOrder = seen.every((k, i) => i === 0 || order.indexOf(k) > order.indexOf(seen[i - 1]));
  check(okOrder && seen.includes('storm') && seen[seen.length - 1] === 'clearing', `흐름: ${seen.join(' → ')}`);
  check(thunders >= 3 && maxMask > 0.5 && maxRain >= 0.95, `폭우 중 천둥 ${thunders}번 (총성 가림 최대 ${f2(maxMask)}), 최대 비 ${f2(maxRain)}`);
  check(maxFog > CONFIG.weather.presets.storm.fogAdd, `비가 그친 뒤 안개 ${f2(maxFog * 1000)}‰ > 폭우 중 ${f2(CONFIG.weather.presets.storm.fogAdd * 1000)}‰`);
  // 빗소리가 발소리 반경을 줄임 (4단계 청각)
  const nz = new NoiseEvents();
  nz.rainIntensity = 0;
  const r0 = nz.emitNoise({ x: 0, y: 0, z: 0 }, 20, 'footstep').radius;
  nz.rainIntensity = 1;
  const r1 = nz.emitNoise({ x: 0, y: 0, z: 0 }, 20, 'footstep').radius;
  nz.thunderMask = 1;
  const g0 = nz.emitNoise({ x: 0, y: 0, z: 0 }, 900, 'gunshot').radius;
  check(r1 < r0 * 0.7 && g0 < 900 * 0.5, `발소리 반경 맑음 ${f1(r0)} → 폭우 ${f1(r1)}m, 천둥 순간 총성 반경 ${f1(g0)}m (기본 900)`);
  // 시계: 4배 속도
  const clk = new GameClock(6);
  clk.update(900);
  check(Math.abs(clk.hours - 7) < 1e-6 && clk.label === '07:00', `게임 시계 4배: 실제 15분 → ${clk.label}`);
}

// =====================================================================
console.log('\n[8] 시간 제한 · 사망 · 결과 집계');
{
  const def = generateMission('recon', 501, world);
  const ms = new Mission(def);
  const pos = { x: def.start.x, z: def.start.z };
  let failed = null;
  ms.on('failed', (e) => { failed = e.reason; });
  for (let t = 0; t < def.limit + 2; t += 1) ms.update(1, { pos, fwd: { x: 0, z: -1 }, alive: true });
  check(failed === 'time', `제한 시간 ${def.limit / 60}분 넘김 → 실패 ('${failed}')`);
  const ms2 = new Mission(def);
  ms2.update(1, { pos, fwd: { x: 0, z: -1 }, alive: false });
  check(ms2.phase === 'failed' && ms2.reason === 'dead', `사망 → 임무 실패 ('${ms2.reason}')`);
  // 정찰 지점 확인: 25m 안에서 5초 바라보기 → 모두 확인 → 회수 60초 → 성공
  const ms3 = new Mission(def, { checkpoint: true });
  const evs = [];
  for (const k of ['objective', 'extract', 'checkpoint', 'complete']) ms3.on(k, () => evs.push(k));
  for (const o of def.objectives) {
    const p = { x: o.x + 12, z: o.z };
    for (let t = 0; t < 6; t += 0.1) ms3.update(0.1, { pos: p, fwd: { x: -1, z: 0 }, alive: true });
  }
  for (let t = 0; t < 61; t += 0.5) ms3.update(0.5, { pos: { x: def.extraction.x, z: def.extraction.z }, fwd: { x: 0, z: -1 }, alive: true });
  check(ms3.phase === 'complete' && evs.filter((e) => e === 'objective').length === def.objectives.length && evs.filter((e) => e === 'checkpoint').length === 1,
    `정찰 지점 ${def.objectives.length}곳 확인 → 회수 60초 → 성공 (체크포인트 ${evs.filter((e) => e === 'checkpoint').length}번)`);
  // 결과 집계
  const st = ms3.stats;
  Object.assign(st, { distance: 812.4, shots: 47, hits: 6, roundsStart: 180, looseStart: 90, roundsLeft: 121, looseLeft: 72, loaded: 18, confirmed: 2, estimated: 1, enemyWounded: 1, wounds: ['대퇴'] });
  const sum = ms3.summary();
  check(sum.success && sum.used === 47 && sum.roundsLeft === 121 && sum.looseLeft === 72 && sum.confirmed === 2 && sum.estimated === 1 && sum.wounds.length === 1,
    `결과: 성공 · 사용 ${sum.used}발 · 남은 탄창 ${sum.roundsLeft} + 낱발 ${sum.looseLeft} · 확인 사살 ${sum.confirmed} / 추정 ${sum.estimated} · 부상 ${sum.wounds.join(',')}`);
}

console.log(`\n${failures ? `실패 ${failures}개 (통과 ${passes})` : `모두 통과 (통과 ${passes})`} · ${((performance.now() - t0All) / 1000).toFixed(1)}초`);
process.exit(failures ? 1 : 0);
