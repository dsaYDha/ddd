// 탄도용 월드 질의 (순수 로직) — WorldQuery 데이터 위에서 '선분' 하나의 정확한 교차를 구한다.
//  raycastWorld(0.2m 간격 행진·시야 기준)와 달리 탄은 한 번에 약 3m(1/240초) 선분을 날아가므로
//  얇은 줄기·지형 능선을 건너뛰지 않게 모든 교차를 해석적으로 푼다:
//   · 원기둥 충돌체(나무·대나무·덩굴 벽…): 수평 원 × 높이 구간 — 4m 격자 셀을 선분이 지나는 순서대로 훑음(DDA)
//   · 지지형 장애물(통나무·뿌리·판근 = 3D 캡슐, 바위 = 회전 타원체), 논둑(직육면체), 리아나(늘어진 곡선 = 캡슐 사슬)
//   · 지형: 0.5m 칸마다 쌍선형 높이면이 선분 위에서 2차식 → 첫 근을 바로 구함 (법선은 getSlope 기울기)
//   · 물: 칸별 수면을 위에서 뚫고 들어가는 점 = 'partial' 통과 (Ballistics 가 감속·물보라·도탄 처리)
//   · 잎 적분 Σσ·ds: 은폐 높이 구간 σ(지면 위 탄 높이) + 캐노피 + bulletBlock 'none' 원기둥(어린 나무·바나나 잎…) + extraFoliage
//     '빽빽한 잎' 판정은 겹친 잎 조각의 σ 를 더한 국소 σ 로 한다 (원기둥 잎이 은폐 구간 안에 있으면 둘의 합):
//     foliageDeflect = 국소 σ ≥ ballistics.foliage.denseSigma 인 곳의 Σσ·ds → Ballistics 잎 빗나감 확률 (보통 숲 공기는 빼고 빽빽한 잎만)
//  멈추는 지점(hit) 이전의 partial·잎만 보고한다.
import { CONFIG, SURFACE_KEYS } from '../config.js';
import { NO_WATER } from '../world/WorldConstants.js';
import { segCapsuleRaw } from './geom.js';

// 재질 (CombatFX·WeaponAudio 가 이 이름으로 효과를 고름)
const OBJECT_MATERIAL = {
  bigTree: 'wood', midTree: 'wood', palm: 'wood', buttress: 'wood', root: 'wood', log: 'wood',
  rock: 'rock', dike: 'mud', bamboo: 'bamboo', bambooDense: 'bamboo', vineWall: 'fiber', liana: 'fiber', treeFern: 'fiber',
  water: 'water', terrain: 'dirt',
};
const SURFACE_MATERIAL = {
  packedDirt: 'dirt', wetEarth: 'dirt', leafLitter: 'leaves', groundCover: 'leaves', shrub: 'leaves', brush: 'leaves',
  shallowMud: 'mud', deepMud: 'mud', paddy: 'mud', shallowWater: 'mud', deepWater: 'mud',   // 물 밑 바닥은 진흙
};
export function materialOf(objectType) {
  return OBJECT_MATERIAL[objectType] ?? 'dirt';
}

// 물체 대신 쓰는 표식 (ignore·object 비교용) — tags 는 호출 시점의 config
export const WATER_OBJECT = { type: 'water', get tags() { return CONFIG.objects.water; } };
const TERRAIN_OBJECT = { type: 'terrain', get tags() { return CONFIG.objects.terrain; } };
const DIKE_OBJECT = { type: 'dike', get tags() { return CONFIG.objects.dike; } };

// 리아나: 월드 데이터의 중심선 L.path (Flora — 렌더러 PlantGeometry.buildLianas 가 그리는 바로 그 점들)를 마디마다 캡슐 하나로.
//  그려진 관은 단면이 4각 (꼭짓점 L.r·(1±0.15), 면 가운데 0.6~0.8·L.r) → 원 단면 충돌 반경 = L.r × LIANA_FIT 이면
//  관 표면 어디서나 ±0.275·L.r (가장 굵은 8.5cm 덩굴도 ±2.4cm) 안에서 맞는다. path 가 없으면 출렁임 없는 처짐 곡선 (렌더러도 같음)
const LIANA_SEGMENTS = 12;
const LIANA_FIT = 0.875;

const INF = Infinity;

/** cast 결과 객체 (재사용) */
export function makeCastResult() {
  return {
    hit: false, t: 1,
    point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 },
    objectType: null, material: null, object: null, underwater: false,
    partials: [],          // [{ t, point, normal, objectType, material, object, foliage, foliageDense, foliageDeflect }]
    foliage: 0,            // Σσ·ds (멈춘 지점까지)
    foliageDense: 0,       // 잎이 우거진 곳(국소 σ ≥ ballistics.foliage.leafFxSigma) 속을 지난 길이 (m) — 잎 효과
    foliageDeflect: 0,     // 빽빽한 잎(국소 σ ≥ ballistics.foliage.denseSigma) 속의 Σσ·ds — 잎 빗나감 확률
    foliageDeflectT: -1,   // 빽빽한 잎이 처음 시작되는 t (없으면 -1) — F7 안전 간격 (최악의 잎 빗나감 거리)
    foliagePoint: null,    // 잎을 가장 많이 지난 곳 (잎 효과용) 또는 null
    endInWater: false,     // 선분 끝(멈춤이 없을 때)이 물속인가
    _fp: { x: 0, y: 0, z: 0 },
    _pool: [],
    _cand: [],             // partial 후보 (정렬 전)
    _fol: [],              // 잎 조각: [t0, t1, σ·길이, σ] 반복
  };
}

