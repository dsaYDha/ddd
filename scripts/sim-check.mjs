// 이동 규칙 헤드리스 검증 (브라우저 없이 Node로 실행)
//   node scripts/sim-check.mjs
// 생성된 실제 맵 위에서 HumanMotor를 돌려 지면별 속도·빠짐·미끄러짐·스태미나·거동 불능을 측정한다.
// 2단계 [13]~[17]: 탄도(실제 투사체) · 실제 맵 관통 · 제압 · 무기(연사·재장전·탄창·기능 고장) · 부위별 피격 판정.
//   (난이도 명중률 측정은 따로: npm run aim — scripts/aim-sim.mjs)
import { CONFIG, SURFACE_KEYS } from '../src/config.js';
import { generateWorld } from '../src/world/WorldGen.js';
import { WorldQuery } from '../src/world/WorldQuery.js';
import { HumanMotor } from '../src/human/HumanMotor.js';
import { NoiseEvents } from '../src/core/NoiseEvents.js';
import { SURFACE, surfaceLabel } from '../src/world/Surfaces.js';
import { computeExposure } from '../src/human/Exposure.js';
import { VEG } from '../src/world/WorldGen.js';
import { RNG } from '../src/core/rng.js';
import { Ballistics } from '../src/combat/Ballistics.js';
import { BulletWorld, createFlatWorld } from '../src/combat/BulletWorld.js';
import { CombatSystem } from '../src/combat/CombatSystem.js';
import { Suppression } from '../src/combat/Suppression.js';
import { suppressionSwayMul } from '../src/combat/AimModel.js';
import { Weapon } from '../src/combat/Weapon.js';
import { PARTS, partLabel } from '../src/combat/Hitboxes.js';
import { deviate, dirFromYawPitch, dot as dot3, normalize as normalize3, segCapsule, v3 } from '../src/combat/geom.js';

const data = generateWorld(CONFIG.world.seed);
const world = new WorldQuery(data);
const noise = new NoiseEvents();
const DT = 1 / 60;
let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

function run(motor, seconds, fn) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    if (fn) fn(i * DT);
    motor.update(DT);
    noise.update(DT);
  }
}

/** 지정 지면이 반경 r 안에서 균일하고 평탄한 지점 찾기 (가까운 순 후보 목록) */
function findSpots(surface, r = 3, maxSlope = 5, near = CONFIG.world.start, maxDist = 150) {
  const out = [];
  for (let z = -180; z < 180; z += 1) {
    for (let x = -180; x < 165; x += 1) {
      const d = Math.hypot(x - near.x, z - near.z);
      if (d > maxDist) continue;
      if (world.getSurfaceAt(x, z) !== surface) continue;
      if (world.getSlope(x, z).deg > maxSlope) continue;
      let ok = true;
      for (let a = 0; a < 6.28 && ok; a += 0.5) {
        for (const rr of [r * 0.5, r]) {
          const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
          if (world.getSurfaceAt(px, pz) !== surface || world.getSupportHeight(px, pz) > world.getTerrainHeight(px, pz) + 0.01) { ok = false; break; }
        }
      }
      if (ok) out.push({ x, z, d });
    }
  }
  return out.sort((a, b) => a.d - b.d);
}
function findSpot(surface, r = 3, maxSlope = 5, near = CONFIG.world.start, maxDist = 150) {
  return findSpots(surface, r, maxSlope, near, maxDist)[0] || null;
}

function newMotor(x, z, yaw = 0) {
  const m = new HumanMotor(world, { x, z, yaw, noise });
  return m;
}

console.log(`\n월드 생성 ${Math.round(data.timings.total)}ms, seed ${data.seed}`);

// -------------------------------------------------------------------
console.log('\n[1] 지면별 걷기 속도 · 카메라 높이 · 발소리 반경 (맑음)');
world.wetness = CONFIG.weather.presets.clear.wetness;
const results = {};
const header = '  지면'.padEnd(18) + '거리(m)  걷기속도  기대값  빠짐(cm)  눈높이차(cm)  소음반경';
console.log(header);
/** 같은 지면이 앞뒤로 len 이상 이어지는 방향 찾기 */
function findAxis(x, z, surface, len) {
  for (let a = 0; a < Math.PI; a += Math.PI / 24) {
    let ok = true;
    for (let d = -len; d <= len && ok; d += 0.25) {
      const px = x + Math.sin(a) * d, pz = z + Math.cos(a) * d;
      if (world.getSurfaceAt(px, pz) !== surface || world.getSupportHeight(px, pz) > world.getTerrainHeight(px, pz) + 0.01) ok = false;
      // 줄기(어린 나무·바나나 등)에 걸리지 않는 직선
      else if (world.clearanceAt(px, pz, world.getTerrainHeight(px, pz) + 1) < CONFIG.movement.radius + 0.1) ok = false;
    }
    if (ok) return a;
  }
  return null;
}
for (let id = 0; id < SURFACE_KEYS.length; id++) {
  let spot = null, axis = null;
  search: for (const [r, sl] of [[2, 6], [1.2, 6], [0.6, 6], [0.6, 12]]) {
    for (const c of findSpots(id, r, sl).slice(0, 40)) {
      axis = findAxis(c.x, c.z, id, 2.2);
      if (axis !== null) { spot = c; break search; }
    }
  }
  if (!spot || axis === null) { console.log(`  ${surfaceLabel(id)}: 지점 없음`); check(false, `${surfaceLabel(id)} 지점이 시작점 150m 안에 존재`); continue; }
  const m = newMotor(spot.x, spot.z, axis);
  let samples = 0, sum = 0;
  let maxSink = 0;
  let lastNoise = 0;
  m.on('footstep', (e) => { lastNoise = e.radius; });
  m.input.move.z = 1;
  // 같은 지면 안에서 앞뒤로 왕복 (뒤돌아 걷기)
  let leg = 0;
  run(m, 3.4, (t) => {
    const legNow = Math.floor(t / 1.7);
    if (legNow !== leg) { leg = legNow; m.yaw += Math.PI; }
    if ((t > 0.9 && t < 1.65) || t > 2.6) { sum += Math.hypot(m.velocity.x, m.velocity.z); samples++; }
    maxSink = Math.max(maxSink, m.sink);
  });
  const avg = sum / samples;
  const sp = CONFIG.surfaces[SURFACE_KEYS[id]];
  const expected = 1.6 * sp.speed * (1 - (CONFIG.load.baseKg - CONFIG.load.freeKg) * CONFIG.load.speedPerKg);
  const eyeDrop = (world.getSupportHeight(m.position.x, m.position.z) + 1.65) - (m.position.y + m.eyeHeight);
  results[id] = { avg, sink: m.sink, eyeDrop, noise: lastNoise, spot, axis };
  console.log(`  ${surfaceLabel(id).padEnd(14)} ${Math.hypot(spot.x - CONFIG.world.start.x, spot.z - CONFIG.world.start.z).toFixed(0).padStart(5)}   ${avg.toFixed(2).padStart(6)}   ${expected.toFixed(2).padStart(6)}   ${(maxSink * 100).toFixed(0).padStart(6)}    ${(eyeDrop * 100).toFixed(0).padStart(8)}     ${lastNoise.toFixed(1).padStart(6)}`);
}
check(results[SURFACE.PACKED_DIRT].avg > results[SURFACE.SHALLOW_MUD].avg * 1.5, '흙길이 얕은 진흙보다 확실히 빠름');
check(results[SURFACE.SHALLOW_MUD].avg > results[SURFACE.DEEP_MUD].avg * 1.6, '얕은 진흙이 깊은 진흙보다 빠름');
check(results[SURFACE.DEEP_MUD].avg < 0.5, `깊은 진흙 걷기 속도 < 0.5 m/s (${results[SURFACE.DEEP_MUD].avg.toFixed(2)})`);
check(results[SURFACE.PADDY].avg < results[SURFACE.PACKED_DIRT].avg * 0.45, '논 안이 논둑/흙길보다 매우 느림');
check(results[SURFACE.DEEP_MUD].eyeDrop > 0.25, `깊은 진흙에서 카메라가 낮아짐 (${(results[SURFACE.DEEP_MUD].eyeDrop * 100).toFixed(0)}cm)`);
check(results[SURFACE.PADDY].eyeDrop > 0.18, `논에서 카메라가 낮아짐 (${(results[SURFACE.PADDY].eyeDrop * 100).toFixed(0)}cm)`);
check(results[SURFACE.SHALLOW_WATER].noise > results[SURFACE.PACKED_DIRT].noise, '물 첨벙 소리가 흙길 발소리보다 멀리 퍼짐');

