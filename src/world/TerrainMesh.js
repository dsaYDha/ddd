// 지형 메시 (청크 단위 → 프러스텀 컬링) + 스플랫 셰이더
// 지면 종류 스플랫 텍스처(R 진흙, G 흙길, B 습기, A 풀)로 낙엽·흙·진흙 질감을 섞는다.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { addPatch, patchCanopy, shared } from '../render/Materials.js';
import { Noise2D } from '../core/noise.js';
import { riverCenterZ } from './MapLayout.js';

export function createTerrainMaterial(tex) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, normalMap: tex.detailNormal, normalScale: new THREE.Vector2(0.55, 0.55) });
  const splat = new THREE.DataTexture(tex.splatData, tex.splatSize, tex.splatSize, THREE.RGBAFormat);
  splat.magFilter = THREE.LinearFilter;
  splat.minFilter = THREE.LinearMipmapLinearFilter;
  splat.generateMipmaps = true;
  splat.needsUpdate = true;
  const L = CONFIG.lighting;

  addPatch(mat, 'terrain', (shader) => {
    Object.assign(shader.uniforms, {
      uSplat: { value: splat },
      uLitter: { value: tex.litter },
      uDirt: { value: tex.dirt },
      uMud: { value: tex.mud },
      uCover: { value: tex.cover },
      uSoil: { value: tex.soil },
      uRock: { value: tex.rock },
      uNoise: { value: tex.noise },
      uWetness: shared.uWetness,
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTWorldNormal;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vTWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uSplat, uLitter, uDirt, uMud, uCover, uSoil, uRock, uNoise;
uniform float uWetness;
varying vec3 vTWorldNormal;
vec3 triRock( vec3 p, vec3 n ) {
  vec3 w = pow( abs( n ), vec3( 4.0 ) );
  w /= ( w.x + w.y + w.z );
  return texture2D( uRock, p.zy * 0.2 ).rgb * w.x + texture2D( uRock, p.xz * 0.2 ).rgb * w.y + texture2D( uRock, p.xy * 0.2 ).rgb * w.z;
}`)
      .replace('#include <map_fragment>', `
  vec2 wxz = vPatchWorld.xz;
  vec2 guv = ( wxz + uCanopyInfo.x ) / uCanopyInfo.y;
  vec4 sp = texture2D( uSplat, guv );
  vec4 nzA = texture2D( uNoise, wxz * 0.019 );
  vec4 nzB = texture2D( uNoise, wxz * 0.11 );
  vec3 cLitter = mix( texture2D( uLitter, wxz * 0.42 ).rgb, texture2D( uLitter, wxz * 0.12 + 0.37 ).rgb, 0.35 );
  vec3 cDirt = texture2D( uDirt, wxz * 0.31 ).rgb;
  vec3 cMud = mix( texture2D( uMud, wxz * 0.26 ).rgb, texture2D( uMud, wxz * 0.07 ).rgb, 0.3 );
  vec3 cCover = mix( texture2D( uCover, wxz * 0.36 ).rgb, texture2D( uCover, wxz * 0.11 + 0.5 ).rgb, 0.4 );
  vec3 nW = normalize( vTWorldNormal );
  vec3 cSoil = texture2D( uSoil, vec2( wxz.x * 0.7 + wxz.y * 0.7, vPatchWorld.y * 1.2 ) * 0.22 ).rgb;
  vec3 cRock = triRock( vPatchWorld, nW );
  float mudW = smoothstep( 0.22, 0.72, sp.r + ( nzB.g - 0.5 ) * 0.4 );
  float dirtW = smoothstep( 0.25, 0.75, sp.g + ( nzB.b - 0.5 ) * 0.3 );
  // 지피식물: 스플랫 A (숲 바닥 덮임) — 평지는 거의 다 덮이고 경사면은 흙이 줄무늬로 드러남
  float coverW = smoothstep( 0.22, 0.78, sp.a + ( nzA.r - 0.5 ) * 0.35 + ( nzB.r - 0.5 ) * 0.2 );
  float slopeK = smoothstep( 0.88, 0.74, nW.y );                      // 약 28° → 42°
  float soilW = slopeK * smoothstep( 0.5, 0.68, nzB.r * 0.7 + nzA.g * 0.3 + slopeK * 0.2 );
  float rockW = smoothstep( 0.74, 0.62, nW.y );                        // 약 42° 이상
  float moist = sp.b;
  vec3 tcol = cLitter * mix( 0.82, 1.12, nzA.r );
  tcol = mix( tcol, cCover * mix( 0.85, 1.15, nzA.a ), coverW * ( 1.0 - soilW * 0.75 ) );
  tcol = mix( tcol, cSoil, soilW * ( 1.0 - dirtW ) * ( 1.0 - mudW ) );
  tcol = mix( tcol, cDirt, dirtW );
  tcol = mix( tcol, cMud, mudW );
  float wetAll = clamp( moist * 0.7 + uWetness * 0.5, 0.0, 1.0 );
  tcol *= mix( 1.0, 0.62, wetAll * ( 1.0 - dirtW * 0.35 ) * ( 1.0 - coverW * 0.5 ) );
  tcol = mix( tcol, cRock * vec3( 0.82, 0.82, 0.74 ), rockW );
  // 줄기 밑동·덤불·바위 아래 어두워짐 (0.5m 차폐 격자)
  float floorAO = texture2D( uCanopyTex, guv ).g;
  tcol *= mix( 1.0, floorAO, ${L.floorAO.toFixed(3)} );
  diffuseColor.rgb *= tcol;
  // 검증용 분류: R = 맨땅(낙엽·흙·바위) 비중, G = 오솔길·진흙 비중, B = 1 (지형)
  {
    float coverVis = coverW * ( 1.0 - soilW * 0.75 ) * ( 1.0 - rockW );
    gClassColor = vec4( ( 1.0 - coverVis ) * ( 1.0 - dirtW ) * ( 1.0 - mudW ), max( dirtW, mudW ), 1.0, 1.0 );
  }
  float terrainGloss = mudW * 0.72 + wetAll * 0.22 * ( 1.0 - coverW * 0.6 ) + uWetness * 0.38 * ( 1.0 - rockW );
`)
      .replace('#include <roughnessmap_fragment>', `
  float roughnessFactor = clamp( 0.96 - terrainGloss * 0.78 - nzB.r * 0.06 * mudW, 0.12, 1.0 );`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  // 진흙·물웅덩이에서는 미세 요철을 줄임 (번들거리는 면)
  normal = normalize( mix( normal, normalize( vNormal ), mudW * 0.7 ) );`);
  });
  patchCanopy(mat, { sun: 1, sky: 0.62 });
  return mat;
}