// ---------------------------------------------------------------
// 공용: 결과 초기화·마무리
// ---------------------------------------------------------------
function resetResult(out) {
  if (!out._fol) Object.assign(out, makeCastResult());   // 호출 쪽이 빈 객체를 넘겨도 동작
  out.hit = false; out.t = 1;
  out.objectType = null; out.material = null; out.object = null; out.underwater = false;
  out.partials.length = 0; out._cand.length = 0; out._fol.length = 0;
  out.foliage = 0; out.foliageDense = 0; out.foliageDeflect = 0; out.foliageDeflectT = -1; out.foliagePoint = null; out.endInWater = false;
}

function partialEntry(out, k) {
  let e = out._pool[k];
  if (!e) {
    e = { t: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, objectType: null, material: null, object: null, foliage: 0, foliageDense: 0, foliageDeflect: 0 };
    out._pool[k] = e;
  }
  return e;
}

/** partial 후보 추가 (정규화 법선 nx,ny,nz) */
function addCandidate(out, t, ax, ay, az, dx, dy, dz, nx, ny, nz, type, object) {
  const k = out._cand.length;
  const e = partialEntry(out, k);
  e.t = t;
  e.point.x = ax + dx * t; e.point.y = ay + dy * t; e.point.z = az + dz * t;
  e.normal.x = nx; e.normal.y = ny; e.normal.z = nz;
  e.objectType = type; e.material = materialOf(type); e.object = object;
  out._cand.push(e);
}

/** 잎 조각 [t0,t1] (σ: 1/m, len3: 선분 전체 길이) */
function addFoliage(out, t0, t1, sigma, len3) {
  if (!(t1 > t0) || !(sigma > 0)) return;
  out._fol.push(t0, t1, sigma * (t1 - t0) * len3, sigma);
}

/** T 까지의 잎 적분 */
function foliageUpTo(fol, T) {
  let s = 0;
  for (let i = 0; i < fol.length; i += 4) {
    const t0 = fol[i], t1 = fol[i + 1];
    if (t0 >= T) continue;
    s += t1 <= T ? fol[i + 2] : fol[i + 2] * (T - t0) / (t1 - t0);
  }
  return s;
}

// 국소 σ 훑기: 잎 조각 경계 (t, ±σ) 를 t 순서로 — 겹친 조각(은폐 구간 + 어린 나무 수관 등)의 σ 를 더해서 판정 (재사용 배열)
const SWEEP_EV = [];
const SWEEP = { fx: 0, deflect: 0, deflectT: -1 };
function insertEvent(ev, n, t, s) {
  let k = n;
  while (k > 0 && ev[k - 2] > t) { ev[k] = ev[k - 2]; ev[k + 1] = ev[k - 1]; k -= 2; }
  ev[k] = t; ev[k + 1] = s;
  return n + 2;
}
/**
 * T 까지: fx = 국소 σ ≥ fxSigma 인 길이 (m, 잎 효과), deflect = 국소 σ ≥ denseSigma 인 곳의 Σσ·ds (빗나감),
 * deflectT = 그런 곳이 처음 시작되는 t (없으면 -1). 조각은 대부분 t 순서라 삽입 정렬이 거의 선형.
 */
function sweepFoliage(fol, T, len3, fxSigma, denseSigma) {
  const ev = SWEEP_EV;
  let n = 0;
  for (let i = 0; i < fol.length; i += 4) {
    const t0 = fol[i];
    if (t0 >= T) continue;
    const t1 = fol[i + 1] < T ? fol[i + 1] : T;
    n = insertEvent(ev, n, t0, fol[i + 3]);
    n = insertEvent(ev, n, t1, -fol[i + 3]);
  }
  let cur = 0, prev = 0, fx = 0, defl = 0, dT = -1;
  for (let k = 0; k < n; k += 2) {
    const t = ev[k];
    if (t > prev && cur > 1e-9) {
      if (cur >= fxSigma) fx += t - prev;
      if (cur >= denseSigma) { defl += cur * (t - prev); if (dT < 0) dT = prev; }
    }
    cur += ev[k + 1];
    prev = t;
  }
  SWEEP.fx = fx * len3; SWEEP.deflect = defl * len3; SWEEP.deflectT = dT;
  return SWEEP;
}

/** 멈춘 지점 이전 partial 정렬·중복 제거 + 잎 적분 */
function finishResult(out, ax, ay, az, dx, dy, dz, len3) {
  const T = out.hit ? out.t : 1;
  const cand = out._cand;
  if (cand.length > 1) cand.sort(byT);
  const FO = CONFIG.ballistics.foliage;
  const fxSigma = FO.leafFxSigma ?? 0.3, denseSigma = FO.denseSigma ?? 0;
  const fol = out._fol;
  for (let i = 0; i < cand.length; i++) {
    const e = cand[i];
    if (e.t >= T) break;
    // 같은 물체(리아나 캡슐 사슬 이음매 등)는 처음 들어간 곳만
    let dup = false;
    for (let j = 0; j < out.partials.length; j++) if (out.partials[j].object === e.object) { dup = true; break; }
    if (dup) continue;
    e.foliage = foliageUpTo(fol, e.t);
    const sw = sweepFoliage(fol, e.t, len3, fxSigma, denseSigma);
    e.foliageDense = sw.fx;
    e.foliageDeflect = sw.deflect;
    out.partials.push(e);
  }
  if (fol.length) {
    out.foliage = foliageUpTo(fol, T);
    const sw = sweepFoliage(fol, T, len3, fxSigma, denseSigma);
    out.foliageDense = sw.fx;
    out.foliageDeflect = sw.deflect;
    out.foliageDeflectT = sw.deflectT;
    let best = 0, bt = -1;
    for (let i = 0; i < fol.length; i += 4) {
      if (fol[i] >= T) continue;
      const c = fol[i + 1] <= T ? fol[i + 2] : fol[i + 2] * (T - fol[i]) / (fol[i + 1] - fol[i]);
      if (c > best) { best = c; bt = (fol[i] + Math.min(fol[i + 1], T)) / 2; }
    }
    if (bt >= 0) {
      const p = out._fp;
      p.x = ax + dx * bt; p.y = ay + dy * bt; p.z = az + dz * bt;
      out.foliagePoint = p;
    }
  }
  return out;
}

