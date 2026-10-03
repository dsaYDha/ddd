// 공용 셰이더 유니폼과 머티리얼 패치
//  - 캐노피 조명: 캐노피 맵 + 햇빛 얼룩(sunfleck) 패턴으로 직사광을 가리고, 숲 바닥 하늘빛을 녹색으로 어둡게
//  - 식물: 정점별 흔들림(aWind) + 사람이 지나가면 옆으로 밀림 + 역광 투과 + 먼 거리 알파 보정
//  - 이끼: 위를 향한 면·밑동(aMoss)에 이끼
//  - 높이 안개: 골짜기·늪 위에 깔리는 안개, 숲속은 녹회색, 해 쪽은 밝게 산란
//  - 톤: ACES 뒤에 채도·대비 보정 (config.lighting.grading)
import * as THREE from 'three';
import { CONFIG } from '../config.js';

export const shared = {
  uTime: { value: 0 },
  uWetness: { value: 0.2 },
  uWind: { value: 0.3 },
  uRain: { value: 0 },
  // 캐노피 텍스처 (0.5m): R 캐노피 덮임, G 바닥 차폐(AO), B 캐노피 꼭대기 높이 (y+20)/100
  uCanopyTex: { value: null },
  // x: 맵 절반, y: 맵 크기, zw: 햇빛 방향 투영 오프셋 (m)
  uCanopyInfo: { value: new THREE.Vector4(200, 400, 0, 0) },
  uSunLow: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Color(1, 1, 1) },       // 햇빛 색 × 세기 (선형)
  uWindDir: { value: new THREE.Vector2(0.87, 0.49) },
  uPush: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, -1e4, 0, 0)) }, // xyz 발 위치, w 반경 (0 = 없음)
  uPushStrength: { value: 0.55 },
  uTranslucency: { value: 0.55 },
  uFleckTex: { value: null },
  uFleckInfo: { value: new THREE.Vector4(0.11, 0.9, 0, 0) },  // x: 1/타일 크기(m), y: 세기, zw: 흔들림 오프셋
  uFleckMat: { value: new THREE.Vector4(1, 0, 0, 1) },       // 해 방위로 늘인 2×2 행렬 (행 우선)
  uCanopyTint: { value: new THREE.Color(0.8, 1.0, 0.68) },
  uNoiseTex: { value: null },
  // 안개 확장: xyz 해 방향, w 산란 세기 / 해 색 / rgb 숲속 안개 색 배율, a 적용량
  uFogSun: { value: new THREE.Vector4(0, 1, 0, 0) },
  uFogSunColor: { value: new THREE.Color(1, 1, 1) },
  uFogCanopy: { value: new THREE.Vector4(1, 1, 1, 0) },
  // 검증용 분류 렌더 (0: 보통, 1: 픽셀 종류 색, 2: 깊이) — scripts 의 화면 측정에서만 사용
  uClassMode: { value: 0 },
};

/** 전역 셰이더 청크 교체 — 높이 안개(모든 내장 머티리얼) + 톤 보정 */
export function installShaderChunks() {
  const F = CONFIG.fog;
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
  uniform vec4 uFogSun;
  uniform vec3 uFogSunColor;
  uniform vec4 uFogCanopy;
  varying float vFogDepth;
  varying vec3 vFogWorld;
#endif`;
  THREE.ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG
  float fogYAvg = 0.5 * ( vFogWorld.y + cameraPosition.y );
  float fogMist = fogFar * exp( - max( fogYAvg - ${F.mistBase.toFixed(2)}, 0.0 ) / ${F.mistFalloff.toFixed(2)} );
  float fogD = fogNear + fogMist;
  float fogFactor = 1.0 - exp( - fogD * fogD * vFogDepth * vFogDepth );
  vec3 fogViewDir = normalize( vFogWorld - cameraPosition );
  float fogSunAmt = pow( max( dot( fogViewDir, uFogSun.xyz ), 0.0 ), 5.0 ) * uFogSun.w;
  // 숲속: 눈높이 아래 먼 줄기들은 어두운 녹회색 안개로, 위쪽 수관·하늘은 밝은 안개로 → 겹겹이 보이는 실루엣
  float fogLow = 1.0 - smoothstep( -3.0, 20.0, vFogWorld.y - cameraPosition.y );
  vec3 fogTint = mix( vec3( 1.0 ), uFogCanopy.rgb, uFogCanopy.a * ( 0.4 + 0.6 * fogLow ) );
  vec3 fogCol = fogColor * fogTint + uFogSunColor * fogSunAmt;
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogCol, fogFactor );
#endif`;

  // ACES 다음에 채도·대비 보정 (sqrt 공간 근사)
  const G = CONFIG.lighting.grading;
  const tm = THREE.ShaderChunk.tonemapping_pars_fragment;
  const anchor = 'color = ACESOutputMat * color;';
  if (tm.includes(anchor) && !tm.includes('GRADE_SAT')) {
    THREE.ShaderChunk.tonemapping_pars_fragment = tm.replace(anchor, `${anchor}
	color = clamp( color, 0.0, 1.0 );
	#define GRADE_SAT ${G.saturation.toFixed(3)}
	#define GRADE_CON ${G.contrast.toFixed(3)}
	float gradeL = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
	color = max( mix( vec3( gradeL ), color, GRADE_SAT ), 0.0 );
	vec3 gradeP = ( sqrt( color ) - 0.5 ) * GRADE_CON + 0.5;
	color = gradeP * gradeP;`);
  }
}
/** @deprecated 이름 호환 */
export const installFogChunks = installShaderChunks;