// -------------------------------------------------------------------
console.log('\n[2] 논둑 vs 논 안');
{
  const pd = data.paddy;
  const [mx, mz] = pd.toWorld(-pd.halfU + pd.cellW * 0.5, -pd.halfV + pd.mainDikeRow * pd.cellH);
  const m = newMotor(mx, mz, -Math.PI / 2 - pd.rot); // 동쪽(+u) 방향
  m.input.move.z = 1;
  let s = 0, n = 0;
  run(m, 4, (t) => { if (t > 1.5) { s += m.speed; n++; } });
  const dikeSpeed = s / n;
  const dikeEye = m.position.y + m.eyeHeight;
  const [px, pz] = pd.toWorld(-pd.halfU + pd.cellW * 1.5, -pd.halfV + pd.cellH * 0.5);
  const m2 = newMotor(px, pz, -Math.PI / 2 - pd.rot);
  m2.input.move.z = 1;
  s = 0; n = 0;
  run(m2, 4, (t) => { if (t > 1.5) { s += m2.speed; n++; } });
  const paddySpeed = s / n;
  const floor = pd.query(px, pz).floor;
  const dikeTop = pd.query(mx, mz).dikeTop;
  console.log(`  논둑 위 속도 ${dikeSpeed.toFixed(2)} m/s, 눈높이 ${(dikeEye - floor).toFixed(2)}m (논바닥 기준) / 논 안 속도 ${paddySpeed.toFixed(2)} m/s, 눈높이 ${(m2.position.y + m2.eyeHeight - floor).toFixed(2)}m`);
  console.log(`  논둑 높이: 바닥 위 ${(dikeTop - floor).toFixed(2)}m`);
  check(dikeSpeed > paddySpeed * 2.5, '논둑 위가 논 안보다 2.5배 이상 빠름');
  check(dikeEye - floor > m2.position.y + m2.eyeHeight - pd.query(m2.position.x, m2.position.z).floor + 0.3, '논둑 위가 0.3m 이상 높아 노출됨');
  // 논에서 논둑으로 다시 올라올 수 있는지
  const m3 = newMotor(...pd.toWorld(-pd.halfU + pd.cellW * 0.5, -pd.halfV + pd.mainDikeRow * pd.cellH + 2.5), 0);
  m3.yaw = -pd.rot; // -v 방향(북)으로 → 주 논둑 쪽
  m3.input.move.z = 1;
  let climbed = false;
  run(m3, 8, () => { if (m3.ground.onDike) climbed = true; });
  check(climbed, '논 안에서 점프 없이 논둑으로 올라설 수 있음');
}

// -------------------------------------------------------------------
console.log('\n[3] 깊은 진흙: 멈추면 서서히 빠지고, 다시 움직일 때 지연');
{
  const spot = findSpot(SURFACE.DEEP_MUD, 3, 8);
  const m = newMotor(spot.x, spot.z);
  const trace = [];
  run(m, 4, (t) => { if (Math.abs(t % 0.5) < DT / 2) trace.push(`${t.toFixed(1)}s:${(m.sink * 100).toFixed(0)}cm`); });
  console.log('  정지 중 빠짐: ' + trace.join(' '));
  check(m.sink > 0.45, `3초 이상 정지 후 빠진 깊이 ${(m.sink * 100).toFixed(0)}cm (최대 50cm 근처)`);
  let suction = false;
  m.on('suction', () => { suction = true; });
  m.input.move.z = 1;
  let tMove = null;
  const p0 = { ...m.position };
  run(m, 2.0, (t) => { if (tMove === null && Math.hypot(m.position.x - p0.x, m.position.z - p0.z) > 0.1) tMove = t; });
  console.log(`  다시 움직여 10cm 이동까지 ${tMove?.toFixed(2)}s (흙길에선 ~0.1s), 빠짐 ${(m.sink * 100).toFixed(0)}cm`);
  check(suction, '발 빼는 소리(suction) 이벤트 발생');
  check(tMove > 0.6, '발을 빼는 지연 0.6초 이상');
  m.input.move.z = 0;
  m.input.sprint = true; m.input.move.z = 1;
  run(m, 1.0);
  check(m.gait !== 'sprint', '깊은 진흙에서 달리기 불가');
  m.input.jump = true;
  const vy0 = m.vy;
  m.update(DT);
  check(m.grounded && m.vy === vy0, '깊은 진흙에서 점프 불가');
  check(!m.requestStance('prone'), '깊은 진흙에서 엎드리기 불가');
}

// -------------------------------------------------------------------
console.log('\n[4] 젖은 급경사 미끄러짐 (맑음 vs 폭우)');
{
  const tp = data.layout.slopeTest;
  console.log(`  테스트 지점 (${tp.x.toFixed(1)}, ${tp.z.toFixed(1)}) 경사 ${tp.slope.toFixed(1)}° 지면 ${surfaceLabel(world.getSurfaceAt(tp.x, tp.z))}`);
  const slideTest = (wet, sprintUp) => {
    world.wetness = wet;
    const m = newMotor(tp.x, tp.z);
    const sl = world.getSlope(tp.x, tp.z);
    // 오르막 방향을 바라봄
    m.yaw = Math.atan2(-sl.gx, -sl.gz);
    if (sprintUp) { m.input.move.z = 1; m.input.sprint = true; }
    const y0 = world.getTerrainHeight(m.position.x, m.position.z);
    let maxSlide = 0;
    run(m, 2.5, () => { maxSlide = Math.max(maxSlide, Math.hypot(m.slideVel.x, m.slideVel.z)); });
    const dy = world.getTerrainHeight(m.position.x, m.position.z) - y0;
    return { dy, maxSlide };
  };
  const clearStill = slideTest(CONFIG.weather.presets.clear.wetness, false);
  const stormStill = slideTest(CONFIG.weather.presets.storm.wetness, false);
  const stormUp = slideTest(CONFIG.weather.presets.storm.wetness, true);
  console.log(`  맑음 정지: 높이 변화 ${clearStill.dy.toFixed(2)}m, 최대 미끄럼 ${clearStill.maxSlide.toFixed(2)}m/s`);
  console.log(`  폭우 정지: 높이 변화 ${stormStill.dy.toFixed(2)}m, 최대 미끄럼 ${stormStill.maxSlide.toFixed(2)}m/s`);
  console.log(`  폭우 오르막 달리기: 높이 변화 ${stormUp.dy.toFixed(2)}m, 최대 미끄럼 ${stormUp.maxSlide.toFixed(2)}m/s`);
  check(stormStill.maxSlide > clearStill.maxSlide * 2 && stormStill.dy < -0.3, '폭우 때 젖은 급경사에서 확실히 미끄러져 내려감');
  check(stormUp.maxSlide > stormStill.maxSlide, '달리면 더 크게 미끄러짐');
  world.wetness = CONFIG.weather.presets.clear.wetness;
}

// -------------------------------------------------------------------
console.log('\n[5] 스태미나 고갈');
{
  // 숲이 빽빽해져 원을 그리며 달릴 공터가 없으므로 북쪽 오솔길(T4)을 따라 달린다
  const trail = data.layout.trails[3].line;
  const m = newMotor(trail.x[0], trail.z[0]);
  const follow = () => {
    const c = trail.closestS(m.position.x, m.position.z).s;
    const [tx, tz] = trail.pointAt(Math.min(trail.length, c + 4));
    m.yaw = Math.atan2(-(tx - m.position.x), -(tz - m.position.z));
  };
  m.input.move.z = 1; m.input.sprint = true;
  let tEx = null;
  for (let i = 0; i < 20 * 60 && tEx === null; i++) {
    if (i % 6 === 0) follow();
    m.update(DT);
    if (m.exhausted) tEx = i * DT;
  }
  run(m, 0.5, () => follow());
  console.log(`  오솔길 달리기 → 고갈까지 ${tEx?.toFixed(1)}s, 심박 ${m.heartRate.toFixed(0)}bpm, 숨 ${m.breath.toFixed(2)}`);
  check(tEx !== null, '달리기로 스태미나 고갈');
  check(m.gait !== 'sprint', '고갈 후 달리기 불가');
  check(m.breath > 0.7, '고갈 시 거친 숨 (breath > 0.7)');
  m.input.move.z = 0; m.input.sprint = false;
  let tRec = null;
  run(m, 6, (t) => { if (tRec === null && !m.exhausted) tRec = t; });
  console.log(`  정지 후 30까지 회복 ${tRec?.toFixed(1)}s`);
  check(tRec !== null && tRec > 2, '30까지 회복되어야 다시 달리기 가능');

  const mud = findSpot(SURFACE.DEEP_MUD, 3, 8);
  const m2 = newMotor(mud.x, mud.z);
  m2.input.move.z = 1;
  const s0 = m2.stamina;
  run(m2, 10, (t) => { if (Math.abs(t % 1.5) < DT / 2) m2.yaw += 2.2; });
  console.log(`  깊은 진흙 10초 걷기: 스태미나 ${s0.toFixed(0)} → ${m2.stamina.toFixed(0)}`);
  check(m2.stamina < s0 - 15, '깊은 진흙에서는 걷기만 해도 지침');
  const dirt = results[SURFACE.PACKED_DIRT];
  const m3 = newMotor(dirt.spot.x, dirt.spot.z, dirt.axis);
  m3.stamina = 50;
  m3.input.move.z = 1;
  run(m3, 1.2);
  console.log(`  다져진 흙길 걷기: 순변화 ${(m3.regenRate - m3.drainRate).toFixed(2)}/s`);
  check(m3.regenRate - m3.drainRate > 0, '단단한 땅에서는 걸으며 천천히 회복');
}

// -------------------------------------------------------------------
console.log('\n[6] F6 거동 불능 시뮬레이션');
{
  const spot = findSpot(SURFACE.GROUND_COVER, 3, 5);
  const m = newMotor(spot.x, spot.z);
  m.setRestriction('incapacitated', { canStand: false, canCrouch: false, canSprint: false, canJump: false, maxSpeedMultiplier: 0.5 });
  run(m, 1.5);
  check(m.stance === 'prone', `강제로 엎드림 (현재 ${m.stance})`);
  check(!m.requestStance('stand') && !m.requestStance('crouch'), '서기·앉기 불가');
  m.input.move.z = 1; m.input.sprint = true;
  let s = 0, n = 0;
  run(m, 3, (t) => { if (t > 1) { s += m.speed; n++; } });
  const expected = 0.35 * 0.9 * 0.5 * (1 - 17 * 0.005);
  console.log(`  포복 속도 ${(s / n).toFixed(3)} m/s (기대 ≈ ${expected.toFixed(3)})`);
  check(Math.abs(s / n - expected) < 0.04, '포복만 가능, 속도 50%');
  m.clearRestriction('incapacitated');
  check(m.requestStance('stand'), '해제 후 다시 일어설 수 있음');
}