/** extraFoliage 덤불 (수직 원기둥 × 높이 구간, σ 1/m) — {x,z,r,y0,y1,sigma} 또는 {x,y,z,r,height,sigma} */
function castBushes(list, out, ax, ay, az, dx, dy, dz, len3) {
  if (!list || !list.length) return;
  const a2 = dx * dx + dz * dz;
  for (let k = 0; k < list.length; k++) {
    const b = list[k];
    const y0 = b.y0 ?? b.y ?? -1e9;
    const y1 = b.y1 ?? (b.height !== undefined ? y0 + b.height : 1e9);
    const span = cylinderSpan(ax, ay, az, dx, dy, dz, a2, b.x, b.z, b.r, y0, y1);
    if (!span) continue;
    addFoliage(out, Math.max(0, SPAN.tin), Math.min(1, SPAN.tout), b.sigma ?? 1, len3);
  }
}

// 원기둥 교차 결과 (재사용)
const SPAN = { tin: 0, tout: 0, cap: false };
/** 선분과 수직 원기둥(중심 cx,cz 반경 r, 높이 y0~y1)의 겹치는 t 구간. 없으면 false. cap = 윗면/아랫면으로 들어감 */
function cylinderSpan(ax, ay, az, dx, dy, dz, a2, cx, cz, r, y0, y1) {
  const fx = ax - cx, fz = az - cz;
  const c2 = fx * fx + fz * fz - r * r;
  let tA, tB;
  if (a2 < 1e-14) {
    if (c2 > 0) return false;
    tA = -INF; tB = INF;
  } else {
    const b2 = fx * dx + fz * dz;           // (B/2)
    const disc = b2 * b2 - a2 * c2;
    if (disc < 0) return false;
    const sq = Math.sqrt(disc);
    tA = (-b2 - sq) / a2; tB = (-b2 + sq) / a2;
  }
  let sA, sB;
  if (Math.abs(dy) < 1e-14) {
    if (ay < y0 || ay > y1) return false;
    sA = -INF; sB = INF;
  } else {
    const s0 = (y0 - ay) / dy, s1 = (y1 - ay) / dy;
    if (s0 < s1) { sA = s0; sB = s1; } else { sA = s1; sB = s0; }
  }
  const tin = tA > sA ? tA : sA, tout = tB < sB ? tB : sB;
  if (tin > tout || tout < 0 || tin > 1) return false;
  SPAN.tin = tin; SPAN.tout = tout; SPAN.cap = sA > tA;
  return true;
}

// =================================================================
// BulletWorld — 생성된 정글 맵
// =================================================================
export class BulletWorld {
  /** @param {import('../world/WorldQuery.js').WorldQuery} query */
  constructor(query) {
    this.query = query;
    const d = query.data;
    this.data = d;
    this.half = query.half;
    /** 동적 덤불 [{x, z, r, y0, y1, sigma}] (F8 반쯤 가린 표적 수풀) — bulletBlock 'none', 잎 적분에만 더함 */
    this.extraFoliage = [];
    this._out = makeCastResult();
    this._stamp = 0;
    this._cells = new Int32Array(64);
    this._lianas = buildLianaGrid(d, query.circleGrid);
    this._paddy = buildDikes(query.paddy);
  }

  /** 지점의 지형 재질 (지면 종류 + 급경사 = 바위) */
  materialAt(x, z) {
    const q = this.query;
    if (q.getSlope(x, z).deg > (CONFIG.ballistics.rockSlopeDeg ?? 42)) return 'rock';
    return SURFACE_MATERIAL[SURFACE_KEYS[q.getSurfaceAt(x, z)]] ?? 'dirt';
  }

  /** 점이 단단한 것(bulletBlock 'full') 속인가: 땅·논둑·지지형 장애물 윗면 아래, 또는 굵은 줄기 원기둥 안 */
  isInsideSolid(p) {
    if (p.y < this.query.getSupportHeight(p.x, p.z)) return true;
    const list = this.query.circleGrid.at(p.x, p.z);
    for (let k = 0; k < list.length; k++) {
      const c = list[k];
      if (c.tags.bulletBlock !== 'full' || p.y < c.y0 || p.y > c.y1) continue;
      const dx = p.x - c.x, dz = p.z - c.z;
      if (dx * dx + dz * dz < c.r * c.r) return true;
    }
    return false;
  }

  /** 지형 법선 (getSlope 의 높이 기울기로) */
  terrainNormal(x, z, out = { x: 0, y: 1, z: 0 }) {
    const s = this.query.getSlope(x, z);
    const l = Math.hypot(s.gx, 1, s.gz);
    out.x = -s.gx / l; out.y = 1 / l; out.z = -s.gz / l;
    return out;
  }

