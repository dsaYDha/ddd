// =====================================================================
//  MissionGen — 5단계 임무 만들기 (순수 로직: three.js·DOM 없음, Node 에서 검증 가능)
//   같은 맵(월드 시드 고정) 위에서 임무 시드마다 배치가 달라진다: 투입 지점, 목표, 회수 지점, 적 계획, 흔적, 시각, 날씨.
//   · 지형지물(landmark): 개울 여울·깊은 웅덩이·강과 만나는 곳·늪으로 드는 곳·오솔길 갈림길·논 모퉁이·늪 가장자리·
//     코끼리풀 개활지·대나무 숲·언덕(능선) 위 큰 나무 — 지도에 있는 것으로 말로 설명할 수 있는 곳만.
//   · 정찰: 지형지물 2~3곳 확인 → 회수.  매복: 오솔길 구간에서 보급 행렬 기습 → 회수.  습격: 야영지 문서 회수 → 회수.
//   · 회수 지점: 강가 모래톱 또는 논(개활지). 모든 목표·회수 지점은 길찾기 격자(NavGrid)로 실제 걸어서 닿는지 확인.
//   · 브리핑의 적 규모는 ±30% 틀릴 수 있다.
//   · 6단계: 시작 시각에 '밤' 추가, 해질녘 임무는 밤까지 이어질 수 있다 (5단계 제한 해제). 달 모양 (보름·반달·그믐).
//     함정 계획 (TrapPlan.planTraps — 대부분 오솔길·논둑·야영지 접근로 길목, 숲속엔 드물게) → m.traps
//  generateMission(type, seed, world) — world = { data, query, nav }
// =====================================================================
import { CONFIG, SURFACE_KEYS } from '../config.js';
import { RNG } from '../core/rng.js';
import { LAYOUT, riverCenterZ } from '../world/MapLayout.js';
import { WeatherCycle } from './Weather.js';
import { planTraps } from './TrapPlan.js';

export const MISSION_TYPES = ['recon', 'ambush', 'raid'];
export const MISSION_LABELS = { recon: '정찰', ambush: '매복', raid: '적 야영지 습격' };
const TOD_KEYS = ['dawn', 'noon', 'dusk', 'night'];
const TOD_LABELS = { dawn: '새벽', noon: '한낮', dusk: '해질녘', night: '밤' };
const MOON_KEYS = ['full', 'half', 'new'];
const rr = (rng, r) => rng.range(r[0], r[1]);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const SURF = (k) => SURFACE_KEYS.indexOf(k);

/** 북쪽(−z)에서 시계 방향 방위 (도) */
export function bearingDeg(dx, dz) {
  const a = Math.atan2(dx, -dz) * 180 / Math.PI;
  return (a + 360) % 360;
}
const DIR8 = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
export function dirName(dx, dz) { return DIR8[Math.round(bearingDeg(dx, dz) / 45) % 8]; }
/** 맵 안 위치 → '북동쪽' / '가운데' */
export function areaName(x, z) { return Math.hypot(x, z) < 45 ? '가운데' : `${dirName(x, z)}쪽`; }

// ---------------------------------------------------------------------
// 맵 분석 (월드마다 한 번)
// ---------------------------------------------------------------------
const CACHE = new WeakMap();

export function analyzeWorld(world) {
  let A = CACHE.get(world.data);
  if (A) return A;
  A = {
    landmarks: findLandmarks(world),
    starts: findStarts(world),
    extractions: findExtractions(world),
    camps: findCampSites(world),
    trailPoints: trailPoints(world),
  };
  CACHE.set(world.data, A);
  return A;
}

function approachOf(world, x, z) {
  return world.nav.nearestOpen(x, z, 6);
}

function streamName(st) { return st.name === 'east' ? '동쪽 개울' : '서쪽 개울'; }