// -------------------------------------------------------------------
console.log('\n[7] 통나무 넘기 (시작 지점 오솔길)');
{
  const log = data.placements.log[0];
  const cx = (log.ax + log.bx) / 2, cz = (log.az + log.bz) / 2;
  // 통나무에 수직으로 3m 떨어진 곳에서 출발
  const nx = -(log.bz - log.az), nz = log.bx - log.ax;
  const nl = Math.hypot(nx, nz);
  const sx = cx + (nx / nl) * 3, sz = cz + (nz / nl) * 3;
  const yaw = Math.atan2(-(cx - sx), -(cz - sz));
  const m = newMotor(sx, sz, yaw);
  m.input.move.z = 1;
  run(m, 4);
  const side = (p) => Math.sign((p.x - cx) * nx + (p.z - cz) * nz);
  const mid = (log.ay + log.by) / 2 + log.r - world.getTerrainHeight(cx, cz);
  console.log(`  통나무 높이(오솔길 중앙) ${mid.toFixed(2)}m`);
  check(side(m.position) > 0, '점프 없이 걸어서는 못 넘음');
  const m2 = newMotor(sx, sz, yaw);
  m2.input.move.z = 1;
  let jumped = false;
  run(m2, 5, () => {
    const d = Math.abs((m2.position.x - cx) * nx + (m2.position.z - cz) * nz) / nl;
    if (!jumped && d < 0.75) { m2.input.jump = true; jumped = true; }
  });
  check(side(m2.position) < 0, '점프하면 넘어감');
}

// -------------------------------------------------------------------
console.log('\n[8] raycastWorld (vision / bullet)');
{
  const eyeAt = (x, z, h) => ({ x, y: world.getTerrainHeight(x, z) + h, z });
  // 코끼리풀 군락 안: 앉은 눈높이에서 시야는 풀에 막히고, 탄도는 풀을 무시
  const g = data.placements.grass[Math.floor(data.placements.grass.length / 2)];
  const o1 = eyeAt(g.x, g.z, 1.0);
  let vegBlocked = 0, bulletVeg = 0;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
    const d = { x: Math.cos(a), y: -0.02, z: Math.sin(a) };
    const v = world.raycastWorld(o1, d, 60, 'vision');
    const b = world.raycastWorld(o1, d, 60, 'bullet');
    if (v.hit && v.object.type === 'vegetation' && v.distance < 8) vegBlocked++;
    if (b.hit && b.object.type === 'vegetation') bulletVeg++;
  }
  console.log(`  코끼리풀 속 16방향: 시야가 8m 안에서 풀에 막힘 ${vegBlocked}, 탄도가 풀에 막힘 ${bulletVeg}`);
  check(vegBlocked >= 8, '코끼리풀이 시야를 가림');
  check(bulletVeg === 0, '탄도는 풀(bulletBlock none)을 통과');
  // 대나무: 시야 부분 차단, 탄도 partial 기록
  const bb = data.placements.bamboo[0];
  const o2 = eyeAt(bb.x - 6, bb.z, 1.5);
  const dir = { x: 6, y: world.getTerrainHeight(bb.x, bb.z) + 1.5 - o2.y, z: 0 };
  const v2 = world.raycastWorld(o2, dir, 12, 'vision');
  const b2 = world.raycastWorld(o2, dir, 12, 'bullet');
  console.log(`  대나무 군락 관통: 시야 투과 ${v2.transmittance.toFixed(2)} / 탄도 기록 ${JSON.stringify(b2.passed.map((p) => p.type + ':' + p.block))}, 정지=${b2.object?.type ?? '없음'}`);
  check(b2.passed.some((p) => p.type === 'bamboo' && p.block === 'partial') || (b2.object && b2.object.type !== 'bamboo'), '대나무는 탄도 partial');
  // 큰 나무 줄기: 둘 다 정지
  const t = data.placements.bigTree[0];
  const o3 = eyeAt(t.x - 8, t.z, 1.5);
  const dir3 = { x: 8, y: world.getTerrainHeight(t.x, t.z) + 1.5 - o3.y, z: 0 };
  const v3 = world.raycastWorld(o3, dir3, 20, 'vision');
  const b3 = world.raycastWorld(o3, dir3, 20, 'bullet');
  console.log(`  큰 나무: 시야 → ${v3.object?.type} ${v3.distance.toFixed(1)}m / 탄도 → ${b3.object?.type} ${b3.distance.toFixed(1)}m`);
  check(b3.object && ['bigTree', 'root', 'buttress', 'terrain'].includes(b3.object.type), '큰 줄기는 탄도 full');
}

// -------------------------------------------------------------------
console.log('\n[9] 1단계 보완: 식생 지면 이동 저항·바스락 소음');
{
  for (const id of [SURFACE.GROUND_COVER, SURFACE.SHRUB, SURFACE.BRUSH]) {
    const r = results[id];
    const sp = CONFIG.surfaces[SURFACE_KEYS[id]];
    const m = newMotor(r.spot.x, r.spot.z, r.axis);
    let rustle = null;
    m.on('rustle', (e) => { if (e.surface === id && rustle === null) rustle = e.radius; });
    m.input.move.z = 1;
    run(m, 2.5);
    const expect = 1.6 * sp.speed * (1 - 17 * 0.005);
    console.log(`  ${surfaceLabel(id).padEnd(12)} 속도 ${r.avg.toFixed(2)} (기대 ${expect.toFixed(2)}) · 스태미나 배율 ${sp.stamina} · 바스락 반경 ${rustle?.toFixed(1)}m`);
    check(Math.abs(r.avg - expect) < 0.12, `${surfaceLabel(id)} 속도 배율 ${sp.speed}`);
    check(rustle !== null && Math.abs(rustle - sp.rustle) < 0.01, `${surfaceLabel(id)} 헤치고 지나갈 때 소음 이벤트 (반경 ${sp.rustle}m)`);
  }
  // 엎드리면 바스락 반경이 줄어듦
  const r = results[SURFACE.SHRUB];
  const m = newMotor(r.spot.x, r.spot.z, r.axis);
  m.requestStance('crouch'); run(m, 0.5); m.requestStance('prone'); run(m, 1.2);
  let rr = null;
  m.on('rustle', (e) => { rr = e.radius; });
  m.input.move.z = 1; run(m, 4);
  check(rr !== null && rr < CONFIG.surfaces.shrub.rustle * 0.7, `포복하면 덤불 소음이 작아짐 (${rr?.toFixed(1)}m)`);
}

// -------------------------------------------------------------------
console.log('\n[10] 숲속 시야 거리 (raycastWorld vision, 눈높이 1.65m)');
{
  // 언덕 사면이 막는 방향은 식생 밀도와 무관하므로 따로 센다 (지형만으로 50m 안에 막히는 방향 제외)
  const terrainOnly = (o, d, max) => {
    for (let t = 0; t <= max; t += 0.5) {
      const px = o.x + d.x * t, pz = o.z + d.z * t;
      if (Math.abs(px) > data.half - 1 || Math.abs(pz) > data.half - 1) return max;
      if (o.y < world.getTerrainHeight(px, pz)) return t;
    }
    return max;
  };
  const r = { s: 12345, f() { this.s = (this.s * 1664525 + 1013904223) >>> 0; return this.s / 4294967296; } };
  const all = [], open = [], crouchD = [];
  let pts = 0, tries = 0;
  while (pts < 200 && tries++ < 40000) {
    const x = -160 + r.f() * 320, z = -160 + r.f() * 320;
    const v = data.vegKind[Math.floor((z + 200) / 0.5) * data.sN + Math.floor((x + 200) / 0.5)];
    if (v !== VEG.COVER && v !== VEG.SHRUB && v !== VEG.THICKET) continue;
    if (world.getSurfaceAt(x, z) === SURFACE.PACKED_DIRT) continue;
    const p = { x, z };
    world.resolveCircles(p, 0.4, -1e4, 1e4);
    const gy = world.getTerrainHeight(p.x, p.z);
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const d = { x: Math.cos(ang), y: 0, z: Math.sin(ang) };
      const o = { x: p.x, y: gy + 1.65, z: p.z };
      const dist = world.raycastWorld(o, d, 120, 'vision').distance;
      all.push(dist);
      if (terrainOnly(o, d, 60) < 50) continue;
      open.push(dist);
      crouchD.push(world.raycastWorld({ x: p.x, y: gy + 1.05, z: p.z }, d, 120, 'vision').distance);
    }
    pts++;
  }
  const q = (arr, f) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * f)]; };
  console.log(`  ${pts}개 지점 × 16방향 — 전체 중앙값 ${q(all, 0.5).toFixed(1)}m (사면에 막히는 방향 포함)`);
  console.log(`  지형이 트인 ${open.length}방향: 서서 중앙값 ${q(open, 0.5).toFixed(1)}m (25% ${q(open, 0.25).toFixed(1)} · 75% ${q(open, 0.75).toFixed(1)}), 60m 넘게 트인 방향 ${(100 * open.filter((d) => d > 60).length / open.length).toFixed(0)}% / 앉아서 중앙값 ${q(crouchD, 0.5).toFixed(1)}m`);
  check(q(open, 0.5) >= 15 && q(open, 0.5) <= 40, '일반 숲속 시야가 식생에 15~40m 안에서 막힘 (중앙값)');
  check(q(crouchD, 0.5) < q(open, 0.5), '앉으면 덤불에 가려 시야가 더 짧아짐');
}