  /**
   * 선분 a→b 탄도 질의.
   * @param ignore  이 물체는 무시 (방금 관통·도탄한 물체에서 다시 출발할 때 같은 면을 또 맞지 않게; WATER_OBJECT = 이미 물속)
   * @returns out — hit/t/point/normal/objectType/material(/object/underwater), partials, foliage, foliagePoint
   *          (+foliageDense, foliageDeflect, foliageDeflectT, endInWater)
   */
  cast(a, b, out = this._out, ignore = null) {
    resetResult(out);
    const ax = a.x, ay = a.y, az = a.z;
    const dx = b.x - ax, dy = b.y - ay, dz = b.z - az;
    const len3 = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len3 < 1e-9) return out;
    const half = this.half;

    // 맵 사각형으로 자르기 (밖은 아무것도 없음 — 탄은 Ballistics 가 'out' 으로 끝냄)
    if (!clipToSquare(ax, dx, az, dz, half)) return out;
    const tc0 = CLIP.t0, tc1 = CLIP.t1;

    // 멈춤 후보
    let tStop = INF, stopObj = null, stopType = null;
    let nx = 0, ny = 1, nz = 0;   // 멈춤 법선 (지형은 마무리 때 계산)
    const a2 = dx * dx + dz * dz;
    const stamp = ++this._stamp;

    // ---- 1) 4m 격자: 원기둥·지지형 장애물·리아나
    const cg = this.query.circleGrid, sg = this.query.supportGrid, lg = this._lianas;
    const ncell = this._coarseCells(ax + dx * tc0, az + dz * tc0, ax + dx * tc1, az + dz * tc1, cg);
    const cells = this._cells;
    for (let ci = 0; ci < ncell; ci++) {
      const cell = cells[ci];
      // 원기둥 충돌체
      const clist = cg.cells[cell];
      if (clist) {
        for (let k = 0; k < clist.length; k++) {
          const c = clist[k];
          if (c._bw === stamp || c === ignore) continue;
          c._bw = stamp;
          if (!cylinderSpan(ax, ay, az, dx, dy, dz, a2, c.x, c.z, c.r, c.y0, c.y1)) continue;
          const block = c.tags.bulletBlock;
          const tin = SPAN.tin;
          if (block === 'full') {
            const te = tin > 0 ? tin : 0;
            if (te < tStop) {
              tStop = te; stopObj = c; stopType = c.type;
              if (SPAN.cap && tin > 0) { nx = 0; ny = dy > 0 ? -1 : 1; nz = 0; } else { radial(ax + dx * te - c.x, az + dz * te - c.z, c.r); nx = RN.x; ny = 0; nz = RN.z; }
            }
          } else if (block === 'partial') {
            // 바깥에서 들어오는 경우만 (안에서 출발 = 이미 지나는 중)
            if (tin >= 0 && tin <= 1) {
              if (SPAN.cap) addCandidate(out, tin, ax, ay, az, dx, dy, dz, 0, dy > 0 ? -1 : 1, 0, c.type, c);
              else { radial(ax + dx * tin - c.x, az + dz * tin - c.z, c.r); addCandidate(out, tin, ax, ay, az, dx, dy, dz, RN.x, 0, RN.z, c.type, c); }
            }
          } else {
            // 잎·가는 줄기 (σ: 평균 현 길이 πr/2 를 지날 때 시야 차단율만큼 가려지는 소광계수)
            const vb = c.tags.visionBlock;
            if (vb > 0) addFoliage(out, Math.max(0, tin), Math.min(1, SPAN.tout), -Math.log(1 - Math.min(vb, 0.99)) / (Math.PI * c.r * 0.5), len3);
          }
        }
      }
      // 지지형 장애물 (통나무·뿌리·판근 캡슐, 바위 타원체)
      const slist = sg.cells[cell];
      if (slist) {
        for (let k = 0; k < slist.length; k++) {
          const s = slist[k];
          if (s._bw === stamp || s === ignore) continue;
          s._bw = stamp;
          const block = s.tags.bulletBlock;
          if (block === 'none') continue;
          const t = s.kind === 'capsule' ? segCapsuleRaw(ax, ay, az, dx, dy, dz, s.ax, s.ay, s.az, s.bx, s.by, s.bz, s.r)
            : s.kind === 'ellipsoid' ? segEllipsoid(ax, ay, az, dx, dy, dz, s) : -1;
          if (t < 0) continue;
          if (block === 'full') {
            if (t < tStop) { tStop = t; stopObj = s; stopType = s.type; shapeNormal(s, ax + dx * t, ay + dy * t, az + dz * t); nx = RN.x; ny = RN.y; nz = RN.z; }
          } else if (t > 0) {
            shapeNormal(s, ax + dx * t, ay + dy * t, az + dz * t);
            addCandidate(out, t, ax, ay, az, dx, dy, dz, RN.x, RN.y, RN.z, s.type, s);
          }
        }
      }
      // 리아나 (캡슐 사슬)
      const llist = lg.cells[cell];
      if (llist) {
        for (let k = 0; k < llist.length; k++) {
          const s = llist[k];
          if (s._bw === stamp || s.liana === ignore) continue;
          s._bw = stamp;
          const t = segCapsuleRaw(ax, ay, az, dx, dy, dz, s.ax, s.ay, s.az, s.bx, s.by, s.bz, s.r);
          if (!(t > 0)) continue;   // 안에서 출발(0)이면 이미 지나는 중
          const block = CONFIG.objects.liana.bulletBlock;
          if (block === 'none') continue;
          capsuleRadial(s, ax + dx * t, ay + dy * t, az + dz * t);
          if (block === 'full') { if (t < tStop) { tStop = t; stopObj = s.liana; stopType = 'liana'; nx = RN.x; ny = RN.y; nz = RN.z; } }
          else addCandidate(out, t, ax, ay, az, dx, dy, dz, RN.x, RN.y, RN.z, 'liana', s.liana);
        }
      }
    }

