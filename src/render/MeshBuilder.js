// 절차적 지오메트리 조립 도우미 (위치·법선·UV·정점색)
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

export class MeshBuilder {
  constructor() {
    this.pos = []; this.nor = []; this.uv = []; this.col = []; this.idx = [];
  }

  get count() { return this.pos.length / 3; }

  vertex(px, py, pz, nx, ny, nz, u, v, r, g, b) {
    this.pos.push(px, py, pz);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    return this.count - 1;
  }

  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }

  /** 다른 지오메트리를 변환해 붙임 */
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

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * 곡선을 따라가는 굵기 변화 튜브.
 * @param {THREE.Vector3[]} pts  중심선
 * @param {(t:number)=>number} radius
 * @param {(t:number, a:number)=>number[]} color  rgb
 */
export function tube(mb, pts, radius, radial, color, uvRepeat = [1, 1], capEnd = false) {
  const n = pts.length;
  const tangents = [], normals = [], binormals = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    tangents.push(new THREE.Vector3().subVectors(b, a).normalize());
  }
  // 평행 이동 프레임
  let ref = Math.abs(tangents[0].y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  let nrm = new THREE.Vector3().crossVectors(tangents[0], ref).normalize();
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
    const r = radius(t);
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2;
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
}

/**
 * 잎 띠 (야자·고사리·바나나 잎 등): 위로 솟았다가 처지는 곡선.
 * @param {object} o {origin, yaw, pitch, length, width, segs, droop, region, color:[r,g,b], fold, twist}
 */
export function leafStrip(mb, o) {
  const { origin, yaw, pitch, length, width, segs = 5, droop = 0.4, region, color, fold = 0, taperBase = 0.2 } = o;
  const dirH = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
  const side = new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw));
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const base = mb.count;
  let prev = origin.clone();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const along = length * t;
    const p = new THREE.Vector3(
      origin.x + dirH.x * cp * along,
      origin.y + sp * along - droop * length * t * t,
      origin.z + dirH.z * cp * along,
    );
    const tan = i === 0 ? new THREE.Vector3(dirH.x * cp, sp, dirH.z * cp) : p.clone().sub(prev).normalize();
    prev = p;
    const nrm = new THREE.Vector3().crossVectors(side, tan).normalize();
    if (nrm.y < 0) nrm.negate();
    const w = width * (taperBase + (1 - taperBase) * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.95)));
    const v = region.v0 + (region.v1 - region.v0) * t;
    const lift = fold * w;
    const c = color;
    mb.vertex(p.x - side.x * w * 0.5, p.y + lift, p.z - side.z * w * 0.5, nrm.x, nrm.y, nrm.z, region.u0, v, c[0], c[1], c[2]);
    mb.vertex(p.x + side.x * w * 0.5, p.y + lift, p.z + side.z * w * 0.5, nrm.x, nrm.y, nrm.z, region.u1, v, c[0], c[1], c[2]);
    // 가운데 (접힘)
    if (i > 0) {
      const a = base + (i - 1) * 2, b = base + i * 2;
      mb.quad(a, b, b + 1, a + 1);
    }
  }
}

/** 사각 카드 (중심 기준, 법선 방향으로 향함) */
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

/** sRGB 색 → 선형 rgb 배열 */
export function srgb(hex, mul = 1) {
  const c = new THREE.Color(hex);
  return [c.r * mul, c.g * mul, c.b * mul];
}