// -------------------------------------------------------------------
console.log('\n[11] 노출도: 엎드리면 지피층·덤불에 묻힘');
{
  const light = { daylight: 1, sunOffset: { x: 0, z: 0 } };
  for (const id of [SURFACE.GROUND_COVER, SURFACE.SHRUB, SURFACE.BRUSH]) {
    const r = results[id];
    const m = newMotor(r.spot.x, r.spot.z, r.axis);
    const stand = computeExposure(m, world, light).value;
    m.requestStance('crouch'); run(m, 0.5); m.requestStance('prone'); run(m, 1.2);
    const prone = computeExposure(m, world, light).value;
    console.log(`  ${surfaceLabel(id).padEnd(12)} 서기 ${stand.toFixed(2)} → 엎드리기 ${prone.toFixed(2)}`);
    check(prone < 0.12, `${surfaceLabel(id)}: 엎드리면 노출도 0.12 미만`);
  }
}

// -------------------------------------------------------------------
console.log('\n[12] 얽힌 덩굴 벽·밀집 대나무: 통과 불가');
{
  const walls = data.circles.filter((c) => c.type === 'vineWall');
  let blocked = 0, tested = 0;
  for (let k = 1; k < walls.length - 1 && tested < 12; k += 7) {
    const w = walls[k], a = walls[k - 1], b = walls[k + 1];
    if (Math.hypot(a.x - w.x, a.z - w.z) > 1.2 || Math.hypot(b.x - w.x, b.z - w.z) > 1.2) continue; // 같은 벽의 중간 마디만
    // 벽에 수직인 방향으로 3m 떨어진 곳에서 벽을 향해 5초간 걷기 → 반대편으로 넘어가면 실패
    const tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz);
    for (const side of [1, -1]) {
      const nx = (-tz / tl) * side, nz = (tx / tl) * side;
      const sx = w.x + nx * 3, sz = w.z + nz * 3;
      if (world.getSurfaceAt(sx, sz) === SURFACE.DEEP_WATER) continue;
      const m = newMotor(sx, sz, Math.atan2(nx, nz));
      if (Math.hypot(m.position.x - sx, m.position.z - sz) > 0.3) continue;
      m.input.move.z = 1;
      let crossed = false;
      run(m, 5, () => { if ((m.position.x - w.x) * nx + (m.position.z - w.z) * nz < 0) crossed = true; });
      tested++;
      if (!crossed) blocked++;
      break;
    }
  }
  console.log(`  덩굴 벽 ${data.layout.vineWalls}개 중 ${tested}곳 시험: ${blocked}곳에서 막힘`);
  check(tested > 5 && blocked === tested, '덩굴 벽을 가로질러 넘어갈 수 없음');
}

// ===================================================================
//  2단계: 탄도 · 관통 · 제압 · 무기 · 피격 판정 (src/combat/ 순수 로직 — 게임과 같은 모듈)
// ===================================================================
const W2 = CONFIG.weapons[CONFIG.weapons.default];
const DEG2 = Math.PI / 180;
const pt3 = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// -------------------------------------------------------------------
console.log('\n[13] 탄도: 영점 100m · 비행시간·속도 · 100m 넘으면 낙차 (실제 투사체, 평지)');
{
  const zero = Ballistics.computeZeroAngle(W2);
  const RANGES = [25, 50, 100, 150, 200, 300];
  // Shooter 와 같은 구성: 조준선 = 눈에서 수평, 탄 출발 = 눈 아래 sightHeight, 총열 = 조준선 + 영점각
  const fly = (dt) => {
    const bal = new Ballistics(createFlatWorld(-100), null, { rng: new RNG(1) });
    const eyeY = 10;
    const p = bal.fire({ origin: { x: 0, y: eyeY - W2.sightHeight, z: 0 }, dir: deviate(dirFromYawPitch(0, 0), 0, zero), weapon: W2 });
    const marks = {};
    let px = -p.pos.z, py = p.pos.y, pt = p.time, ps = p.speed;
    for (let i = 0; i < 4000 && p.alive && marks[300] === undefined; i++) {
      bal.update(dt);
      const x = -p.pos.z;
      for (const R of RANGES) {
        if (marks[R] === undefined && x >= R) {
          const a = (R - px) / (x - px);
          marks[R] = { h: py + (p.pos.y - py) * a - eyeY, t: pt + (p.time - pt) * a, v: ps + (p.speed - ps) * a };
        }
      }
      px = x; py = p.pos.y; pt = p.time; ps = p.speed;
    }
    return marks;
  };
  const m = fly(1 / 60), m30 = fly(1 / 30);
  // 먼 영점: 조준선을 위 → 아래로 지나는 거리
  let cross = NaN;
  for (let R = 70, prev = Ballistics.simulate(W2, R, zero).height - W2.sightHeight; R < 130; R += 0.25) {
    const h = Ballistics.simulate(W2, R + 0.25, zero).height - W2.sightHeight;
    if (prev >= 0 && h < 0) { cross = R + 0.25 * prev / (prev - h); break; }
    prev = h;
  }
  console.log(`  영점각 ${(zero / DEG2 * 60).toFixed(2)}′ (총열이 조준선보다 들림) · 조준선 높이 ${(W2.sightHeight * 100).toFixed(0)}cm · 초속 ${W2.muzzleVelocity}m/s`);
  console.log('  거리(m)  비행시간(s)  속도(m/s)  조준선 기준(cm)  총열 연장선 아래 낙차(cm)');
  for (const R of RANGES) {
    const k = m[R], s = Ballistics.simulate(W2, R, zero);
    console.log(`  ${String(R).padStart(6)}   ${k.t.toFixed(4).padStart(9)}   ${k.v.toFixed(0).padStart(8)}   ${(k.h * 100).toFixed(1).padStart(13)}   ${(s.drop * 100).toFixed(1).padStart(17)}`);
  }
  check(Math.abs(m[100].h) < 0.01 && Math.abs(cross - W2.zeroRange) < 1, `영점 100m: 탄이 ${cross.toFixed(1)}m 에서 조준선을 위→아래로 지남 (실제 탄 100m ${(m[100].h * 100).toFixed(2)}cm)`);
  check(Math.abs(m30[100].h - m[100].h) < 0.01, `프레임레이트 무관 (30fps 100m ${(m30[100].h * 100).toFixed(2)}cm)`);
  check(Math.abs(m[100].t - 0.15) < 0.01 && Math.abs(m[100].v - 620) < 20, `100m: 비행 ${m[100].t.toFixed(3)}s · ${m[100].v.toFixed(0)}m/s (≈ 0.15s · 620m/s)`);
  check(Math.abs(m[200].t - 0.32) < 0.02 && m[300].t > 0.45 && Math.abs(m[300].v - 470) < 30 && m[300].v > CONFIG.ballistics.speedOfSound,
    `200m 비행 ${m[200].t.toFixed(3)}s · 300m 비행 ${m[300].t.toFixed(3)}s · ${m[300].v.toFixed(0)}m/s (≈ 470m/s, 아직 초음속)`);
  check(m[150].h < m[100].h - 0.03 && m[200].h < -0.1 && m[300].h < -0.5 && m[300].h < m[200].h,
    `100m 넘으면 확실히 떨어짐: 150m ${(m[150].h * 100).toFixed(0)}cm · 200m ${(m[200].h * 100).toFixed(0)}cm · 300m ${(m[300].h * 100).toFixed(0)}cm`);
  check(RANGES.every((R) => Math.abs(Ballistics.simulate(W2, R, zero).height - W2.sightHeight - m[R].h) < 0.01), '실제 탄 = Ballistics.simulate (같은 적분식, 1cm 이내)');
}

