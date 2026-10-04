// 1인칭 소총·팔 절차적 모델 (지오메트리만 — 재질·애니메이션·조명은 WeaponView)
//  7.62mm 돌격소총: 찍어 만든(프레스) 리시버 + 덮개, 나무 개머리판·위아래 총열 덮개, 굽은 30발 탄창, 권총형 손잡이,
//  가스관, 앞쪽 가늠쇠 뭉치(가늠쇠 + 보호 귀), 빗각 제퇴기, 가늠자 뭉치 위 접이식 가늠자 판(U 홈),
//  오른쪽 장전 손잡이·조정간. 특정 상표가 아닌 이 계열의 일반형. 실제 비율 (전장 약 0.88m, 조준선 길이 = config).
//
//  총 공간 좌표 (m): 원점 = 가늠자 홈 기준점 (U 홈 가로 가운데, 가늠자 판 윗변 높이), −Z = 앞(총구), +Y 위, +X 오른쪽.
//   가늠쇠 끝 = (0, 0, −sightRadius) → 홈 기준점과 같은 −Z 축 위. 이 축(조준선)이 눈을 지나면 가늠쇠 끝이 곧 조준점이다.
//   총열 축 = y −sightHeight (조준선과 평행 — 영점 각 ~0.06° 는 화면에서 보이지 않으므로 모델에 넣지 않음).
//  움직이는 부품(노리쇠·조정간·방아쇠·탄창)과 팔(상완·하완·손·오른손 검지)은 각자 '뼈 공간'에서 만든다:
//   모든 뼈의 기준(바인드) 행렬 = 단위 행렬 → 실행 중엔 뼈의 월드 행렬만 정하면 된다.
//   재질이 같은 부품은 SkinnedMesh 하나로 묶는다 (재질 하나 = 그리기 호출 하나).
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const DEG = Math.PI / 180;
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const _col = new THREE.Color();

// ---------------------------------------------------------------
// 표면 — kind 는 셰이더 패치가 세부 텍스처를 쓰는 방식 (WeaponView 참고)
// ---------------------------------------------------------------
export const KIND = { steel: 0, wood: 1, grip: 2, bright: 3, brass: 4, fabric: 5, skin: 6 };
export const SURF = {
  steel:     { kind: KIND.steel, color: 0x2b2c2f, rough: 0.44, metal: 0.62 },   // 총열·가늠쇠·덮개 (흑청 처리)
  paint:     { kind: KIND.steel, color: 0x242527, rough: 0.56, metal: 0.42 },   // 리시버 (검은 도장)
  bright:    { kind: KIND.bright, color: 0x76787a, rough: 0.3, metal: 0.92 },   // 노리쇠 뭉치·마모된 쇠
  wood:      { kind: KIND.wood, color: 0x6b371c, rough: 0.42, metal: 0.0 },     // 합판 개머리판·총열 덮개 (니스)
  grip:      { kind: KIND.grip, color: 0x431a10, rough: 0.38, metal: 0.0 },     // 권총형 손잡이 (적갈색 베이클라이트)
  mag:       { kind: KIND.steel, color: 0x2d2d2c, rough: 0.5, metal: 0.55 },    // 강철 탄창
  hole:      { kind: KIND.steel, color: 0x050505, rough: 0.95, metal: 0.0 },    // 총구 안·홈 속 (그늘)
  brass:     { kind: KIND.brass, color: 0xb88c3c, rough: 0.28, metal: 0.95 },   // 탄피
  copper:    { kind: KIND.brass, color: 0x9a5b36, rough: 0.34, metal: 0.9 },    // 탄두 (구리 피갑)
  fabric:    { kind: KIND.fabric, color: 0x485033, rough: 0.96, metal: 0.0 },   // 올리브색 정글복 소매 (빛바래고 땀에 젖은 OD)
  cuff:      { kind: KIND.fabric, color: 0x3e452a, rough: 0.96, metal: 0.0 },
  inner:     { kind: KIND.fabric, color: 0x16180f, rough: 1.0, metal: 0.0 },    // 소매 안쪽 그늘
  skin:      { kind: KIND.skin, color: 0x8c5c3f, rough: 0.58, metal: 0.0 },     // 햇볕에 그을린 손
  nail:      { kind: KIND.skin, color: 0xbf9378, rough: 0.38, metal: 0.0 },
  // 5단계: 주운 적 소총 (5.56 계열) — 검은 합성수지 개머리판·총열 덮개·손잡이
  polymer:   { kind: KIND.grip, color: 0x1f211d, rough: 0.72, metal: 0.0 },
  polyGrip:  { kind: KIND.grip, color: 0x191a17, rough: 0.66, metal: 0.0 },
};

// ---------------------------------------------------------------
// 부품 조립기 — 부품 지오메트리를 뼈 공간으로 옮기며 정점색·표면·세부 UV·뼈 가중치를 붙인다
// ---------------------------------------------------------------
/** 비색인 삼각형 위치 배열 → 주름각(crease) 법선: 각이 creaseDeg 이하로 꺾인 이웃 면끼리만 법선을 부드럽게 섞는다.
 *  (three 의 toCreasedNormals 는 1cm 격자로 정점을 합쳐 작은 총 부품에는 너무 거칠다 → 0.01mm 격자) */
function creaseNormals(pos, creaseDeg) {
  const nv = pos.length / 3, nf = nv / 3;
  const fn = new Float32Array(nf * 3);   // 단위 면 법선
  const fa = new Float32Array(nf * 3);   // 넓이 가중 면 법선
  for (let f = 0; f < nf; f++) {
    const o = f * 9;
    const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
    const e1x = pos[o + 3] - ax, e1y = pos[o + 4] - ay, e1z = pos[o + 5] - az;
    const e2x = pos[o + 6] - ax, e2y = pos[o + 7] - ay, e2z = pos[o + 8] - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    fa[f * 3] = nx; fa[f * 3 + 1] = ny; fa[f * 3 + 2] = nz;
    fn[f * 3] = nx / l; fn[f * 3 + 1] = ny / l; fn[f * 3 + 2] = nz / l;
  }
  const groups = new Map();
  const keys = new Array(nv);
  for (let i = 0; i < nv; i++) {
    const k = `${Math.round(pos[i * 3] * 1e5)},${Math.round(pos[i * 3 + 1] * 1e5)},${Math.round(pos[i * 3 + 2] * 1e5)}`;
    keys[i] = k;
    let g = groups.get(k);
    if (!g) { g = []; groups.set(k, g); }
    g.push(i);
  }
  const cosC = Math.cos(creaseDeg * DEG);
  const out = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    const f = (i / 3) | 0;
    let sx = 0, sy = 0, sz = 0;
    for (const j of groups.get(keys[i])) {
      const g = (j / 3) | 0;
      if (fn[f * 3] * fn[g * 3] + fn[f * 3 + 1] * fn[g * 3 + 1] + fn[f * 3 + 2] * fn[g * 3 + 2] < cosC) continue;
      sx += fa[g * 3]; sy += fa[g * 3 + 1]; sz += fa[g * 3 + 2];
    }
    const l = Math.hypot(sx, sy, sz) || 1;
    out[i * 3] = sx / l; out[i * 3 + 1] = sy / l; out[i * 3 + 2] = sz / l;
  }
  return out;
}

export class PartBuilder {
  constructor() {
    this.pos = []; this.nrm = []; this.uv = []; this.col = []; this.surf = []; this.si = []; this.sw = [];
  }

  get count() { return this.pos.length / 3; }