export function findLandmarks(world) {
  const { data, query } = world;
  const L = data.layout;
  const out = [];
  const add = (kind, x, z, label) => {
    const ap = approachOf(world, x, z);
    if (!ap) return;
    if (out.some((o) => dist(o, { x, z }) < 25)) return;
    out.push({ id: out.length, kind, x, z, label, approach: ap });
  };
  for (const st of L.streams) {
    const nm = streamName(st);
    for (const s of st.fords ?? []) {
      const [x, z] = st.line.pointAt(s);
      add('ford', x, z, `${nm} 여울 — 오솔길이 개울을 건너는 곳`);
    }
    for (const p of st.poolsAbs ?? []) {
      const [x, z] = st.line.pointAt(Math.max(0, Math.min(st.line.length, p.s)));
      add('pool', x, z, `${nm}의 깊은 웅덩이`);
    }
    // 강과 만나는 곳
    for (let s = 0; s < st.line.length; s += 2) {
      const [x, z] = st.line.pointAt(s);
      if (z >= riverCenterZ(x) - LAYOUT.river.halfWidth - 8) { add('mouth', x, z, `${nm}이 강과 만나는 곳`); break; }
    }
    // 늪으로 드는 곳
    const sw = L.swamp;
    let best = null, bd = Infinity;
    for (let s = 0; s < st.line.length; s += 2) {
      const [x, z] = st.line.pointAt(s);
      const d = Math.abs(Math.hypot(x - sw.x, z - sw.z) - sw.radius);
      if (d < bd && z < sw.z) { bd = d; best = [x, z]; }
    }
    if (best && bd < 6) add('swampIn', best[0], best[1], `${nm}이 늪으로 흘러드는 곳`);
  }
  // 오솔길 갈림길: 끝점이 다른 오솔길 끝점·선과 만나는 곳
  const trails = L.trails;
  const ends = [];
  for (const tr of trails) {
    const ln = tr.line;
    ends.push({ x: ln.x[0], z: ln.z[0], tr }, { x: ln.x[ln.count - 1], z: ln.z[ln.count - 1], tr });
  }
  const usedEnd = new Set();
  for (let i = 0; i < ends.length; i++) {
    if (usedEnd.has(i)) continue;
    const e = ends[i];
    const group = new Set([e.tr]);
    for (let j = i + 1; j < ends.length; j++) {
      if (dist(e, ends[j]) < 5) { group.add(ends[j].tr); usedEnd.add(j); }
    }
    if (group.size >= 2) add('junction', e.x, e.z, group.size >= 3 ? '세 갈래 오솔길이 만나는 곳' : '오솔길이 갈라지는 곳');
  }
  // 논 모퉁이
  const pd = data.paddy;
  if (pd) {
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const [x, z] = pd.toWorld(su * (pd.halfU + 1.5), sv * (pd.halfV + 1.5));
      add('paddyCorner', x, z, `논 ${dirName(x - pd.cx, z - pd.cz)}쪽 모퉁이`);
    }
  }
  // 늪 가장자리
  {
    const sw = L.swamp;
    for (const [dx, dz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const x = sw.x + dx * (sw.radius + 5), z = sw.z + dz * (sw.radius + 5);
      add('swampEdge', x, z, `늪 ${dirName(dx, dz)}쪽 가장자리`);
    }
  }
  for (const b of LAYOUT.grassBlobs) if (Math.abs(b.x) < 170 && Math.abs(b.z) < 170) add('grass', b.x, b.z, `${areaName(b.x, b.z)} 코끼리풀 개활지`);
  for (const b of LAYOUT.bambooGroves) add('bamboo', b.x, b.z, `${areaName(b.x, b.z)} 대나무 숲`);
  // 언덕·능선 위 큰 나무: 둘레 25m 보다 1.5m 이상 높은 곳의 큰 나무
  const trees = data.placements.bigTree ?? [];
  const H = (x, z) => query.getTerrainHeight(x, z);
  const cand = [];
  for (const t of trees) {
    if (Math.abs(t.x) > 160 || Math.abs(t.z) > 160) continue;
    const h0 = H(t.x, t.z);
    let ring = 0, maxDrop = 0, minDrop = Infinity;
    const drops = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const d = h0 - H(t.x + Math.cos(a) * 25, t.z + Math.sin(a) * 25);
      ring += d / 8;
      drops.push(d);
    }
    for (let k = 0; k < 4; k++) {
      const pair = (drops[k] + drops[k + 4]) / 2;
      maxDrop = Math.max(maxDrop, pair); minDrop = Math.min(minDrop, pair);
    }
    if (ring > 1.5 && Math.min(...drops) > -0.5) cand.push({ t, ring, ridge: minDrop < maxDrop * 0.35 });
  }
  cand.sort((a, b) => b.ring - a.ring);
  for (const c of cand.slice(0, 6)) add('tree', c.t.x, c.t.z, `${c.ridge ? '능선' : '언덕'} 위 큰 나무 (${areaName(c.t.x, c.t.z)})`);
  return out;
}

/** 투입 지점: 맵 가장자리 오솔길 끝 · 남쪽 강가 */
export function findStarts(world) {
  const { data, nav } = world;
  const out = [];
  for (const tr of data.layout.trails) {
    const ln = tr.line;
    for (const end of [0, ln.count - 1]) {
      const x = ln.x[end], z = ln.z[end];
      if (Math.max(Math.abs(x), Math.abs(z)) < 140) continue;
      const p = nav.nearestOpen(x * 0.97, z * 0.97, 5);
      if (p) out.push({ x: p.x, z: p.z, label: `${areaName(x, z)} 오솔길 끝` });
    }
  }
  for (const x of [-120, 90]) {
    const z = riverCenterZ(x) - LAYOUT.river.halfWidth - 9;
    const p = nav.nearestOpen(x, z, 5);
    if (p) out.push({ x: p.x, z: p.z, label: `남쪽 강가 (${x < 0 ? '서' : '동'}쪽)` });
  }
  for (const s of out) s.yaw = Math.atan2(s.x, s.z);   // 맵 가운데를 향함 (yaw 0 = −Z)
  return out;
}