// -------------------------------------------------------------------
console.log('\n[14] 관통 — 실제 맵: 풀·덤불 통과 / 대나무 일부 관통 (감속·1~5° 굴절) / 큰 줄기·바위·지형 정지 (재질)');
{
  const bw = new BulletWorld(world);
  const combat = new CombatSystem(world, null, { world: bw, rng: new RNG(2024) });
  const P = data.placements;
  const H = (x, z) => world.getTerrainHeight(x, z);
  const vs = { name: '시험 사수', position: { x: 0, y: 0, z: 0 } };
  const evs = [];
  for (const ev of ['impact', 'partial', 'foliage']) combat.on(ev, (e) => evs.push([ev, e]));
  const shoot = (o, d) => {
    evs.length = 0;
    const p = combat.fire(vs, { origin: o, dir: normalize3(v3(), d), weapon: W2 });
    for (let i = 0; i < 400 && p.alive; i++) combat.update(DT);
    return { p, ev: evs.slice() };
  };
  const firstImpact = (ev) => ev.find(([e]) => e === 'impact')?.[1];
  /** 물체 t 쪽으로 쏠 자리: 16방향 × 거리 dist, 지면 위 height — 선분 cast 결과가 want(r, 단위 방향)를 만족하는 첫 선 */
  const findLine = (t, dist, height, want, { targetY, beyond = 2 } = {}) => {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const o = { x: t.x + Math.cos(a) * dist, z: t.z + Math.sin(a) * dist };
      if (Math.abs(o.x) > 190 || Math.abs(o.z) > 190) continue;
      o.y = H(o.x, o.z) + height;
      if (world.clearanceAt(o.x, o.z, o.y) < 0.35) continue;
      const tg = { x: t.x, y: targetY ?? H(t.x, t.z) + height, z: t.z };
      const d = { x: tg.x - o.x, y: tg.y - o.y, z: tg.z - o.z };
      const L = Math.hypot(d.x, d.y, d.z), f = (L + beyond) / L;
      const r = bw.cast(o, { x: o.x + d.x * f, y: o.y + d.y * f, z: o.z + d.z * f });
      if (want(r, { x: d.x / L, y: d.y / L, z: d.z / L })) return { o, d, L };
    }
    return null;
  };

  // (a) 코끼리풀 (bulletBlock none) — 같은 선으로 100발
  let gl = null;
  for (const g of P.grass.filter((_, i) => i % 37 === 0)) {
    gl = findLine(g, 6, 1.35, (r) => !r.hit && r.partials.length === 0 && r.foliage > 3, { beyond: 6 });
    if (gl) break;
  }
  check(!!gl, '코끼리풀 사격선 찾음');
  if (gl) {
    const N = 100;
    let pass = 0, defl = 0, F = 0, Fd = 0, fx = 0;
    for (let i = 0; i < N; i++) {
      const { p, ev } = shoot(gl.o, gl.d);
      if (!ev.some(([e, x]) => e === 'impact' && dist3(x.point, gl.o) < gl.L + 6)) pass++;
      if (p.deflections > 0) defl++;
      F += p.foliage;
      Fd += p.foliageDeflect;
      fx += ev.filter(([e]) => e === 'foliage').length;
    }
    F /= N; Fd /= N;
    const FO = CONFIG.ballistics.foliage;
    const expect = 1 - Math.exp(-FO.chancePerSigmaM * Fd);
    console.log(`  코끼리풀 (가슴 높이 수평) ${N}발: 통과 ${pass}/${N} · 탄당 잎 적분 ${F.toFixed(2)} (빽빽한 잎 σ≥${FO.denseSigma} ${Fd.toFixed(2)}) · 잎에 빗나감 ${defl}발 (기대 ${(expect * 100).toFixed(0)}%) · 잎 효과 ${(fx / N).toFixed(1)}회/발`);
    check(pass === N, '코끼리풀 (bulletBlock none) 은 통과');
    check(defl > 0 && Math.abs(defl / N - expect) < 0.15, `빽빽한 잎(σ ≥ ${FO.denseSigma})을 지나면 확률 1 − exp(−k·Σσds) 로 0~${FO.maxDeflectDeg}° 빗나감`);
  }

  // (b) 덤불 (bulletBlock none)
  let sl = null;
  for (const s of P.shrub.filter((s) => s.height > 1.6)) {
    sl = findLine(s, 4, 1.0, (r) => !r.hit && r.partials.length === 0 && r.foliage > 0.8, { beyond: 4 });
    if (sl) break;
  }
  check(!!sl, '덤불 사격선 찾음');
  if (sl) {
    const { p, ev } = shoot(sl.o, sl.d);
    const stopped = ev.some(([e, x]) => e === 'impact' && dist3(x.point, sl.o) < sl.L + 4);
    console.log(`  덤불 (1.0m 높이): 잎 적분 ${p.foliage.toFixed(2)} · ${stopped ? '막힘' : '통과'} · ${p.dist.toFixed(0)}m 비행 후 ${p.endReason}`);
    check(!stopped, '덤불 (bulletBlock none) 은 통과');
  }

  // (c) 대나무 (partial) — 20발: 속도 크게 감소, 1~5° 굴절, 계속 날아감
  let bl = null;
  for (const b of P.bamboo) {
    bl = findLine(b, b.radius + 4, 1.4, (r) => r.partials.length > 0 && r.partials[0].objectType === 'bamboo' && (!r.hit || r.t > 0.9), { beyond: 3 });
    if (bl) break;
  }
  check(!!bl, '대나무 사격선 찾음');
  if (bl) {
    const T = CONFIG.ballistics.partialByType.bamboo?.speedMul ?? CONFIG.ballistics.partial.speedMul;
    const st = [];
    for (let i = 0; i < 20; i++) {
      const { p, ev } = shoot(bl.o, bl.d);
      const pe = ev.find(([e]) => e === 'partial')?.[1];
      if (pe) st.push({ type: pe.objectType, mat: pe.material, ratio: pe.speedAfter / pe.speedBefore, defl: pe.deflectDeg, after: p.dist - dist3(pe.point, bl.o) });
    }
    const span = (f, d = 2) => `${Math.min(...st.map(f)).toFixed(d)}~${Math.max(...st.map(f)).toFixed(d)}`;
    console.log(`  대나무 군락 (1.4m 높이) 20발: partial ${st.length}회 · 재질 ${st[0]?.mat} · 속도 ×${span((s) => s.ratio)} · 굴절 ${span((s) => s.defl, 1)}° · 첫 줄기 뒤 비행 ${span((s) => s.after, 0)}m`);
    check(st.length === 20 && st.every((s) => s.type === 'bamboo' && s.mat === 'bamboo'), '대나무 (bulletBlock partial) — 막히지 않고 일부 관통, 재질 bamboo');
    check(st.every((s) => s.ratio >= T[0] - 1e-9 && s.ratio <= T[1] + 1e-9 && s.ratio < 0.75), `속도가 크게 줄어듦 (×${T[0]}~${T[1]})`);
    check(st.every((s) => s.defl >= 1 - 1e-9 && s.defl <= 5 + 1e-9), '1~5° 굴절');
    check(st.every((s) => s.after > 0.5), '관통 후 계속 날아감');
  }

  // (d) 큰 나무 줄기 (full)
  let tl = null, tree = null;
  for (const t of P.bigTree.filter((t) => t.trunkR > 0.5)) {
    tl = findLine(t, t.trunkR * 1.22 + 7, 1.5, (r) => r.hit && r.objectType === 'bigTree' && r.object.x === t.x && r.object.z === t.z && r.partials.length === 0 && r.foliage < 0.5);
    if (tl) { tree = t; break; }
  }
  check(!!tl, '큰 나무 사격선 찾음');
  if (tl) {
    const { p, ev } = shoot(tl.o, tl.d);
    const im = firstImpact(ev);
    console.log(`  큰 나무 줄기 (반경 ${tree.trunkR.toFixed(2)}m): ${im ? `${im.objectType} · 재질 ${im.material} · ${im.speed.toFixed(0)}m/s 로 착탄` : '착탄 없음'} · 끝 ${p.endReason}`);
    check(im && im.objectType === 'bigTree' && im.material === 'wood' && !im.ricochet && p.endReason === 'stopped', '큰 줄기 (full): 막힘, 재질 wood');
  }

  // (e) 바위 (full) — 정면 (면과 30° 이상)
  let rl = null, rock = null;
  for (const r of P.rock.filter((r) => Math.max(r.rx, r.rz) > 0.9 && r.ry > 0.5)) {
    if (r.cy + r.ry - H(r.cx, r.cz) < 0.6) continue;
    rl = findLine({ x: r.cx, z: r.cz }, Math.max(r.rx, r.rz) + 5, 0.4,
      (c, u) => c.hit && c.objectType === 'rock' && c.partials.length === 0 && Math.abs(dot3(c.normal, u)) > 0.5, { targetY: r.cy + r.ry * 0.3 });
    if (rl) { rock = r; break; }
  }
  check(!!rl, '바위 사격선 찾음');
  if (rl) {
    const { p, ev } = shoot(rl.o, rl.d);
    const im = firstImpact(ev);
    const graze = im ? Math.asin(Math.min(1, Math.abs(dot3(im.normal, im.dir)))) / DEG2 : 0;
    console.log(`  바위 (${rock.rx.toFixed(1)}×${rock.ry.toFixed(1)}×${rock.rz.toFixed(1)}m) 정면: ${im ? `${im.objectType} · 재질 ${im.material} · 면과 ${graze.toFixed(0)}° · 도탄 ${im.ricochet ? '예' : '아니오'}` : '착탄 없음'} · 끝 ${p.endReason}`);
    check(im && im.objectType === 'rock' && im.material === 'rock' && !im.ricochet && p.endReason === 'stopped', '바위 (full): 막힘, 재질 rock');
  }

  // (f) 지형 (full) — 지면 종류별 재질
  const rng = new RNG(8);
  const mats = [];
  for (const [surf, mat] of [[SURFACE.PACKED_DIRT, 'dirt'], [SURFACE.LEAF_LITTER, 'leaves'], [SURFACE.SHALLOW_MUD, 'mud']]) {
    let ok = null;
    for (let k = 0; k < 40000 && !ok; k++) {
      const x = rng.range(-170, 160), z = rng.range(-170, 160);
      if (world.getSurfaceAt(x, z) !== surf || world.getWaterDepth(x, z) > 0 || world.getSlope(x, z).deg > 20) continue;
      if (world.getSupportHeight(x, z) > H(x, z) + 0.01) continue;
      const tg = { x, y: H(x, z), z };
      for (let a = 0; a < 6.28 && !ok; a += 0.7) {
        const o = { x: x + Math.cos(a) * 2.5, z: z + Math.sin(a) * 2.5 };
        o.y = H(o.x, o.z) + 1.6;
        const d = { x: tg.x - o.x, y: tg.y - o.y, z: tg.z - o.z };
        const c = bw.cast(o, pt3(o, tg, 1.3));
        if (c.hit && c.objectType === 'terrain' && c.partials.length === 0 && dist3(c.point, tg) < 0.2) ok = { o, d };
      }
    }
    if (!ok) { mats.push(`${surfaceLabel(surf)} 지점 없음`); check(false, `지형 ${surfaceLabel(surf)} 사격 지점`); continue; }
    const { p, ev } = shoot(ok.o, ok.d);
    const im = firstImpact(ev);
    mats.push(`${surfaceLabel(surf)} → ${im?.material}`);
    check(im && im.objectType === 'terrain' && im.material === mat && p.endReason === 'stopped', `지형 (${surfaceLabel(surf)}): 막힘, 재질 ${mat}`);
  }
  console.log(`  지형 착탄 재질: ${mats.join(' · ')}`);
}

