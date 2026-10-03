// 절차적 지오메트리 조립 도우미 (위치·법선·UV·정점색 + 사용자 속성)
//  사용자 속성: new MeshBuilder({ aWind: 3 }) 로 등록하고, mb.set('aWind', sway, flutter, phase) 로
//  '현재 값'을 바꾸면 이후 추가되는 정점에 그 값이 들어간다.
//  aWind = (가지 흔들림 진폭 m, 잎 떨림 진폭 m, 위상 0~1) — Materials.patchFoliage 가 사용
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

export class MeshBuilder {
  constructor(extra = {}) {
    this.pos = []; this.nor = []; this.uv = []; this.col = []; this.idx = [];
    this.extra = {};
    this.state = {};
    for (const [name, size] of Object.entries(extra)) this.addAttr(name, size);
  }

  addAttr(name, size) {
    this.extra[name] = { size, data: [] };
    this.state[name] = new Array(size).fill(0);
    // 이미 있는 정점은 0으로 채움
    for (let i = 0; i < this.count; i++) for (let k = 0; k < size; k++) this.extra[name].data.push(0);
    return this;
  }

  set(name, ...values) {
    const s = this.state[name];
    for (let k = 0; k < s.length; k++) s[k] = values[k] ?? 0;
    return this;
  }

  get count() { return this.pos.length / 3; }

  vertex(px, py, pz, nx, ny, nz, u, v, r, g, b) {
    this.pos.push(px, py, pz);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    for (const name in this.extra) {
      const e = this.extra[name], s = this.state[name];
      for (let k = 0; k < e.size; k++) e.data.push(s[k]);
    }
    return this.count - 1;
  }

  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }

  /** 다른 지오메트리를 변환해 붙임 (colorFn(local, world, normal) → [r,g,b]) */
  addGeometry(geo, matrix, colorFn) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
    const nm = new THREE.Matrix3().getNormalMatrix(matrix);
    const base = this.count;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i);
      const local = _v.clone();
      _v.applyMatrix4(matrix);
      _n.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      const c = colorFn ? colorFn(local, _v, _n) : [1, 1, 1];
      this.vertex(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0, c[0], c[1], c[2]);
    }
    for (let i = 0; i < p.count; i += 3) this.idx.push(base + i, base + i + 1, base + i + 2);
  }

  /** 다른 빌더의 내용을 그대로 이어 붙임 (속성 이름이 같아야 함) */
  append(other) {
    const base = this.count;
    const cat = (dst, src) => { for (let i = 0; i < src.length; i++) dst.push(src[i]); };
    cat(this.pos, other.pos); cat(this.nor, other.nor); cat(this.uv, other.uv); cat(this.col, other.col);
    for (const name in this.extra) {
      const src = other.extra[name];
      if (src) cat(this.extra[name].data, src.data);
      else for (let i = 0; i < other.count * this.extra[name].size; i++) this.extra[name].data.push(0);
    }
    for (const i of other.idx) this.idx.push(base + i);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    for (const name in this.extra) {
      const e = this.extra[name];
      g.setAttribute(name, new THREE.Float32BufferAttribute(e.data, e.size));
    }
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * 곡선을 따라가는 굵기 변화 튜브.
 * @param {THREE.Vector3[]} pts  중심선
 * @param {(t:number, a:number)=>number} radius  t: 0~1 길이 비율, a: 둘레 각
 * @param {(t:number, a:number)=>number[]} color  rgb
 * @param {(t:number)=>void} [onRing]  고리마다 호출 (사용자 속성 갱신용)
 */
export function tube(mb, pts, radius, radial, color, uvRepeat = [1, 1], capEnd = false, onRing = null) {
  const n = pts.length;
  const tangents = [], normals = [], binormals = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    tangents.push(new THREE.Vector3().subVectors(b, a).normalize());
  }
  // 평행 이동 프레임
  const ref = Math.abs(tangents[0].y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const nrm = new THREE.Vector3().crossVectors(tangents[0], ref).normalize();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const axis = new THREE.Vector3().crossVectors(tangents[i - 1], tangents[i]);
      const len = axis.length();
      if (len > 1e-6) {
        const ang = Math.acos(THREE.MathUtils.clamp(tangents[i - 1].dot(tangents[i]), -1, 1));
        nrm.applyAxisAngle(axis.divideScalar(len), ang);
      }
    }
    normals.push(nrm.clone());
    binormals.push(new THREE.Vector3().crossVectors(tangents[i], nrm).normalize());
  }
  let total = 0;
  const lens = [0];
  for (let i = 1; i < n; i++) { total += pts[i].distanceTo(pts[i - 1]); lens.push(total); }
  const base = mb.count;
  for (let i = 0; i < n; i++) {
    const t = lens[i] / (total || 1);
    if (onRing) onRing(t, pts[i]);
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const r = radius(t, a);
      const cx = Math.cos(a), sx = Math.sin(a);
      const nx = normals[i].x * cx + binormals[i].x * sx;
      const ny = normals[i].y * cx + binormals[i].y * sx;
      const nz = normals[i].z * cx + binormals[i].z * sx;
      const c = color(t, a);
      mb.vertex(pts[i].x + nx * r, pts[i].y + ny * r, pts[i].z + nz * r, nx, ny, nz,
        (k / radial) * uvRepeat[0], lens[i] * uvRepeat[1], c[0], c[1], c[2]);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const a = base + i * (radial + 1) + k, b = a + radial + 1;
      mb.quad(a, b, b + 1, a + 1);
    }
  }
  if (capEnd) {
    const last = pts[n - 1], t = tangents[n - 1];
    const c = color(1, 0);
    const center = mb.vertex(last.x, last.y, last.z, t.x, t.y, t.z, 0.5, 0.5, c[0], c[1], c[2]);
    const ring = base + (n - 1) * (radial + 1);
    for (let k = 0; k < radial; k++) mb.tri(ring + k, ring + k + 1, center);
  }
  return { base, rings: n, radial };
}