/** 회수 지점 후보: 강가 모래톱 (얕은 물가) · 논 개활지 둑 */
export function findExtractions(world) {
  const { data, nav, query } = world;
  const out = [];
  for (let x = -150; x <= 150; x += 20) {
    const z = riverCenterZ(x) - LAYOUT.river.halfWidth - 2.5;
    const p = nav.nearestOpen(x, z, 3);
    if (!p) continue;
    const slope = query.getSlope(p.x, p.z).deg;
    if (slope > 14) continue;
    out.push({ kind: 'sandbar', x: p.x, z: p.z, r: CONFIG.mission.extraction.radius, label: `${areaName(x, z)} 강가 모래톱` });
  }
  const pd = data.paddy;
  if (pd) {
    for (const [su, sv] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const [x, z] = pd.toWorld(su * pd.halfU * 0.55, sv * pd.halfV * 0.55);
      const p = nav.nearestOpen(x, z, 3);
      if (p) out.push({ kind: 'paddy', x: p.x, z: p.z, r: CONFIG.mission.extraction.radius, label: `논 개활지 (${dirName(x - pd.cx, z - pd.cz)}쪽)` });
    }
  }
  return out;
}

/** 야영지 후보: 평평하고 마른 숲속, 오솔길에서 18~70m, 개울·늪·논에서 떨어진 곳 (캐노피 아래 선호) */
export function findCampSites(world) {
  const { data, nav, query } = world;
  const L = data.layout;
  const out = [];
  const wetSurf = new Set([SURF('shallowMud'), SURF('deepMud'), SURF('paddy'), SURF('shallowWater'), SURF('deepWater')]);
  const trailDist = (x, z) => {
    let best = Infinity;
    for (const tr of L.trails) { const c = tr.line.closestS(x, z); if (c.dist < best) best = c.dist; }
    return best;
  };
  const streamDist = (x, z) => {
    let best = Infinity;
    for (const st of L.streams) { const c = st.line.closestS(x, z); if (c.dist < best) best = c.dist; }
    return best;
  };
  for (let x = -145; x <= 145; x += 10) {
    for (let z = -145; z <= 150; z += 10) {
      if (!nav.walkable(x, z)) continue;
      if (Math.hypot(x - L.swamp.x, z - L.swamp.z) < L.swamp.radius + 18) continue;
      if (data.paddy && data.paddy.signedDistance(x, z) < 14) continue;
      if (z > riverCenterZ(x) - LAYOUT.river.halfWidth - 25) continue;
      const td = trailDist(x, z);
      if (td < 18 || td > 70) continue;
      if (streamDist(x, z) < 22) continue;
      let hmin = Infinity, hmax = -Infinity, bad = false;
      for (let k = 0; k < 9 && !bad; k++) {
        const a = (k / 8) * Math.PI * 2, r = k === 8 ? 0 : 12;
        const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        const h = query.getTerrainHeight(px, pz);
        hmin = Math.min(hmin, h); hmax = Math.max(hmax, h);
        if (query.getWaterLevel(px, pz) > h - 0.05) bad = true;
        if (wetSurf.has(query.getSurfaceAt(px, pz))) bad = true;
      }
      if (bad || hmax - hmin > 2.2) continue;
      out.push({ x, z, canopy: query.getCanopyCover(x, z), trailDist: td });
    }
  }
  return out;
}

/** 오솔길 위 점들 (5m 간격) — 매복 구간·행렬 경로 */
function trailPoints(world) {
  const out = [];
  world.data.layout.trails.forEach((tr, ti) => {
    const ln = tr.line;
    for (let s = 6; s < ln.length - 6; s += 5) {
      const [x, z] = ln.pointAt(s);
      const [x2, z2] = ln.pointAt(Math.min(ln.length, s + 2));
      const dl = Math.hypot(x2 - x, z2 - z) || 1;
      out.push({ x, z, ti, s, dir: { x: (x2 - x) / dl, z: (z2 - z) / dl } });
    }
  });
  return out;
}