// -------------------------------------------------------------------
console.log('\n[15] 제압: 근접 통과 증가량 · 2초 대기 후 초당 12 감소 · 2m 안 착탄 +10 · 단계');
{
  // (a) 증가량 — 사용자 기준: 0.3m 이하 +30 / 1m +15 / 2m +5 (사이 선형), 2m 밖은 근접 통과 아님
  const want = [[0, 30], [0.3, 30], [0.65, 22.5], [1, 15], [1.5, 10], [2, 5], [2.01, 0], [5, 0]];
  const got = want.map(([d]) => Suppression.gainForPass(d));
  console.log(`  근접 통과 증가량: ${want.map(([d], i) => `${d}m +${+got[i].toFixed(2)}`).join(' · ')}`);
  check(want.every(([, g], i) => Math.abs(got[i] - g) < 1e-9), '0.3m 이하 +30 · 1m +15 · 2m +5 (사이 선형) · 2m 밖 0');

  // (b) 감소 시간표 (60Hz)
  const s = new Suppression();
  s.addNearPass(0.3);
  const marks = [[1, 30], [1.95, 30], [2.5, 24], [3, 18], [4, 6], [4.5, 0]];
  const seen = [];
  let frames = 0;
  for (const [tm] of marks) {
    for (const n = Math.round(tm / DT); frames < n; frames++) s.update(DT);
    seen.push(s.value);
  }
  console.log(`  0.3m 통과 한 번 (+30) 뒤: ${marks.map(([tm], i) => `${tm}s ${seen[i].toFixed(1)}`).join(' · ')}`);
  check(marks.every(([, v], i) => Math.abs(seen[i] - v) < 1e-6), '마지막 이벤트 후 2초 유지, 이후 초당 12 감소');

  // (c) 실제 탄: 머리 옆 0.5m 를 지나감 → 거리 표대로 증가 + 초음속 '딱'
  const cs = new CombatSystem(null, null, { world: createFlatWorld(0), rng: new RNG(3) });
  const person = cs.addPerson({ name: '병사', getPose: () => ({ x: 0, y: 0, z: 0, yaw: 0, stance: 'stand', arms: 'down' }) });
  const vs = { name: 'F7 사수', position: { x: 0, y: 1.6, z: -60 } };
  const rec = { pass: [], impact: [], flyby: [] };
  person.suppression.on('nearPass', (e) => rec.pass.push(e));
  person.suppression.on('nearImpact', (e) => rec.impact.push(e));
  cs.on('flyby', (e) => { if (e.person === person) rec.flyby.push(e); });
  const fireAt = (o, d) => {
    const p = cs.fire(vs, { origin: o, dir: normalize3(v3(), d), weapon: W2 });
    for (let i = 0; i < 120 && p.alive; i++) cs.update(DT);
  };
  const head = person.hitboxes.find((c) => c.part === 'head');
  const hc = pt3(head.a, head.b, 0.5);
  fireAt({ x: hc.x + head.r + 0.5, y: hc.y, z: -60 }, { x: 0, y: 0.0005, z: 1 });   // 60m 비행 낙차(약 3cm)만큼 살짝 위로
  const np = rec.pass[0];
  console.log(`  머리 옆 0.5m 를 지나는 탄: 근접 통과 ${np ? `${np.distance.toFixed(3)}m → +${np.gain.toFixed(1)}` : '없음'} · 초음속 '딱' ${rec.flyby.length}회${rec.flyby[0] ? ` (${rec.flyby[0].speed.toFixed(0)}m/s)` : ''} · 제압 ${person.suppression.value.toFixed(1)} (${person.suppression.level})`);
  check(np && Math.abs(np.distance - 0.5) < 0.03 && Math.abs(np.gain - Suppression.gainForPass(np.distance)) < 1e-9 && Math.abs(person.suppression.value - np.gain) < 1e-9,
    '실제 탄의 근접 통과 → 거리 표대로 증가');
  check(rec.pass.length === 1 && rec.flyby.length === 1, "(탄, 사람)당 근접 통과·초음속 '딱' 한 번씩");

  // (d) 2m 안 착탄 +10 (발 앞 1.2m 땅) / 2m 밖 착탄은 0
  person.suppression.reset(); rec.pass.length = 0; rec.impact.length = 0;
  fireAt({ x: 0, y: 6, z: -4.2 }, { x: 0, y: -6, z: 3 });
  const ni = rec.impact[0];
  const passGain = rec.pass.reduce((sum, e) => sum + e.gain, 0);
  console.log(`  발 앞 1.2m 땅에 착탄: 근처 착탄 ${ni ? `${ni.distance.toFixed(2)}m (${ni.material}) → +${ni.gain}` : '없음'} · 그 전 근접 통과 +${passGain.toFixed(1)} · 제압 ${person.suppression.value.toFixed(1)}`);
  check(ni && ni.gain === 10 && ni.distance <= 2 && Math.abs(person.suppression.value - passGain - 10) < 1e-6, '2m 안 착탄 +10');
  person.suppression.reset(); rec.pass.length = 0; rec.impact.length = 0;
  fireAt({ x: 0, y: 6, z: -7 }, { x: 0, y: -6, z: 3 });   // 발 앞 4m
  check(rec.impact.length === 0 && rec.pass.length === 0 && person.suppression.value === 0, '2m 밖 착탄·통과는 제압 없음');

  // (e) 단계 · 감소 중 단계 이벤트
  const lv = [[29.9, 'none'], [30, 'light'], [59.9, 'light'], [60, 'heavy'], [84.9, 'heavy'], [85, 'pinned'], [100, 'pinned']];
  check(lv.every(([v, l]) => Suppression.levelFor(v) === l), '단계: 30 이상 경미(light) · 60 이상 강함(heavy) · 85 이상 완전 제압(pinned)');
  const s2 = new Suppression();
  const steps = [];
  let f2 = 0;
  s2.on('level', (e) => steps.push({ prev: e.prev, level: e.level, t: f2 * DT }));
  s2.add(100, 'test');
  for (; f2 < 12 * 60 && s2.value > 0;) { f2++; s2.update(DT); }
  const expT = [0, 2 + 15 / 12, 2 + 40 / 12, 2 + 70 / 12];
  console.log(`  100 에서 감소: ${steps.map((e) => `${e.prev}→${e.level} ${e.t.toFixed(2)}s`).join(' · ')}`);
  check(steps.length === 4 && steps.map((e) => e.level).join() === 'pinned,heavy,light,none' && steps.every((e, i) => Math.abs(e.t - expT[i]) <= DT + 1e-9),
    "단계가 바뀔 때 'level' 이벤트 (85·60·30 아래로 내려가는 시각 3.25 / 5.33 / 7.83s)");

  // (f) 지속 효과 — 사용자 기준 '조준 흔들림 배율 최대 ×2.5' (수치에 비례) + 지속적인 미세 떨림.
  //     완전 제압 추가 배율(pinnedSwayMul)까지 곱한 실제 배율이 0~100 어디에서도 ×2.5 를 넘으면 안 된다
  const fx = (v) => { const q = new Suppression(); q.value = v; return q.effects(); };
  const E = CONFIG.suppression.effects;
  const e60 = fx(60), e85 = fx(85), e100 = fx(100);
  let maxMul = 0, mono = true, sameAim = true;
  for (let v = 0, prev = 0; v <= 100; v += 0.5) {
    const m = fx(v).swayMul;
    if (!(m >= prev - 1e-12)) mono = false;
    if (Math.abs(suppressionSwayMul(v) - m) > 1e-12) sameAim = false;   // effects 를 안 넘길 때 AimModel 이 쓰는 식
    prev = m;
    maxMul = Math.max(maxMul, m);
  }
  console.log(`  효과: 60 → 흔들림 ×${e60.swayMul.toFixed(2)} · 85 → ×${e85.swayMul.toFixed(3)}${E.pinnedSwayMul !== 1 ? ` (완전 제압 ×${E.pinnedSwayMul} 포함)` : ''}, 떨림 ${e85.tremorDeg.toFixed(3)}°, 심박 긴장 ${e85.heartStress.toFixed(3)}, 터널 ${e85.tunnel.toFixed(2)}, 먹먹함 ${e85.muffle.toFixed(2)} · 100 → ×${e100.swayMul.toFixed(2)} · 0~100 최대 ×${maxMul.toFixed(3)}`);
  check(E.swayMaxMul === 2.5 && Math.abs(e60.swayMul - 1.9) < 1e-9 && Math.abs(e100.swayMul - 2.5) < 1e-9 && maxMul <= 2.5 + 1e-9 && mono,
    '흔들림 배율 1 → ×2.5 (수치에 비례) — 85 이상 추가 배율까지 곱해도 최대 ×2.5 를 넘지 않음');
  check(sameAim && e85.tremorDeg > 0 && Math.abs(e85.heartStress - E.heartStress * 0.85) < 1e-9 && Math.abs(e85.tunnel - E.tunnel * 0.85) < 1e-9,
    '미세 떨림 · 심박 긴장 · 터널 시야 (수치에 비례) · AimModel 기본 경로(suppressionSwayMul)도 같은 배율');

  // (g) 심박 긴장 → 심박: 쉬고 있는 HumanMotor 에 motor.stress = effects().heartStress (게임 연결과 같음 — effects() 는 이미
  //     수치/100 배라 다시 곱하지 않음) 를 주면 rest + (max − rest)·min(1, stressWeight·stress) 로 수렴 = npm run aim #6 의 심박
  {
    const H = CONFIG.heart;
    const want = H.rest + (H.max - H.rest) * Math.min(1, H.stressWeight * e85.heartStress);
    const dirt = results[SURFACE.PACKED_DIRT];
    const m = dirt?.spot ? newMotor(dirt.spot.x, dirt.spot.z) : null;
    if (!m || typeof m.stress !== 'number') {
      console.log(`  심박 긴장: HumanMotor.stress 가 아직 없어 수렴 검사는 건너뜀 (연결되면 자동 검사 — 제압 85 기대 심박 ${want.toFixed(1)})`);
    } else {
      m.stress = e85.heartStress;
      run(m, 60);
      console.log(`  심박 긴장: 제압 85 → stress ${e85.heartStress.toFixed(4)} → 60초 쉰 HumanMotor 심박 ${m.heartRate.toFixed(1)} (난이도 측정 #6 ${want.toFixed(1)})`);
      check(Math.abs(m.heartRate - want) < 0.5, '제압 긴장으로 오른 심박이 난이도 측정(npm run aim #6)과 같은 값으로 수렴');
    }
  }
}