// ---------------------------------------------------------------
// 패치 합성: 머티리얼마다 여러 패치를 순서대로 적용
// ---------------------------------------------------------------
export function addPatch(material, key, fn) {
  const ud = material.userData;
  if (!ud.patches) {
    ud.patches = [];
    material.onBeforeCompile = (shader, renderer) => {
      // 안개 확장 유니폼 (안개 청크가 쓰는 공용 값)
      shader.uniforms.uFogSun = shared.uFogSun;
      shader.uniforms.uFogSunColor = shared.uFogSunColor;
      shader.uniforms.uFogCanopy = shared.uFogCanopy;
      shader.uniforms.uClassMode = shared.uClassMode;
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uClassMode;\nvec4 gClassColor = vec4( 0.0, 0.0, 0.5, 1.0 );');
      for (const p of ud.patches) p.fn(shader, renderer);
      // 분류 렌더: 1 = 종류 색 (지형은 패치가 gClassColor 를 채움), 2 = 깊이 (24비트)
      shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
  if ( uClassMode > 0.5 ) {
    if ( uClassMode < 1.5 ) gl_FragColor = gClassColor;
    else {
      vec3 enc = fract( gl_FragCoord.z * vec3( 1.0, 255.0, 65025.0 ) );
      enc -= enc.yzz * vec3( 1.0 / 255.0, 1.0 / 255.0, 0.0 );
      gl_FragColor = vec4( enc, 1.0 );
    }
  }`);
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
    .replace('#include <common>', '#include <common>\nvarying vec3 vPatchWorld;\nvarying vec3 vPatchNormalW;')
    .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  {
    mat4 pm = modelMatrix;
    #ifdef USE_INSTANCING
      pm = modelMatrix * instanceMatrix;
    #endif
    vPatchWorld = ( pm * vec4( transformed, 1.0 ) ).xyz;
    vPatchNormalW = normalize( mat3( pm ) * objectNormal );
  }`);
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vPatchWorld;\nvarying vec3 vPatchNormalW;');
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
    Object.assign(shader.uniforms, {
      uCanopyTex: shared.uCanopyTex, uCanopyInfo: shared.uCanopyInfo, uSunLow: shared.uSunLow,
      uFleckTex: shared.uFleckTex, uFleckInfo: shared.uFleckInfo, uFleckMat: shared.uFleckMat, uCanopyTint: shared.uCanopyTint,
    });
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
uniform sampler2D uCanopyTex, uFleckTex;
uniform vec4 uCanopyInfo, uFleckInfo, uFleckMat;
uniform float uSunLow;
uniform vec3 uCanopyTint;
// 캐노피 덮임 (그 지점 캐노피 꼭대기 근처의 잎은 덜 가려짐)
float canopyCoverAt( vec2 xz, float y ) {
  vec4 c = texture2D( uCanopyTex, ( xz + uCanopyInfo.x ) / uCanopyInfo.y );
  float top = c.b * 100.0 - 20.0;
  return c.r * ( 1.0 - smoothstep( top - 7.0, top + 0.5, y ) );
}`);
    const begin = THREE.ShaderChunk.lights_fragment_begin
      .replace('getDirectionalLightInfo( directionalLight, directLight );',
        'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= canopySun;')
      .replace(/directLight\.color \*= \( directLight\.visible && receiveShadow \) \? (getShadow\( directionalShadowMap\[ i \][^;]*?) : 1\.0;/,
        'sunShadowVis = ( directLight.visible && receiveShadow ) ? $1 : 1.0;\n\t\tdirectLight.color *= sunShadowVis;');
    const cut = begin.lastIndexOf('#if defined( RE_IndirectSpecular )');
    const patched = begin.slice(0, cut) + '#if defined( RE_IndirectDiffuse )\n\tirradiance *= canopySkyTint;\n#endif\n' + begin.slice(cut);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_fragment_begin>', `
  float sunShadowVis = 1.0;
  // 햇빛: 해 쪽으로 투영한 캐노피 덮임 → 햇빛 얼룩 패턴의 문턱값
  float canopySunCover = canopyCoverAt( vPatchWorld.xz + uCanopyInfo.zw, vPatchWorld.y );
  canopySunCover = clamp( canopySunCover * ( 1.0 + 0.2 * uSunLow ), 0.0, 1.0 );
  vec2 fleckP = vPatchWorld.xz + uCanopyInfo.zw;
  vec2 fleckUv = vec2( dot( fleckP, uFleckMat.xy ), dot( fleckP, uFleckMat.zw ) ) * uFleckInfo.x + uFleckInfo.zw;
  float fleckV = texture2D( uFleckTex, fleckUv ).r;
  float fleckThr = canopySunCover * 0.9;
  float fleckLit = smoothstep( fleckThr - 0.045, fleckThr + 0.045, fleckV );
  float canopySun = mix( 1.0, fleckLit, ${sunK} * uFleckInfo.y );
  float canopySkyCover = canopyCoverAt( vPatchWorld.xz, vPatchWorld.y );
  float canopySky = 1.0 - ${skyK} * canopySkyCover;
  vec3 canopySkyTint = canopySky * mix( vec3( 1.0 ), uCanopyTint, canopySkyCover );
  ${patched}`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
  #if defined( RE_IndirectDiffuse )
    iblIrradiance *= canopySkyTint;
  #endif
  #if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
    radiance *= mix( 0.06, 1.0, canopySky * canopySky );
  #endif`);
  });
}