// ---------------------------------------------------------------------
// 길 확인
// ---------------------------------------------------------------------
/** a → b 를 실제로 걸어서 갈 수 있는지 (경로 길이 m, 못 가면 Infinity) */
export function pathLength(world, a, b) {
  const path = world.nav.findPath(a, b, { mode: 'normal', maxNodes: 60000, ignoreHazards: true });
  if (!path) return Infinity;
  let L = 0, px = a.x, pz = a.z;
  for (const p of path) { L += Math.hypot(p.x - px, p.z - pz); px = p.x; pz = p.z; }
  // 끝이 목표 근처까지 왔나 (막혀서 가장 가까운 칸에서 멈추지 않았나)
  if (Math.hypot(px - b.x, pz - b.z) > 6) return Infinity;
  return L;
}

// ---------------------------------------------------------------------
// 임무
// ---------------------------------------------------------------------
/**
 * @param {'recon'|'ambush'|'raid'} type
 * @param {number} seed
 * @param {{data, query, nav}} world
 */
export function generateMission(type, seed, world) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const rng = new RNG((seed * 7919 + attempt * 104729) >>> 0);
    const m = tryMission(type, seed, rng, world);
    if (m) { m.attempt = attempt; return m; }
  }
  throw new Error(`임무를 만들 수 없음: ${type} ${seed}`);
}

function tryMission(type, seed, rng, world) {
  const A = analyzeWorld(world);
  const M = CONFIG.mission;
  const start = { ...rng.pick(A.starts) };
  const m = {
    type, seed, label: MISSION_LABELS[type],
    start, objectives: [], extraction: null, camp: null, ambushSite: null,
    enemies: { patrols: [], ambushes: [], camp: null, convoy: null, reinforce: null },
    traces: [], carve: [], marks: [], routeLength: 0,
  };
  // ---- 목표
  let plan;
  if (type === 'recon') plan = planRecon(m, rng, world, A);
  else if (type === 'ambush') plan = planAmbush(m, rng, world, A);
  else plan = planRaid(m, rng, world, A);
  if (!plan) return null;
  // ---- 회수 지점: 마지막 목표에서 70m 이상, 투입 지점에서 60m 이상
  const last = m.objectives[m.objectives.length - 1];
  const exCands = A.extractions.filter((e) => dist(e, last) > 70 && dist(e, start) > 60);
  if (!exCands.length) return null;
  exCands.sort((a, b) => dist(a, last) - dist(b, last));
  const pickFrom = exCands.slice(0, Math.max(2, Math.ceil(exCands.length * 0.4)));
  m.extraction = { ...rng.pick(pickFrom) };
  if (m.extraction.kind === 'sandbar') m.carve.push({ x: m.extraction.x, z: m.extraction.z, r: 9, kind: 'sandbar' });
  // ---- 실제로 걸어서 닿는지: 투입 → 목표들 → 회수
  let total = 0, prev = start;
  for (const o of m.objectives) {
    const L = pathLength(world, prev, o.approach);
    if (!Number.isFinite(L)) return null;
    total += L; prev = o.approach;
  }
  const Lx = pathLength(world, prev, m.extraction);
  if (!Number.isFinite(Lx)) return null;
  total += Lx;
  m.routeLength = total;
  // ---- 시각·제한 시간 (6단계: 해질녘 임무도 밤까지 이어질 수 있음) · 달 모양
  const tod = rng.pick(TOD_KEYS);
  m.tod = tod;
  m.startHour = M.startHours[tod] + rng.range(-0.15, 0.25);
  {
    let r = rng.range(0, 1), acc = 0;
    m.moon = MOON_KEYS[MOON_KEYS.length - 1];
    for (const k of MOON_KEYS) { acc += M.moon[k]; if (r <= acc) { m.moon = k; break; } }
  }
  const [lo, hi] = M.limitMin[type];
  // 걷는 시간 (숲속 약 0.7m/s) 의 여유 + 기다림·교전 시간
  const limitMin = Math.max(lo, Math.min(hi, total / 0.7 / 60 * 1.8 + (type === 'ambush' ? 16 : 8)));
  m.limit = Math.round(limitMin) * 60;
  m.endHour = m.startHour + (m.limit * M.timeScale) / 3600;
  // ---- 날씨
  m.weatherPlan = WeatherCycle.makePlan(m.limit, rng);
  // ---- 흔적 (첫 목표 쪽으로 가는 길 위)
  placeTraces(m, rng, world);
  // ---- 6단계: 함정 (길목 위주)
  planTraps(m, rng, world, A);
  // ---- 지도 연필 표시
  for (const o of m.objectives) {
    if (o.kind === 'observe') m.marks.push({ kind: 'circle', x: o.x, z: o.z, r: 9, label: o.mapLabel });
    else if (o.kind === 'ambush') m.marks.push({ kind: 'segment', x: o.x, z: o.z, x2: o.x2, z2: o.z2, label: '매복 구간' });
  }
  if (m.camp) m.marks.push({ kind: 'area', x: m.camp.markX, z: m.camp.markZ, r: m.camp.markR, label: '야영지 추정 범위' });
  m.marks.push({ kind: 'lz', x: m.extraction.x, z: m.extraction.z, r: 8, label: '회수' });
  m.marks.push({ kind: 'start', x: start.x, z: start.z, r: 5, label: '투입' });
  // ---- 브리핑
  m.briefing = briefing(m, rng);
  return m;
}