// -------------------------------------------------------------------
console.log('\n[16] 무기: 600rpm · 전술 재장전 31발 · 빈 상태 재장전 · 쓰다 만 탄창 재사용 · 기능 고장 (오염도 최대 ×20) · 해결');
{
  const mk = (seed) => new Weapon(W2, { rng: new RNG(seed) });
  // 동작 흐름 시험 (a~d) 은 기능 고장 없는 복사본으로 — 0.05% 고장이 우연히 끼어 결과가 흔들리지 않게 (고장은 e·g 에서 따로)
  const NOJAM = { ...W2, malfunction: { ...W2.malfunction, perShot: 0 } };
  const mkSure = (seed) => new Weapon(NOJAM, { rng: new RNG(seed) });
  const press = (w, dt = DT, extra = {}) => w.update(dt, { trigger: true, triggerPressed: true, ...extra });
  const release = (w, dt = DT) => w.update(dt, { trigger: false });
  const waitReady = (w) => { let t = 0; while (w.busy && t < 10) { w.update(DT, {}); t += DT; } return t; };

  // (a) 연사 간격
  const wa = mkSure(1);
  wa.setMode('auto');
  const times = [];
  wa.on('shot', (e) => times.push(wa.time - e.timeOffset));
  press(wa);
  for (let i = 0; i < 240; i++) wa.update(DT, { trigger: true });
  const iv = times.slice(1).map((t, i) => t - times[i]);
  console.log(`  연발: ${times.length}발 (탄창 29 + 약실 1) · 첫 발 → 마지막 ${(times.at(-1) - times[0]).toFixed(3)}s · 간격 ${Math.min(...iv).toFixed(4)}~${Math.max(...iv).toFixed(4)}s`);
  check(times.length === 30 && iv.every((d) => Math.abs(d - 60 / 600) < 1e-6) && W2.rpm === 600, '분당 600발 (0.1초 간격), 30발 탄창');

  // (b) 전술 재장전: 10발 쏘고 R → 2.3초, 약실 1발 유지 → 31발, 쓰던 탄창(19발)은 보관
  const wb = mkSure(2);
  const mech = [];
  wb.on('noise', (e) => mech.push(e.kind));
  for (let i = 0; i < 10; i++) { press(wb, 0.1); release(wb, 0.1); }
  const before = wb.totalRounds;
  wb.update(DT, { reload: true });
  const kindB = wb.action?.kind;
  const tB = waitReady(wb);   // R 을 누른 프레임 끝부터
  console.log(`  전술 재장전: ${kindB} ${tB.toFixed(2)}s · 끼운 탄창 ${wb.magRounds} + 약실 ${wb.chambered ? 1 : 0} = ${wb.magRounds + (wb.chambered ? 1 : 0)}발 · 탄창들 [${wb.mags.map((q, i) => (i === wb.magIndex ? '*' : '') + q.rounds).join(', ')}]`);
  check(kindB === 'reloadTactical' && Math.abs(tB - W2.reload.tactical) <= DT + 1e-9 && W2.reload.tactical === 2.3, '탄이 남은 상태 재장전 2.3초');
  check(wb.magRounds === 30 && wb.chambered && wb.mags[0].rounds === 19 && wb.totalRounds === before, '약실 1발 유지 → 31발, 빼낸 탄창(19발)은 버리지 않고 보관');
  check(mech.includes('weaponMech'), '탄창 분리·결합 기계음 소음 이벤트');

  // (c) 빈 상태 재장전: 30발 다 쏘고 R → 3.0초 (노리쇠 당기기 포함)
  const wc = mkSure(3);
  wc.setMode('auto');
  const steps = [];
  for (const k of ['magOut', 'magIn', 'boltPull', 'boltRelease']) wc.on(k, () => steps.push(k));
  press(wc);
  for (let i = 0; i < 240 && wc.chambered; i++) wc.update(DT, { trigger: true });
  release(wc);
  const emptyBefore = !wc.chambered && wc.magRounds === 0;
  wc.update(DT, { reload: true });
  const kindC = wc.action?.kind;
  const tC = waitReady(wc);
  console.log(`  빈 상태 재장전: ${kindC} ${tC.toFixed(2)}s · ${steps.join(' → ')} · 탄창 ${wc.magRounds} + 약실 ${wc.chambered ? 1 : 0}`);
  check(emptyBefore && kindC === 'reloadEmpty' && Math.abs(tC - W2.reload.empty) <= DT + 1e-9 && W2.reload.empty === 3.0, '빈 상태 재장전 3.0초');
  check(steps.join() === 'magOut,magIn,boltPull,boltRelease' && wc.magRounds === 29 && wc.chambered, '노리쇠를 당겨 약실 장전 (29 + 1)');

  // (d) 쓰다 만 탄창 재사용: (b) 의 총으로 남은 탄을 모두 쏨 — 가장 많이 든 탄창부터, 19발 탄창도 마지막에 다시 씀
  const magIns = [];
  let fired = 10, duds = 0, noMags = false;
  wb.on('magIn', (e) => magIns.push(e.rounds));
  wb.on('shot', () => fired++);
  wb.on('malfunction', () => duds++);
  wb.on('noMags', () => { noMags = true; });
  wb.setMode('auto');
  for (let guard = 0; guard < 40 && !noMags; guard++) {
    press(wb);
    for (let i = 0; i < 400 && wb.chambered && !wb.malfunctioned; i++) wb.update(DT, { trigger: true });
    release(wb);
    wb.update(DT, { reload: true });   // 고장이면 해결, 비었으면 재장전, 더 나은 탄창이 없으면 'noMags'
    waitReady(wb);
  }
  console.log(`  남은 탄 모두 사격: 끼운 탄창 순서 [${magIns.join(', ')}] · 발사 ${fired} + 불발 ${duds} = ${fired + duds} / 휴대 ${W2.magsCarried * W2.magCapacity}`);
  check(noMags && magIns.at(-1) === 19 && fired + duds === W2.magsCarried * W2.magCapacity && wb.totalRounds === 0, '쓰다 만 탄창도 버리지 않고 다시 사용 (휴대한 탄을 모두 씀)');

  // (e) 기능 고장 확률: 발당 0.05% × (1 + 19 × 오염도/100) — 오염도 100 이면 ×20
  const rateAt = (f) => { const w = mk(5); w.fouling = f; return w.malfunctionChance; };
  const measure = (fouling, n, seed) => {
    const w = mk(seed);
    let jams = 0;
    w.on('malfunction', () => jams++);
    w.fouling = fouling;
    for (let i = 0; i < n; i++) {
      if (!w.chambered || w.malfunctioned) { w.reset(); w.fouling = fouling; }
      press(w, DT);
      release(w, 0.1);
    }
    return jams;
  };
  const n0 = 60000, n1 = 30000;
  const j0 = measure(0, n0, 11), j1 = measure(100, n1, 12);
  const p0 = rateAt(0), p1 = rateAt(100);
  const z0 = (j0 - n0 * p0) / Math.sqrt(n0 * p0 * (1 - p0)), z1 = (j1 - n1 * p1) / Math.sqrt(n1 * p1 * (1 - p1));
  console.log(`  기능 고장: 오염도 0 → 발당 ${(p0 * 100).toFixed(3)}% (측정 ${j0}/${n0} = ${(j0 / n0 * 100).toFixed(3)}%, z ${z0.toFixed(1)}) · 50 → ${(rateAt(50) * 100).toFixed(3)}% · 100 → ${(p1 * 100).toFixed(2)}% (측정 ${j1}/${n1} = ${(j1 / n1 * 100).toFixed(2)}%, z ${z1.toFixed(1)}) · ×${(p1 / p0).toFixed(1)}`);
  check(Math.abs(p0 - 0.0005) < 1e-12 && Math.abs(p1 / p0 - 20) < 1e-9 && Math.abs(rateAt(50) - 0.0005 * 10.5) < 1e-12, '발당 0.05%, 오염도에 비례해 최대 ×20');
  check(Math.abs(z0) < 4 && Math.abs(z1) < 4, '실제 사격 경로의 고장 빈도가 확률과 일치 (±4σ)');

  // (f) 오염도 증가: 진흙에서 포복 · 물에 잠김
  const wf = mk(6);
  wf.updateFouling(5, { stance: 'prone', surface: 'shallowMud', moving: true });
  const afterMud = wf.fouling;
  wf.updateFouling(1, { stance: 'stand', surface: 'shallowWater', moving: true, waterDepth: 1.3 });
  const afterWater = wf.fouling;
  wf.updateFouling(5, { stance: 'stand', surface: 'packedDirt', moving: true, waterDepth: 0 });
  const FO = CONFIG.weapons.fouling;
  console.log(`  오염도: 진흙 포복 5초 → ${afterMud.toFixed(1)} · 허리 깊이(1.3m) 물에 1초 → ${afterWater.toFixed(1)} · 흙길 서서 5초 → ${wf.fouling.toFixed(1)}`);
  check(Math.abs(afterMud - FO.proneMud * 5) < 1e-9 && Math.abs(afterWater - afterMud - FO.submerged) < 1e-9 && wf.fouling === afterWater,
    '진흙에서 포복하거나 물에 잠기면 오염도 증가 (흙길에선 그대로)');

  // (g) 고장 → '딸깍'만 → R 로 노리쇠를 당겨 해결 (1.5초, 불발탄 1발 버림)
  const wg = mk(7);
  wg.fouling = 100;
  for (let i = 0; i < 20000 && !wg.malfunctioned; i++) {
    if (!wg.chambered || wg.magRounds === 0) { wg.reset(); wg.fouling = 100; }   // 탄창에 탄이 남은 채로 고장 나게
    press(wg); release(wg, 0.1);
  }
  const dry = [], shotsG = [];
  wg.on('dryFire', (e) => dry.push(e.reason));
  wg.on('shot', () => shotsG.push(1));
  const total0 = wg.totalRounds;
  press(wg); release(wg, 0.1);
  const clickOnly = wg.malfunctioned && dry.join() === 'malfunction' && shotsG.length === 0;
  wg.update(DT, { reload: true });
  const kindG = wg.action?.kind, stateG = wg.state;
  const tG = waitReady(wg);
  press(wg); release(wg, 0.1);
  console.log(`  고장: 방아쇠 → '딸깍' (${dry.join(',')}) · R → ${kindG} (${stateG}) ${tG.toFixed(2)}s · 해결 후 고장 ${wg.malfunctioned ? 'O' : 'X'} · 탄 ${total0} → ${wg.totalRounds + shotsG.length} (불발탄 버림) · 다시 사격 ${shotsG.length}발`);
  check(clickOnly, "고장이면 방아쇠를 당겨도 '딸깍'만 (발사 없음)");
  check(kindG === 'clear' && stateG === 'clearing' && Math.abs(tG - W2.reload.clear) <= DT + 1e-9 && W2.reload.clear === 1.5 && !wg.malfunctioned, 'R 로 노리쇠를 당겨 해결 (1.5초)');
  check(wg.totalRounds + shotsG.length === total0 - 1 && shotsG.length === 1, '불발탄 1발을 버리고 다음 탄 장전 → 다시 쏠 수 있음');

  // (h) 총성·착탄 소음 이벤트 (4단계 적 반응용)
  const ne = new NoiseEvents();
  const heard = [];
  ne.on('noise', (e) => heard.push(e));
  const cs = new CombatSystem(null, ne, { world: createFlatWorld(0), rng: new RNG(4) });
  const p = cs.fire({ name: '시험 사수', position: { x: 0, y: 1.5, z: 0 } }, { origin: { x: 0, y: 1.5, z: 0 }, dir: normalize3(v3(), { x: 0, y: -0.2, z: -1 }), weapon: W2 });
  for (let i = 0; i < 30 && p.alive; i++) cs.update(DT);
  const gs = heard.find((e) => e.kind === 'gunshot'), ih = heard.find((e) => e.kind === 'impact');
  console.log(`  소음: 총성 반경 ${gs?.baseRadius}m · 착탄 반경 ${ih?.baseRadius}m (${ih?.material}, ${ih ? Math.hypot(ih.x, ih.z).toFixed(1) : '-'}m 앞)`);
  check(gs && gs.baseRadius === CONFIG.noise.gunshot && ih && ih.baseRadius === CONFIG.noise.impact && Math.abs(ih.y) < 0.01, '발사음과 착탄에 소음 이벤트');
}

