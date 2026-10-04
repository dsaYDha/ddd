// =====================================================================
//  TrapPlan — 6단계 함정 배치 (순수 로직, MissionGen 이 임무마다 부름 — 디렉터 계획의 일부)
//   대부분 길목: 오솔길(갈림길·여울 근처, 플레이어가 지나갈 만한 경로 근처일수록 자주) · 논둑 · 야영지 접근로.
//   빽빽한 숲속엔 드물게 (forestShare). 함정끼리 spacing m 이상, 투입 지점·목표·회수 지점·매복 대기 구간 근처는 피함.
//   종류는 자리마다 비율 (CONFIG.traps.kinds) — 철선은 길을 가로지르게, 구덩이·지뢰는 사람이 디디는 길 가운데.
//   적의 표시 (묶은 풀·꺾은 가지·막대 표식)는 markerChance 로 함정 앞 길가에.
//  planTraps(m, rng, world, A) → m.traps = [{ kind, site, x, z, yaw, len?, marker, seed }], m.trapSites = {trail, dike, approach, forest}
// =====================================================================
import { CONFIG, SURFACE_KEYS } from '../config.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const SURF = (k) => SURFACE_KEYS.indexOf(k);

/** 점에서 선분까지 거리 */
function segDist(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z);
}

function pickKind(rng, table) {
  let r = rng.range(0, 1), acc = 0;
  const ks = Object.keys(table);
  for (const k of ks) { acc += table[k]; if (r <= acc) return k; }
  return ks[ks.length - 1];
}

/** 플레이어 예상 경로 (투입 → 목표들 → 회수, 직선 구간들) */
function routeLegs(m) {
  const pts = [m.start, ...m.objectives.map((o) => o.approach ?? o), m.extraction].filter(Boolean);
  const legs = [];
  for (let i = 0; i < pts.length - 1; i++) legs.push([pts[i], pts[i + 1]]);
  return legs;
}