/**
 * 식물 패치: 바람(aWind) + 밀림 + 먼 거리 알파 보정 + 역광 투과.
 * @param {object} o  translucency: 투과 배율, noFlip: 뒷면 법선 뒤집지 않기(잎 덩어리), depthOnly: 그림자용
 */
export function patchFoliage(material, o = {}) {
  const trans = (o.translucency ?? 1).toFixed(3);
  const noFlip = o.noFlip !== false;
  const depthOnly = !!o.depthOnly;
  return addPatch(material, `foliage${trans}_${noFlip}_${depthOnly}`, (shader) => {
    Object.assign(shader.uniforms, {
      uTime: shared.uTime, uWind: shared.uWind, uWindDir: shared.uWindDir,
      uPush: shared.uPush, uPushStrength: shared.uPushStrength,
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aWind;
uniform float uTime;
uniform float uWind;
uniform vec2 uWindDir;
uniform vec4 uPush[ 4 ];
uniform float uPushStrength;
// 월드 변위: 바람(가지 흔들림 + 잎 떨림) + 사람에게 밀림
vec3 foliageDisp( vec3 wp, vec3 org ) {
  float ph = aWind.z * 6.2832 + dot( org.xz, vec2( 0.37, 0.23 ) );
  float gust = 0.55 + 0.45 * sin( uTime * ${CONFIG.wind.gustSpeed.toFixed(3)} + dot( org.xz, vec2( 0.021, 0.017 ) ) );
  float sway = ( sin( uTime * 1.05 + ph ) * 0.65 + sin( uTime * 2.1 + ph * 1.7 ) * 0.35 ) * gust;
  vec3 d = vec3( uWindDir.x, 0.0, uWindDir.y ) * ( sway + 0.5 * gust ) * aWind.x * uWind;
  float fl = sin( uTime * 6.8 + ph * 3.1 + wp.x * 1.9 + wp.y * 2.3 + wp.z * 1.3 ) * aWind.y * uWind * ( 0.4 + gust );
  d += vec3( fl * 0.5, fl, fl * 0.4 );
  float flex = clamp( ( aWind.x + aWind.y * 2.0 ) * 8.0, 0.0, 1.0 );
  for ( int i = 0; i < 4; i ++ ) {
    vec4 pu = uPush[ i ];
    if ( pu.w <= 0.0 ) continue;
    vec2 dd = wp.xz - pu.xz;
    float dist = length( dd );
    float hRel = wp.y - pu.y;
    float hk = smoothstep( -0.4, 0.05, hRel ) * ( 1.0 - smoothstep( 1.5, 2.1, hRel ) );
    float k = ( 1.0 - smoothstep( pu.w * 0.3, pu.w, dist ) ) * hk * flex;
    vec2 pdir = dist > 0.001 ? dd / dist : vec2( 1.0, 0.0 );
    d.xz += pdir * k * uPushStrength * pu.w;
    d.y -= k * uPushStrength * 0.3 * clamp( hRel, 0.0, 1.0 );
  }
  return d;
}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  {
    mat4 fm = modelMatrix;
    #ifdef USE_INSTANCING
      fm = modelMatrix * instanceMatrix;
    #endif
    vec3 fwp = ( fm * vec4( transformed, 1.0 ) ).xyz;
    vec3 fdisp = foliageDisp( fwp, fm[ 3 ].xyz );
    transformed += inverse( mat3( fm ) ) * fdisp;
  }`);
    // 멀리서 밉맵 알파가 줄어 잎이 성겨지는 것 보정 (밉 단계마다 알파를 키움)
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `
  #ifdef USE_MAP
  {
    vec2 mts = vMapUv * vec2( textureSize( map, 0 ) );
    vec2 mdx = dFdx( mts ), mdy = dFdy( mts );
    float mlod = max( 0.0, 0.5 * log2( max( dot( mdx, mdx ), dot( mdy, mdy ) ) ) );
    diffuseColor.a *= 1.0 + mlod * 0.28;
  }
  #endif
  #include <alphatest_fragment>`);
    if (depthOnly) return;
    if (noFlip) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>',
        THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', '/* 잎 덩어리: 앞뒤 같은 법선 */'));
    }
    shader.uniforms.uSunDir = shared.uSunDir;
    shader.uniforms.uSunColor = shared.uSunColor;
    shader.uniforms.uTranslucency = shared.uTranslucency;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSunDir;\nuniform vec3 uSunColor;\nuniform float uTranslucency;')
      .replace('#include <opaque_fragment>', `
  {
    // 역광 투과: 해를 등진 잎이 노랗게 빛남 (그림자·캐노피에 가려지면 약해짐)
    vec3 tvd = normalize( vPatchWorld - cameraPosition );
    float back = pow( max( dot( tvd, uSunDir ), 0.0 ), 4.0 );
    outgoingLight += diffuseColor.rgb * vec3( 1.05, 1.1, 0.75 ) * uSunColor * ( 0.12 + 1.3 * back ) * uTranslucency * ${trans} * canopySun * mix( 0.25, 1.0, sunShadowVis );
  }
  #include <opaque_fragment>`);
  });
}

/** 줄기 등 단순 높이 비례 흔들림 (대나무 줄기·야자 줄기) */
export function patchWind(material, amp = 0.1, refH = 1, freq = 1.6) {
  return addPatch(material, `wind${amp}_${refH}_${freq}`, (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWind = shared.uWind;
    shader.uniforms.uWindDir = shared.uWindDir;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;\nuniform vec2 uWindDir;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  {
    float wh = clamp( position.y / ${refH.toFixed(3)}, 0.0, 1.6 );
    vec3 ipos = vec3( 0.0 );
    #ifdef USE_INSTANCING
      ipos = instanceMatrix[ 3 ].xyz;
    #endif
    float ph = uTime * ${freq.toFixed(3)} + ipos.x * 0.37 + ipos.z * 0.23;
    float gust = 0.6 + 0.4 * sin( uTime * 0.31 + ipos.x * 0.02 );
    float sway = ( sin( ph ) + 0.45 * sin( ph * 2.3 + 1.7 ) + 0.6 ) * uWind * gust * ${amp.toFixed(4)} * wh * wh;
    transformed.x += sway * uWindDir.x;
    transformed.z += sway * uWindDir.y;
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

/**
 * 이끼: 위를 향한 면(top) + 정점 속성 aMoss(밑동·틈) 만큼 이끼색을 섞는다.
 * 통나무는 aPeel(1: 벗겨진 목재, 2: 마구리 나이테, 3: 버섯 — 정점색만) 도 처리.
 */
export function patchMoss(material, o = {}) {
  const top = (o.top ?? 0.6).toFixed(3);
  const log = !!o.log;
  return addPatch(material, `moss${top}_${log}`, (shader) => {
    ensureWorldVarying(shader);
    shader.uniforms.uNoiseTex = shared.uNoiseTex;
    shader.uniforms.uWoodTex = { value: o.wood || null };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aMoss;
attribute float aPeel;
varying float vMoss;
varying float vPeel;`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vMoss = aMoss;\n  vPeel = aPeel;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uNoiseTex;
uniform sampler2D uWoodTex;
varying float vMoss;
varying float vPeel;`)
      .replace('#include <map_fragment>', log ? `
  #ifdef USE_MAP
    vec4 sampledDiffuseColor = texture2D( map, vMapUv );
    if ( vPeel > 2.5 ) sampledDiffuseColor = vec4( 1.0 );
    else if ( vPeel > 1.5 ) {
      // 마구리: 나이테 + 썩은 가운데 + 바깥 껍질 고리
      vec2 cuv = vMapUv - 0.5;
      float rr = length( cuv ) * 2.0;
      float ring = 0.5 + 0.5 * sin( rr * 46.0 + texture2D( uNoiseTex, cuv * 0.5 ).g * 6.0 );
      vec3 wood = mix( vec3( 0.62, 0.48, 0.32 ), vec3( 0.46, 0.33, 0.21 ), ring );
      wood = mix( wood, vec3( 0.2, 0.15, 0.1 ), smoothstep( 0.86, 0.95, rr ) );
      wood *= mix( 0.55, 1.0, smoothstep( 0.0, 0.35, rr ) );
      sampledDiffuseColor = vec4( wood, 1.0 );
    } else if ( vPeel > 0.5 ) sampledDiffuseColor = texture2D( uWoodTex, vMapUv * vec2( 1.0, 0.5 ) );
    diffuseColor *= sampledDiffuseColor;
  #endif` : '#include <map_fragment>')
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    float mn = texture2D( uNoiseTex, vPatchWorld.xz * 0.29 + vec2( vPatchWorld.y * 0.17 ) ).g;
    float mossAmt = clamp( vMoss * 1.25 + ( vPatchNormalW.y - 0.45 ) * 2.2 * ${top}, 0.0, 1.0 );
    mossAmt *= smoothstep( 0.42, 0.7, mn + vMoss * 0.2 );
    ${log ? 'if ( vPeel > 1.5 ) mossAmt *= 0.15;' : ''}
    vec3 mossCol = mix( vec3( 0.08, 0.13, 0.035 ), vec3( 0.2, 0.27, 0.08 ), mn );
    diffuseColor.rgb = mix( diffuseColor.rgb, mossCol, mossAmt );
  }`);
  });
}

/** 잎 머티리얼 + 그림자용 깊이 머티리얼 (같은 흔들림·알파) */
export function createFoliageMaterial(atlas, o = {}) {
  const mat = new THREE.MeshLambertMaterial({
    map: atlas, vertexColors: true, alphaTest: o.alphaTest ?? 0.5, side: THREE.DoubleSide,
    alphaToCoverage: !!o.alphaToCoverage,
  });
  patchCanopy(mat, { sun: 1, sky: o.sky ?? 0.62 });
  patchFoliage(mat, { translucency: o.translucency ?? 1, noFlip: o.noFlip });
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: o.alphaTest ?? 0.5 });
  patchFoliage(depth, { depthOnly: true });
  mat.userData.depthMaterial = depth;
  return mat;
}