  /**
   * @param {THREE.BufferGeometry} geo  부품 (position 필수, uv 는 o.uv === 'keep' 일 때만 사용)
   * @param {object} o
   *  surf: SURF 항목 · bone: 뼈 번호 · matrix: 부품 → 뼈 공간 · crease: 주름각(°, 기본 38)
   *  uv: 'box' (부품 공간 위치를 법선 축으로 투영, u 는 되도록 부품의 Z 축 = 나뭇결 방향) | 'keep' (지오메트리 UV)
   *  uvScale: 1m 당 타일 수 (또는 [su, sv]) · uvOffset: [ou, ov]
   *  tint: 색 배율 · shade(p, n): 부품 공간 위치·법선 → 색 배율 (마모·그늘)
   *  mirrorX: X 반전 (왼손). 정점은 뼈 하나에 가중치 1 로 묶는다 (모든 뼈의 바인드 행렬이 단위 행렬이라
   *  여러 뼈에 나눠 묶으면 뼈마다 다른 공간으로 해석된다 — 관절 이음매는 소맷부리·관절 공으로 가린다)
   */
  add(geo, o) {
    const src = geo.index ? geo.toNonIndexed() : geo;
    const P = src.attributes.position, UV = src.attributes.uv;
    const nv = P.count;
    const pos = new Float32Array(nv * 3);
    const uvs = UV && o.uv === 'keep' ? new Float32Array(nv * 2) : null;
    for (let i = 0; i < nv; i++) {
      pos[i * 3] = P.getX(i) * (o.mirrorX ? -1 : 1); pos[i * 3 + 1] = P.getY(i); pos[i * 3 + 2] = P.getZ(i);
      if (uvs) { uvs[i * 2] = UV.getX(i); uvs[i * 2 + 1] = UV.getY(i); }
    }
    if (o.mirrorX) {
      // 거울상은 삼각형 감김이 뒤집힌다 → 두 번째·세 번째 정점 교환
      for (let t = 0; t < nv; t += 3) {
        for (let c = 0; c < 3; c++) { const a = pos[(t + 1) * 3 + c]; pos[(t + 1) * 3 + c] = pos[(t + 2) * 3 + c]; pos[(t + 2) * 3 + c] = a; }
        if (uvs) for (let c = 0; c < 2; c++) { const a = uvs[(t + 1) * 2 + c]; uvs[(t + 1) * 2 + c] = uvs[(t + 2) * 2 + c]; uvs[(t + 2) * 2 + c] = a; }
      }
    }
    const nrm = creaseNormals(pos, o.crease ?? 38);
    const m = o.matrix || null;
    if (m) _nm.getNormalMatrix(m);
    const s = o.surf;
    const base = _col.setHex(s.color, THREE.SRGBColorSpace);   // 선형 값으로 변환됨
    const br = base.r, bg = base.g, bb = base.b;
    const tint = o.tint ?? 1;
    const tr = Array.isArray(tint) ? tint[0] : tint, tg = Array.isArray(tint) ? tint[1] : tint, tb = Array.isArray(tint) ? tint[2] : tint;
    const sc = o.uvScale ?? 4;
    const su = Array.isArray(sc) ? sc[0] : sc, sv = Array.isArray(sc) ? sc[1] : sc;
    const ou = o.uvOffset ? o.uvOffset[0] : 0, ov = o.uvOffset ? o.uvOffset[1] : 0;
    const bone = o.bone ?? 0;
    for (let i = 0; i < nv; i++) {
      const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
      const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
      // 세부 UV
      let u, v;
      if (uvs) { u = uvs[i * 2]; v = uvs[i * 2 + 1]; } else {
        const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
        if (ax >= ay && ax >= az) { u = pz; v = py; } else if (ay >= az) { u = pz; v = px; } else { u = px; v = py; }
      }
      this.uv.push(u * su + ou, v * sv + ov);
      // 색
      _v.set(px, py, pz); _n.set(nx, ny, nz);
      const k = o.shade ? o.shade(_v, _n) : 1;
      this.col.push(br * tr * k, bg * tg * k, bb * tb * k);
      this.surf.push(s.kind, s.rough, s.metal);
      // 뼈
      this.si.push(bone, 0, 0, 0); this.sw.push(1, 0, 0, 0);
      // 뼈 공간으로
      if (m) { _v.applyMatrix4(m); _n.applyMatrix3(_nm).normalize(); }
      this.pos.push(_v.x, _v.y, _v.z);
      this.nrm.push(_n.x, _n.y, _n.z);
    }
    if (src !== geo) src.dispose();
    return this;
  }

  build() {
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.surf, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    // 같은 값의 정점(매끈한 면)을 합쳐 색인 지오메트리로 — 스키닝할 정점 수가 크게 준다
    g = mergeVertices(g, 1e-6);
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------
// 형상 도우미
// ---------------------------------------------------------------
/** 위치 + 오일러(XYZ, rad) + 배율 → 행렬 */
export function mat(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
}
const ROT_Y_TO_Z = new THREE.Matrix4().makeRotationX(Math.PI / 2);    // +Y 축 → +Z 축
const ROT_Y_TO_X = new THREE.Matrix4().makeRotationZ(-Math.PI / 2);   // +Y 축 → +X 축
/** 원기둥 (축 +Z, 가운데 원점). r0 = −Z 쪽(앞) 반지름, r1 = +Z 쪽 반지름 */
function cylZ(r0, r1, len, seg = 12, open = false) {
  // CylinderGeometry 는 +Y 가 radiusTop → Y→Z 회전 후 +Z 쪽이 top. 앞(−Z)이 r0 이 되게 top = r1
  return new THREE.CylinderGeometry(r1, r0, len, seg, 1, open).applyMatrix4(ROT_Y_TO_Z);
}
function cylX(r, len, seg = 10) { return new THREE.CylinderGeometry(r, r, len, seg).applyMatrix4(ROT_Y_TO_X); }
function cylY(r0, r1, len, seg = 10) { return new THREE.CylinderGeometry(r1, r0, len, seg); }

/** 2D 슈퍼타원 단면 (반시계, 점 n개). p 가 클수록 각진 둥근 사각형 */
function superEllipse(rx, ry, n = 20, p = 3) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    pts.push([rx * Math.sign(c) * Math.pow(Math.abs(c), 2 / p), ry * Math.sign(s) * Math.pow(Math.abs(s), 2 / p)]);
  }
  return pts;
}

function centroid(ring) {
  const c = new THREE.Vector3();
  for (const p of ring) c.add(p);
  return c.multiplyScalar(1 / ring.length);
}

/**
 * 고리(같은 점 개수의 닫힌 다각형, Vector3 배열)들을 이어 붙인 몸체. 감김 방향은 첫 고리에서 자동 판정해
 * 바깥을 향하게 만들고, 양 끝은 부채꼴로 막는다.
 */