/** 길목 후보: 오솔길 · 논둑 · 야영지 접근로 */
export function chokeCandidates(m, world, A) {
  const T = CONFIG.traps, Wt = T.weights;
  const { data, query, nav } = world;
  const legs = routeLegs(m);
  const forks = A.landmarks.filter((l) => l.kind === 'junction' || l.kind === 'ford');
  const out = [];
  const blocked = (p) => {
    if (dist(p, m.start) < T.avoidStart) return true;
    for (const o of m.objectives) {
      if (dist(p, o) < T.avoidObjective || (o.approach && dist(p, o.approach) < T.avoidObjective)) return true;
      if (o.kind === 'ambush' && segDist(p, o, { x: o.x2, z: o.z2 }) < T.avoidAmbushSite) return true;
    }
    if (m.extraction && dist(p, m.extraction) < T.avoidExtraction) return true;
    if (query.getWaterDepth(p.x, p.z) > 0.04) return true;
    return !nav.walkable(p.x, p.z);
  };
  const nearRoute = (p) => legs.some(([a, b]) => segDist(p, a, b) < T.routeRadius);
  // 오솔길
  for (const tp of A.trailPoints) {
    if (blocked(tp)) continue;
    let w = Wt.trail;
    for (const f of forks) if (dist(f, tp) < T.junctionRadius) { w *= f.kind === 'junction' ? Wt.junction : Wt.ford; break; }
    w *= nearRoute(tp) ? Wt.route : Wt.offRoute;
    const tr = data.layout.trails[tp.ti];
    out.push({ site: 'trail', x: tp.x, z: tp.z, dir: tp.dir, w, half: tr?.halfWidth ?? 1.2 });
  }
  // 논둑 (가운데 큰 논둑이 주로 다니는 길)
  const pd = data.paddy;
  if (pd) {
    const rows = pd.rows, cols = pd.cols;
    const du = { x: Math.cos(pd.rot), z: Math.sin(pd.rot) }, dv = { x: -Math.sin(pd.rot), z: Math.cos(pd.rot) };
    for (let r = 0; r <= rows; r++) {
      const v = -pd.halfV + r * pd.cellH, main = r === pd.mainDikeRow;
      for (let u = -pd.halfU + 2.5; u <= pd.halfU - 2.5; u += 5) {
        const [x, z] = pd.toWorld(u, v);
        const p = { x, z };
        if (!pd.query(x, z).onDike || blocked(p)) continue;
        const w = Wt.dike * (main ? 1 : 0.5) * (nearRoute(p) ? Wt.route : Wt.offRouteDike);
        out.push({ site: 'dike', x, z, dir: du, w, half: main ? pd.mainDikeHalf : pd.dikeHalf });
      }
    }
    for (let c = 0; c <= cols; c++) {
      const u = -pd.halfU + c * pd.cellW;
      for (let v = -pd.halfV + 2.5; v <= pd.halfV - 2.5; v += 5) {
        const [x, z] = pd.toWorld(u, v);
        const p = { x, z };
        if (!pd.query(x, z).onDike || blocked(p)) continue;
        const w = Wt.dike * 0.5 * (nearRoute(p) ? Wt.route : Wt.offRouteDike);
        out.push({ site: 'dike', x, z, dir: dv, w, half: pd.dikeHalf });
      }
    }
  }
  // 야영지 접근로: 가장 가까운 오솔길 점 → 야영지 사이 (야영지에서 12~32m)
  if (m.camp) {
    const c = m.camp;
    const tps = A.trailPoints.filter((t) => dist(t, c) < 80).sort((a, b) => dist(a, c) - dist(b, c)).slice(0, 2);
    const ends = tps.length ? tps : [];
    // 투입 지점 쪽에서 오는 길도 접근로
    ends.push({ x: m.start.x, z: m.start.z, far: true });
    for (const e of ends) {
      const dx = e.x - c.x, dz = e.z - c.z, dl = Math.hypot(dx, dz) || 1;
      const ux = dx / dl, uz = dz / dl;
      for (let d = 12; d <= Math.min(32, dl - 2); d += 5) {
        const p = nav.nearestOpen(c.x + ux * d, c.z + uz * d, 2);
        if (!p || blocked(p)) continue;
        out.push({ site: 'approach', x: p.x, z: p.z, dir: { x: -ux, z: -uz }, w: Wt.approach * (e.far ? 0.6 : 1), half: 1.3 });
      }
    }
  }
  return out;
}

/** 빽빽한 숲속 후보 (오솔길·논·물·진흙에서 떨어진, 은폐가 짙은 곳) — 임무 지역 안 */
export function forestCandidates(m, world, rng, n = 160) {
  const T = CONFIG.traps;
  const { query, nav, data } = world;
  const pts = [m.start, ...m.objectives, m.extraction].filter(Boolean);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  x0 = Math.max(-185, x0 - 40); x1 = Math.min(185, x1 + 40); z0 = Math.max(-185, z0 - 40); z1 = Math.min(185, z1 + 40);
  const wet = new Set([SURF('shallowMud'), SURF('deepMud'), SURF('paddy'), SURF('shallowWater'), SURF('deepWater')]);
  const out = [];
  for (let k = 0; k < n * 4 && out.length < n; k++) {
    const x = rng.range(x0, x1), z = rng.range(z0, z1);
    if (!nav.walkable(x, z) || nav.onTrail(x, z)) continue;
    let nearTrail = false;
    for (const tr of data.layout.trails) { if (tr.line.closestS(x, z).dist < 7) { nearTrail = true; break; } }
    if (nearTrail) continue;
    if (data.paddy && data.paddy.signedDistance(x, z) < 4) continue;
    if (wet.has(query.getSurfaceAt(x, z)) || query.getWaterDepth(x, z) > 0.02) continue;
    if (nav.concealAt(x, z) < 0.35) continue;
    const p = { x, z };
    if (dist(p, m.start) < T.avoidStart || (m.extraction && dist(p, m.extraction) < T.avoidExtraction)) continue;
    if (m.objectives.some((o) => dist(p, o) < T.avoidObjective * 1.5)) continue;
    out.push({ site: 'forest', x, z, dir: null, w: 1, half: 1 });
  }
  return out;
}