// -------------------------------------------------------------------
console.log('\n[17] 피격 부위: 서기·앉기·엎드리기 표적의 부위 중심을 쏘면 그 부위로 판정 · hit 이벤트 내용');
{
  const cs = new CombatSystem(null, null, { world: createFlatWorld(0), rng: new RNG(5) });
  const pose = { x: 0, y: 0, z: 0, yaw: 0, stance: 'stand', arms: 'down' };
  const target = cs.addPerson({ name: '표적', getPose: () => pose });
  const vs = { name: '시험 사수', position: { x: 0, y: 0, z: 0 } };
  const hits = [];
  let personHits = 0;
  cs.on('hit', (e) => hits.push(e));
  target.on('hit', () => personHits++);
  // 쏘는 방향 후보 (표적 기준, 앞 = −Z): 수평 8방위 × 높이 0·30·60° + 바로 위 — 앞에서 수평이 먼저
  const AZ = ['정면', '오른쪽 앞', '오른쪽', '오른쪽 뒤', '뒤', '왼쪽 뒤', '왼쪽', '왼쪽 앞'];
  const cands = [];
  for (const el of [0, 30, 60]) {
    for (let k = 0; k < 8; k++) {
      const az = (k / 8) * Math.PI * 2, e = el * DEG2;
      // 쏘는 곳 방향 s (표적에서 사수 쪽): 앞(−Z)·오른쪽(+X)
      const s = { x: Math.sin(az) * Math.cos(e), y: Math.sin(e), z: -Math.cos(az) * Math.cos(e) };
      cands.push({ label: el ? `${AZ[k]} 위 ${el}°` : AZ[k], s });
    }
  }
  cands.push({ label: '바로 위', s: { x: 0, y: 1, z: 0 } });
  const STANCE_KO = { stand: '서기', crouch: '앉기', prone: '엎드리기' };
  let payloadOk = true, labelOk = true;
  for (const stance of ['stand', 'crouch', 'prone']) {
    pose.stance = stance;
    target.refresh();
    const caps = target.hitboxes;
    const rows = [];
    let right = 0;
    for (const part of PARTS) {
      const mine = caps.filter((c) => c.part === part);
      const C = { x: 0, y: 0, z: 0 };
      for (const c of mine) { C.x += (c.a.x + c.b.x) / 2; C.y += (c.a.y + c.b.y) / 2; C.z += (c.a.z + c.b.z) / 2; }
      C.x /= mine.length; C.y /= mine.length; C.z /= mine.length;
      // 부위 중심까지 다른 부위에 가리지 않는 방향 (첫 교차 캡슐이 그 부위)
      let use = null;
      for (const cd of cands) {
        const o = { x: C.x + cd.s.x * 8, y: C.y + cd.s.y * 8, z: C.z + cd.s.z * 8 };
        if (o.y < 0.02) continue;
        const end = { x: C.x - cd.s.x * 0.3, y: C.y - cd.s.y * 0.3, z: C.z - cd.s.z * 0.3 };
        let best = Infinity, bp = null;
        for (const c of caps) { const t = segCapsule(o, end, c); if (t >= 0 && t < best) { best = t; bp = c.part; } }
        if (bp === part) { use = { o, d: { x: -cd.s.x, y: -cd.s.y, z: -cd.s.z }, label: cd.label }; break; }
      }
      if (!use) { rows.push(`${partLabel(part)} (가리지 않는 방향 없음)`); continue; }
      hits.length = 0;
      const p = cs.fire(vs, { origin: use.o, dir: use.d, weapon: W2 });
      for (let i = 0; i < 10 && p.alive; i++) cs.update(DT);
      const h = hits[0];
      const ok = h && h.part === part;
      if (ok) right++;
      if (h) {
        payloadOk &&= h.person === target && PARTS.includes(h.part) && h.speed > 600 && h.speed <= W2.muzzleVelocity && h.incidenceDeg >= 0 && h.incidenceDeg <= 90 &&
          !!h.point && !!h.normal && !!h.dir && Math.abs(h.distance - 8) < 0.5 && h.timeOfFlight > 0 && Array.isArray(h.penetrated);
        labelOk &&= partLabel(h.part) === CONFIG.hitboxes.labels[h.part];
      }
      rows.push(ok ? `${partLabel(part)}(${use.label} ${h.incidenceDeg.toFixed(0)}°)` : `${partLabel(part)} → ${h ? partLabel(h.part) : '빗나감'}`);
    }
    console.log(`  ${STANCE_KO[stance]}: ${rows.join(' · ')}`);
    check(right === PARTS.length, `${STANCE_KO[stance]} 표적: ${PARTS.length}개 부위 중 ${right}개를 그 부위로 판정`);
  }
  const ex = hits[0];
  if (ex) console.log(`  hit 예: 사람 '${ex.person.name}' · 부위 ${ex.part} (${partLabel(ex.part)}) · 탄 속도 ${ex.speed.toFixed(0)}m/s · 입사각 ${ex.incidenceDeg.toFixed(1)}° · 거리 ${ex.distance.toFixed(2)}m · 비행 ${ex.timeOfFlight.toFixed(4)}s · 관통 [${ex.penetrated.join(', ')}]`);
  check(payloadOk && hits.length > 0, "'hit' 이벤트: 맞은 사람 · 부위 · 탄 속도 · 입사각 (+ 지점·법선·거리·비행시간·관통)");
  check(labelOk && personHits === 3 * PARTS.length, "부위 이름표 (CONFIG.hitboxes.labels) · 맞은 Person 도 'hit' 을 받음");
}

console.log(failures ? `\n실패 ${failures}건` : '\n모든 검증 통과');
process.exitCode = failures ? 1 : 0;