    // ---- 2) 논둑 (직육면체)
    const P = this._paddy;
    if (P && ignore !== DIKE_OBJECT) {
      const minY = Math.min(ay, ay + dy);
      if (minY < P.maxTop && !(Math.max(ax, ax + dx) < P.x0 || Math.min(ax, ax + dx) > P.x1 || Math.max(az, az + dz) < P.z0 || Math.min(az, az + dz) > P.z1)) {
        const t = segDikes(P, ax, ay, az, dx, dy, dz);
        if (t >= 0 && t < tStop) { tStop = t; stopObj = DIKE_OBJECT; stopType = 'dike'; nx = RN.x; ny = RN.y; nz = RN.z; }
      }
    }

    // ---- 3) 동적 덤불
    castBushes(this.extraFoliage, out, ax, ay, az, dx, dy, dz, len3);

    // ---- 4) 0.5m 칸: 지형 · 물 · 은폐 높이 구간 · 캐노피
    const d = this.data;
    const sRes = d.sRes, sN = d.sN, hRes = d.hRes, hN = d.hN, H = d.height, WL = d.waterLevel;
    const cN = d.cN, canopy = d.canopy, cLow = d.canopyLow, cHigh = d.canopyHigh, bands = d.coverBands, edges = d.coverBandEdges;
    const NB = edges.length - 1, bandTop = edges[NB];
    const sigCanopy = -Math.log(1 - Math.min(0.99, CONFIG.objects.canopy.visionBlock));
    const tEnd = Math.min(tStop, tc1);
    let terrainHit = false, underwaterHit = false;
    let inWater = false;
    if (tc0 < tEnd) {
      let t0 = tc0;
      const sx = ax + dx * t0, sz = az + dz * t0;
      let i = clampI(Math.floor((sx + half) / sRes), sN), j = clampI(Math.floor((sz + half) / sRes), sN);
      // 칸 경계 위에서 출발하면 진행 방향 쪽 칸
      if (dx < 0 && (sx + half) / sRes === i && i > 0) i--;
      if (dz < 0 && (sz + half) / sRes === j && j > 0) j--;
      const stepI = dx > 0 ? 1 : dx < 0 ? -1 : 0, stepJ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
      const tDX = stepI ? sRes / Math.abs(dx) : INF, tDZ = stepJ ? sRes / Math.abs(dz) : INF;
      let tMaxX = stepI > 0 ? ((i + 1) * sRes - half - ax) / dx : stepI < 0 ? (i * sRes - half - ax) / dx : INF;
      let tMaxZ = stepJ > 0 ? ((j + 1) * sRes - half - az) / dz : stepJ < 0 ? (j * sRes - half - az) / dz : INF;
      // 출발점의 물 상태
      {
        const wl0 = WL[j * sN + i];
        inWater = ignore === WATER_OBJECT || (wl0 !== NO_WATER && ay + dy * t0 < wl0);
      }
      for (let guard = 0; guard < 100000; guard++) {
        const tn = Math.min(tMaxX, tMaxZ, tEnd);
        if (tn > t0) {
          // 이 칸의 쌍선형 지형면: 선분 위에서 h(t) = c0 + c1 t + c2 t²
          const tm = (t0 + tn) * 0.5;
          const fxm = (ax + dx * tm + half) / hRes, fzm = (az + dz * tm + half) / hRes;
          const hi = fxm < 0 ? 0 : fxm >= hN - 1 ? hN - 2 : Math.floor(fxm);
          const hj = fzm < 0 ? 0 : fzm >= hN - 1 ? hN - 2 : Math.floor(fzm);
          const kk = hj * hN + hi;
          const h00 = H[kk], h10 = H[kk + 1], h01 = H[kk + hN], h11 = H[kk + hN + 1];
          const A = h10 - h00, B = h01 - h00, C = h00 - h10 - h01 + h11;
          const u0 = (ax + half) / hRes - hi, w0 = (az + half) / hRes - hj, du = dx / hRes, dw = dz / hRes;
          const c0 = h00 + A * u0 + B * w0 + C * u0 * w0;
          const c1 = A * du + B * dw + C * (u0 * dw + w0 * du);
          const c2 = C * du * dw;
          const q0 = ay - c0, q1 = dy - c1, q2 = -c2;   // f(t) = 탄 높이 - 지형
          let tHit = INF;
          if (q0 + q1 * t0 + q2 * t0 * t0 < 0) tHit = t0;
          else tHit = firstRoot(q0, q1, q2, t0, tn);
          // 물: 수면을 위에서 뚫고 들어가는 점
          const wl = WL[j * sN + i];
          let tw = INF;
          if (wl !== NO_WATER) {
            const y0 = ay + dy * t0, y1 = ay + dy * tn;
            if (!inWater) {
              if (y0 < wl) tw = t0;                              // 옆 칸에서 수면 아래로 넘어옴
              else if (y1 < wl) tw = (wl - ay) / dy;
            }
          }
          const tCut = tHit < tn ? tHit : tn;
          if (tw <= tCut && tw < INF) {
            addCandidate(out, tw, ax, ay, az, dx, dy, dz, 0, 1, 0, 'water', WATER_OBJECT);
            inWater = true;
          }
          // 잎 (물 밖, 지면 위)
          if (tCut > t0 && !(wl !== NO_WATER && ay + dy * ((t0 + tCut) * 0.5) < wl)) {
            const tf = (t0 + tCut) * 0.5;
            const xm = ax + dx * tf, ym = ay + dy * tf, zm = az + dz * tf;
            const hh = ym - (c0 + c1 * tf + c2 * tf * tf);
            let ci = Math.floor(xm + half), cj = Math.floor(zm + half);
            ci = ci < 0 ? 0 : ci >= cN ? cN - 1 : ci;
            cj = cj < 0 ? 0 : cj >= cN ? cN - 1 : cj;
            const kc = cj * cN + ci;
            let sig = 0;
            if (hh >= 0 && hh < bandTop) {
              let bnd = 0;
              while (hh >= edges[bnd + 1]) bnd++;
              sig += bands[kc * NB + bnd];
            }
            const cv = canopy[kc];
            if (cv > 0.05 && ym > cLow[kc] && ym < cHigh[kc]) sig += sigCanopy * cv;
            if (sig > 0) addFoliage(out, t0, tCut, sig, len3);
          }
          // 이 칸을 나갈 때 물속인가 (수면 위로 떠오르면 다시 밖)
          inWater = wl !== NO_WATER && ay + dy * tn < wl;
          if (tHit < INF) {
            if (tHit < tStop) {
              tStop = tHit; stopObj = TERRAIN_OBJECT; stopType = 'terrain'; terrainHit = true;
              underwaterHit = wl !== NO_WATER && ay + dy * tHit < wl;
            }
            break;
          }
        }
        if (tn >= tEnd) break;
        t0 = tn;
        if (tMaxX < tMaxZ) {
          i += stepI; tMaxX += tDX;
          if (i < 0 || i >= sN) break;
        } else {
          j += stepJ; tMaxZ += tDZ;
          if (j < 0 || j >= sN) break;
        }
      }
    }

