// 물 표면 (개울·늪·강: 수위 격자에서 생성 / 논: 칸별 사각형) + 논둑 메시
import * as THREE from 'three';
import { NO_WATER } from './WorldGen.js';
import { addPatch, patchCanopy, shared } from '../render/Materials.js';
import { riverCenterZ, LAYOUT } from './MapLayout.js';

// 탁한 황갈색·녹색 (종류별)
const KIND_COLOR = {
  1: '#6a5a34',  // 개울: 탁한 황갈색
  2: '#3b3b20',  // 늪: 어두운 녹갈색
  3: '#5c5c36',  // 논
  4: '#6e5c38',  // 강
};
// 종류별 [거칠기, 불투명해지는 깊이(m), 최소 불투명도] — 늪은 부유물로 둔하고, 얕은 곳은 진흙이 드러남
const KIND_PARAM = { 1: [0.1, 0.3, 0.3], 2: [0.32, 0.5, 0.0], 3: [0.08, 0.3, 0.3], 4: [0.12, 0.4, 0.3] };

export function createWaterMaterial(noiseTex) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, transparent: true, roughness: 0.1, metalness: 0.0,
    depthWrite: false, envMapIntensity: 0.4,
  });
  addPatch(mat, 'water', (shader) => {
    shader.uniforms.uNoise = { value: noiseTex };
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uRain = shared.uRain;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aDepth;\nattribute vec3 aWater;\nvarying float vDepth;\nvarying vec3 vWater;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vDepth = aDepth;\n  vWater = aWater;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uNoise;
uniform float uTime;
uniform float uRain;
varying float vDepth;
varying vec3 vWater;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  gClassColor = vec4( 0.0, 1.0, 1.0, 1.0 );   // 검증용 분류: 물
  // 탁한 물: 얕은 가장자리만 살짝 비침
  diffuseColor.a = mix( vWater.z, 0.93, smoothstep( vWater.z > 0.05 ? 0.0 : 0.06, vWater.y, vDepth ) );`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = vWater.x;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  {
    vec2 wxz = vPatchWorld.xz;
    vec2 n1 = texture2D( uNoise, wxz * 0.09 + vec2( uTime * 0.012, uTime * 0.007 ) ).rg - 0.5;
    vec2 n2 = texture2D( uNoise, wxz * 0.23 - vec2( uTime * 0.02, -uTime * 0.013 ) ).gb - 0.5;
    vec2 n3 = texture2D( uNoise, wxz * 1.7 + vec2( uTime * 0.9, uTime * 0.6 ) ).ba - 0.5; // 빗방울
    vec2 slope = n1 * 0.12 + n2 * 0.08 + n3 * 0.35 * uRain;
    vec3 nW = normalize( vec3( -slope.x, 1.0, -slope.y ) );
    normal = normalize( ( viewMatrix * vec4( nW, 0.0 ) ).xyz );
  }`);
  });
  patchCanopy(mat, { sun: 1, sky: 0.8 });
  return mat;
}