export function loft(rings, capStart = true, capEnd = true) {
  const m = rings[0].length;
  const pos = [];
  const c0 = centroid(rings[0]), c1 = centroid(rings[1]);
  const axis = c1.clone().sub(c0);
  const area = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let i = 0; i < m; i++) {
    a.copy(rings[0][i]).sub(c0); b.copy(rings[0][(i + 1) % m]).sub(c0);
    area.add(a.cross(b));
  }
  const ccw = area.dot(axis) > 0;
  const tri = (p, q, r) => {
    if (ccw) pos.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z);
    else pos.push(p.x, p.y, p.z, r.x, r.y, r.z, q.x, q.y, q.z);
  };
  for (let k = 0; k < rings.length - 1; k++) {
    const A = rings[k], B = rings[k + 1];
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      tri(A[i], A[j], B[j]);
      tri(A[i], B[j], B[i]);
    }
  }
  if (capStart) {
    const R0 = rings[0], c = centroid(R0);
    for (let i = 0; i < m; i++) tri(c, R0[(i + 1) % m], R0[i]);
  }
  if (capEnd) {
    const L = rings[rings.length - 1], c = centroid(L);
    for (let i = 0; i < m; i++) tri(c, L[i], L[(i + 1) % m]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/** 2D 단면 → 3D 고리: origin + x·ax + y·ay */
function ring(pts, origin, ax = X_AXIS, ay = Y_AXIS) {
  return pts.map(([x, y]) => new THREE.Vector3(
    origin.x + ax.x * x + ay.x * y, origin.y + ax.y * x + ay.y * y, origin.z + ax.z * x + ay.z * y));
}
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Z 방향 직선 몸체: sections = [{ z, w, h, cx?, cy?, p? }] (반폭 w, 반높이 h, 중심 cx·cy, 슈퍼타원 지수 p) */
function loftZ(sections, n = 20, caps = [true, true]) {
  const rings = sections.map((s) => ring(superEllipse(s.w, s.h, n, s.p ?? 3), new THREE.Vector3(s.cx ?? 0, s.cy ?? 0, s.z)));
  return loft(rings, caps[0], caps[1]);
}

/** 모서리를 깎은 상자 (가운데 원점). bevel = 모서리 깎임 (m) */
function bevelBox(w, h, d, bevel = 0.0008, p = 8) {
  const b = Math.min(bevel, w * 0.3, h * 0.3, d * 0.3);
  const hw = w / 2, hh = h / 2, hd = d / 2;
  return loftZ([
    { z: -hd, w: hw - b, h: hh - b, p },
    { z: -hd + b, w: hw, h: hh, p },
    { z: hd - b, w: hw, h: hh, p },
    { z: hd, w: hw - b, h: hh - b, p },
  ], 16);
}

/** 곡선 경로를 따라가는 납작한 띠 (방아쇠울·방아쇠 날). side = 띠의 폭 방향(고정 축) */
function strip(points, width, thick, side = X_AXIS) {
  const curve = new THREE.CatmullRomCurve3(points);
  const N = 18;
  const rings = [];
  const t = new THREE.Vector3(), nrm = new THREE.Vector3();
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const p = curve.getPointAt(u);
    curve.getTangentAt(u, t);
    nrm.crossVectors(side, t).normalize();   // 띠 두께 방향
    rings.push(ring(superEllipse(width / 2, thick / 2, 12, 6), p, side, nrm));
  }
  return loft(rings);
}

// ---------------------------------------------------------------
// 소총
// ---------------------------------------------------------------
export const RIFLE_BONES = { root: 0, bolt: 1, selector: 2, trigger: 3, mag: 4 };

/**
 * @param {object} data  무기 데이터 (sightRadius, sightHeight)
 * @returns {{ geometry, points, frames, dims }}
 *  points (총 공간): rearSight(홈 기준점), frontSight(가늠쇠 끝), muzzle, ejection(배출구), selectorPivot, triggerPivot, magPivot, chargeKnob
 *  frames: 손이 잡는 자리 { pos, quat } — gripR(총 공간), guardL(총 공간), magL(탄창 뼈 공간), chargeR(노리쇠 뼈 공간)
 *  dims: 노리쇠 행정, 조정간 각, 탄창 기울임 등 애니메이션용 치수
 */
export function buildRifle(data = {}) {
  const R = data.sightRadius ?? 0.378;
  const H = data.sightHeight ?? 0.06;
  const b = new PartBuilder();
  const B = RIFLE_BONES;
  // 몸통 재질: 'wood' (기본 7.62) / 'polymer' (5단계 적 소총)
  const POLY = data.model === 'polymer';
  const S_WOOD = POLY ? SURF.polymer : SURF.wood, S_GRIP = POLY ? SURF.polyGrip : SURF.grip;

  // ---- 주요 치수 (총 공간, −Z 앞)
  const yB = -H;                          // 총열 축
  const zPost = -R;                       // 가늠쇠
  const zMz = zPost - 0.05;               // 총구 끝 (제퇴기 앞)
  const zBrB = zMz + 0.026;               // 제퇴기 뒤 = 가늠쇠 뭉치 앞
  const zFsB = zBrB + 0.044;              // 가늠쇠 뭉치 뒤
  const zGbF = zPost + 0.104;             // 가스 블록 앞
  const zGbB = zGbF + 0.026;
  const zHgF = zGbB + 0.007;              // 아래 총열 덮개 앞 (덮개 고정쇠 포함)
  const zRsF = -0.078;                    // 가늠자 뭉치 앞
  const zRsB = 0.006;
  const zRecF = -0.04, zRecB = 0.236;     // 리시버
  const zMagF = 0.018, zMagB = 0.076;     // 탄창 윗부분 앞·뒤
  const zTrig = 0.113;                    // 방아쇠
  const zButt = zMz + 0.88;               // 개머리판 끝 (전장 0.88m)
  const yRecT = -0.037, yRecBot = yB - 0.04;   // 리시버 윗변(덮개 받침)·밑면
  const yGt = yB + 0.029;                 // 가스관 축
  const wear = (top = 0.18, bottom = 0.22) => (p, n) => 1 + top * Math.max(0, n.y) ** 2 - bottom * Math.max(0, -n.y);

  // ================= 총구 쪽 =================
  // 제퇴기 (빗각: 위쪽이 짧고 아래 턱이 앞으로 나옴 — 가스를 위·오른쪽으로 빼 총구 들림을 줄이는 형태)
  {
    const r = 0.0118, seg = 16;
    const back = [], front = [], mouth = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      back.push(new THREE.Vector3(x, yB + y, zBrB));
      const zf = zMz + (y / r + 1) * 0.5 * 0.011;   // 위로 갈수록 뒤로 물러난 빗면
      front.push(new THREE.Vector3(x, yB + y, zf));
      mouth.push(new THREE.Vector3(x * 0.42, yB + y * 0.42, zf + 0.0012));
    }
    b.add(loft([back, front, mouth], true, false), { surf: SURF.steel, bone: B.root, shade: wear() });
    // 총구 구멍 (안쪽 그늘)
    b.add(cylZ(0.0047, 0.0047, 0.03, 10, true), { surf: SURF.hole, bone: B.root, matrix: mat(0, yB, zMz + 0.016) });
    // 빗면 위쪽의 가스 구멍 둘 (어두운 점)
    b.add(cylY(0.0021, 0.0021, 0.006, 8), { surf: SURF.hole, bone: B.root, matrix: mat(0.004, yB + 0.0101, zMz + 0.0175, 0, 0, -0.35) });
    b.add(cylY(0.0021, 0.0021, 0.006, 8), { surf: SURF.hole, bone: B.root, matrix: mat(-0.003, yB + 0.0106, zMz + 0.0215, 0, 0, 0.2) });
  }
  // 가늠쇠 뭉치: 총열 고리 + 아래 착검 돌기 + 기둥 + 가늠쇠 드럼 + 가늠쇠 + U자 보호 귀
  {
    const zc = (zBrB + zFsB) / 2;
    b.add(cylZ(0.0148, 0.0148, zFsB - zBrB, 18), { surf: SURF.steel, bone: B.root, matrix: mat(0, yB, zc), shade: wear() });
    b.add(bevelBox(0.0118, 0.012, 0.03, 0.0012), { surf: SURF.steel, bone: B.root, matrix: mat(0, yB - 0.0165, zBrB + 0.016), shade: wear() });
    // 기둥 (총열 위 → 가늠쇠 드럼)
    const towerBot = yB + 0.009, towerTop = -0.0205;
    b.add(bevelBox(0.0105, towerTop - towerBot, 0.021, 0.0012), { surf: SURF.steel, bone: B.root, matrix: mat(0, (towerTop + towerBot) / 2, zPost + 0.002), shade: wear() });
    // 드럼 (가로 원통)
    b.add(cylX(0.0044, 0.0125, 14), { surf: SURF.steel, bone: B.root, matrix: mat(0, -0.0212, zPost + 0.0005) });
    // 가늠쇠 (둥근 기둥, 끝이 정확히 y = 0)
    b.add(cylY(0.0016, 0.0016, 0.0205, 10), { surf: SURF.steel, bone: B.root, matrix: mat(0, -0.01025, zPost), crease: 50 });
    // U자 보호 귀 (위가 열린 고리 — 귀 끝이 가늠쇠 끝보다 살짝 높다)
    const s = new THREE.Shape();
    const ro = 0.0098, ri = 0.0069, yc = -0.0192, top = 0.0026;
    s.moveTo(-ro, top);
    s.lineTo(-ro, yc);
    s.absarc(0, yc, ro, Math.PI, Math.PI * 2, false);
    s.lineTo(ro, top);
    s.lineTo(ri, top);
    s.lineTo(ri, yc);
    s.absarc(0, yc, ri, 0, -Math.PI, true);
    s.lineTo(-ri, top);
    s.closePath();
    const ears = new THREE.ExtrudeGeometry(s, { depth: 0.0085, bevelEnabled: false, curveSegments: 12 });
    b.add(ears, { surf: SURF.steel, bone: B.root, matrix: mat(0, 0, zPost - 0.0072), crease: 30, shade: wear(0.3, 0.2) });
    // 귀 아래 받침 (귀와 기둥을 잇는 덩어리)
    b.add(bevelBox(0.0205, 0.009, 0.0085, 0.001), { surf: SURF.steel, bone: B.root, matrix: mat(0, -0.0315, zPost - 0.003) });
  }
  // 총열 (가늠쇠 뭉치 ~ 가늠자 뭉치, 앞이 가늘다)
  b.add(cylZ(0.0089, 0.0103, zRsF - zFsB, 16), { surf: SURF.steel, bone: B.root, matrix: mat(0, yB, (zFsB + zRsF) / 2), shade: wear(0.25, 0.2) });
  // 꽂을대 (총열 아래, 앞쪽 머리가 굵다)
  {
    const yr = yB - 0.0172, z0 = zBrB + 0.004, z1 = zHgF;
    b.add(cylZ(0.0027, 0.0027, z1 - z0, 8), { surf: SURF.steel, bone: B.root, matrix: mat(0, yr, (z0 + z1) / 2) });
    b.add(cylZ(0.0045, 0.0045, 0.009, 10), { surf: SURF.steel, bone: B.root, matrix: mat(0, yr, z0 + 0.003) });
  }
  // 가스 블록: 총열 고리 + 45° 기운 가스 통로 + 가스관 앞마개 + 멜빵 고리
  {
    const zc = (zGbF + zGbB) / 2;
    b.add(cylZ(0.0138, 0.0138, zGbB - zGbF, 18), { surf: SURF.steel, bone: B.root, matrix: mat(0, yB, zc), shade: wear() });
    b.add(bevelBox(0.0155, 0.03, 0.0145, 0.0015), { surf: SURF.steel, bone: B.root, matrix: mat(0, yB + 0.0145, zc + 0.002, -0.62, 0, 0), shade: wear() });
    b.add(cylZ(0.0109, 0.0109, 0.024, 16), { surf: SURF.steel, bone: B.root, matrix: mat(0, yGt, zc + 0.006), shade: wear() });
    b.add(new THREE.TorusGeometry(0.0062, 0.0014, 6, 14), { surf: SURF.steel, bone: B.root, matrix: mat(-0.0125, yB - 0.006, zc, 0, Math.PI / 2, 0) });
  }
  // 가스관 (위 총열 덮개 앞쪽으로 조금 드러남)
  b.add(cylZ(0.0102, 0.0102, zRsF - zGbB, 16), { surf: SURF.steel, bone: B.root, matrix: mat(0, yGt, (zGbB + zRsF) / 2) });
  // 가스관 앞쪽 통풍 구멍
  for (let i = 0; i < 3; i++) {
    b.add(cylX(0.0016, 0.0208, 8), { surf: SURF.hole, bone: B.root, matrix: mat(0, yGt + 0.001, zGbB + 0.0045 + i * 0.0042) });
  }

  // ================= 나무 총열 덮개 =================
  // 위 덮개: 가스관을 덮는 둥근 지붕
  {
    const z0 = zGbB + 0.0165, z1 = zRsF - 0.002, L = z1 - z0;
    const secs = [];
    const N = 12;
    for (let i = 0; i <= N; i++) {
      const t = i / N, z = z0 + L * t;
      const endK = Math.min(1, Math.min(t, 1 - t) * 14);   // 양 끝을 둥글게 오므림
      const k = 0.93 + 0.07 * Math.sqrt(endK);
      secs.push({ z, w: 0.0178 * k, h: 0.014 * (0.9 + 0.1 * endK), cy: yGt + 0.0005, p: 2.6 });
    }
    b.add(loftZ(secs, 24), { surf: S_WOOD, bone: B.root, uvScale: 5, uvOffset: [0.31, 0.17], shade: wear(0.12, 0.3), crease: 50 });
  }
  // 아래 덮개: 손바닥 받침이 불룩한 덮개 (옆면 손가락 홈)
  {
    const z0 = zHgF + 0.009, z1 = zRsF - 0.001, L = z1 - z0;
    const secs = [];
    const N = 18;
    for (let i = 0; i <= N; i++) {
      const t = i / N, z = z0 + L * t;
      const swell = Math.exp(-(((t - 0.42) / 0.26) ** 2));            // 손바닥 받침 (앞쪽 가운데가 불룩)
      const groove = Math.exp(-(((t - 0.78) / 0.05) ** 2)) * 0.0016;   // 뒤쪽 손가락 홈
      const endK = Math.min(1, Math.min(t, 1 - t) * 20);
      const hw = (0.0195 + 0.0035 * swell - groove) * (0.96 + 0.04 * endK);
      secs.push({ z, w: hw, h: 0.0245, cy: yB - 0.0085, p: 2.9 });
    }
    b.add(loftZ(secs, 26), { surf: S_WOOD, bone: B.root, uvScale: 5, uvOffset: [0.73, 0.41], shade: wear(0.12, 0.32), crease: 50 });
    // 덮개 앞 고정쇠 (쇠띠)
    b.add(loftZ([
      { z: zHgF, w: 0.0205, h: 0.0255, cy: yB - 0.0075, p: 3 },
      { z: zHgF + 0.0012, w: 0.0212, h: 0.026, cy: yB - 0.0075, p: 3 },
      { z: zHgF + 0.0098, w: 0.0212, h: 0.026, cy: yB - 0.0075, p: 3 },
      { z: zHgF + 0.011, w: 0.0205, h: 0.0255, cy: yB - 0.0075, p: 3 },
    ], 24), { surf: SURF.steel, bone: B.root, shade: wear() });
  }

  // ================= 가늠자 뭉치 =================
  {
    // 받침 (총열·앞 트러니언을 감싸는 덩어리)
    const yTop = -0.0118, yBot = yB - 0.031;
    b.add(loftZ([
      { z: zRsF, w: 0.0158, h: (yTop - yBot) / 2 - 0.001, cy: (yTop + yBot) / 2, p: 5 },
      { z: zRsF + 0.0015, w: 0.0165, h: (yTop - yBot) / 2, cy: (yTop + yBot) / 2, p: 5 },
      { z: zRsB - 0.0015, w: 0.0165, h: (yTop - yBot) / 2, cy: (yTop + yBot) / 2, p: 5 },
      { z: zRsB, w: 0.0158, h: (yTop - yBot) / 2 - 0.001, cy: (yTop + yBot) / 2, p: 5 },
    ], 22), { surf: SURF.steel, bone: B.root, shade: wear() });
    // 가늠자 판 양옆의 경사 받침 (슬라이더가 올라타는 곡면)
    for (const sx of [-1, 1]) {
      b.add(bevelBox(0.0042, 0.0072, 0.064, 0.0008), { surf: SURF.steel, bone: B.root, matrix: mat(sx * 0.0112, -0.0082, -0.039, 0.025, 0, 0) });
    }
    // 가늠자 판 (앞 경첩, 뒤끝에 홈 판)
    b.add(bevelBox(0.0165, 0.0026, 0.07, 0.0006), { surf: SURF.steel, bone: B.root, matrix: mat(0, -0.0049, -0.036, -0.03, 0, 0) });
    // 홈 판: 위가 y = 0, U 홈 폭 4.2mm·깊이 3.4mm
    const s = new THREE.Shape();
    const hw = 0.0085, nw = 0.0025, nd = 0.0038, bot = -0.0064;
    s.moveTo(-hw, bot);
    s.lineTo(hw, bot);
    s.lineTo(hw, 0);
    s.lineTo(nw, 0);
    s.lineTo(nw, -nd + nw);
    s.absarc(0, -nd + nw, nw, 0, -Math.PI, true);
    s.lineTo(-nw, 0);
    s.lineTo(-hw, 0);
    s.closePath();
    const blade = new THREE.ExtrudeGeometry(s, { depth: 0.0032, bevelEnabled: false, curveSegments: 10 });
    b.add(blade, { surf: SURF.steel, bone: B.root, matrix: mat(0, 0, -0.0026), crease: 30, shade: wear(0.25, 0.1) });
    // 슬라이더 (판을 감싸는 고리, 전투 가늠 위치 = 앞쪽) + 옆 누름쇠
    b.add(bevelBox(0.0212, 0.0062, 0.0105, 0.0009), { surf: SURF.steel, bone: B.root, matrix: mat(0, -0.0058, -0.054), shade: wear(0.3) });
    b.add(bevelBox(0.003, 0.0045, 0.0062, 0.0006), { surf: SURF.bright, bone: B.root, matrix: mat(0.0118, -0.0058, -0.054) });
    // 경첩 핀
    b.add(cylX(0.0022, 0.0335, 10), { surf: SURF.steel, bone: B.root, matrix: mat(0, -0.0085, -0.07) });
    // 가스관 고정 레버 (오른쪽, 가늠자 뭉치 앞)
    b.add(bevelBox(0.0032, 0.0068, 0.016, 0.0006), { surf: SURF.steel, bone: B.root, matrix: mat(0.0175, -0.0185, zRsF + 0.012, 0.12, 0, 0) });
  }

  // ================= 리시버 + 덮개 =================
  {
    // 리시버 (찍어 만든 판): 아래 모서리가 둥근 상자. 앞은 가늠자 뭉치 아래로 들어간다
    const secs = [];
    const zs = [zRecF, zRecF + 0.002, zRecB - 0.002, zRecB];
    for (let i = 0; i < zs.length; i++) {
      const inset = i === 0 || i === zs.length - 1 ? 0.0008 : 0;
      secs.push({ z: zs[i], w: 0.018 - inset, h: (yRecT - yRecBot) / 2 - inset, cy: (yRecT + yRecBot) / 2, p: 6 });
    }
    // 배출구(오른쪽 벽 위쪽)를 정점색으로 어둡게 + 아래 모서리·밑면 그늘
    const port = (p, n) => {
      let k = 1 + 0.12 * Math.max(0, n.y) ** 2 - 0.3 * Math.max(0, -n.y);
      if (n.x > 0.6 && p.z > 0.028 && p.z < 0.128 && p.y > -0.052) k *= 0.18;
      return k;
    };
    const recv = loftZ(secs, 28);
    b.add(recv, { surf: SURF.paint, bone: B.root, shade: port, crease: 35 });
    // 배출구 가장자리를 날카롭게 보이려고, 리시버 벽에 살짝 띄운 판 둘 (배출구 위·아래 테두리)
    for (const [y, h] of [[-0.0535, 0.003], [-0.0372, 0.0016]]) {
      b.add(bevelBox(0.0008, h, 0.1, 0.0002), { surf: SURF.bright, bone: B.root, matrix: mat(0.0182, y, 0.078), tint: 0.55 });
    }
    // 탄창 안내 홈 (탄창 구멍 위 양옆의 오목한 점)
    for (const sx of [-1, 1]) {
      b.add(new THREE.SphereGeometry(0.0038, 10, 6), { surf: SURF.paint, bone: B.root, matrix: mat(sx * 0.0172, -0.072, 0.047, 0, 0, 0, 0.35, 1, 1.6), tint: 0.55 });
    }
    // 리벳 (앞·뒤 트러니언, 방아쇠 뭉치 핀)
    const rivets = [[-0.052, 0.006], [-0.064, 0.006], [-0.058, -0.004], [-0.053, 0.2155], [-0.075, 0.226], [-0.086, 0.214]];
    for (const sx of [-1, 1]) {
      for (const [y, z] of rivets) b.add(cylX(0.0021, 0.0016, 10), { surf: SURF.paint, bone: B.root, matrix: mat(sx * 0.0186, y, z), tint: 1.25 });
      for (const [y, z] of [[-0.079, 0.1], [-0.079, 0.127]]) b.add(cylX(0.0024, 0.0018, 10), { surf: SURF.bright, bone: B.root, matrix: mat(sx * 0.0187, y, z), tint: 0.6 });
    }
    // 덮개 (아치형, 가로 보강 줄)
    const arch = (k, y0) => {
      const pts = [];
      const n = 18;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI;   // 0 = 오른쪽 → π = 왼쪽
        const x = Math.cos(a) * 0.0188 * k;
        const y = y0 + Math.pow(Math.sin(a), 0.62) * 0.0172 * k;
        pts.push([x, y]);
      }
      pts.push([-0.0188 * k, y0 - 0.004], [0.0188 * k, y0 - 0.004]);   // 아래(안쪽)를 닫음
      return pts;
    };
    const y0 = -0.0402;
    const rings = [];
    const zc0 = 0.0028, zc1 = zRecB;
    const ribs = [0.07, 0.1, 0.13, 0.16, 0.19];
    const zKeys = [zc0, zc0 + 0.0015];
    for (const r of ribs) zKeys.push(r - 0.004, r - 0.0022, r + 0.0022, r + 0.004);
    zKeys.push(zc1 - 0.0015, zc1);
    for (let i = 0; i < zKeys.length; i++) {
      const z = zKeys[i];
      let k = 1;
      for (const r of ribs) if (Math.abs(z - r) < 0.003) k = 1.055;
      if (i === 0 || i === zKeys.length - 1) k = 0.97;
      rings.push(ring(arch(k, y0), new THREE.Vector3(0, 0, z)));
    }
    b.add(loft(rings), { surf: SURF.steel, bone: B.root, shade: wear(0.22, 0.1), crease: 34 });
    // 덮개 뒤 단추 (복좌 용수철 안내봉 끝)
    b.add(bevelBox(0.0085, 0.0062, 0.0105, 0.0012), { surf: SURF.steel, bone: B.root, matrix: mat(0, -0.0292, zRecB + 0.0035), shade: wear(0.3) });
  }

  // ================= 방아쇠울·탄창 멈치·권총형 손잡이 =================
  {
    const pts = [
      new THREE.Vector3(0, yRecBot + 0.002, zMagB + 0.003),
      new THREE.Vector3(0, yRecBot - 0.013, zMagB + 0.009),
      new THREE.Vector3(0, yRecBot - 0.027, zMagB + 0.03),
      new THREE.Vector3(0, yRecBot - 0.0285, zTrig + 0.012),
      new THREE.Vector3(0, yRecBot - 0.02, 0.152),
      new THREE.Vector3(0, yRecBot - 0.008, 0.162),
    ];
    b.add(strip(pts, 0.0112, 0.0026), { surf: SURF.steel, bone: B.root, shade: wear(0.2, 0.15) });
    // 탄창 멈치 (탄창 뒤 주걱)
    b.add(bevelBox(0.0122, 0.0165, 0.0038, 0.0008), { surf: SURF.steel, bone: B.root, matrix: mat(0, yRecBot - 0.0085, zMagB + 0.0052, 0.32, 0, 0) });
  }
  const gripTop = new THREE.Vector3(0, yRecBot + 0.004, 0.176);
  const gripAng = 18 * DEG;
  const gripAxis = new THREE.Vector3(0, -Math.cos(gripAng), Math.sin(gripAng));   // 위 → 아래 (뒤로 기움)
  const gripLen = 0.118;
  {
    // 단면은 손잡이 축에 수직 (x = 폭, d = 앞뒤). 앞면에 완만한 손가락 굴곡, 아래 끝은 살짝 넓다
    const fwd = new THREE.Vector3(0, -Math.sin(gripAng), -Math.cos(gripAng));   // 단면의 '앞' 방향
    const rings = [];
    const N = 12;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const c = gripTop.clone().addScaledVector(gripAxis, gripLen * t);
      const fingers = 0.0012 * Math.sin(t * Math.PI * 3 + 0.4) * (t > 0.15 && t < 0.92 ? 1 : 0);
      const w = 0.0142 + 0.0018 * t;
      const d = 0.0198 + 0.0028 * t;
      const endK = t > 0.93 ? Math.cos((t - 0.93) / 0.07 * Math.PI / 2) ** 0.5 : 1;
      const pts = superEllipse(w * (0.6 + 0.4 * endK), d * (0.6 + 0.4 * endK), 22, 2.8).map(([x, y]) => [x, y > 0 ? y + fingers : y * 1.04]);
      rings.push(ring(pts, c.clone().addScaledVector(fwd, 0.0015 * t), X_AXIS, fwd));
    }
    // 손잡이 공간 = 축을 Z 로 본 좌표 (체커링이 옆면에 고르게) → UV 는 상자 투영 그대로
    b.add(loft(rings), { surf: S_GRIP, bone: B.root, uvScale: 15, uvOffset: [0.12, 0.6], shade: wear(0.1, 0.25), crease: 55 });
    // 손잡이 위 리시버 아래 받침 (손잡이 고정 나사 판)
    b.add(bevelBox(0.024, 0.006, 0.05, 0.001), { surf: SURF.steel, bone: B.root, matrix: mat(0, yRecBot - 0.001, 0.18) });
  }

  // ================= 개머리판 =================
  {
    const z0 = zRecB - 0.008, z1 = zButt - 0.008;
    const L = z1 - z0;
    const secs = [];
    const N = 16;
    for (let i = 0; i <= N; i++) {
      const t = i / N, z = z0 + L * t;
      // 윗선: 리시버 윗면에서 개머리판 끝(뒤꿈치)으로 곧게 내려감. 아랫선: 손목에서 잘록 → 끝(발끝)으로 크게 내려감
      const top = yRecT - 0.004 - 0.042 * t;
      const wrist = Math.exp(-(((t - 0.18) / 0.16) ** 2));
      const bot = yRecBot - 0.006 - 0.105 * Math.pow(t, 1.15) + 0.012 * wrist;
      const hw = 0.0172 + 0.0042 * t - 0.0018 * wrist;
      const endK = Math.min(1, t * 30);
      secs.push({ z, w: hw * (0.985 + 0.015 * endK), h: (top - bot) / 2, cy: (top + bot) / 2, p: 2.7 + 0.8 * t });
    }
    b.add(loftZ(secs, 28), { surf: S_WOOD, bone: B.root, uvScale: 4.5, uvOffset: [0.55, 0.05], shade: wear(0.1, 0.3), crease: 50 });
    // 개머리판 앞 쇠 테 (리시버와 맞물림)
    const s0 = secs[0];
    b.add(loftZ([
      { z: z0 - 0.003, w: s0.w + 0.0006, h: s0.h + 0.0006, cy: s0.cy, p: s0.p },
      { z: z0 + 0.004, w: s0.w + 0.0006, h: s0.h + 0.0006, cy: s0.cy, p: s0.p },
    ], 24), { surf: SURF.steel, bone: B.root });
    // 개머리판 끝 쇠판
    const se = secs[secs.length - 1];
    b.add(loftZ([
      { z: z1, w: se.w + 0.0004, h: se.h + 0.0004, cy: se.cy, p: se.p },
      { z: z1 + 0.0066, w: se.w + 0.0002, h: se.h + 0.0002, cy: se.cy, p: se.p },
      { z: z1 + 0.008, w: se.w - 0.0008, h: se.h - 0.0008, cy: se.cy, p: se.p },
    ], 24), { surf: SURF.steel, bone: B.root, shade: wear(0.2, 0.1) });
    // 아래 멜빵 고리
    b.add(new THREE.TorusGeometry(0.0072, 0.0015, 6, 14), { surf: SURF.steel, bone: B.root, matrix: mat(-0.0185, se.cy - se.h + 0.012, z1 - 0.03, 0, Math.PI / 2, 0) });
  }

  // ================= 조정간 (오른쪽 긴 지렛대, 뒤 축 회전) =================
  const selectorPivot = new THREE.Vector3(0.0188, -0.0615, 0.205);
  {
    // 지렛대 판: 축 원판 + 앞으로 뻗은 판 + 앞 끝 손가락 걸이 (축 기준 좌표로 만듦)
    b.add(cylX(0.0072, 0.0022, 16), { surf: SURF.steel, bone: B.selector, matrix: mat(0.0012, 0, 0), shade: wear(0.3) });
    const lever = loftZ([
      { z: -0.122, w: 0.0009, h: 0.0052, cy: 0.0175, cx: 0.0012, p: 6 },
      { z: -0.1, w: 0.0009, h: 0.0058, cy: 0.017, cx: 0.0012, p: 6 },
      { z: -0.04, w: 0.0009, h: 0.0062, cy: 0.0135, cx: 0.0012, p: 6 },
      { z: -0.004, w: 0.0009, h: 0.0068, cy: 0.004, cx: 0.0012, p: 6 },
    ], 14);
    b.add(lever, { surf: SURF.steel, bone: B.selector, shade: wear(0.35, 0.1) });
    b.add(bevelBox(0.0085, 0.0032, 0.0105, 0.0006), { surf: SURF.steel, bone: B.selector, matrix: mat(0.0055, 0.0195, -0.122, 0, 0, -0.25), shade: wear(0.4) });
  }

  // ================= 방아쇠 (축 기준) =================
  const triggerPivot = new THREE.Vector3(0, yRecBot + 0.0015, zTrig - 0.003);
  {
    const pts = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, -0.009, -0.002),
      new THREE.Vector3(0, -0.017, 0.0005),
      new THREE.Vector3(0, -0.0225, 0.0062),
    ];
    b.add(strip(pts, 0.0058, 0.0034), { surf: SURF.steel, bone: B.trigger, shade: wear(0.25, 0.1) });
  }

  // ================= 노리쇠 뭉치 + 장전 손잡이 (노리쇠 뼈 = 총 공간, Z 방향으로만 움직임) =================
  const chargeKnob = new THREE.Vector3(0.0425, -0.0428, 0.042);
  {
    // 배출구 안에 보이는 노리쇠 뭉치 옆면 + 덮개 아래 홈을 따라가는 손잡이 뿌리
    b.add(bevelBox(0.0016, 0.0128, 0.088, 0.0004), { surf: SURF.bright, bone: B.bolt, matrix: mat(0.0177, -0.0452, 0.08), tint: 0.85 });
    b.add(bevelBox(0.0062, 0.0074, 0.022, 0.0009), { surf: SURF.bright, bone: B.bolt, matrix: mat(0.0205, -0.0422, chargeKnob.z + 0.003) });
    // 손잡이 막대 (살짝 위로 꺾임) + 둥근 머리
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.021, -0.0422, chargeKnob.z + 0.002),
      new THREE.Vector3(0.031, -0.0425, chargeKnob.z + 0.0005),
      new THREE.Vector3(chargeKnob.x - 0.004, chargeKnob.y + 0.0006, chargeKnob.z),
    ]);
    b.add(new THREE.TubeGeometry(path, 8, 0.0033, 10), { surf: SURF.bright, bone: B.bolt });
    b.add(new THREE.SphereGeometry(0.0068, 14, 10), { surf: SURF.bright, bone: B.bolt, matrix: mat(chargeKnob.x, chargeKnob.y, chargeKnob.z, 0, 0, 0, 0.82, 0.92, 1.05), crease: 70 });
  }

  // ================= 탄창 (굽은 30발, 앞 윗모서리 = 걸쇠 축) =================
  const magPivot = new THREE.Vector3(0, yRecBot + 0.002, zMagF + 0.002);
  const magTop = new THREE.Vector3(0, yRecBot + 0.006, (zMagF + zMagB) / 2);
  const mag = buildMagazine(b, magTop.clone().sub(magPivot), B.mag);

  const geometry = b.build();

  // ---- 손 자리 (손목 관절 위치 + 손가락 방향 + 손바닥 법선) — 손 뼈 공간: 손목 원점, 손가락 −Z, 손등 +Y
  const frames = {};
  {
    // 오른손: 손바닥이 손잡이 오른쪽 면을 감싸고 손가락이 앞을 돌아 왼쪽으로. 검지는 방아쇠
    const mid = gripTop.clone().addScaledVector(gripAxis, 0.05);
    const f = new THREE.Vector3(0, -Math.sin(gripAng), -Math.cos(gripAng));
    frames.gripR = handFrame(mid.clone().add(new THREE.Vector3(0.0245, 0.0, 0)).addScaledVector(f, -0.057), f, new THREE.Vector3(-1, 0.08, 0));
    // 왼손: 아래 덮개를 밑에서 받치고 손가락이 오른쪽 면을 감아 올라감, 엄지는 왼쪽 면
    const gz = zHgF + (zRsF - zHgF) * 0.42;
    const fl = new THREE.Vector3(0.72, 0.06, -0.69).normalize();
    const mcpL = new THREE.Vector3(0.015, yB - 0.041, gz);
    frames.guardL = handFrame(mcpL.clone().addScaledVector(fl, -0.088), fl, new THREE.Vector3(0.28, 0.96, 0.0));
    // 왼손으로 탄창 잡기 (탄창 뼈 공간): 손바닥이 왼쪽 면, 손가락이 앞을 돌아 오른쪽 면, 엄지는 뒤 (멈치 쪽)
    const mm = mag.mid;
    frames.magL = handFrame(mm.clone().add(new THREE.Vector3(-0.034, 0.012, 0.05)), new THREE.Vector3(0.25, -0.18, -0.95).normalize(), new THREE.Vector3(0.96, 0.05, -0.1));
    // 오른손으로 장전 손잡이 잡기 (노리쇠 뼈 = 총 공간): 손바닥이 아래·왼쪽으로 손잡이 머리를 덮고 손가락이 앞쪽으로 감쌈
    frames.chargeR = handFrame(chargeKnob.clone().add(new THREE.Vector3(0.052, 0.03, 0.05)), new THREE.Vector3(-0.42, -0.45, -0.79).normalize(), new THREE.Vector3(-0.55, -0.82, 0.12));
  }

  return {
    geometry,
    points: {
      rearSight: new THREE.Vector3(0, 0, 0),
      frontSight: new THREE.Vector3(0, 0, zPost),
      muzzle: new THREE.Vector3(0, yB, zMz),
      ejection: new THREE.Vector3(0.019, -0.045, 0.072),
      selectorPivot, triggerPivot, magPivot, chargeKnob,
      gripTop, buttCenter: new THREE.Vector3(0, -0.14, zButt),
    },
    frames,
    dims: {
      sightRadius: R, sightHeight: H, boltTravel: 0.105, length: 0.88,
      selector: { auto: -10 * DEG, semi: -20 * DEG },
      magRockOut: 24 * DEG, triggerPull: 16 * DEG,
      magBottom: mag.bottom,
    },
  };
}