    // ---- 마무리
    if (tStop <= 1) {
      out.hit = true;
      out.t = tStop;
      const p = out.point;
      p.x = ax + dx * tStop; p.y = ay + dy * tStop; p.z = az + dz * tStop;
      out.object = stopObj;
      out.objectType = stopType;
      if (terrainHit && stopObj === TERRAIN_OBJECT) {
        this.terrainNormal(p.x, p.z, out.normal);
        out.underwater = underwaterHit;
        out.material = underwaterHit ? 'mud' : this.materialAt(p.x, p.z);
      } else {
        out.normal.x = nx; out.normal.y = ny; out.normal.z = nz;
        out.material = materialOf(stopType);
      }
    } else {
      out.endInWater = inWater;
    }
    return finishResult(out, ax, ay, az, dx, dy, dz, len3);
  }

  /** 4m 격자(원기둥·지지형 공용) 위에서 선분이 지나는 칸 번호를 순서대로 */
  _coarseCells(x0, z0, x1, z1, grid) {
    const cs = grid.cell, n = grid.n, gh = grid.half;
    let i = clampI(Math.floor((x0 + gh) / cs), n), j = clampI(Math.floor((z0 + gh) / cs), n);
    const ex = x1 - x0, ez = z1 - z0;
    const stepI = ex > 0 ? 1 : ex < 0 ? -1 : 0, stepJ = ez > 0 ? 1 : ez < 0 ? -1 : 0;
    const tDX = stepI ? cs / Math.abs(ex) : INF, tDZ = stepJ ? cs / Math.abs(ez) : INF;
    let tMaxX = stepI > 0 ? ((i + 1) * cs - gh - x0) / ex : stepI < 0 ? (i * cs - gh - x0) / ex : INF;
    let tMaxZ = stepJ > 0 ? ((j + 1) * cs - gh - z0) / ez : stepJ < 0 ? (j * cs - gh - z0) / ez : INF;
    let count = 0;
    for (;;) {
      if (count >= this._cells.length) {
        const bigger = new Int32Array(this._cells.length * 2);
        bigger.set(this._cells);
        this._cells = bigger;
      }
      this._cells[count++] = j * n + i;
      if (Math.min(tMaxX, tMaxZ) > 1) break;
      if (tMaxX < tMaxZ) { i += stepI; tMaxX += tDX; if (i < 0 || i >= n) break; } else { j += stepJ; tMaxZ += tDZ; if (j < 0 || j >= n) break; }
    }
    return count;
  }
}

// =================================================================
// 평평한 월드 (헤드리스 시뮬·난이도 측정용) — 같은 cast() API, 지면 y = groundY, 물체 없음
// =================================================================
class FlatWorld {
  constructor(groundY = 0) {
    this.groundY = groundY;
    this.half = Infinity;
    this.query = null;
    this.extraFoliage = [];
    this._out = makeCastResult();
  }
  getGroundHeight() { return this.groundY; }
  isInsideSolid(p) { return p.y < this.groundY; }
  materialAt() { return 'dirt'; }
  terrainNormal(x, z, out = { x: 0, y: 1, z: 0 }) { out.x = 0; out.y = 1; out.z = 0; return out; }
  cast(a, b, out = this._out) {
    resetResult(out);
    const ax = a.x, ay = a.y, az = a.z;
    const dx = b.x - ax, dy = b.y - ay, dz = b.z - az;
    const len3 = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len3 < 1e-9) return out;
    const g = this.groundY;
    let t = INF;
    if (ay < g) t = 0;
    else if (ay + dy < g) t = (ay - g) / (ay - (ay + dy));
    castBushes(this.extraFoliage, out, ax, ay, az, dx, dy, dz, len3);
    if (t <= 1) {
      out.hit = true; out.t = t;
      out.point.x = ax + dx * t; out.point.y = ay + dy * t; out.point.z = az + dz * t;
      out.normal.x = 0; out.normal.y = 1; out.normal.z = 0;
      out.objectType = 'terrain'; out.material = 'dirt'; out.object = TERRAIN_OBJECT;
    }
    return finishResult(out, ax, ay, az, dx, dy, dz, len3);
  }
}