/** 수위 격자 → 물 메시 (청크 분할) */
export function buildWater(data, material) {
  const { half, sN, sRes, hN, hRes } = data;
  const n = hN;
  const level = new Float32Array(n * n).fill(NO_WATER);
  const kindAt = new Uint8Array(n * n);
  // 정점 = 주변 4개 지면 셀 중 물이 있는 셀의 최고 수위 (논 제외)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let best = NO_WATER, kind = 0;
      const ci = Math.round((i * hRes) / sRes), cj = Math.round((j * hRes) / sRes);
      for (let dj = -1; dj <= 0; dj++) {
        for (let di = -1; di <= 0; di++) {
          const a = ci + di, b = cj + dj;
          if (a < 0 || b < 0 || a >= sN || b >= sN) continue;
          const c = b * sN + a;
          if (data.waterKind[c] === 3 || data.waterKind[c] === 0) continue;
          if (data.waterLevel[c] > best) { best = data.waterLevel[c]; kind = data.waterKind[c]; }
        }
      }
      level[j * n + i] = best;
      kindAt[j * n + i] = kind;
    }
  }
  // 물가 바깥 한 칸 확장 (지형과 교차해 가장자리가 자연스럽게)
  const filled = level.slice();
  const fkind = kindAt.slice();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (level[k] !== NO_WATER) continue;
      let best = NO_WATER, kind = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const a = i + di, b = j + dj;
          if (a < 0 || b < 0 || a >= n || b >= n) continue;
          if (level[b * n + a] > best) { best = level[b * n + a]; kind = kindAt[b * n + a]; }
        }
      }
      filled[k] = best;
      fkind[k] = kind;
    }
  }

  const group = new THREE.Group();
  group.name = 'water';
  const CH = 50;
  const colors = {};
  for (const [k, hex] of Object.entries(KIND_COLOR)) colors[k] = new THREE.Color(hex);
  for (let cj = 0; cj < n - 1; cj += CH) {
    for (let ci = 0; ci < n - 1; ci += CH) {
      const pos = [], col = [], dep = [], idx = [], wp = [];
      const map = new Map();
      const vtx = (i, j) => {
        const k = j * n + i;
        let v = map.get(k);
        if (v !== undefined) return v;
        v = pos.length / 3;
        const x = -half + i * hRes, z = -half + j * hRes;
        const lv = filled[k];
        pos.push(x, lv, z);
        const c = colors[fkind[k]] || colors[1];
        col.push(c.r, c.g, c.b);
        wp.push(...(KIND_PARAM[fkind[k]] || KIND_PARAM[1]));
        dep.push(Math.max(0, lv - data.height[k]));
        map.set(k, v);
        return v;
      };
      for (let j = cj; j < Math.min(cj + CH, n - 1); j++) {
        for (let i = ci; i < Math.min(ci + CH, n - 1); i++) {
          const ks = [j * n + i, j * n + i + 1, (j + 1) * n + i, (j + 1) * n + i + 1];
          if (ks.some((k) => filled[k] === NO_WATER)) continue;
          if (!ks.some((k) => level[k] !== NO_WATER)) continue;
          // 높이 차가 큰 경계(다른 수면끼리)는 생략
          const lv = ks.map((k) => filled[k]);
          if (Math.max(...lv) - Math.min(...lv) > 0.6) continue;
          const a = vtx(i, j), b = vtx(i + 1, j), c = vtx(i, j + 1), d = vtx(i + 1, j + 1);
          idx.push(a, c, b, b, c, d);
        }
      }
      if (!idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('aDepth', new THREE.Float32BufferAttribute(dep, 1));
      g.setAttribute('aWater', new THREE.Float32BufferAttribute(wp, 3));
      const nrm = new Float32Array(pos.length);
      for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, material);
      m.renderOrder = 2;
      m.matrixAutoUpdate = false;
      group.add(m);
    }
  }

  // 맵 밖으로 이어지는 강 (지평선 방향)
  {
    const pos = [], col = [], dep = [], idx = [], wp = [];
    const c = colors[4];
    const lvl = LAYOUT.riverLevel;
    for (const side of [-1, 1]) {
      const xs = [];
      for (let x = side * half; Math.abs(x) <= half + 160; x += side * 8) xs.push(x);
      const base = pos.length / 3;
      for (const x of xs) {
        const zc = riverCenterZ(side * half);
        for (const dz of [-LAYOUT.river.halfWidth - 2, LAYOUT.river.halfWidth + 2]) {
          pos.push(x, lvl, zc + dz); col.push(c.r, c.g, c.b); dep.push(2); wp.push(...KIND_PARAM[4]);
        }
      }
      for (let i = 0; i < xs.length - 1; i++) {
        const a = base + i * 2;
        if (side > 0) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); else idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aDepth', new THREE.Float32BufferAttribute(dep, 1));
    g.setAttribute('aWater', new THREE.Float32BufferAttribute(wp, 3));
    const nrm = new Float32Array(pos.length);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, material);
    m.renderOrder = 2;
    group.add(m);
  }

  // 논 물: 칸마다 사각형 (논둑 밑으로 살짝 들어가게)
  {
    const pd = data.paddy;
    const pos = [], col = [], dep = [], idx = [], wp = [];
    const c = colors[3];
    for (let r = 0; r < pd.rows; r++) {
      for (let cc = 0; cc < pd.cols; cc++) {
        const u0 = -pd.halfU + cc * pd.cellW - 0.15, u1 = u0 + pd.cellW + 0.3;
        const v0 = -pd.halfV + r * pd.cellH - 0.15, v1 = v0 + pd.cellH + 0.3;
        const y = pd.floors[r * pd.cols + cc] + pd.waterDepth;
        const base = pos.length / 3;
        for (const [u, v] of [[u0, v0], [u1, v0], [u0, v1], [u1, v1]]) {
          const [x, z] = pd.toWorld(u, v);
          pos.push(x, y, z); col.push(c.r, c.g, c.b); dep.push(0.16); wp.push(...KIND_PARAM[3]);
        }
        idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aDepth', new THREE.Float32BufferAttribute(dep, 1));
    g.setAttribute('aWater', new THREE.Float32BufferAttribute(wp, 3));
    const nrm = new Float32Array(pos.length);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, material);
    m.renderOrder = 2;
    group.add(m);
  }
  return group;
}

