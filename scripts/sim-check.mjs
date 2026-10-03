// 이동 규칙 헤드리스 검증 (브라우저 없이 Node로 실행)
//   node scripts/sim-check.mjs
// 생성된 실제 맵 위에서 HumanMotor를 돌려 지면별 속도·빠짐·미끄러짐·스태미나·거동 불능을 측정한다.
import { CONFIG, SURFACE_KEYS } from '../src/config.js';
import { generateWorld } from '../src/world/WorldGen.js';
import { WorldQuery } from '../src/world/WorldQuery.js';
import { HumanMotor } from '../src/human/HumanMotor.js';
import { NoiseEvents } from '../src/core/NoiseEvents.js';
import { SURFACE, surfaceLabel } from '../src/world/Surfaces.js';
import { computeExposure } from '../src/human/Exposure.js';
import { VEG } from '../src/world/WorldGen.js';

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
  check(b3.object && ['bigTree', 'root', 'terrain'].includes(b3.object.type), '큰 줄기는 탄도 full');
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

console.log(failures ? `\n실패 ${failures}건` : '\n모든 검증 통과');
process.exitCode = failures ? 1 : 0;