/** 손 자리: 손목 위치, 손가락 방향(−Z 손), 손바닥 법선(−Y 손) → { pos, quat } */
function handFrame(wrist, fingersDir, palmNormal) {
  const z = fingersDir.clone().normalize().negate();
  const y = palmNormal.clone().normalize().negate();
  y.addScaledVector(z, -y.dot(z)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  return { pos: wrist.clone(), quat: new THREE.Quaternion().setFromRotationMatrix(m) };
}

/**
 * 굽은 탄창 (탄창 뼈 공간: 원점 = 앞 걸쇠 축). 위 중심 top 에서 아래로 내려가며 앞(−Z)으로 휜다.
 * 옆면에 세로 보강 줄 2개, 아래 바닥판(앞 턱), 맨 위에 탄 한 발 (빼냈을 때 보인다).
 */
function buildMagazine(b, top, bone) {
  const Rc = 0.36;                  // 휜 반지름
  const L = 0.205;                  // 등뼈 길이
  const C = new THREE.Vector3(0, top.y, top.z - Rc);
  const spine = (s) => {
    const a = (s * L) / Rc;
    return {
      p: new THREE.Vector3(0, C.y - Rc * Math.sin(a), C.z + Rc * Math.cos(a)),
      d: new THREE.Vector3(0, Math.sin(a), -Math.cos(a)),     // 단면의 '앞' 방향
    };
  };
  const rings = [];
  const N = 16;
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const { p, d } = spine(s);
    const hw = 0.0132 + 0.0008 * s;
    const hd = 0.0285 + 0.0035 * s;
    const pts = superEllipse(hw, hd, 32, 3.6).map(([x, y]) => {
      // 옆면 세로 보강 줄 (앞뒤 두 줄)
      if (Math.abs(x) > hw * 0.8) {
        const rib = Math.exp(-(((y - 0.011) / 0.0042) ** 2)) + Math.exp(-(((y + 0.012) / 0.0042) ** 2));
        return [x + Math.sign(x) * 0.0011 * rib, y];
      }
      return [x, y];
    });
    rings.push(ring(pts, p, X_AXIS, d));
  }
  b.add(loft(rings), { surf: SURF.mag, bone, uvScale: 5, uvOffset: [0.2, 0.8], shade: (p, n) => 1 + 0.16 * Math.max(0, n.y) - 0.2 * Math.max(0, -n.y), crease: 40 });
  // 바닥판 (앞으로 턱이 나옴)
  const end = spine(1);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), end.d);
  const bottomFrame = new THREE.Matrix4().compose(end.p.clone().addScaledVector(new THREE.Vector3(0, -Math.cos(L / Rc), -Math.sin(L / Rc)), 0.002), q, new THREE.Vector3(1, 1, 1));
  b.add(bevelBox(0.031, 0.0055, 0.071, 0.0012).applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, -0.003)), { surf: SURF.mag, bone, matrix: bottomFrame, shade: (p, n) => 1 + 0.2 * Math.max(0, -n.y) });
  // 맨 위 탄 (탄피 + 탄두, 앞을 향해 누움)
  const tp = spine(0).p;
  b.add(cylZ(0.0051, 0.0056, 0.031, 10), { surf: SURF.brass, bone, matrix: mat(0, tp.y + 0.002, tp.z + 0.004) });
  b.add(new THREE.LatheGeometry(bulletProfile(), 10).applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2)), { surf: SURF.copper, bone, matrix: mat(0, tp.y + 0.002, tp.z - 0.0115) });
  // 탄창 윗부분 송탄 입술 (탄을 물고 있는 테)
  b.add(bevelBox(0.0275, 0.004, 0.05, 0.0006), { surf: SURF.mag, bone, matrix: mat(0, tp.y - 0.001, tp.z + 0.004), tint: 0.9 });
  return { mid: spine(0.38).p, bottom: end.p.clone() };
}