function pickLandmarks(rng, A, n, start, avoid = []) {
  const pool = A.landmarks.filter((l) => dist(l, start) > 90 && dist(l, start) < 310 && !avoid.some((a) => dist(a, l) < 60));
  const chosen = [];
  for (let k = 0; k < 60 && chosen.length < n; k++) {
    const l = rng.pick(pool);
    if (!l || chosen.includes(l)) continue;
    if (chosen.some((c) => dist(c, l) < 70 || c.kind === l.kind)) continue;
    chosen.push(l);
  }
  return chosen.length === n ? chosen : null;
}

function planRecon(m, rng, world, A) {
  const M = CONFIG.mission;
  const n = rng.int(M.recon.points[0], M.recon.points[1]);
  const pts = pickLandmarks(rng, A, n, m.start);
  if (!pts) return null;
  // 가까운 순서로 (투입 지점에서 출발해 차례로)
  const order = [];
  let cur = m.start;
  const left = pts.slice();
  while (left.length) {
    left.sort((a, b) => dist(a, cur) - dist(b, cur));
    cur = left.shift();
    order.push(cur);
  }
  order.forEach((l, i) => m.objectives.push({
    id: `p${i}`, kind: 'observe', x: l.x, z: l.z, approach: l.approach, label: l.label, mapLabel: `${i + 1}`, landmark: l.kind,
  }));
  // 적: 순찰 2~3개 (투입 지점에서 멀리 출발, 목표 근처를 지나감) + 목표 하나 근처 매복조
  const np = rng.int(M.recon.patrols[0], M.recon.patrols[1]);
  for (let i = 0; i < np; i++) {
    const via = rng.pick(order);
    const from = farPoint(world, rng, m.start, 210, via);
    const to = farPoint(world, rng, from, 120, null, m.start);
    if (!from || !to) continue;
    m.enemies.patrols.push({ size: rng.int(4, 6), mg: rng.chance(0.5), waypoints: [from, nearOf(world, via, rng, 20), to], delay: i * rng.range(30, 120) });
  }
  const target = order[order.length - 1];
  const tp = nearestTrailPoint(A, target, 20, 80);
  if (tp && dist(tp, m.start) > 170) m.enemies.ambushes.push({ size: rng.int(3, 4), mg: rng.chance(0.5), killZone: { x: tp.x, z: tp.z, dir: tp.dir } });
  return true;
}

function planAmbush(m, rng, world, A) {
  const M = CONFIG.mission;
  // 매복 구간: 투입 지점에서 100~260m 의 오솔길 점, 행렬이 150m 넘게 걸어올 수 있는 쪽 끝이 있는 곳
  const cands = A.trailPoints.filter((p) => dist(p, m.start) > 100 && dist(p, m.start) < 260);
  for (let k = 0; k < 40; k++) {
    const site = rng.pick(cands);
    if (!site) return null;
    // 행렬 출발점: 맵 가장자리 오솔길 끝 중 매복 구간에서 185m 이상 (매복 자리에서 기다리는 플레이어 시야·150m 밖에서 나타남),
    //  투입 지점에서 160m 이상, 경로로 170m 이상
    const ends = A.starts.filter((s) => dist(s, site) > M.spawnMinDist + 35 && dist(s, m.start) > 160);
    if (!ends.length) continue;
    const from = rng.pick(ends);
    const Lin = pathLength(world, from, site);
    if (!Number.isFinite(Lin) || Lin < 170) continue;
    // 행렬 목적지: 매복 구간을 지나 계속 가는 쪽 (되돌아가지 않게 — 들어온 방향과 60° 안쪽)
    const inx = site.x - from.x, inz = site.z - from.z, inl = Math.hypot(inx, inz) || 1;
    const ahead = (s) => {
      const ox = s.x - site.x, oz = s.z - site.z, ol = Math.hypot(ox, oz) || 1;
      return (ox * inx + oz * inz) / (ol * inl);
    };
    const exits = A.starts.filter((s) => s !== from && dist(s, site) > 80 && dist(s, from) > 150 && ahead(s) > 0.5);
    let to = exits.length ? rng.pick(exits) : null;
    if (!to) {
      for (let k2 = 0; k2 < 12 && !to; k2++) {
        const q = farPoint(world, rng, site, 100, { x: site.x + inx / inl * 100, z: site.z + inz / inl * 100 }, from);
        if (q && ahead(q) > 0.5) to = q;
      }
    }
    if (!to) continue;
    const half = 14;
    m.ambushSite = { x: site.x, z: site.z, dir: site.dir, ti: site.ti };
    m.objectives.push({
      id: 'ambush', kind: 'ambush', x: site.x, z: site.z, approach: world.nav.nearestOpen(site.x, site.z, 4) ?? { x: site.x, z: site.z },
      x2: site.x + site.dir.x * half, z2: site.z + site.dir.z * half, label: '오솔길 매복 구간', mapLabel: '매복',
    });
    m.objectives[0].x -= site.dir.x * half; m.objectives[0].z -= site.dir.z * half;
    const squads = rng.int(M.convoySquads[0], M.convoySquads[1]);
    m.enemies.convoy = {
      delay: rr(rng, M.convoyDelay), from, via: { x: site.x, z: site.z }, to,
      squads: Array.from({ length: squads }, (_, i) => ({ size: rng.int(4, 6), mg: i === 0, gap: i * rng.range(35, 60) })),
    };
    m.enemies.reinforce = { trigger: 'ambush', delay: rr(rng, M.reinforce.ambush), size: rng.int(M.reinforce.squad[0], M.reinforce.squad[1]), to: { x: site.x, z: site.z }, from: from };
    // 다른 곳 순찰 하나 (가끔)
    if (rng.chance(0.6)) {
      const pf = farPoint(world, rng, m.start, 200, null);
      const pt = pf && farPoint(world, rng, pf, 110, null, m.start);
      if (pf && pt) m.enemies.patrols.push({ size: rng.int(3, 5), mg: false, waypoints: [pf, pt], delay: rng.range(60, 240) });
    }
    return true;
  }
  return null;
}