/**
 * 400m 지형을 100m 청크로 나눠 메시 생성 — 청크마다 1m(가까이)·2m(멀리) 두 단계,
 * 가장자리에 아래로 내린 '치마'를 붙여 단계가 다른 청크 사이 틈을 가린다.
 */
export function buildTerrain(data, material, chunkCells = 100) {
  const { hN, hRes, half, height } = data;
  const group = new THREE.Group();
  group.name = 'terrain';
  const cells = hN - 1;
  const H = (i, j) => height[Math.min(hN - 1, Math.max(0, j)) * hN + Math.min(hN - 1, Math.max(0, i))];
  const build = (ci, cj, nI, nJ, step) => {
    const ni = Math.ceil(nI / step), nj = Math.ceil(nJ / step);
    const pos = [], nor = [], uvs = [], idx = [];
    const vert = (gi, gj, drop) => {
      const x = -half + gi * hRes, z = -half + gj * hRes;
      pos.push(x, H(gi, gj) - drop, z);
      uvs.push(x * 0.33, z * 0.33);
      const dx = (H(gi + 1, gj) - H(gi - 1, gj)) / (2 * hRes);
      const dz = (H(gi, gj + 1) - H(gi, gj - 1)) / (2 * hRes);
      const l = Math.hypot(dx, 1, dz);
      nor.push(-dx / l, 1 / l, -dz / l);
      return pos.length / 3 - 1;
    };
    const gIdx = (i, j) => [ci + Math.min(nI, i * step), cj + Math.min(nJ, j * step)];
    for (let j = 0; j <= nj; j++) for (let i = 0; i <= ni; i++) { const [gi, gj] = gIdx(i, j); vert(gi, gj, 0); }
    const at = (i, j) => j * (ni + 1) + i;
    for (let j = 0; j < nj; j++) {
      for (let i = 0; i < ni; i++) {
        const a = at(i, j), b = a + 1, c = at(i, j + 1), d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    // 치마 (청크 둘레를 따라 1m 아래로)
    const edge = [];
    for (let i = 0; i <= ni; i++) edge.push([i, 0]);
    for (let j = 1; j <= nj; j++) edge.push([ni, j]);
    for (let i = ni - 1; i >= 0; i--) edge.push([i, nj]);
    for (let j = nj - 1; j >= 1; j--) edge.push([0, j]);
    edge.push([0, 0]);
    let prevTop = -1, prevBot = -1;
    for (const [i, j] of edge) {
      const top = at(i, j);
      const [gi, gj] = gIdx(i, j);
      const bot = vert(gi, gj, 1.2);
      // 양면 (어느 쪽에서 틈을 봐도 가려지게)
      if (prevTop >= 0) idx.push(prevTop, top, prevBot, prevBot, top, bot, prevTop, prevBot, top, prevBot, bot, top);
      prevTop = top; prevBot = bot;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  };
  for (let cj = 0; cj < cells; cj += chunkCells) {
    for (let ci = 0; ci < cells; ci += chunkCells) {
      const nI = Math.min(chunkCells, cells - ci), nJ = Math.min(chunkCells, cells - cj);
      const lods = [build(ci, cj, nI, nJ, 1), build(ci, cj, nI, nJ, 2)];
      const m = new THREE.Mesh(lods[0], material);
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      m.userData.lods = lods;
      m.userData.box = { x0: -half + ci * hRes, z0: -half + cj * hRes, x1: -half + (ci + nI) * hRes, z1: -half + (cj + nJ) * hRes };
      group.add(m);
    }
  }
  return group;
}

/** 카메라 거리로 청크 단계 선택 + 시야 거리 밖 청크 숨김 */
export function updateTerrainLod(group, camPos, lodDist, viewDist) {
  for (const m of group.children) {
    const b = m.userData.box;
    const dx = Math.max(b.x0 - camPos.x, 0, camPos.x - b.x1), dz = Math.max(b.z0 - camPos.z, 0, camPos.z - b.z1);
    const d = Math.hypot(dx, dz);
    m.visible = d < viewDist;
    const g = m.userData.lods[d > lodDist ? 1 : 0];
    if (m.geometry !== g) m.geometry = g;
  }
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
  const pos = [], nor = [], idx = [], uvl = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = -R + i * step, z = -R + j * step;
      pos.push(x, H(x, z), z);
      uvl.push(x * 0.33, z * 0.33);
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
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvl, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, material);
  m.name = 'outerTerrain';
  m.matrixAutoUpdate = false;
  return m;
}