/** 탄두 외형 (Lathe 용 [반지름, 축]) — 축 +Y 가 탄두 끝 */
function bulletProfile() {
  const pts = [];
  const len = 0.0195, r = 0.0039;
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const y = t * len;
    const k = t < 0.35 ? 1 : Math.sqrt(Math.max(0, 1 - ((t - 0.35) / 0.65) ** 2));
    pts.push(new THREE.Vector2(Math.max(0.0002, r * k), y));
  }
  pts.unshift(new THREE.Vector2(0.0001, 0));
  return pts;
}

// ---------------------------------------------------------------
// 탄피 / 실탄 (배출용) — 축 −Z 가 탄피 입구 (약실에 있던 방향 그대로), 원점 = 바닥 테
// ---------------------------------------------------------------
export function buildCasing(live = false) {
  const b = new PartBuilder();
  // 7.62×39 탄피: 바닥 지름 11.35mm, 어깨 8.6mm → 목, 길이 38.6mm (Lathe: x = 반지름, y = 축)
  const prof = [
    [0.0001, 0], [0.0056, 0], [0.0057, 0.0012], [0.0049, 0.0016], [0.0049, 0.0026], [0.0056, 0.0032],
    [0.00515, 0.0305], [0.0046, 0.0325], [0.0044, 0.0386], [0.0039, 0.0386],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const lathe = new THREE.LatheGeometry(prof, 12).applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  b.add(lathe, { surf: SURF.brass, bone: 0, crease: 45, shade: (p, n) => 1 + 0.15 * Math.max(0, n.y) });
  if (live) {
    b.add(new THREE.LatheGeometry(bulletProfile(), 12).applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2)), { surf: SURF.copper, bone: 0, matrix: mat(0, 0, -0.0384), crease: 45 });
  } else {
    // 빈 탄피 입구 안쪽 그늘
    b.add(new THREE.CircleGeometry(0.0039, 10), { surf: SURF.hole, bone: 0, matrix: mat(0, 0, -0.0378, 0, Math.PI, 0) });
  }
  return b.build();
}