function planRaid(m, rng, world, A) {
  const M = CONFIG.mission, R = M.raid;
  const sites = A.camps.filter((c) => dist(c, m.start) > 190 && dist(c, m.start) < 330);
  if (!sites.length) return null;
  sites.sort((a, b) => b.canopy - a.canopy);
  const top = sites.slice(0, Math.max(3, Math.ceil(sites.length * 0.5)));
  // 접근로 매복조 자리 (야영지에서 가장 가까운 오솔길 길목) 도 투입 지점에서 충분히 멀어야 한다
  let site = null, tp = null;
  for (let k = 0; k < 20 && !site; k++) {
    const c = rng.pick(top);
    const t = nearestTrailPoint(A, c, 15, 75);
    if (t && dist(t, m.start) < M.spawnMinDist + 15) continue;
    site = c; tp = t;
  }
  if (!site) return null;
  const nHuts = rng.int(R.huts[0], R.huts[1]);
  const huts = [];
  const a0 = rng.range(0, Math.PI * 2);
  for (let i = 0; i < nHuts; i++) {
    const a = a0 + (i / nHuts) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const r = rng.range(6.5, 8.5);
    const x = site.x + Math.cos(a) * r, z = site.z + Math.sin(a) * r;
    // 문은 모닥불 쪽
    huts.push({ x, z, yaw: Math.atan2(-(site.x - x), -(site.z - z)), w: rng.range(3.2, 4.0), d: rng.range(2.8, 3.4) });
  }
  const docsHut = rng.int(0, nHuts - 1);
  const h = huts[docsHut];
  // 문서: 오두막 안쪽 (문 반대편 벽 앞)
  const fx = -Math.sin(h.yaw), fz = -Math.cos(h.yaw);
  const docs = { x: h.x - fx * (h.d * 0.25), z: h.z - fz * (h.d * 0.25) };
  // 지도에는 대략적인 범위만 (실제 중심에서 어긋난 원)
  const off = rng.range(10, 28), oa = rng.range(0, Math.PI * 2);
  m.camp = {
    x: site.x, z: site.z, r: R.campRadius, huts, docsHut, docs, fire: { x: site.x + rng.range(-1, 1), z: site.z + rng.range(-1, 1) },
    markX: site.x + Math.cos(oa) * off, markZ: site.z + Math.sin(oa) * off, markR: rng.range(42, 58),
  };
  m.carve.push({ x: site.x, z: site.z, r: R.campRadius, kind: 'camp' });
  m.objectives.push({ id: 'docs', kind: 'documents', x: docs.x, z: docs.z, approach: world.nav.nearestOpen(site.x, site.z, 6) ?? { x: site.x, z: site.z }, label: '야영지 오두막 안 적 문서', mapLabel: '야영지' });
  // 병사: 보초 2 · 쉬는 병사 · 접근로 매복조
  const n = rng.int(R.soldiers[0], R.soldiers[1]);
  const nAmbush = n >= 8 ? 3 : 2;
  const nSentry = 2;
  const nRest = Math.max(2, n - nAmbush - nSentry);
  // 접근로: 야영지에서 가장 가까운 오솔길 점 (그 오솔길로 들어오는 길목) — tp
  m.enemies.camp = { center: { x: site.x, z: site.z }, sentries: nSentry, rest: nRest, huts };
  if (tp) {
    const dx = site.x - tp.x, dz = site.z - tp.z, dl = Math.hypot(dx, dz) || 1;
    const kz = { x: tp.x + dx / dl * Math.min(10, dl * 0.4), z: tp.z + dz / dl * Math.min(10, dl * 0.4), dir: { x: dx / dl, z: dz / dl } };
    m.enemies.ambushes.push({ size: nAmbush, mg: false, killZone: kz, camp: true });
  }
  m.enemies.reinforce = { trigger: 'bigFight', delay: rr(rng, M.reinforce.raid), size: rng.int(M.reinforce.squad[0], M.reinforce.squad[1]), to: { x: site.x, z: site.z }, from: null };
  if (rng.chance(0.5)) {
    const pf = farPoint(world, rng, m.start, 200, site);
    const pt = pf && nearOf(world, site, rng, 45);
    if (pf && pt) m.enemies.patrols.push({ size: rng.int(3, 4), mg: false, waypoints: [pf, pt, pf], delay: rng.range(30, 200) });
  }
  return true;
}

