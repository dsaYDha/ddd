// 공용 셰이더 유니폼과 머티리얼 패치
//  - 캐노피 조명: 캐노피 맵으로 직사광(햇빛 틈)과 하늘빛(어두운 숲 바닥)을 가림
//  - 바람 흔들림: 풀·잎
//  - 높이 안개: 골짜기·늪·논 위에 깔리는 새벽 안개 (THREE.Fog의 near/far 를 밀도/안개량으로 사용)
import * as THREE from 'three';

export const shared = {
  uTime: { value: 0 },
  uWetness: { value: 0.2 },
  uWind: { value: 0.3 },
  uRain: { value: 0 },
  uCanopyTex: { value: null },
  // x: 맵 절반, y: 맵 크기, zw: 햇빛 방향 투영 오프셋 (m)
  uCanopyInfo: { value: new THREE.Vector4(200, 400, 0, 0) },
  uSunLow: { value: 0 },
};

export const MIST = { base: 7.0, falloff: 4.5 };

/** 전역 안개 청크 교체 — 모든 내장 머티리얼에 높이 안개 적용 */
export function installFogChunks() {
  THREE.ShaderChunk.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorld;
#endif`;
  THREE.ShaderChunk.fog_vertex = /* glsl */`
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vec4 fogWp = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    fogWp = instanceMatrix * fogWp;
  #endif
  vFogWorld = ( modelMatrix * fogWp ).xyz;
#endif`;
  THREE.ShaderChunk.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  uniform float fogNear;   // = 기본 안개 밀도
  uniform float fogFar;    // = 저지대 안개량
  varying float vFogDepth;
  varying vec3 vFogWorld;
#endif`;
  THREE.ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG
  float fogYAvg = 0.5 * ( vFogWorld.y + cameraPosition.y );
  float fogMist = fogFar * exp( - max( fogYAvg - ${MIST.base.toFixed(2)}, 0.0 ) / ${MIST.falloff.toFixed(2)} );
  float fogD = fogNear + fogMist;
  float fogFactor = 1.0 - exp( - fogD * fogD * vFogDepth * vFogDepth );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;
}

// ---------------------------------------------------------------
// 패치 합성: 머티리얼마다 여러 패치를 순서대로 적용
// ---------------------------------------------------------------
export function addPatch(material, key, fn) {
  const ud = material.userData;
  if (!ud.patches) {
    ud.patches = [];
    material.onBeforeCompile = (shader, renderer) => {
      for (const p of ud.patches) p.fn(shader, renderer);
    };
    material.customProgramCacheKey = () => ud.patches.map((p) => p.key).join('|');
  }
  ud.patches.push({ key, fn });
  material.needsUpdate = true;
  return material;
}

/** 월드 좌표 varying (여러 패치가 공유) */
function ensureWorldVarying(shader) {
  if (shader.vertexShader.includes('vPatchWorld')) return;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vPatchWorld;')
    .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  {
    vec4 pw = vec4( transformed, 1.0 );
    #ifdef USE_INSTANCING
      pw = instanceMatrix * pw;
    #endif
    vPatchWorld = ( modelMatrix * pw ).xyz;
  }`);
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vPatchWorld;');
}

/**
 * 캐노피 조명 패치.
 * @param {object} o  sun: 직사광 가림 세기(0~1), sky: 하늘빛 가림 세기(0~1)
 */
export function patchCanopy(material, o = {}) {
  const sunK = (o.sun ?? 1).toFixed(3);
  const skyK = (o.sky ?? 0.72).toFixed(3);
  return addPatch(material, `canopy${sunK}_${skyK}`, (shader) => {
    ensureWorldVarying(shader);
    shader.uniforms.uCanopyTex = shared.uCanopyTex;
    shader.uniforms.uCanopyInfo = shared.uCanopyInfo;
    shader.uniforms.uSunLow = shared.uSunLow;
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
uniform sampler2D uCanopyTex;
uniform vec4 uCanopyInfo;
uniform float uSunLow;
float canopyCoverAt( vec2 xz ) {
  return texture2D( uCanopyTex, ( xz + uCanopyInfo.x ) / uCanopyInfo.y ).r;
}`);
    const begin = THREE.ShaderChunk.lights_fragment_begin
      .replace('getDirectionalLightInfo( directionalLight, directLight );',
        'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= canopySun;');
    const cut = begin.lastIndexOf('#if defined( RE_IndirectSpecular )');
    const patched = begin.slice(0, cut) + '#if defined( RE_IndirectDiffuse )\n\tirradiance *= canopySky;\n#endif\n' + begin.slice(cut);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_fragment_begin>', `
  float canopySunCover = canopyCoverAt( vPatchWorld.xz + uCanopyInfo.zw );
  // 낮은 해는 더 많은 잎을 지나므로 더 많이 막힘
  canopySunCover = clamp( canopySunCover * ( 1.0 + 0.25 * uSunLow ), 0.0, 1.0 );
  float canopySun = 1.0 - ${sunK} * smoothstep( 0.28, 0.82, canopySunCover );
  float canopySky = 1.0 - ${skyK} * canopyCoverAt( vPatchWorld.xz );
  ${patched}`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
  #if defined( RE_IndirectDiffuse )
    iblIrradiance *= canopySky;
  #endif
  #if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
    radiance *= mix( 0.06, 1.0, canopySky * canopySky );
  #endif`);
  });
}

/**
 * 바람 흔들림 (정점 높이에 비례).
 * @param {number} amp     최대 변위 (m, uWind=1 일 때)
 * @param {number} refH    이 높이에서 amp 만큼 흔들림 (로컬 좌표)
 * @param {number} freq    진동 속도
 */
export function patchWind(material, amp = 0.1, refH = 1, freq = 1.6) {
  return addPatch(material, `wind${amp}_${refH}_${freq}`, (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWind = shared.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  {
    float wh = clamp( position.y / ${refH.toFixed(3)}, 0.0, 1.6 );
    vec3 ipos = vec3( 0.0 );
    #ifdef USE_INSTANCING
      ipos = instanceMatrix[ 3 ].xyz;
    #endif
    float ph = uTime * ${freq.toFixed(3)} + ipos.x * 0.37 + ipos.z * 0.23 + position.x * 0.8;
    float gust = 0.6 + 0.4 * sin( uTime * 0.31 + ipos.x * 0.02 );
    float sway = ( sin( ph ) + 0.45 * sin( ph * 2.3 + 1.7 ) ) * uWind * gust * ${amp.toFixed(4)} * wh * wh;
    transformed.x += sway;
    transformed.z += sway * 0.55 * cos( ph * 0.7 );
  }`);
  });
}

/** 젖음도에 따라 어두워지고 번들거림 (표준 머티리얼) */
export function patchWetness(material, strength = 1) {
  return addPatch(material, `wet${strength}`, (shader) => {
    shader.uniforms.uWetness = shared.uWetness;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWetness;')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = clamp( roughnessFactor - uWetness * 0.4 * ${strength.toFixed(2)}, 0.08, 1.0 );`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  diffuseColor.rgb *= 1.0 - uWetness * 0.28 * ${strength.toFixed(2)};`);
  });
}