export function createFlatWorld(groundY = 0) {
  return new FlatWorld(groundY);
}

// =================================================================
// 도우미
// =================================================================
function clampI(v, n) { return v < 0 ? 0 : v >= n ? n - 1 : v; }

const byT = (p, q) => p.t - q.t;

// 선분을 맵 사각형 [-half, half]² (수평)으로 자른 t 구간 (재사용)
const CLIP = { t0: 0, t1: 1 };
function clipToSquare(ax, dx, az, dz, half) {
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 2; k++) {
    const p = k ? az : ax, q = k ? dz : dx;
    if (Math.abs(q) < 1e-14) { if (p < -half || p > half) return false; continue; }
    let s0 = (-half - p) / q, s1 = (half - p) / q;
    if (s0 > s1) { const tmp = s0; s0 = s1; s1 = tmp; }
    if (s0 > t0) t0 = s0;
    if (s1 < t1) t1 = s1;
  }
  if (t0 >= t1) return false;
  CLIP.t0 = t0; CLIP.t1 = t1;
  return true;
}

/** f(t) = q0 + q1 t + q2 t² 가 (t0, t1] 에서 처음 0 이하가 되는 t (f(t0) ≥ 0 가정), 없으면 Infinity */
function firstRoot(q0, q1, q2, t0, t1) {
  if (Math.abs(q2) < 1e-12) {
    if (q1 >= 0) return INF;
    const r = -q0 / q1;
    return r > t0 && r <= t1 ? r : INF;
  }
  const disc = q1 * q1 - 4 * q2 * q0;
  if (disc < 0) return INF;
  const sq = Math.sqrt(disc);
  const q = -0.5 * (q1 + (q1 >= 0 ? sq : -sq));
  let r1 = q / q2, r2 = q !== 0 ? q0 / q : r1;
  if (r1 > r2) { const tmp = r1; r1 = r2; r2 = tmp; }
  if (r1 > t0 && r1 <= t1) return r1;
  if (r2 > t0 && r2 <= t1) return r2;
  return INF;
}