/** 근처 걸을 수 있는 점 (반경 r) */
function nearOf(world, p, rng, r) {
  for (let k = 0; k < 12; k++) {
    const a = rng.range(0, Math.PI * 2), d = rng.range(r * 0.3, r);
    const q = world.nav.nearestOpen(p.x + Math.cos(a) * d, p.z + Math.sin(a) * d, 3);
    if (q) return q;
  }
  return world.nav.nearestOpen(p.x, p.z, 6);
}

/** from 에서 minD 이상 떨어진 걸을 수 있는 점 (towards 가 있으면 그쪽 방향 위주, awayFrom 에서도 minD 이상) */
function farPoint(world, rng, from, minD, towards = null, awayFrom = null) {
  for (let k = 0; k < 40; k++) {
    let a = rng.range(0, Math.PI * 2);
    if (towards) a = Math.atan2(towards.z - from.z, towards.x - from.x) + rng.range(-1.1, 1.1);
    const d = rng.range(minD, minD + 90);
    const x = from.x + Math.cos(a) * d, z = from.z + Math.sin(a) * d;
    if (Math.abs(x) > 175 || Math.abs(z) > 175) continue;
    const p = world.nav.nearestOpen(x, z, 4);
    if (!p) continue;
    if (dist(p, from) < minD) continue;
    if (awayFrom && dist(p, awayFrom) < 160) continue;
    return p;
  }
  return null;
}