/**
 * 잎 띠 (야자·고사리·바나나 잎 등): 위로 솟았다가 처지는 곡선.
 * @param {object} o {origin, yaw, pitch, length, width, segs, droop, region, color:[r,g,b], fold, taperBase, onSeg}
 */
export function leafStrip(mb, o) {
  const { origin, yaw, pitch, length, width, segs = 5, droop = 0.4, region, color, fold = 0, taperBase = 0.2, onSeg = null, curl = 0 } = o;
  const dirH = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
  const side = new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw));
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const base = mb.count;
  let prev = origin.clone();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const along = length * t;
    const p = new THREE.Vector3(
      origin.x + dirH.x * cp * along + side.x * curl * along * t,
      origin.y + sp * along - droop * length * t * t,
      origin.z + dirH.z * cp * along + side.z * curl * along * t,
    );
    const tan = i === 0 ? new THREE.Vector3(dirH.x * cp, sp, dirH.z * cp) : p.clone().sub(prev).normalize();
    prev = p;
    const nrm = new THREE.Vector3().crossVectors(side, tan).normalize();
    if (nrm.y < 0) nrm.negate();
    const w = width * (taperBase + (1 - taperBase) * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.95)));
    const v = region.v0 + (region.v1 - region.v0) * t;
    const lift = fold * w;
    const c = color;
    if (onSeg) onSeg(t);
    mb.vertex(p.x - side.x * w * 0.5, p.y + lift, p.z - side.z * w * 0.5, nrm.x, nrm.y, nrm.z, region.u0, v, c[0], c[1], c[2]);
    mb.vertex(p.x + side.x * w * 0.5, p.y + lift, p.z + side.z * w * 0.5, nrm.x, nrm.y, nrm.z, region.u1, v, c[0], c[1], c[2]);
    if (i > 0) {
      const a = base + (i - 1) * 2, b = base + i * 2;
      mb.quad(a, b, b + 1, a + 1);
    }
  }
}