// 법선 결과 (재사용)
const RN = { x: 0, y: 1, z: 0 };
function radial(x, z, r) {
  const l = Math.hypot(x, z);
  if (l > 1e-9) { RN.x = x / l; RN.z = z / l; } else { RN.x = 1; RN.z = 0; }
  RN.y = 0;
  return RN;
}
function capsuleRadial(s, x, y, z) {
  const abx = s.bx - s.ax, aby = s.by - s.ay, abz = s.bz - s.az;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((x - s.ax) * abx + (y - s.ay) * aby + (z - s.az) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const nx = x - (s.ax + abx * t), ny = y - (s.ay + aby * t), nz = z - (s.az + abz * t);
  const l = Math.hypot(nx, ny, nz);
  if (l > 1e-9) { RN.x = nx / l; RN.y = ny / l; RN.z = nz / l; } else { RN.x = 0; RN.y = 1; RN.z = 0; }
  return RN;
}
function shapeNormal(s, x, y, z) {
  if (s.kind === 'capsule') return capsuleRadial(s, x, y, z);
  // 타원체: 국소 좌표의 기울기 (lx/rx², ly/ry², lz/rz²) → 월드
  const px = x - s.cx, py = y - s.cy, pz = z - s.cz;
  const lx = px * s.cos + pz * s.sin, lz = -px * s.sin + pz * s.cos;
  const gx = lx / (s.rx * s.rx), gy = py / (s.ry * s.ry), gz = lz / (s.rz * s.rz);
  const wx = gx * s.cos - gz * s.sin, wz = gx * s.sin + gz * s.cos;
  const l = Math.hypot(wx, gy, wz) || 1;
  RN.x = wx / l; RN.y = gy / l; RN.z = wz / l;
  return RN;
}

/** 회전 타원체 (WorldQuery insideShape 와 같은 국소 좌표) — 첫 진입 t, 안에서 출발 0, 없으면 -1 */
function segEllipsoid(ax, ay, az, dx, dy, dz, s) {
  const px = ax - s.cx, py = ay - s.cy, pz = az - s.cz;
  const X = (px * s.cos + pz * s.sin) / s.rx, Y = py / s.ry, Z = (-px * s.sin + pz * s.cos) / s.rz;
  const DX = (dx * s.cos + dz * s.sin) / s.rx, DY = dy / s.ry, DZ = (-dx * s.sin + dz * s.cos) / s.rz;
  const c = X * X + Y * Y + Z * Z - 1;
  if (c <= 0) return 0;
  const a = DX * DX + DY * DY + DZ * DZ;
  const b = X * DX + Y * DY + Z * DZ;
  const disc = b * b - a * c;
  if (disc < 0 || a < 1e-14) return -1;
  const t = (-b - Math.sqrt(disc)) / a;
  return t >= 0 && t <= 1 ? t : -1;
}

/** 리아나 중심선 [x0,y0,z0, …] — L.path (렌더러와 공용) 또는 출렁임 없는 처짐 곡선 (LIANA_SEGMENTS 마디) */
function lianaPath(L) {
  if (L.path && L.path.length >= 6) return L.path;
  const sag = Math.max(0.5, (L.ay + L.by) / 2 - L.sagY);
  const out = [];
  for (let k = 0; k <= LIANA_SEGMENTS; k++) {
    const t = k / LIANA_SEGMENTS;
    out.push(L.ax + (L.bx - L.ax) * t, L.ay + (L.by - L.ay) * t - sag * 4 * t * (1 - t), L.az + (L.bz - L.az) * t);
  }
  return out;
}

/** 리아나: 중심선 마디마다 캡슐 (그려진 덩굴과 같은 점) — 원기둥 격자와 같은 4m 칸에 넣는다 */
function buildLianaGrid(d, like) {
  const n = like.n, cs = like.cell, gh = like.half;
  const grid = { n, cell: cs, half: gh, cells: new Array(n * n) };
  const list = d.placements?.liana ?? [];
  for (const L of list) {
    const r = L.r * LIANA_FIT;
    const P = lianaPath(L);
    const m = Math.floor(P.length / 3) - 1;
    let p = [P[0], P[1], P[2]];
    for (let k = 0; k < m; k++) {
      const q = [P[k * 3 + 3], P[k * 3 + 4], P[k * 3 + 5]];
      const seg = { ax: p[0], ay: p[1], az: p[2], bx: q[0], by: q[1], bz: q[2], r, liana: L, _bw: 0 };
      const i0 = clampI(Math.floor((Math.min(p[0], q[0]) - r + gh) / cs), n), i1 = clampI(Math.floor((Math.max(p[0], q[0]) + r + gh) / cs), n);
      const j0 = clampI(Math.floor((Math.min(p[2], q[2]) - r + gh) / cs), n), j1 = clampI(Math.floor((Math.max(p[2], q[2]) + r + gh) / cs), n);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (grid.cells[j * n + i] ||= []).push(seg);
      p = q;
    }
  }
  return grid;
}

/** 논둑을 논 국소 좌표(u,v)의 직육면체로 — 렌더링용 dikeSegments 와 같은 범위·높이 */
function buildDikes(paddy) {
  if (!paddy || typeof paddy.dikeSegments !== 'function') return null;
  const boxes = [];
  let maxTop = -INF;
  for (const s of paddy.dikeSegments()) {
    boxes.push({
      u0: Math.min(s.u0, s.u1) - s.half, u1: Math.max(s.u0, s.u1) + s.half,
      v0: Math.min(s.v0, s.v1) - s.half, v1: Math.max(s.v0, s.v1) + s.half,
      y0: s.bottom, y1: s.top,
    });
    maxTop = Math.max(maxTop, s.top);
  }
  const ext = Math.max(paddy.dikeHalf, paddy.mainDikeHalf ?? paddy.dikeHalf);
  let x0 = INF, x1 = -INF, z0 = INF, z1 = -INF;
  for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const [x, z] = paddy.toWorld(u * (paddy.halfU + ext), v * (paddy.halfV + ext));
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  return { boxes, maxTop, x0, x1, z0, z1, cx: paddy.cx, cz: paddy.cz, cos: paddy.cos, sin: paddy.sin };
}

/** 논둑 직육면체들과 선분 — 첫 진입 t (RN 에 법선), 없으면 -1 */
function segDikes(P, ax, ay, az, dx, dy, dz) {
  const px = ax - P.cx, pz = az - P.cz;
  const u = px * P.cos + pz * P.sin, v = -px * P.sin + pz * P.cos;
  const du = dx * P.cos + dz * P.sin, dv = -dx * P.sin + dz * P.cos;
  let best = INF, axis = 0, sign = 0;
  for (let k = 0; k < P.boxes.length; k++) {
    const B = P.boxes[k];
    let tin = -INF, tout = INF, ax0 = -1, sg0 = 0;
    // u
    if (Math.abs(du) < 1e-14) { if (u < B.u0 || u > B.u1) continue; } else {
      let s0 = (B.u0 - u) / du, s1 = (B.u1 - u) / du, sg = -1;
      if (s0 > s1) { const tmp = s0; s0 = s1; s1 = tmp; sg = 1; }
      if (s0 > tin) { tin = s0; ax0 = 0; sg0 = sg; }
      if (s1 < tout) tout = s1;
    }
    // y
    if (Math.abs(dy) < 1e-14) { if (ay < B.y0 || ay > B.y1) continue; } else {
      let s0 = (B.y0 - ay) / dy, s1 = (B.y1 - ay) / dy, sg = -1;
      if (s0 > s1) { const tmp = s0; s0 = s1; s1 = tmp; sg = 1; }
      if (s0 > tin) { tin = s0; ax0 = 1; sg0 = sg; }
      if (s1 < tout) tout = s1;
    }
    // v
    if (Math.abs(dv) < 1e-14) { if (v < B.v0 || v > B.v1) continue; } else {
      let s0 = (B.v0 - v) / dv, s1 = (B.v1 - v) / dv, sg = -1;
      if (s0 > s1) { const tmp = s0; s0 = s1; s1 = tmp; sg = 1; }
      if (s0 > tin) { tin = s0; ax0 = 2; sg0 = sg; }
      if (s1 < tout) tout = s1;
    }
    if (tin > tout || tout < 0 || tin > 1) continue;
    const te = tin > 0 ? tin : 0;
    if (te < best) { best = te; axis = tin > 0 ? ax0 : 1; sign = tin > 0 ? sg0 : 1; }
  }
  if (best === INF) return -1;
  // 법선: 들어간 면 (안에서 출발이면 위)
  if (axis === 1) { RN.x = 0; RN.y = sign; RN.z = 0; } else if (axis === 0) { RN.x = P.cos * sign; RN.y = 0; RN.z = P.sin * sign; } else { RN.x = -P.sin * sign; RN.y = 0; RN.z = P.cos * sign; }
  return best;
}