function nearestTrailPoint(A, p, dmin, dmax) {
  let best = null, bd = Infinity;
  for (const t of A.trailPoints) {
    const d = dist(t, p);
    if (d < dmin || d > dmax) continue;
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}

/** 흔적: 투입 지점 → 첫 목표 방향으로 45~170m (좌우로 조금) — 발자국은 진흙·젖은 흙을 찾아서 */
function placeTraces(m, rng, world) {
  const T = CONFIG.mission.traces;
  const { query, nav } = world;
  const n = rng.int(T.count[0], T.count[1]);
  const goal = m.objectives[0];
  // 종류는 뽑은 뒤 다시 넣지 않는다 (꺼진 모닥불·잘린 덩굴은 한 번씩)
  const kinds = ['prints', 'casings', 'firepit', 'vines', 'prints', 'casings'];
  for (let i = kinds.length - 1; i > 0; i--) { const j = rng.int(0, i); [kinds[i], kinds[j]] = [kinds[j], kinds[i]]; }
  const mud = new Set(CONFIG.footprints.surfaces.map((k) => SURF(k)));
  for (let i = 0; i < Math.min(n, kinds.length); i++) {
    const kind = kinds[i];
    const t = rr(rng, T.dist);
    const dx = goal.x - m.start.x, dz = goal.z - m.start.z, dl = Math.hypot(dx, dz) || 1;
    const k = Math.min(0.85, t / dl);
    let x = m.start.x + dx * k + (-dz / dl) * rng.range(-18, 18), z = m.start.z + dz * k + (dx / dl) * rng.range(-18, 18);
    if (kind === 'prints') {
      // 진흙 칸 찾기 (25m 안)
      let found = null;
      for (let s = 0; s < 40 && !found; s++) {
        const a = rng.range(0, Math.PI * 2), r = rng.range(0, 25);
        const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        if (mud.has(query.getSurfaceAt(px, pz)) && nav.walkable(px, pz)) found = { x: px, z: pz };
      }
      if (!found) continue;
      x = found.x; z = found.z;
    }
    const p = nav.nearestOpen(x, z, 3);
    if (!p) continue;
    m.traces.push({ kind, x: p.x, z: p.z, yaw: rng.range(0, Math.PI * 2), n: rng.int(6, 14), age: rng.range(60, 360), seed: rng.int(1, 1e6) });
  }
}

/** 브리핑 기상 예보 (계획의 앞부분만 — 정확한 시각은 말하지 않는다) */
function weatherLine(m) {
  const W = CONFIG.weather.presets;
  const kinds = m.weatherPlan.map((p) => p.kind);
  const now = W[kinds[0]].label;
  let acc = 0, rainAt = null;
  for (const p of m.weatherPlan) { if (p.kind === 'rain' || p.kind === 'storm') { rainAt = acc; break; } acc += p.dur; }
  if (rainAt == null || rainAt > m.limit) return `기상: ${now}. 작전 중 큰 변화는 없을 것으로 봄`;
  const when = rainAt < m.limit * 0.3 ? '곧' : rainAt < m.limit * 0.6 ? '작전 중반쯤' : '후반에';
  return `기상: ${now}. ${when} 비 — 폭우와 뇌우 가능, 비가 그치면 안개`;
}

/** 밤·해질녘 임무: 달 모양과 어둠 안내 */
function nightLine(m) {
  const moon = CONFIG.night.moon[m.moon]?.label ?? '';
  if (m.tod === 'night') return `밤 작전 — ${moon}. 캐노피 아래는 거의 보이지 않는다. 손전등과 총구 화염은 위치를 드러낸다. 적은 소리를 듣고 조명탄을 쏜다.`;
  if (m.tod === 'dusk') return `해질녘 작전 — 곧 어두워진다 (${moon}). 밤까지 이어질 수 있다.`;
  return '';
}

function briefing(m, rng) {
  const M = CONFIG.mission;
  const E = m.enemies;
  let count = 0;
  for (const p of E.patrols) count += p.size;
  for (const a of E.ambushes) count += a.size;
  if (E.camp) count += E.camp.sentries + E.camp.rest;
  if (E.convoy) for (const s of E.convoy.squads) count += s.size;
  const est = Math.max(2, Math.round(count * rng.range(1 - M.estimateError, 1 + M.estimateError)));
  m.trueCount = count;
  m.estimate = est;
  const fmt = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
  const lines = [];
  if (m.type === 'recon') {
    lines.push(`목표: 지도에 표시한 ${m.objectives.length}곳을 확인하고 회수 지점으로 귀환한다. 각 지점 25m 안에서 잠시 살피면 된다.`);
    m.objectives.forEach((o, i) => lines.push(`  ${i + 1}. ${o.label}`));
    lines.push('교전은 피하라. 들키지 않을수록 유리하다.');
  } else if (m.type === 'ambush') {
    lines.push('목표: 지도에 표시한 오솔길 구간에서 적 보급 행렬을 기다렸다가 기습한다.');
    lines.push('행렬이 언제 올지는 모른다 — 길게는 15분. 기습 뒤에는 증원이 소리를 듣고 달려올 것이다. 곧장 회수 지점으로 철수하라.');
  } else {
    lines.push('목표: 적 야영지 오두막 안의 문서를 회수한다 (오두막 안에서 F 3초).');
    lines.push('야영지 위치는 대략적인 범위만 안다. 보초와 접근로 매복을 조심하라. 큰 교전이 벌어지면 근처의 증원이 온다.');
  }
  lines.push(`회수 지점: ${m.extraction.label}. 도착 후 60초를 버티면 헬기가 온다.`);
  lines.push('적은 오솔길·논둑·야영지 접근로 같은 길목에 인계철선·꼬챙이 구덩이·지뢰를 놓는다. 빠른 길일수록 위험하다 — 천천히 살피고(X·앉기), 의심되면 탐침(Y).');
  return {
    title: `${MISSION_LABELS[m.type]} — 작전 #${String(m.seed).slice(-4).padStart(4, '0')}`,
    lines,
    start: `투입: ${m.start.label}, ${TOD_LABELS[m.tod]} ${fmt(m.startHour)}`,
    limit: `제한 시간: ${Math.round(m.limit / 60)}분 (작전 시각 ${fmt(m.endHour)}까지)`,
    enemy: `적 규모: 약 ${est}명 추정 (정보가 틀릴 수 있음)`,
    weather: weatherLine(m),
    night: nightLine(m),
    equipment: ['7.62mm 소총', '탄창 6개 (30발)', '낱발 탄약 90발', '붕대 2', '지혈대 1', '수통 2 (1L씩)', '손전등', '종이 지도 · 손목 나침반 · 시계'],
  };
}
