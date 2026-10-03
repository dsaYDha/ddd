// 지형 메시 (청크 단위 → 프러스텀 컬링) + 스플랫 셰이더
// 지면 종류 스플랫 텍스처(R 진흙, G 흙길, B 습기, A 풀)로 낙엽·흙·진흙 질감을 섞는다.
import * as THREE from 'three';
import { addPatch, patchCanopy, shared } from '../render/Materials.js';
import { Noise2D } from '../core/noise.js';
import { riverCenterZ } from './MapLayout.js';

export function createTerrainMaterial(tex) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  const splat = new THREE.DataTexture(tex.splatData, tex.splatSize, tex.splatSize, THREE.RGBAFormat);
  splat.magFilter = THREE.LinearFilter;
  splat.minFilter = THREE.LinearMipmapLinearFilter;
  splat.generateMipmaps = true;
  splat.needsUpdate = true;

  addPatch(mat, 'terrain', (shader) => {
    Object.assign(shader.uniforms, {
      uSplat: { value: splat },
      uLitter: { value: tex.litter },
      uDirt: { value: tex.dirt },
      uMud: { value: tex.mud },
      uGrassG: { value: tex.grass },
      uRock: { value: tex.rock },
      uNoise: { value: tex.noise },
      uWetness: shared.uWetness,
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTWorldNormal;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vTWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uSplat, uLitter, uDirt, uMud, uGrassG, uRock, uNoise;
uniform float uWetness;
varying vec3 vTWorldNormal;`)
      .replace('#include <map_fragment>', `
  vec2 wxz = vPatchWorld.xz;
  vec4 sp = texture2D( uSplat, ( wxz + uCanopyInfo.x ) / uCanopyInfo.y );
  vec4 nzA = texture2D( uNoise, wxz * 0.019 );
  vec4 nzB = texture2D( uNoise, wxz * 0.11 );
  vec3 cLitter = mix( texture2D( uLitter, wxz * 0.42 ).rgb, texture2D( uLitter, wxz * 0.12 + 0.37 ).rgb, 0.35 );
  vec3 cDirt = texture2D( uDirt, wxz * 0.31 ).rgb;
  vec3 cMud = mix( texture2D( uMud, wxz * 0.26 ).rgb, texture2D( uMud, wxz * 0.07 ).rgb, 0.3 );
  vec3 cGrass = texture2D( uGrassG, wxz * 0.5 ).rgb;
  vec3 cRock = texture2D( uRock, vec2( wxz.x + wxz.y, vPatchWorld.y * 1.3 ) * 0.21 ).rgb;
  float mudW = smoothstep( 0.22, 0.72, sp.r + ( nzB.g - 0.5 ) * 0.4 );
  float dirtW = smoothstep( 0.25, 0.75, sp.g + ( nzB.b - 0.5 ) * 0.3 );
  float grassW = smoothstep( 0.2, 0.85, sp.a + ( nzA.r - 0.5 ) * 0.3 ) * 0.85;
  float moist = sp.b;
  vec3 tcol = cLitter * mix( 0.82, 1.12, nzA.r );
  tcol = mix( tcol, cGrass, grassW );
  tcol = mix( tcol, cDirt, dirtW );
  tcol = mix( tcol, cMud, mudW );
  float wetAll = clamp( moist * 0.7 + uWetness * 0.5, 0.0, 1.0 );
  tcol *= mix( 1.0, 0.62, wetAll * ( 1.0 - dirtW * 0.35 ) );
  float steep = smoothstep( 0.8, 0.56, vTWorldNormal.y );
  tcol = mix( tcol, cRock * vec3( 0.8, 0.8, 0.72 ), steep );
  tcol *= mix( 0.86, 1.08, nzA.a );
  diffuseColor.rgb *= tcol;
  float terrainGloss = mudW * 0.72 + wetAll * 0.22 + uWetness * 0.38 * ( 1.0 - steep );
`)
      .replace('#include <roughnessmap_fragment>', `
  float roughnessFactor = clamp( 0.96 - terrainGloss * 0.78 - nzB.r * 0.06 * mudW, 0.12, 1.0 );`);
  });
  patchCanopy(mat, { sun: 1, sky: 0.6 });
  return mat;
}

/** 400m 지형을 청크로 나눠 메시 생성 */
export function buildTerrain(data, material, chunkCells = 50) {
  const { hN, hRes, half, height } = data;
  const group = new THREE.Group();
  group.name = 'terrain';
  const cells = hN - 1;
  const H = (i, j) => height[Math.min(hN - 1, Math.max(0, j)) * hN + Math.min(hN - 1, Math.max(0, i))];
  for (let cj = 0; cj < cells; cj += chunkCells) {
    for (let ci = 0; ci < cells; ci += chunkCells) {
      const nI = Math.min(chunkCells, cells - ci), nJ = Math.min(chunkCells, cells - cj);
      const vcount = (nI + 1) * (nJ + 1);
      const pos = new Float32Array(vcount * 3);
      const nor = new Float32Array(vcount * 3);
      let k = 0;
      for (let j = 0; j <= nJ; j++) {
        for (let i = 0; i <= nI; i++) {
          const gi = ci + i, gj = cj + j;
          pos[k * 3] = -half + gi * hRes;
          pos[k * 3 + 1] = H(gi, gj);
          pos[k * 3 + 2] = -half + gj * hRes;
          const dx = (H(gi + 1, gj) - H(gi - 1, gj)) / (2 * hRes);
          const dz = (H(gi, gj + 1) - H(gi, gj - 1)) / (2 * hRes);
          const l = Math.hypot(dx, 1, dz);
          nor[k * 3] = -dx / l; nor[k * 3 + 1] = 1 / l; nor[k * 3 + 2] = -dz / l;
          k++;
        }
      }
      const idx = new Uint32Array(nI * nJ * 6);
      let t = 0;
      for (let j = 0; j < nJ; j++) {
        for (let i = 0; i < nI; i++) {
          const a = j * (nI + 1) + i, b = a + 1, c = a + (nI + 1), d = c + 1;
          idx[t++] = a; idx[t++] = c; idx[t++] = b;
          idx[t++] = b; idx[t++] = c; idx[t++] = d;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      const m = new THREE.Mesh(g, material);
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      group.add(m);
    }
  }
  return group;
}

let _outerNoise = null;
/** 맵 바깥 지형 높이 (지평선용, 충돌 없음) */
export function outerHeight(data, x, z) {
  const { half } = data;
  if (!_outerNoise || _outerNoise.seed !== data.seed) { _outerNoise = new Noise2D(data.seed ^ 0x1234); _outerNoise.seed = data.seed; }
  const cx = Math.max(-half, Math.min(half, x)), cz = Math.max(-half, Math.min(half, z));
  const i = Math.round(cx + half), j = Math.round(cz + half);
  const base = data.height[Math.min(data.hN - 1, j) * data.hN + Math.min(data.hN - 1, i)];
  const out = Math.max(Math.abs(x) - half, Math.abs(z) - half);
  if (out <= 0) return base - 0.3; // 안쪽은 본 지형이 덮음
  // 강 줄기는 맵 밖으로도 이어지게 낮게 유지
  const riverBand = Math.abs(z - riverCenterZ(cx)) < 16 && Math.abs(z) < half + 30;
  if (riverBand) return Math.min(base, -1.5);
  return base + Math.min(out, 120) * 0.12 + 14 * (0.5 + 0.5 * _outerNoise.fbm(x / 90, z / 90, 3)) * Math.min(1, out / 60) - 0.5;
}

/** 맵 바깥 먼 지형 (지평선이 비지 않도록) — 충돌 없음 */
export function buildOuterTerrain(data, material) {
  const { half } = data;
  const R = 720, step = 12;
  const n = Math.round((2 * R) / step);
  const H = (x, z) => outerHeight(data, x, z);
  const pos = [], nor = [], idx = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = -R + i * step, z = -R + j * step;
      pos.push(x, H(x, z), z);
      const dx = (H(x + step, z) - H(x - step, z)) / (2 * step);
      const dz = (H(x, z + step) - H(x, z - step)) / (2 * step);
      const l = Math.hypot(dx, 1, dz);
      nor.push(-dx / l, 1 / l, -dz / l);
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = -R + i * step, z0 = -R + j * step;
      // 완전히 안쪽 칸은 생략
      if (x0 > -half + step && x0 + step < half - step && z0 > -half + step && z0 + step < half - step) continue;
      const a = j * (n + 1) + i, b = a + 1, c = a + (n + 1), d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, material);
  m.name = 'outerTerrain';
  m.matrixAutoUpdate = false;
  return m;
}