// ---------------------------------------------------------------
// 총구 화염 판 (화염 공간: 원점 = 총구, −Z = 총열 방향). UV: 텍스처 왼쪽 = 정면 별, 오른쪽 = 옆 불꽃
// 정점색 = 판별 밝기 (가산 혼합)
// ---------------------------------------------------------------
export function buildFlashGeometry() {
  const pos = [], uv = [], col = [];
  const quad = (p0, p1, p2, p3, uvr, c) => {
    const [u0, v0, u1, v1] = uvr;
    const P = [p0, p1, p2, p0, p2, p3];
    const U = [[u0, v0], [u1, v0], [u1, v1], [u0, v0], [u1, v1], [u0, v1]];
    for (let i = 0; i < 6; i++) { pos.push(...P[i]); uv.push(...U[i]); col.push(c, c, c); }
  };
  // 정면 별 두 장 (크기·회전이 달라 대칭이 깨짐)
  // 빗각 제퇴기는 가스를 위·오른쪽으로 뺀다 → 화염 중심이 총구보다 조금 위 (조준 중 가늠쇠를 순간 가림)
  for (const [s, z, rot, c, oy] of [[0.085, -0.03, 0, 1.0, 0.022], [0.15, -0.02, 0.5, 0.5, 0.03]]) {
    const pts = [[-s, -s], [s, -s], [s, s], [-s, s]].map(([x, y]) => [x * Math.cos(rot) - y * Math.sin(rot) + 0.006, x * Math.sin(rot) + y * Math.cos(rot) + oy, z]);
    // u 를 양쪽 4텍셀씩 안쪽으로 (별 중심 u 0.25 유지): 밉맵·선형 필터가 오른쪽 절반(옆 불꽃, 왼쪽 끝이 가장 밝음)을 정면 판 가장자리로 번지게 하지 않게
    quad(pts[0], pts[1], pts[2], pts[3], [0.008, 0, 0.492, 1], c);
  }
  // 옆 불꽃 세 장 (총열 축을 품고 60° 간격)
  const len = 0.19, w = 0.06;
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI;
    const ox = Math.cos(a) * w, oy = Math.sin(a) * w;
    quad([-ox, -oy, 0.004], [-ox, -oy, -len], [ox, oy, -len], [ox, oy, 0.004], [0.5, 0, 1, 1], 0.75);
  }
  // 옆 불꽃 UV: u 는 총구(0.5) → 끝(1). 위의 quad 는 (u0→u1) 를 p0→p1 에 매핑하므로 p0/p3 = 총구 쪽 ✓
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------
// 팔 (상완·하완 소매 + 손) — 뼈: 0 상완L, 1 하완L, 2 손L, 3 상완R, 4 하완R, 5 손R, 6 검지R
//  상완·하완 뼈 공간: 원점 = 어깨·팔꿈치 관절, 팔이 −Z 로 뻗음. 손 뼈 공간: 원점 = 손목, 손가락 −Z, 손등 +Y.
//  왼쪽은 오른쪽을 X 로 뒤집어 만든다 (손 뼈 공간에서는 엄지가 +X).
// ---------------------------------------------------------------
export const ARM_BONES = { upperL: 0, foreL: 1, handL: 2, upperR: 3, foreR: 4, handR: 5, indexR: 6 };
export const ARM_DIMS = { upper: 0.3, fore: 0.258, sleeveEnd: 0.012 };

