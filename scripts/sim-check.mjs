// 이동 규칙 헤드리스 검증 (브라우저 없이 Node로 실행)
//   node scripts/sim-check.mjs
// 생성된 실제 맵 위에서 HumanMotor를 돌려 지면별 속도·빠짐·미끄러짐·스태미나·거동 불능을 측정한다.
import { CONFIG, SURFACE_KEYS } from '../src/config.js';
import { generateWorld } from '../src/world/WorldGen.js';
import { WorldQuery } from '../src/world/WorldQuery.js';
import { HumanMotor } from '../src/human/HumanMotor.js';
import { NoiseEvents } from '../src/core/NoiseEvents.js';
import { SURFACE, surfaceLabel } from '../src/world/Surfaces.js';

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

/** 지정 지면이 반경 r 안에서 균일하고 평탄한 지점 찾기 */
function findSpot(surface, r = 3, maxSlope = 5, near = CONFIG.world.start, maxDist = 150) {
  let best = null, bestD = Infinity;
  for (let z = -180; z < 180; z += 1) {
    for (let x = -180; x < 165; x += 1) {
      const d = Math.hypot(x - near.x, z - near.z);
      if (d > maxDist || d > bestD) continue;
      if (world.getSurfaceAt(x, z) !== surface) continue;
      if (world.getSlope(x, z).deg > maxSlope) continue;
      let ok = true;
      for (let a = 0; a < 6.28 && ok; a += 0.5) {
        for (const rr of [r * 0.5, r]) {
          const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
          if (world.getSurfaceAt(px, pz) !== surface || world.getSupportHeight(px, pz) > world.getTerrainHeight(px, pz) + 0.01) { ok = false; break; }
        }
      }
      if (ok) { best = { x, z }; bestD = d; }
    }
  }
  return best;
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
    }
    if (ok) return a;
  }
  return null;
}
for (let id = 0; id < SURFACE_KEYS.length; id++) {
  let spot = null, axis = null;
  for (const r of [2, 1.2, 0.6]) {
    spot = findSpot(id, r, 6);
    if (spot) { axis = findAxis(spot.x, spot.z, id, 2.2); if (axis !== null) break; }
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
  const spot = findSpot(SURFACE.LEAF_LITTER, 30, 4);
  const m = newMotor(spot.x, spot.z);
  m.input.move.z = 1; m.input.sprint = true;
  let tEx = null;
  for (let i = 0; i < 20 * 60 && tEx === null; i++) {
    const t = i * DT;
    if (Math.abs(t % 2) < DT / 2) m.yaw += 2.0; // 원을 그리며
    m.update(DT);
    if (m.exhausted) tEx = t;
  }
  run(m, 0.5);
  console.log(`  낙엽 지면 달리기 → 고갈까지 ${tEx?.toFixed(1)}s, 심박 ${m.heartRate.toFixed(0)}bpm, 숨 ${m.breath.toFixed(2)}`);
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
  const spot = findSpot(SURFACE.LEAF_LITTER, 10, 4);
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

console.log(failures ? `\n실패 ${failures}건` : '\n모든 검증 통과');
process.exitCode = failures ? 1 : 0;