/** 논둑: 칸 경계마다 흙 둑 (윗면은 풀) */
export function buildDikes(data, textures) {
  const pd = data.paddy;
  const segs = pd.dikeSegments();
  const pos = [], nor = [], uv = [], col = [], idx = [];
  const top = new THREE.Color(0.62, 0.66, 0.42), side = new THREE.Color(0.72, 0.6, 0.48);
  for (const s of segs) {
    const du = s.u1 - s.u0, dv = s.v1 - s.v0;
    const len = Math.hypot(du, dv);
    const tu = du / len, tv = dv / len;
    const nu = -tv, nv = tu;
    const ext = s.half + 0.02;
    // 윗면은 약간 좁게 (사다리꼴 단면)
    const pts = (w, along) => {
      const u = s.u0 + tu * along + nu * w, v = s.v0 + tv * along + nv * w;
      return pd.toWorld(u, v);
    };
    const a0 = -ext, a1 = len + ext;
    const tw = s.half * 0.75, bw = s.half * 1.25;
    const corners = [
      [...pts(-tw, a0), s.top], [...pts(tw, a0), s.top], [...pts(tw, a1), s.top], [...pts(-tw, a1), s.top],
      [...pts(-bw, a0), s.bottom], [...pts(bw, a0), s.bottom], [...pts(bw, a1), s.bottom], [...pts(-bw, a1), s.bottom],
    ];
    // 둑 중심 (바깥쪽 판정용)
    let ox = 0, oy = 0, oz = 0;
    for (const c of corners) { ox += c[0]; oy += c[2]; oz += c[1]; }
    ox /= 8; oy /= 8; oz /= 8;
    const face = (ia, ib, ic, id, c) => {
      let P = [ia, ib, ic, id].map((k) => new THREE.Vector3(corners[k][0], corners[k][2], corners[k][1]));
      const ctr = P.reduce((a, v) => a.add(v), new THREE.Vector3()).multiplyScalar(0.25);
      const out = new THREE.Vector3(ctr.x - ox, ctr.y - oy, ctr.z - oz);
      let n = new THREE.Vector3().subVectors(P[1], P[0]).cross(new THREE.Vector3().subVectors(P[2], P[0])).normalize();
      if (n.dot(out) < 0) { P = [P[0], P[3], P[2], P[1]]; n.negate(); }
      const base = pos.length / 3;
      for (const V of P) {
        pos.push(V.x, V.y, V.z); nor.push(n.x, n.y, n.z); uv.push(V.x * 0.5, V.z * 0.5 + V.y * 0.5); col.push(c.r, c.g, c.b);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    face(0, 3, 2, 1, top);            // 윗면
    face(4, 5, 1, 0, side);           // 앞
    face(6, 7, 3, 2, side);           // 뒤
    face(7, 4, 0, 3, side);           // 왼쪽
    face(5, 6, 2, 1, side);           // 오른쪽
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ map: textures.dirt, vertexColors: true, roughness: 0.85 });
  patchCanopy(mat, { sun: 1, sky: 0.7 });
  addPatch(mat, 'dikewet', (shader) => {
    shader.uniforms.uWetness = shared.uWetness;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWetness;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = clamp( roughnessFactor - uWetness * 0.45, 0.15, 1.0 );')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= 1.0 - uWetness * 0.3;\n  gClassColor = vec4( 0.0, 1.0, 1.0, 1.0 );');
  });
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  m.name = 'dikes';
  return m;
}