/** 손 자세 (굽힘 °): [MCP, PIP, DIP, 벌림] — 벌림 + = 엄지 쪽 */
//  엄지: dir = 손허리뼈 방향, bend = 굽어 들어가는 쪽, flex = 마디별 굽힘 (°) — 모두 오른손 기준 손 공간
const POSE_GRIP_R = {
  index: [10, 52, 26, 22], middle: [86, 88, 30, 0], ring: [88, 86, 30, -4], little: [88, 82, 30, -8],
  thumb: { dir: [0.1, -0.57, -0.8], bend: [0.96, -0.13, 0.0], flex: [0, 30, 28] },
};
const POSE_CUP_L = {
  index: [52, 56, 24, 5], middle: [56, 58, 24, 0], ring: [58, 60, 24, -5], little: [62, 60, 24, -10],
  thumb: { dir: [-0.42, -0.21, -0.88], bend: [0.6, -0.37, -0.71], flex: [0, 10, 12] },
};

export function buildArms() {
  const b = new PartBuilder();
  const A = ARM_BONES;
  const sides = [
    { mirror: true, upper: A.upperL, fore: A.foreL, hand: A.handL, index: A.handL, pose: POSE_CUP_L, seed: 3 },
    { mirror: false, upper: A.upperR, fore: A.foreR, hand: A.handR, index: A.indexR, pose: POSE_GRIP_R, seed: 7 },
  ];
  let indexMcp = null;
  for (const s of sides) {
    buildSleeve(b, s, ARM_DIMS.upper, 0.057, 0.05, false);
    buildSleeve(b, s, ARM_DIMS.fore, 0.047, 0.04, true);
    const mcp = buildHand(b, s);
    if (!s.mirror) indexMcp = mcp;
  }
  return { geometry: b.build(), indexMcp };
}

/** 소매 (천 주름, 끝단 소맷부리). fore = 하완 (소맷부리·팔꿈치 주름) */
function buildSleeve(b, s, len, r0, r1, fore) {
  const seg = 18, rows = 14;
  const pos = [], uv = [], idx = [];
  const end = fore ? len - ARM_DIMS.sleeveEnd : len;
  const z0 = fore ? 0.02 : -0.04;   // 하완 소매는 팔꿈치 구 안쪽에서 시작, 상완은 어깨 뒤쪽까지
  const ph = s.seed * 1.7;
  for (let j = 0; j <= rows; j++) {
    const t = j / rows;
    const z = -(z0 + (end - z0) * t);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      // 주름: 비스듬한 접힘 + 소맷부리 위로 뭉친 주름
      let r = r0 + (r1 - r0) * t;
      r *= 1 + 0.045 * Math.sin(a * 3 + t * 9 + ph) * Math.sin(t * Math.PI) + 0.025 * Math.sin(a * 5 - t * 17 + ph * 2);
      if (fore) r *= 1 + 0.06 * Math.exp(-(((t - 0.8) / 0.08) ** 2)) * (0.6 + 0.4 * Math.sin(a * 4 + ph));
      // 아래로 처지는 천 (팔의 아래쪽(−Y)이 조금 더 늘어짐)
      const sag = 1 + 0.06 * Math.max(0, -Math.sin(a));
      pos.push(Math.cos(a) * r, Math.sin(a) * r * sag, z);
      uv.push((i / seg) * 2 * Math.PI * r0 * 10, -z * 10);
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i, c = a + seg + 1;
      idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  fixWinding(g, (p) => new THREE.Vector3(0, 0, p.z));   // 소매 축 = Z
  const bone = fore ? s.fore : s.upper;
  b.add(g, { surf: SURF.fabric, bone, uv: 'keep', uvScale: 1, uvOffset: [s.seed * 0.13, s.seed * 0.29], mirrorX: s.mirror, crease: 70, shade: (p, n) => 0.82 + 0.18 * Math.max(0, n.y) + 0.06 * Math.sin(p.z * 60 + s.seed) });
  if (fore) {
    // 소맷부리 (두꺼운 단 + 단추) + 안쪽 그늘 고리
    const zc = -end;
    b.add(loftZ([
      { z: zc + 0.034, w: r1 * 1.02, h: r1 * 1.02, p: 2 },
      { z: zc + 0.03, w: r1 * 1.1, h: r1 * 1.1, p: 2 },
      { z: zc + 0.003, w: r1 * 1.1, h: r1 * 1.1, p: 2 },
      { z: zc, w: r1 * 1.04, h: r1 * 1.04, p: 2 },
    ], 18, [false, false]), { surf: SURF.cuff, bone, mirrorX: s.mirror, uvScale: 10, crease: 60 });
    const inner = new THREE.RingGeometry(0.023, r1 * 1.05, 18, 1);
    b.add(inner, { surf: SURF.inner, bone, matrix: mat(0, 0, zc - 0.0005, Math.PI, 0, 0), mirrorX: s.mirror });
    b.add(cylY(0.0042, 0.0042, 0.0022, 10), { surf: SURF.bright, bone, matrix: mat(0, r1 * 1.1 + 0.0006, zc + 0.016), tint: [0.5, 0.48, 0.4] });
    // 손목 (하완 뼈에 붙음 — 손을 꺾어도 소맷부리 밖으로 삐져나오지 않음) + 관절 공 (손과 이음매를 메움)
    const skinShade = (p, n) => 0.82 + 0.12 * Math.max(0, n.y);
    b.add(cylZ(0.0232, 0.0262, 0.05, 14, true), { surf: SURF.skin, bone, matrix: mat(0, 0.0005, -len + 0.025), mirrorX: s.mirror, uvScale: 30, crease: 60, shade: skinShade });
    b.add(new THREE.SphereGeometry(0.0236, 14, 10), { surf: SURF.skin, bone, matrix: mat(0, 0.0005, -len, 0, 0, 0, 1, 0.82, 1), mirrorX: s.mirror, uvScale: 30, crease: 70, shade: skinShade });
  } else {
    // 팔꿈치 (상완 끝에 둥근 천 뭉치)
    b.add(new THREE.SphereGeometry(0.05, 14, 10), { surf: SURF.fabric, bone: s.upper, matrix: mat(0, -0.004, -len, 0, 0, 0, 1, 1, 1.05), uvScale: 10, mirrorX: s.mirror, shade: (p, n) => 0.8 + 0.2 * Math.max(0, n.y) });
  }
}

/** 색인 지오메트리의 삼각형이 바깥(axisPoint(p) 로부터 멀어지는 쪽)을 향하게 맞춘다 */
function fixWinding(g, axisPoint) {
  const p = g.attributes.position, idx = g.index.array;
  const a = new THREE.Vector3(), b2 = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    a.fromBufferAttribute(p, idx[t]); b2.fromBufferAttribute(p, idx[t + 1]); c.fromBufferAttribute(p, idx[t + 2]);
    n.subVectors(b2, a).cross(m.subVectors(c, a));
    m.copy(a).add(b2).add(c).multiplyScalar(1 / 3);
    const out = m.clone().sub(axisPoint(m));
    if (n.dot(out) < 0) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
  }
}