/**
 * 임무 함정 계획. m 은 목표·회수 지점까지 정해진 임무 (MissionGen.tryMission).
 */
export function planTraps(m, rng, world, A) {
  const T = CONFIG.traps;
  const [lo, hi] = T.count[m.type] ?? [6, 9];
  const n = rng.int(lo, hi);
  const nForest = Math.max(0, Math.round(n * T.forestShare + rng.range(-0.35, 0.35)));
  const choke = chokeCandidates(m, world, A);
  const chosen = [];
  const far = (p) => chosen.every((c) => dist(c, p) >= (c.site === 'approach' && p.site === 'approach' ? T.approachSpacing : T.spacing));
  // 야영지 접근로 먼저 (습격 임무)
  if (m.camp) {
    const ap = choke.filter((c) => c.site === 'approach');
    const want = rng.int(T.approachCount[0], T.approachCount[1]);
    for (let k = 0; k < ap.length * 3 && chosen.filter((c) => c.site === 'approach').length < want; k++) {
      const c = ap[rng.int(0, ap.length - 1)];
      if (!c.used && far(c)) { c.used = true; chosen.push(c); }
    }
  }
  // 길목: 가중치 비복원 추출 (간격 지킴)
  let total = choke.reduce((s, c) => s + (c.used ? 0 : c.w), 0);
  for (let k = 0; k < 400 && chosen.length < n - nForest && total > 0; k++) {
    let r = rng.range(0, total), pick = null;
    for (const c of choke) { if (c.used) continue; r -= c.w; if (r <= 0) { pick = c; break; } }
    if (!pick) break;
    pick.used = true; total -= pick.w;
    if (far(pick)) chosen.push(pick);
  }
  // 숲속 (드물게)
  const forest = forestCandidates(m, world, rng);
  for (let k = 0; k < forest.length && chosen.length < n; k++) {
    const c = forest[rng.int(0, forest.length - 1)];
    if (!c.used && far(c)) { c.used = true; chosen.push(c); }
  }
  const sites = { trail: 0, dike: 0, approach: 0, forest: 0 };
  m.traps = chosen.map((c, i) => {
    sites[c.site]++;
    const kind = pickKind(rng, T.kinds[c.site] ?? T.kinds.trail);
    let x = c.x, z = c.z, yaw = rng.range(0, Math.PI * 2), len;
    if (kind === 'tripwire') {
      // 길을 가로지르게: 철선 방향 = 길 방향에 수직 (yaw 0 = −Z)
      const d = c.dir ?? { x: Math.cos(yaw), z: Math.sin(yaw) };
      const ux = -d.z, uz = d.x;
      yaw = Math.atan2(-ux, -uz);
      len = Math.max(rng.range(T.tripwire.length[0], T.tripwire.length[1]), (c.half ?? 1.2) * 2 + 0.6);
    } else if (c.dir) {
      // 디디는 길 가운데 근처 (좌우 조금)
      const off = rng.range(-0.35, 0.35);
      x += -c.dir.z * off; z += c.dir.x * off;
    }
    // 적의 표시: 오는 쪽 (투입 지점 쪽) 길가
    let marker = null;
    if (rng.chance(T.markerChance)) {
      const d = c.dir ?? { x: m.start.x - x, z: m.start.z - z };
      const dl = Math.hypot(d.x, d.z) || 1;
      let ax = d.x / dl, az = d.z / dl;
      if ((m.start.x - x) * ax + (m.start.z - z) * az < 0) { ax = -ax; az = -az; }
      const back = rng.range(T.markerDist[0], T.markerDist[1]);
      const side = rng.chance(0.5) ? 1 : -1, lat = (c.half ?? 1) + 0.35;
      marker = { x: x + ax * back - az * side * lat, z: z + az * back + ax * side * lat, kind: rng.pick(['grass', 'branch', 'stick']), yaw: rng.range(0, Math.PI * 2) };
    }
    return { kind, site: c.site, x, z, yaw, len, marker, seed: rng.int(1, 1e6), id: i + 1 };
  });
  m.trapSites = sites;
  return m.traps;
}