/** 사각 카드 (중심 기준). nrm 을 주면 조명용 법선을 그 방향으로 (수관 덩어리의 둥근 음영) */
export function card(mb, center, right, up, region, color, nrm) {
  const n = nrm || new THREE.Vector3().crossVectors(right, up).normalize();
  const c = color;
  const p0 = center.clone().sub(right).sub(up), p1 = center.clone().add(right).sub(up);
  const p2 = center.clone().add(right).add(up), p3 = center.clone().sub(right).add(up);
  const a = mb.vertex(p0.x, p0.y, p0.z, n.x, n.y, n.z, region.u0, region.v0, c[0], c[1], c[2]);
  const b = mb.vertex(p1.x, p1.y, p1.z, n.x, n.y, n.z, region.u1, region.v0, c[0], c[1], c[2]);
  const cc = mb.vertex(p2.x, p2.y, p2.z, n.x, n.y, n.z, region.u1, region.v1, c[0], c[1], c[2]);
  const d = mb.vertex(p3.x, p3.y, p3.z, n.x, n.y, n.z, region.u0, region.v1, c[0], c[1], c[2]);
  mb.quad(a, b, cc, d);
}

/**
 * 잎 덩어리: 서로 교차하는 세로 카드 2장 (+ planes ≥ 3 이면 수평에 가까운 카드 1장 — 아래에서 올려다봐도 빈틈이 적음).
 * 정점 법선은 덩어리 중심 → 꼭짓점 방향과 바깥 방향(out)을 섞어 둥근 음영을 만든다.
 * @param {THREE.Vector3} c 중심, size 반지름(m), out: 덩어리 바깥 방향(수관 중심 → 덩어리)
 */
export function leafCluster(mb, c, size, region, color, out, rng, planes = 2, aspect = 1, lean = 0.6) {
  const outN = out.lengthSq() > 1e-8 ? out.clone().normalize() : new THREE.Vector3(0, 1, 0);
  const outH = new THREE.Vector3(outN.x, 0, outN.z);
  if (outH.lengthSq() > 1e-6) outH.normalize();
  const yaw0 = rng.range(0, Math.PI);
  const quads = [];
  const nv = Math.min(2, planes);
  for (let k = 0; k < nv; k++) {
    const yaw = yaw0 + (k / nv) * Math.PI + rng.range(-0.25, 0.25);
    const right = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    // 가지 끝이 바깥쪽으로 기울어 자라도록 (모두 위를 향하면 침엽수처럼 보임) + 무작위 기울기
    const up = new THREE.Vector3(rng.range(-0.3, 0.3), 1, rng.range(-0.3, 0.3)).addScaledVector(outH, lean * rng.range(0.4, 1.4));
    up.addScaledVector(right, -up.dot(right)).normalize();
    quads.push([right.multiplyScalar(size), up.multiplyScalar(size * aspect)]);
  }
  if (planes >= 3) {
    const yaw = rng.range(0, Math.PI * 2), tilt = rng.range(-0.3, 0.3);
    quads.push([
      new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw)).multiplyScalar(size),
      new THREE.Vector3(-Math.sin(yaw), Math.sin(tilt), Math.cos(yaw)).normalize().multiplyScalar(size * aspect),
    ]);
  }
  const uvs = [[region.u0, region.v0], [region.u1, region.v0], [region.u1, region.v1], [region.u0, region.v1]];
  for (const [right, up] of quads) {
    const p = [
      c.clone().sub(right).sub(up), c.clone().add(right).sub(up),
      c.clone().add(right).add(up), c.clone().sub(right).add(up),
    ];
    const ids = p.map((q, i) => {
      const d = q.clone().sub(c).normalize();
      const n = d.multiplyScalar(0.55).add(outN.clone().multiplyScalar(0.8)).normalize();
      return mb.vertex(q.x, q.y, q.z, n.x, n.y, n.z, uvs[i][0], uvs[i][1], color[0], color[1], color[2]);
    });
    mb.quad(ids[0], ids[1], ids[2], ids[3]);
  }
}

/** sRGB 색 → 선형 rgb 배열 */
export function srgb(hex, mul = 1) {
  const c = new THREE.Color(hex);
  return [c.r * mul, c.g * mul, c.b * mul];
}