/** 손가락 마디 행렬: 캡슐 축(Y) = 마디 방향, 옆(X) = lateral (손가락의 굽힘 축), 손등 쪽으로 납작 (sx 옆 배율, sz 두께 배율) */
function phalanxMatrix(mid, dir, lateral, sx, sz) {
  const x = lateral.clone();
  x.addScaledVector(dir, -x.dot(dir)).normalize();
  const z = new THREE.Vector3().crossVectors(x, dir);
  const m = new THREE.Matrix4().makeBasis(x.multiplyScalar(sx), dir.clone(), z.multiplyScalar(sz));
  return m.setPosition(mid);
}

/**
 * 손 (오른손 기준으로 만들고 s.mirror 면 X 반전). 손 뼈 공간: 손목 원점, 손가락 −Z, 손등 +Y, 엄지 −X.
 * 검지는 s.index 뼈 (원점 = 검지 MCP, 축 방향은 손과 같음) — 방아쇠 당김에 따로 굽힌다.
 * 반환: 손 공간의 검지 MCP 위치
 */
function buildHand(b, s) {
  const skin = SURF.skin;
  const add = (geo, bone, m, o = {}) => b.add(geo, { surf: o.surf || skin, bone, matrix: m, mirrorX: s.mirror, crease: o.crease ?? 60, uvScale: 30, uvOffset: [s.seed * 0.07, 0.3], tint: o.tint ?? 1, shade: o.shade || ((p, n) => 0.9 + 0.12 * Math.max(0, n.y)) });
  // 피부 색 변화: 마디·손가락 끝은 피가 몰려 붉고, 끝마디는 조금 더 어둡다 (햇볕·때)
  const TINT_KNUCKLE = [1.06, 0.9, 0.86], TINT_TIP = [1.0, 0.9, 0.86], TINT_MID = [1.02, 0.95, 0.92];
  // 손바닥 (손목 → 손가락 뿌리, 엄지 쪽이 두툼)
  b.add(loftZ([
    { z: 0.008, w: 0.0225, h: 0.0185, cy: 0.001, p: 2.2 },
    { z: -0.006, w: 0.0285, h: 0.0175, cy: 0.0, p: 2.4 },
    { z: -0.03, w: 0.0375, h: 0.0165, cy: -0.001, cx: -0.001, p: 2.8 },
    { z: -0.062, w: 0.0425, h: 0.0145, cy: -0.001, p: 3.0 },
    { z: -0.084, w: 0.042, h: 0.0115, cy: 0.0, p: 3.0 },
    { z: -0.09, w: 0.038, h: 0.0085, cy: 0.0, p: 2.6 },
  ], 22), { surf: skin, bone: s.hand, mirrorX: s.mirror, crease: 70, uvScale: 30, shade: (p, n) => 0.88 + 0.14 * Math.max(0, n.y) });
  // 엄지 두덩
  add(new THREE.SphereGeometry(1, 12, 8), s.hand, mat(-0.021, -0.0075, -0.03, 0, 0.35, 0, 0.016, 0.0135, 0.029));
  // 손가락: [이름, MCP 위치(x, z), 마디 길이 3개, 반지름]
  const fingers = [
    ['index', -0.0265, -0.087, [0.04, 0.024, 0.016], 0.0084],
    ['middle', -0.0085, -0.09, [0.043, 0.026, 0.017], 0.0087],
    ['ring', 0.0095, -0.087, [0.04, 0.025, 0.017], 0.0081],
    ['little', 0.0255, -0.08, [0.032, 0.019, 0.015], 0.0072],
  ];
  const pose = s.pose;
  let indexMcp = null;
  for (const [name, x, z, lens, r] of fingers) {
    const [mcp, pip, dip, spread] = pose[name];
    const isIndex = name === 'index' && s.index !== s.hand;
    const origin = new THREE.Vector3(x, -0.001, z);
    if (name === 'index') indexMcp = origin.clone();
    // 검지가 따로면 검지 뼈 공간(원점 = MCP)에서 만든다
    const base = isIndex ? new THREE.Vector3() : origin.clone();
    const bone = isIndex ? s.index : s.hand;
    const q = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, spread * DEG);
    let p = base.clone();
    const flex = [mcp, pip, dip];
    for (let k = 0; k < 3; k++) {
      q.multiply(new THREE.Quaternion().setFromAxisAngle(X_AXIS, -flex[k] * DEG));
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      const next = p.clone().addScaledVector(dir, lens[k]);
      const rr = r * (1 - k * 0.11);
      const mid = p.clone().add(next).multiplyScalar(0.5);
      add(new THREE.CapsuleGeometry(rr, lens[k], 3, 9), bone, phalanxMatrix(mid, dir, new THREE.Vector3(1, 0, 0).applyQuaternion(q), 1.06, 0.86), { crease: 75, tint: k === 2 ? TINT_TIP : k === 1 ? TINT_MID : 1 });
      // 손톱 (끝마디 손등 쪽)
      if (k === 2) {
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
        const nm = new THREE.Matrix4().compose(mid.clone().addScaledVector(dir, lens[k] * 0.18).addScaledVector(up, rr * 0.82), new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0).applyQuaternion(q), up, dir.clone().negate())), new THREE.Vector3(1, 1, 1));
        add(bevelBox(rr * 1.45, 0.0016, lens[k] * 0.62, 0.0006), bone, nm, { surf: SURF.nail, crease: 40 });
      }
      p = next;
    }
    // 손등 관절 마디 (MCP 위 볼록)
    add(new THREE.SphereGeometry(r * 1.05, 10, 7), s.hand, mat(origin.x, origin.y + 0.0045, origin.z + 0.002, 0, 0, 0, 1, 0.8, 1), { tint: TINT_KNUCKLE });
  }
  // 엄지 (CMC → 손허리뼈 → 첫마디 → 끝마디): dir 방향에서 bend 쪽으로 마디마다 굽힘
  {
    const t = pose.thumb;
    const d = new THREE.Vector3(...t.dir).normalize();
    const bend = new THREE.Vector3(...t.bend).normalize();
    const axis = new THREE.Vector3().crossVectors(d, bend).normalize();   // d 를 이 축으로 + 회전 = bend 쪽
    let p = new THREE.Vector3(-0.021, -0.007, -0.014);
    const lens = [0.042, 0.03, 0.022], rs = [0.0122, 0.0102, 0.0092];
    for (let k = 0; k < 3; k++) {
      if (t.flex[k]) d.applyAxisAngle(axis, t.flex[k] * DEG);
      const next = p.clone().addScaledVector(d, lens[k]);
      const mid = p.clone().add(next).multiplyScalar(0.5);
      add(new THREE.CapsuleGeometry(rs[k], lens[k], 3, 9), s.hand, phalanxMatrix(mid, d, axis, 1.05, 0.88), { crease: 75 });
      if (k === 2) {
        // 손톱: 굽는 쪽의 반대(손등 쪽)
        const up = bend.clone().addScaledVector(d, -bend.dot(d)).normalize().negate();
        const side = new THREE.Vector3().crossVectors(up, d).normalize();
        const nm = new THREE.Matrix4().makeBasis(side, up, d.clone().negate()).setPosition(mid.clone().addScaledVector(d, lens[k] * 0.15).addScaledVector(up, rs[k] * 0.8));
        add(bevelBox(rs[k] * 1.4, 0.0016, lens[k] * 0.6, 0.0006), s.hand, nm, { surf: SURF.nail, crease: 40 });
      }
      p = next;
    }
  }
  return indexMcp;
}
