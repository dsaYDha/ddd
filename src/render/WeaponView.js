// =====================================================================
//  WeaponView — 1인칭 화면 모델 (7.62mm 소총 + 올리브색 소매의 두 팔)
//  · 자기 장면·카메라(near 0.01)를 갖고 월드 다음에 깊이만 지운 뒤 그린다 → 총이 나무·풀에 파묻히지 않는다.
//    장면 좌표는 '카메라 기준 월드' (원점 = 주 카메라 위치, 축 = 월드 축) — 큰 월드 좌표의 float 오차가 없다.
//  · 조준(ADS, aim.ads = 1): 가늠자 홈 기준점과 가늠쇠 끝이 주 카메라 위치를 지나 shooter.sight.dir 방향인 직선 위에
//    정확히 놓인다 → 가늠쇠 끝이 곧 탄이 가는 곳 (조준점·십자선 없음). 흔들림·관성은 sight.dir 에 이미 들어 있어
//    가늠쇠가 그만큼 화면에서 움직인다. 조준 중에는 이 정렬을 깨는 화면용 흔들림(걸음·관성 추가분·거치 내려앉음)을 끈다.
//  · 비조준: 오른쪽 아래로 내린 자세, 총열은 sight.dir 와 평행 (= 탄이 나가는 '총구 방향').
//    달리기 aim.lowered → 총구를 왼쪽 아래로 내린 자세, aim.restBlend → CONFIG.aim.rest.lowerM 만큼 내려앉음,
//    aim.weaponKick → 뒤로 튐·들림, aim.inertia* → 추가 지연, 걸음 흔들림, 자세 전환·이동 관성.
//  · weapon.action 진행률로 동작 애니메이션 (전술·빈 상태 재장전(노리쇠 당기기 포함), 탄창 확인, 기능 고장 해결)
//    — 진행표(config 비율)에 맞춰 키를 잡아 소리 이벤트와 화면이 같은 순간에 맞는다.
//    이벤트: 'fired' (화염·노리쇠 왕복·탄피 배출), 'modeChange' (조정간 튕김), 'dryFire' (방아쇠 '딸깍'),
//    'magIn'·'boltRelease' (총이 툭 흔들림), 'boltPull' (고장 해결이면 불발탄 배출).
//  · 그리기 호출: 소총 1 (SkinnedMesh — 노리쇠·조정간·방아쇠·탄창은 뼈) + 팔 1 (SkinnedMesh) + 화염 1 + 탄피 1 (+ 불발탄 1)
//    → 최대 5, 평소 2.
//  · 빛: 월드 해·반구광을 lighting(그늘 shade, 햇빛 sunVisible)으로 줄이고 캐노피 아래에선 녹색으로 물들인다.
//    금속은 하늘·땅 색 그라데이션을 가짜 환경 반사로 받는다 (환경맵 없이). 총구 화염 때만 작은 점광원.
// =====================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { clamp, lerp, damp } from '../core/math.js';
import { RNG } from '../core/rng.js';
import { buildRifle, buildArms, buildCasing, buildFlashGeometry, RIFLE_BONES, ARM_BONES, ARM_DIMS } from './WeaponModel.js';
import { createRifleDetailTexture, createArmsDetailTexture, createFlashTexture } from './WeaponTextures.js';

const DEG = Math.PI / 180;

// ---- 화면 모델 자세 (그림 상수 — 게임 수치 아님). 위치 = 조준선 프레임(눈 원점, −Z 조준 방향)에서 가늠자 홈 기준점 (m)
//      회전 = [pitch, yaw, roll] (rad, 총 공간 기준: pitch + 총구 위, yaw + 총구 왼쪽, roll + 반시계(윗면이 왼쪽))
const POSE = {
  eyeRelief: 0.3,                                          // 눈 ~ 가늠자 홈 (뺨을 개머리판에 바짝 댄 거리)
  // 비조준: 가늠자 홈의 앞뒤 위치(z)와 기울기만 그림 상수. 좌우·높이는 CONFIG.aim.hipOffset 에서 —
  // 총열 축이 Shooter 의 지향사격 탄 출발점(눈 + 오른쪽·아래)을 지나게 해서 예광탄·총구 FX 가 그려진 총구와 맞는다.
  // (pos 의 x·y 는 hipOffset 이 없을 때의 대체값)
  hip: { pos: [0.102, -0.112, -0.275], rot: [0.0, 0.0, -0.07] },
  // 엎드리면 비조준 자세도 어깨에 더 붙인다 (ADS 쪽으로). CONFIG.aim.hipProneMix 가 있으면 그 값 —
  // Shooter 의 엎드린 지향사격 탄 출발점도 같은 비율로 조준 출발점 쪽에 섞어야 그려진 총열과 탄 경로가 맞는다
  hipProneMix: 0.55,
  // 달리기: 손잡이 축을 중심으로 총구를 왼쪽 아래로 (위치 = 조준선 프레임, 회전 = 손잡이 중심)
  sprint: { pos: [0.125, -0.07, -0.36], rot: [-0.34, 0.42, -0.5] },
  adsArc: [-0.012, -0.016, 0.018],                         // 조준 전환 중 지나가는 호 (아래로 살짝 처졌다가 올라옴)
  kickPivot: [0, -0.11, 0.4],                              // 반동 회전 중심 (어깨에 댄 개머리판)
  pivot: [0, -0.08, 0.1],                                  // 달리기·동작 회전 중심 (손잡이 근처)
};
// 어깨 관절 (카메라 공간 — 오른쪽 +X, 위 +Y, 뒤 +Z), 팔꿈치 방향 힌트
const SHOULDER_R = new THREE.Vector3(0.19, -0.28, 0.1);
const SHOULDER_L = new THREE.Vector3(-0.2, -0.235, 0.0);
const POLE_R = new THREE.Vector3(0.85, -1, 0.15);
const POLE_L = new THREE.Vector3(-0.55, -1, 0.05);

const FLASH_TIME = 0.03;           // 화염이 보이는 시간 (s): 60fps 에서 1~2 프레임, 느려도 최소 한 프레임은 그린다
const FLASH_COLOR = new THREE.Color(5.5, 3.6, 1.6);
const BOLT_BACK_T = 0.03, BOLT_RETURN_T = 0.058;   // 사격 한 발의 노리쇠 후퇴·복귀 시간 (600rpm 간격 0.1s 안)
const EJECT_AT = 0.014;            // 사격 후 탄피가 튀어나오는 시각 (s)
const CASING_LIFE = 0.85;

const ZERO_KICK = Object.freeze({ back: 0, up: 0, side: 0, roll: 0 });
const DEFAULT_AIM = Object.freeze({ ads: 0, lowered: 0, restBlend: 0, inertiaYaw: 0, inertiaPitch: 0, weaponKick: ZERO_KICK });

// 조명 기본값 (lighting 이 없을 때 — 시험 페이지 등)
const DEFAULT_LIGHT = {
  sunColor: new THREE.Color(1.0, 0.96, 0.88).multiplyScalar(3.2), sunDir: new THREE.Vector3(0.35, 0.8, -0.45).normalize(),
  skyColor: new THREE.Color(0.66, 0.74, 0.8), groundColor: new THREE.Color(0.22, 0.21, 0.15), hemiIntensity: 1.5,
  shade: 0.25, sunVisible: 0.8, flash: 0,
};

// ---- 임시 객체 (프레임마다 새로 만들지 않음)
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _e1 = new THREE.Euler(0, 0, 0, 'YXZ'), _e2 = new THREE.Euler(0, 0, 0, 'YXZ'), _e3 = new THREE.Euler();
const _s1 = new THREE.Vector3(1, 1, 1);
const _c1 = new THREE.Color();
const ONE = new THREE.Vector3(1, 1, 1);
const FWD = new THREE.Vector3(0, 0, -1);

/** 키프레임 [[t, v], …] (t 오름차순) → 구간별 smoothstep 보간 */
function keys(t, k) {
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i][0]) {
      const a = k[i - 1], b = k[i];
      const u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * u * u * (3 - 2 * u);
    }
  }
  return k[k.length - 1][1];
}
/** 벡터 키프레임 [[t, [a, b, …]], …] → out 배열 */
function keysV(t, k, out) {
  let i = 1;
  if (t <= k[0][0]) { for (let c = 0; c < out.length; c++) out[c] = k[0][1][c]; return out; }
  for (; i < k.length; i++) if (t <= k[i][0]) break;
  if (i >= k.length) { const l = k[k.length - 1][1]; for (let c = 0; c < out.length; c++) out[c] = l[c]; return out; }
  const a = k[i - 1], b = k[i];
  const u0 = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
  const u = u0 * u0 * (3 - 2 * u0);
  for (let c = 0; c < out.length; c++) out[c] = a[1][c] + (b[1][c] - a[1][c]) * u;
  return out;
}

/** 원점·앞 방향(−Z)·위 힌트 → 행렬 (전용 임시 벡터 — 호출하는 쪽의 _v* 를 건드리지 않음) */
const _fx = new THREE.Vector3(), _fy = new THREE.Vector3(), _fz = new THREE.Vector3();
function frameMatrix(out, origin, fwd, upHint) {
  const z = _fz.copy(fwd).normalize().negate();
  const x = _fx.crossVectors(upHint, z);
  if (x.lengthSq() < 1e-8) x.set(1, 0, 0).cross(z);
  x.normalize();
  const y = _fy.crossVectors(z, x);
  out.makeBasis(x, y, z);
  out.setPosition(origin);
  return out;
}

// ---------------------------------------------------------------
// 재질: MeshStandardMaterial + 패치 (정점 표면 속성·세부 텍스처·요철·가짜 환경 반사)
//  aSurf = (kind, 거칠기, 금속성). kind: 0 쇠, 1 나무, 2 그립(체커링), 3 맨 쇠, 4 황동, 5 천, 6 피부
// ---------------------------------------------------------------
function makeSurfaceMaterial(detail, env) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = { value: detail };
    shader.uniforms.uEnvSky = env.sky;
    shader.uniforms.uEnvGround = env.ground;
    shader.uniforms.uBump = env.bump;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aSurf;\nvarying vec3 vSurf;\nvarying vec2 vDetUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vSurf = aSurf;\n  vDetUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uDetail;
uniform vec3 uEnvSky;
uniform vec3 uEnvGround;
uniform float uBump;
varying vec3 vSurf;
varying vec2 vDetUv;
float wvK( float kind, float k ) { return 1.0 - step( 0.5, abs( kind - k ) ); }
// 화면 미분 요철 (three 의 범프맵과 같은 식, 높이를 재질별 텍스처 채널 조합으로)
vec3 wvPerturb( vec3 pos, vec3 nrm, vec2 dH, float faceDir ) {
  vec3 sx = dFdx( pos ), sy = dFdy( pos );
  vec3 r1 = cross( sy, nrm ), r2 = cross( nrm, sx );
  float det = dot( sx, r1 ) * faceDir;
  vec3 grad = sign( det ) * ( dH.x * r1 + dH.y * r2 );
  return normalize( abs( det ) * nrm - grad );
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  vec4 wvDet = texture2D( uDetail, vDetUv );
  float wvKind = vSurf.x;
  float kSteel = wvK( wvKind, 0.0 ), kWood = wvK( wvKind, 1.0 ), kGrip = wvK( wvKind, 2.0 ), kBright = wvK( wvKind, 3.0 );
  float kBrass = wvK( wvKind, 4.0 ), kFab = wvK( wvKind, 5.0 ), kSkin = wvK( wvKind, 6.0 );
  float wvMetalK = kSteel + kBright;
  // 흠집 = 맨 쇠가 드러난 곳 (R 0.75 이상)
  float wvScratch = smoothstep( 0.72, 0.9, wvDet.r ) * wvMetalK;
  float wvAlb = 1.0;
  wvAlb *= mix( 1.0, 0.8 + 0.4 * wvDet.r, wvMetalK + kBrass );
  wvAlb *= mix( 1.0, 0.55 + 0.75 * wvDet.g, kWood );
  wvAlb *= mix( 1.0, 0.82 + 0.3 * wvDet.b, kGrip );
  wvAlb *= mix( 1.0, ( 0.8 + 0.3 * wvDet.r ) * ( 0.84 + 0.24 * wvDet.b ), kFab );
  wvAlb *= mix( 1.0, 0.86 + 0.26 * wvDet.g, kSkin );
  float wvGrime = wvDet.a;
  diffuseColor.rgb *= wvAlb * ( 1.0 - 0.3 * wvGrime * ( wvMetalK + kWood + kGrip ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.07, 0.055, 0.035 ), wvGrime * ( 0.4 * kFab + 0.42 * kSkin ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.2, 0.2, 0.21 ), wvScratch * 0.75 );`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = vSurf.y;
  roughnessFactor += wvMetalK * ( ( 0.5 - wvDet.r ) * 0.22 - wvScratch * 0.16 + wvGrime * 0.12 );
  roughnessFactor += kWood * ( wvGrime * 0.25 + ( 0.5 - wvDet.g ) * 0.12 );
  roughnessFactor += kGrip * ( ( 1.0 - wvDet.b ) * 0.18 + wvGrime * 0.2 );
  roughnessFactor += kSkin * ( ( wvDet.g - 0.5 ) * 0.24 + wvGrime * 0.15 );   // 땀이 밴 곳은 번들, 흙 묻은 곳은 거칠게
  roughnessFactor = clamp( roughnessFactor, 0.06, 1.0 );`)
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = clamp( vSurf.z + wvScratch * 0.3 - wvGrime * 0.15 * wvMetalK, 0.0, 1.0 );')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  {
    // 높이 = 재질별 채널: 쇠 R(패임·흠집), 나무 G(결), 그립 B(체커링), 천 R(짜임) + B(주름), 피부 G
    vec4 wvHW = vec4( 0.35 * wvMetalK + 0.6 * kFab, 0.5 * kWood + 0.35 * kSkin, 1.3 * kGrip + 0.9 * kFab, 0.0 );
    vec2 wvDu = dFdx( vDetUv ), wvDv = dFdy( vDetUv );
    float wvH0 = dot( wvDet, wvHW );
    float wvH1 = dot( texture2D( uDetail, vDetUv + wvDu ), wvHW );
    float wvH2 = dot( texture2D( uDetail, vDetUv + wvDv ), wvHW );
    normal = wvPerturb( - vViewPosition, normal, vec2( wvH1 - wvH0, wvH2 - wvH0 ) * uBump, faceDirection );
  }`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
  #if defined( RE_IndirectSpecular )
  {
    // 가짜 환경 반사: 반사 방향의 높이로 하늘·땅 색을 섞는다. 거칠수록 평균색에 가까워진다
    vec3 wvR = inverseTransformDirection( reflect( - geometryViewDir, geometryNormal ), viewMatrix );
    vec3 wvEnv = mix( uEnvGround, uEnvSky, smoothstep( -0.3, 0.5, wvR.y ) );
    wvEnv = mix( wvEnv, 0.5 * ( uEnvGround + uEnvSky ), clamp( material.roughness * 1.15, 0.0, 1.0 ) );
    radiance += wvEnv;
  }
  #endif`);
  };
  mat.customProgramCacheKey = () => 'weaponview-surface-1';
  return mat;
}

/**
 * 가산 화염판: 텍스처가 검은 곳은 출력도 정확히 0.
 * 공용 톤 보정(Materials.installShaderChunks 의 대비 곡선)이 선형 0 을 약 0.0012 (sRGB 4/255) 로 올려 놓아,
 * 가산 혼합에서는 판 전체가 희미한 사각형(무작위 회전이면 마름모)으로 하늘 위에 보인다 → 텍스처 밝기로 가린다.
 * 0.002(선형) 아래만 줄어들어 눈에 보이는 빛무리 모양은 그대로다.
 */
function patchFlashBlack(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', `#include <map_fragment>
  float wvFlashMask = 1.0;
  #ifdef USE_MAP
    wvFlashMask = clamp( max( max( sampledDiffuseColor.r, sampledDiffuseColor.g ), sampledDiffuseColor.b ) * 500.0, 0.0, 1.0 );
  #endif`)
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  gl_FragColor.rgb *= wvFlashMask;');
  };
  mat.customProgramCacheKey = () => 'weaponview-flash-1';
  return mat;
}

/**
 * 동작별 키프레임 표. tl = 무기 데이터의 진행표 비율 (magOut·magIn·boltPull·boltRelease) — 소리 이벤트와 같은 순간에 맞춘다.
 *  poses: [{ w: 가중치 키, rot: [pitch, yaw, roll] 최대 기울임 (손잡이 중심), move: [x, y, z] 최대 이동 (조준선 프레임) }]
 *  mag: 탄창 경로 키 (걸쇠 축 기준 총 공간 [x, y, z, 앞으로 젖힘, 기울임]) · weigh: [시작, 끝] 무게 가늠 구간
 *  leftW / rightW: 손이 탄창 / 장전 손잡이로 가는 가중치 키 · bolt: { bp, br } 노리쇠 당김·놓음 시각
 */
function buildActionTracks(kind, tl, dims) {
  const rock = dims.magRockOut;
  const T = { poses: [], mag: null, weigh: null, leftW: null, rightW: null, bolt: null };
  // 탄창을 화면 밖(탄입대 쪽)으로 갖고 갔다 오는 경로: 앞으로 젖혀 빼냄 → 아래·앞 → 탄입대 → (새 탄창) → 앞 걸쇠를 걸고 → 뒤로 젖혀 '딸깍'
  const magPath = (fo, fi, keyOut) => {
    const pouch = [-0.13, -0.4, 0.2, rock * 1.6, 0.5];
    return [
      [0, [0, 0, 0, 0, 0]],
      [fo - 0.008, [0, 0, 0, 0, 0]],
      [fo + 0.03, [0, -0.003, -0.003, rock, 0]],
      [fo + 0.075, [0.004, -0.06, -0.022, rock * 1.2, 0.1]],
      [fo + keyOut, pouch],
      [fi - 0.2, pouch],
      [fi - 0.085, [0.004, -0.075, -0.024, rock * 1.15, 0.12]],
      [fi - 0.035, [0, -0.0035, -0.002, rock, 0]],
      [fi, [0, 0, 0, 0, 0]],
      [fi + 0.025, [0, 0.0025, 0, 0, 0]],
      [fi + 0.055, [0, 0, 0, 0, 0]],
    ];
  };
  // 오른손 장전 손잡이 당기기 (빈 상태 재장전 끝·고장 해결): 총을 왼쪽 앞으로 내밀고 오른쪽 면이 위로 보이게 반시계로 기울임
  const charge = (bp, br, start, end) => {
    T.rightW = [[start, 0], [bp - 0.045, 1], [br + 0.02, 1], [Math.min(0.99, br + 0.14), 0]];
    T.poses.push({ w: [[start, 0], [bp - 0.06, 1], [br + 0.06, 1], [end, 0]], rot: [0.12, -0.06, 0.82], move: [-0.1, 0.1, -0.1] });
    T.bolt = { bp, br };
  };
  if (kind === 'reloadTactical' || kind === 'reloadEmpty') {
    const empty = kind === 'reloadEmpty';
    const fo = tl.magOut ?? (empty ? 0.13 : 0.16), fi = tl.magIn ?? (empty ? 0.5 : 0.62);
    // 탄창 구멍이 왼손·눈 쪽을 향하게: 총을 화면 안으로 올리고 시계 방향으로 기울이며 총구를 왼쪽 위로
    T.poses.push({ w: [[0, 0], [0.1, 1], [fi + 0.07, 1], [empty ? fi + 0.17 : 0.93, 0]], rot: [0.26, 0.28, -0.62], move: [-0.085, 0.135, 0.02] });
    T.mag = magPath(fo, fi, 0.19);
    T.leftW = [[0.02, 0], [fo - 0.035, 1], [fi + 0.07, 1], [fi + 0.2, 0]];
    if (empty) charge(tl.boltPull ?? 0.74, tl.boltRelease ?? 0.82, fi + 0.04, 0.97);
  } else if (kind === 'magCheck') {
    // 탄창을 빼서 눈앞(총 왼쪽)으로 들고 손으로 무게를 가늠한 뒤 다시 끼움 (진행표 없음 → 고정 비율)
    const fo = 0.2, fi = 0.8;
    const show = [-0.05, 0.012, 0.06, rock * 1.6, 0.6];
    T.poses.push({ w: [[0, 0], [0.12, 1], [0.86, 1], [1, 0]], rot: [0.2, 0.22, -0.48], move: [-0.08, 0.14, 0.03] });
    T.mag = [
      [0, [0, 0, 0, 0, 0]],
      [fo - 0.006, [0, 0, 0, 0, 0]],
      [fo + 0.05, [0, -0.003, -0.003, rock, 0]],
      [fo + 0.11, [-0.015, -0.07, -0.015, rock * 1.3, 0.2]],
      [fo + 0.18, show],
      [fi - 0.16, show],
      [fi - 0.07, [0.002, -0.06, -0.02, rock * 1.15, 0.1]],
      [fi - 0.025, [0, -0.0035, -0.002, rock, 0]],
      [fi, [0, 0, 0, 0, 0]],
      [fi + 0.025, [0, 0.0025, 0, 0, 0]],
      [fi + 0.05, [0, 0, 0, 0, 0]],
    ];
    T.weigh = [0.38, 0.66];
    T.leftW = [[0.0, 0], [fo - 0.03, 1], [fi + 0.06, 1], [0.98, 0]];
  } else if (kind === 'clear') {
    charge(tl.boltPull ?? 0.42, tl.boltRelease ?? 0.58, 0.02, 0.97);
  } else {
    return null;
  }
  return T;
}

/** 감쇠 스프링 (목표 0) 한 단계 — 낮은 프레임에서도 안정하게 1/120 s 이하로 쪼개 반암시적 오일러 */
function springStep(state, w, z, dt) {
  const n = Math.max(1, Math.ceil(dt * 120));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    state.v += (-w * w * state.x - 2 * z * w * state.v) * h;
    state.x += state.v * h;
  }
}

export class WeaponView {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} opts  quality: 'low'|'medium'|'high' (또는 CONFIG.graphics 항목), weaponData: 무기 데이터 (기본 CONFIG 기본 무기),
   *                       rng: RNG (탄피·화염 무작위)
   */
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.visible = true;
    this.shooter = null;
    this.rng = opts.rng || new RNG(0x51a7);
    this.time = 0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 1, 0.01, 20);
    this.camera.rotation.order = 'YXZ';

    // ---- 빛 (월드와 같은 해·반구광을 lighting 으로 줄여 씀). 점광원은 항상 장면에 둔다 (켜고 끌 때 셰이더 재컴파일 방지)
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.target.position.set(0, 0, 0);
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x333322, 1);
    this.scene.add(this.hemi);
    this.flashLight = new THREE.PointLight(0xffa850, 0, 2.5, 2);
    this.scene.add(this.flashLight);

    // ---- 재질
    this.env = { sky: { value: new THREE.Color(0.5, 0.55, 0.6) }, ground: { value: new THREE.Color(0.15, 0.14, 0.1) }, bump: { value: 0.00045 } };
    this.textures = {
      rifle: createRifleDetailTexture(512),
      arms: createArmsDetailTexture(256),   // 소매 10cm·손 3.3cm 마다 반복 → 256 으로 충분 (만드는 시간 절반)
      flash: createFlashTexture(256),
    };
    this.rifleMat = makeSurfaceMaterial(this.textures.rifle, this.env);
    this.armsMat = makeSurfaceMaterial(this.textures.arms, this.env);
    this.casingMat = makeSurfaceMaterial(this.textures.rifle, this.env);
    this.flashMat = new THREE.MeshBasicMaterial({
      map: this.textures.flash, color: FLASH_COLOR.clone(), vertexColors: true, transparent: true, depthWrite: false,
      depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    });
    this.flashMat.forceSinglePass = true;   // 가산 혼합은 순서와 무관 → 양면을 한 번에 (그리기 호출 1)
    patchFlashBlack(this.flashMat);

    // ---- 소총 (SkinnedMesh, 뼈 = 총·노리쇠·조정간·방아쇠·탄창)
    this.rifleBones = Object.keys(RIFLE_BONES).map(() => new THREE.Bone());
    this.armBones = Object.keys(ARM_BONES).map(() => new THREE.Bone());
    for (const bn of [...this.rifleBones, ...this.armBones]) { bn.matrixAutoUpdate = false; bn.matrixWorldAutoUpdate = false; }
    this._buildRifle(opts.weaponData || CONFIG.weapons[CONFIG.weapons.default]);
    const arms = buildArms();
    this.indexMcp = arms.indexMcp;
    this.armsMesh = this._skinned(arms.geometry, this.armsMat, this.armBones);
    this.scene.add(this.armsMesh);

    // ---- 화염 (가산 혼합 판 5장 = 한 번에 그림)
    this.flash = new THREE.Mesh(buildFlashGeometry(), this.flashMat);
    this.flash.frustumCulled = false;
    this.flash.matrixAutoUpdate = false;
    this.flash.renderOrder = 10;
    this.flash.visible = false;
    this.scene.add(this.flash);

    // ---- 탄피 (풀) + 고장 해결 때 튀어나가는 불발탄
    this.casings = [];
    this._casingGeo = buildCasing(false);
    this._liveGeo = buildCasing(true);
    this.casingMesh = new THREE.InstancedMesh(this._casingGeo, this.casingMat, 12);
    this.liveMesh = new THREE.InstancedMesh(this._liveGeo, this.casingMat, 2);
    for (const m of [this.casingMesh, this.liveMesh]) {
      m.frustumCulled = false; m.count = 0; m.visible = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(m);
    }

    // ---- 상태
    this._camPos = new THREE.Vector3();
    this._camQuat = new THREE.Quaternion();
    this._prevCamPos = new THREE.Vector3();
    this._camVel = new THREE.Vector3();
    this._hasPrev = false;
    this._aimQuat = new THREE.Quaternion();
    this._gunLocal = new THREE.Matrix4();
    this._gunWorld = new THREE.Matrix4();      // 카메라 기준 월드
    this._lag = new THREE.Vector3();
    this._settle = { x: 0, v: 0 }; this._lastRest = 0;   // 거치 순간 스프링 (lowerM 배)
    this._jolt = { x: 0, v: 0 };                         // 탄창 끼움·노리쇠 놓음 충격 스프링
    this._boltAge = 1; this._ejectPending = false;
    this._flashAge = 1; this._flashFrames = 0; this._flashRoll = 0; this._flashScale = 1; this._flashLevel = 0; this._flashFresh = false;
    this._trigHold = 0; this._twitchAge = 1;
    this._selAngle = this.dims.selector.semi; this._selFrom = this._selAngle; this._selTo = this._selAngle; this._selAge = 1;
    this._ejectLive = false;
    this._actionRef = null; this._tracksFor = null; this._tracks = null;
    this._indexLift = 0;
    this._handL = new THREE.Matrix4();
    this._handR = new THREE.Matrix4();
    this._magWorld = new THREE.Matrix4();
    this._boltTravel = 0;
    this._actOut = { pos: new THREE.Vector3(), rot: new THREE.Vector3(), leftW: 0, rightW: 0, bolt: 0, mag: [0, 0, 0, 0, 0] };
    this.stats = { calls: 0 };

    this.setQuality(opts.quality ?? CONFIG.defaults.quality);
    this._applyLighting(null);
    // 첫 프레임 끊김 방지: 미리 컴파일 (보이지 않는 화염·탄피도 포함)
    try {
      this.flash.visible = this.casingMesh.visible = this.liveMesh.visible = true;
      this.casingMesh.count = this.liveMesh.count = 1;
      renderer?.compile?.(this.scene, this.camera);
    } catch { /* 일부 환경 미지원 */ }
    this.flash.visible = this.casingMesh.visible = this.liveMesh.visible = false;
    this.casingMesh.count = this.liveMesh.count = 0;
  }

  // -----------------------------------------------------------------
  // 공개 API
  // -----------------------------------------------------------------
  /** Shooter 를 붙인다 (이벤트 구독). 다른 Shooter 로 바꾸면 이전 구독은 끊는다 */
  attach(shooter) {
    if (this._detach) { this._detach(); this._detach = null; }
    this.shooter = shooter || null;
    if (!shooter) return;
    const data = shooter.weapon?.data;
    if (data && (data.sightRadius !== this.dims.sightRadius || data.sightHeight !== this.dims.sightHeight || (data.model ?? 'wood') !== this._model)) this._buildRifle(data);
    if (typeof shooter.on !== 'function') return;
    const subs = [
      ['fired', (e) => this._onFired(e)],
      ['modeChange', (e) => this._onModeChange(e)],
      ['dryFire', () => { this._twitchAge = 0; }],
      ['magOut', () => { this._joltImpulse(-0.6); }],
      ['magIn', () => { this._joltImpulse(1.0); }],
      ['boltPull', (e) => { if (e && e.kind === 'clear') this._ejectLive = true; }],
      ['boltRelease', () => { this._joltImpulse(1.3); }],
      // 동작이 시작되면 방아쇠 손가락을 푼다 (애니메이션 자체는 weapon.action 진행률이 이끈다)
      ['reloadStart', () => this._releaseTrigger()],
      ['magCheckStart', () => this._releaseTrigger()],
      ['clearStart', () => this._releaseTrigger()],
    ];
    const offs = subs.map(([type, fn]) => {
      const off = shooter.on(type, fn);
      return typeof off === 'function' ? off : () => shooter.off?.(type, fn);
    });
    this._detach = () => offs.forEach((off) => off());
    const mode = shooter.weapon?.mode;
    if (mode) this._selAngle = this._selFrom = this._selTo = this._modeAngle(mode);
  }

  /**
   * @param {number} dt
   * @param {THREE.PerspectiveCamera} mainCamera  월드 카메라 (CameraRig 가 이번 프레임 위치·회전을 정한 뒤)
   * @param {object} state  { shooter, motor (stance, gait, gaitPhase, moveFactor, speed, stanceProgress), sprinting, lighting }
   */
  update(dt, mainCamera, state = {}) {
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    this.time += dt;
    if (state.shooter && state.shooter !== this.shooter) this.attach(state.shooter);
    const sh = this.shooter;
    const aim = sh?.aim || DEFAULT_AIM;
    const weapon = sh?.weapon || null;
    const motor = state.motor || null;

    // ---- 1) 카메라 동기화 (카메라 기준 월드: 위치는 원점, 회전·시야각은 주 카메라와 같음)
    mainCamera.updateWorldMatrix(true, false);
    mainCamera.matrixWorld.decompose(this._camPos, this._camQuat, _s1);
    const cam = this.camera;
    if (cam.fov !== mainCamera.fov || cam.aspect !== mainCamera.aspect || cam.zoom !== mainCamera.zoom) {
      cam.fov = mainCamera.fov; cam.aspect = mainCamera.aspect; cam.zoom = mainCamera.zoom;
      cam.updateProjectionMatrix();
    }
    cam.position.set(0, 0, 0);
    cam.quaternion.copy(this._camQuat);
    cam.updateMatrixWorld(true);
    if (this._hasPrev && dt > 1e-4) {
      this._camVel.subVectors(this._camPos, this._prevCamPos).divideScalar(dt);
      if (this._camVel.lengthSq() > 15 * 15) this._camVel.set(0, 0, 0);   // 순간이동
    }
    this._prevCamPos.copy(this._camPos);
    this._hasPrev = true;

    // ---- 2) 조준선 프레임: 앞 = sight.dir, 기울기(roll) = 카메라 기울기 (기울이기·걸음 기울기에 총도 같이)
    _e1.setFromQuaternion(this._camQuat, 'YXZ');
    const camRoll = _e1.z;
    const dir = sh?.sight?.dir;
    let yawS = _e1.y, pitchS = _e1.x;
    if (dir && Number.isFinite(dir.x) && (dir.x * dir.x + dir.y * dir.y + dir.z * dir.z) > 1e-6) {
      const l = Math.hypot(dir.x, dir.y, dir.z);
      yawS = Math.atan2(-dir.x, -dir.z);
      pitchS = Math.asin(clamp(dir.y / l, -1, 1));
    }
    _e2.set(pitchS, yawS, camRoll, 'YXZ');
    this._aimQuat.setFromEuler(_e2);

    // ---- 3) 내부 타이머·스프링
    this._updateTimers(dt, aim, weapon);

    // ---- 4) 총 자세
    this._computeGunPose(dt, aim, weapon, motor);

    // ---- 5) 뼈: 총
    const RB = this.rifleBones, P = this.points;
    RB[RIFLE_BONES.root].matrixWorld.copy(this._gunWorld);
    const boltZ = Math.max(this._boltTravel, this._actOut.bolt);
    RB[RIFLE_BONES.bolt].matrixWorld.multiplyMatrices(this._gunWorld, _m1.makeTranslation(0, 0, boltZ));
    _m1.makeRotationX(this._selAngle).setPosition(P.selectorPivot);
    RB[RIFLE_BONES.selector].matrixWorld.multiplyMatrices(this._gunWorld, _m1);
    const pull = this._triggerPull();
    _m1.makeRotationX(-pull * this.dims.triggerPull).setPosition(P.triggerPivot);
    RB[RIFLE_BONES.trigger].matrixWorld.multiplyMatrices(this._gunWorld, _m1);
    this._computeMag();
    RB[RIFLE_BONES.mag].matrixWorld.copy(this._magWorld);

    // ---- 6) 손 목표 + 팔 (두 관절 IK)
    this._computeHands();
    this._solveArm(SHOULDER_L, POLE_L, this._handL, ARM_BONES.upperL, ARM_BONES.foreL);
    this._solveArm(SHOULDER_R, POLE_R, this._handR, ARM_BONES.upperR, ARM_BONES.foreR);
    // 검지: 손 × MCP × 굽힘 (방아쇠)
    _m1.makeRotationX(-(pull * 15 - this._indexLift * 30) * DEG).setPosition(this.indexMcp);
    this.armBones[ARM_BONES.indexR].matrixWorld.multiplyMatrices(this._handR, _m1);

    // ---- 7) 화염·탄피·빛
    this._updateFlash(dt);
    this._updateCasings(dt);
    this._applyLighting(state.lighting || null);
  }

  /** 월드 다음에 호출: 깊이만 지우고 화면 모델을 그린다 (색은 지우지 않음) */
  render(renderer = this.renderer) {
    if (!this.visible || !renderer) return;
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    const before = renderer.info.render.calls;
    renderer.render(this.scene, this.camera);
    this.stats.calls = renderer.info.autoReset ? renderer.info.render.calls : renderer.info.render.calls - before;
    renderer.autoClear = ac;
  }

  /** 총구 월드 위치 + 총열 방향 (연기·화염 FX 용) */
  getMuzzle(outPos = new THREE.Vector3(), outDir = new THREE.Vector3()) {
    outPos.copy(this.points.muzzle).applyMatrix4(this._gunWorld).add(this._camPos);
    outDir.copy(FWD).transformDirection(this._gunWorld);
    return outPos;
  }

  /** (확장) 가늠자 홈 기준점·가늠쇠 끝의 월드 위치 — 조준 정렬 검사·디버그용 */
  getSightPoints(outRear = new THREE.Vector3(), outFront = new THREE.Vector3()) {
    outRear.copy(this.points.rearSight).applyMatrix4(this._gunWorld).add(this._camPos);
    outFront.copy(this.points.frontSight).applyMatrix4(this._gunWorld).add(this._camPos);
    return { rear: outRear, front: outFront };
  }

  /** 품질: 낮음 = 화염 점광원 없음·탄피 6개·텍스처 이방성 1 */
  setQuality(q) {
    let key = typeof q === 'string' ? q : null;
    if (!key && q && typeof q === 'object') key = Object.keys(CONFIG.graphics).find((k) => CONFIG.graphics[k] === q) || (q.shadows === false ? 'low' : 'medium');
    if (!CONFIG.graphics[key]) key = 'medium';
    this.quality = key;
    const low = key === 'low';
    this.maxCasings = low ? 6 : 12;
    const aniso = low ? 1 : key === 'high' ? 8 : 4;
    for (const t of [this.textures.rifle, this.textures.arms]) {
      if (t.anisotropy !== aniso) { t.anisotropy = aniso; t.needsUpdate = true; }
    }
    // 점광원을 빼고 넣는 것은 셰이더 재컴파일 — 품질을 바꿀 때 한 번뿐이라 허용
    if (low && this.flashLight.parent) this.scene.remove(this.flashLight);
    if (!low && !this.flashLight.parent) this.scene.add(this.flashLight);
  }

  dispose() {
    if (this._detach) this._detach();
    for (const g of [this.rifleMesh.geometry, this.armsMesh.geometry, this.flash.geometry, this._casingGeo, this._liveGeo]) g.dispose();
    for (const m of [this.rifleMat, this.armsMat, this.casingMat, this.flashMat]) m.dispose();
    for (const t of Object.values(this.textures)) t.dispose();
    this.rifleMesh.skeleton.dispose();
    this.armsMesh.skeleton.dispose();
  }

  // -----------------------------------------------------------------
  // 만들기
  // -----------------------------------------------------------------
  _skinned(geometry, material, bones) {
    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.bind(new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4())), new THREE.Matrix4());
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  _buildRifle(data) {
    const rifle = buildRifle(data);
    this._model = data.model ?? 'wood';
    this.points = rifle.points;
    this.frames = rifle.frames;
    this.dims = rifle.dims;
    if (this.rifleMesh) {
      this.rifleMesh.geometry.dispose();
      this.rifleMesh.geometry = rifle.geometry;
    } else {
      this.rifleMesh = this._skinned(rifle.geometry, this.rifleMat, this.rifleBones);
      this.scene.add(this.rifleMesh);
    }
  }

  // -----------------------------------------------------------------
  // 이벤트
  // -----------------------------------------------------------------
  _onFired() {
    // 'fired' 는 게임 루프에서 shooter.update 안(이 update 보다 먼저)에 온다 → 바로 다음 update 는 시간을 더하지 않아
    // 쏜 프레임에 화염이 가장 밝게(k = 1) 그려진다 (전에는 60fps 에서 첫 장면이 이미 44%, 30fps 이하는 35%)
    this._flashAge = 0;
    this._flashFresh = true;
    this._flashFrames = 0;
    this._flashRoll = this.rng.range(0, Math.PI * 2);
    this._flashScale = this.rng.range(0.8, 1.2);
    this._boltAge = 0;
    this._ejectPending = true;
    this._trigHold = 0.12;   // 연발 간격(0.1 s)보다 길게 — 쥐고 쏘는 동안 손가락이 떨리지 않게
  }

  _onModeChange(e) {
    this._selFrom = this._selAngle;
    this._selTo = this._modeAngle(e?.mode);
    this._selAge = 0;
  }

  _modeAngle(mode) { return mode === 'auto' ? this.dims.selector.auto : this.dims.selector.semi; }

  _releaseTrigger() { this._trigHold = 0; this._twitchAge = 1; }

  _joltImpulse(k) { this._jolt.v += k; }

  // -----------------------------------------------------------------
  // 타이머·스프링
  // -----------------------------------------------------------------
  _updateTimers(dt, aim, weapon) {
    if (this._flashFresh) this._flashFresh = false; else this._flashAge += dt;
    this._boltAge += dt;
    this._trigHold = Math.max(0, this._trigHold - dt);
    this._twitchAge += dt;
    this._selAge += dt;
    // 조정간: 0.06~0.16 s 사이에 넘어감
    const st = clamp((this._selAge - 0.06) / 0.1, 0, 1);
    this._selAngle = lerp(this._selFrom, this._selTo, st * st * (3 - 2 * st));
    if (weapon && this._selAge > 0.4) {
      const want = this._modeAngle(weapon.mode);
      if (Math.abs(want - this._selTo) > 1e-6) { this._selFrom = this._selAngle; this._selTo = want; this._selAge = 0.06; }
    }
    // 노리쇠 왕복 (사격)
    const a = this._boltAge, T = this.dims.boltTravel;
    if (a < BOLT_BACK_T) { const u = a / BOLT_BACK_T; this._boltTravel = T * (1 - (1 - u) * (1 - u)); }
    else if (a < BOLT_BACK_T + BOLT_RETURN_T) { const u = (a - BOLT_BACK_T) / BOLT_RETURN_T; this._boltTravel = T * (1 - u * u); }
    else this._boltTravel = 0;
    // 거치: restBlend 가 오를 때 총이 툭 내려앉는 순간 스프링 (조준 중엔 이것만 — 계속 내려앉으면 조준선이 어긋난다)
    const rest = clamp(aim.restBlend ?? 0, 0, 1);
    const dRest = rest - this._lastRest;
    if (dRest > 0) this._settle.v -= dRest * 14;   // 최대 약 0.7 × lowerM 만큼 툭 내려앉았다 돌아옴
    this._lastRest = rest;
    springStep(this._settle, 20, 0.55, dt);
    // 탄창 끼움·노리쇠 놓음의 '툭'
    springStep(this._jolt, 26, 0.35, dt);
    // 진행 중인 동작 (weapon.action 은 동작마다 새 객체, 끝나면 null)
    this._actionRef = weapon?.action || null;
  }

  _triggerPull() {
    // 사격 중 쥐고 있음 + 빈 약실·고장 '딸깍' 때 짧게 당겼다 놓음
    const hold = this._trigHold > 0 ? 1 : 0;
    const tw = this._twitchAge;
    const twitch = tw < 0.06 ? tw / 0.06 : tw < 0.17 ? 1 - (tw - 0.06) / 0.11 : 0;
    return Math.max(hold, twitch);
  }

  // -----------------------------------------------------------------
  // 총 자세 (조준선 프레임 기준)
  // -----------------------------------------------------------------
  _computeGunPose(dt, aim, weapon, motor) {
    const ads = clamp(aim.ads ?? 0, 0, 1);
    const free = 1 - ads;                        // 조준 정렬을 깨는 화면 효과는 이 비율로만
    const lowered = clamp(aim.lowered ?? 0, 0, 1);
    const restBlend = clamp(aim.restBlend ?? 0, 0, 1);
    const kick = aim.weaponKick || ZERO_KICK;
    const stance = motor?.stance || 'stand';

    // gunLocal = T(pos) · R(rx,ry,rz: 가늠자 홈 중심) · [손잡이 중심 회전 prx,pry,prz] · [반동]
    // 비조준 자세 (엎드리면 어깨에 더 붙임)
    const hr = POSE.hip.rot, HO = CONFIG.aim.hipOffset;
    const hp0 = HO ? HO.right : POSE.hip.pos[0];
    const hp1 = HO ? -HO.down + this.dims.sightHeight : POSE.hip.pos[1];
    const pm = stance === 'prone' ? clamp(CONFIG.aim.hipProneMix ?? POSE.hipProneMix, 0, 1) : 0;
    const er = POSE.eyeRelief;
    const hx = lerp(hp0, 0, pm), hy = lerp(hp1, 0, pm), hz = lerp(POSE.hip.pos[2], -er, pm);
    // 비조준 ↔ 조준 (지나가는 호)
    const arc = Math.sin(Math.PI * ads);
    const pos = _v1.set(lerp(hx, 0, ads), lerp(hy, 0, ads), lerp(hz, -er, ads));
    pos.x += POSE.adsArc[0] * arc; pos.y += POSE.adsArc[1] * arc; pos.z += POSE.adsArc[2] * arc;
    let rx = hr[0] * free * (1 - pm), ry = hr[1] * free * (1 - pm), rz = hr[2] * free * (1 - pm) + 0.07 * arc;
    let prx = 0, pry = 0, prz = 0;
    // 달리기 낮춘 자세
    if (lowered > 0) {
      const sp = POSE.sprint.pos, sr = POSE.sprint.rot;
      const k = lowered * lowered * (3 - 2 * lowered);
      pos.x = lerp(pos.x, sp[0], k); pos.y = lerp(pos.y, sp[1], k); pos.z = lerp(pos.z, sp[2], k);
      rx *= 1 - k; ry *= 1 - k; rz *= 1 - k;
      prx += sr[0] * k; pry += sr[1] * k; prz += sr[2] * k;
    }
    // 6단계: 총구가 나무·바위·땅에 닿음 → 총을 들어 올리고 뒤로 당김 (그동안 사격 불가 — Game 이 막음), 덤불에 걸림 → 툭 걸렸다 빠짐
    const ob = clamp(this.obstruct ?? 0, 0, 1);
    if (ob > 0) {
      const H = CONFIG.handling.muzzle;
      const k = ob * ob * (3 - 2 * ob);
      const gnd = clamp(this.obstructGround ?? 0, 0, 1);
      pos.z += H.pullBack * k * (1 - gnd);
      pos.y -= 0.03 * k;
      prx += H.raiseDeg * DEG * k;
      prz += 0.12 * k;
    }
    const sn = clamp(this.snag ?? 0, 0, 1);
    if (sn > 0) { prx -= 0.09 * sn; pry += 0.12 * sn; pos.y -= 0.02 * sn; }
    // 자세 전환 중: 총을 잠깐 내림
    if (motor && motor.stanceProgress !== undefined && motor.stanceProgress < 1) {
      const w = Math.sin(Math.PI * clamp(motor.stanceProgress, 0, 1)) * (1 - 0.7 * ads);
      pos.y -= 0.035 * w; prx -= 0.14 * w; prz += 0.1 * w;
    }
    // 걸음 흔들림 (8자: 걸음마다 아래로, 두 걸음에 좌우 한 번)
    if (motor) {
      const gait = motor.gait || 'idle';
      const gm = gait === 'sprint' ? 1.7 : gait === 'quiet' ? 0.6 : gait === 'crouch' ? 0.8 : gait === 'prone' ? 1.1 : 1;
      const amp = clamp(motor.moveFactor ?? 0, 0, 1) * gm * (free * free);
      if (amp > 1e-4) {
        const ph = (motor.gaitPhase || 0) * Math.PI;
        const s1 = Math.sin(ph), c2 = Math.cos(2 * ph);
        pos.x += s1 * 0.009 * amp;
        pos.y -= (0.5 - 0.5 * c2) * 0.008 * amp;
        ry += s1 * 1.1 * DEG * amp;
        rz += s1 * 1.8 * DEG * amp;
        rx += c2 * 0.5 * DEG * amp;
      }
    }
    // 무기 관성: AimModel 의 관성이 이미 조준선에 들어 있고, 비조준에서 조금 더 늦게 따라오게 (총이 무거움)
    const iy = aim.inertiaYaw || 0, ip = aim.inertiaPitch || 0;
    ry += iy * 0.7 * free; rx += ip * 0.7 * free; rz += iy * 0.5 * free;
    pos.x += iy * 0.04 * free; pos.y += ip * 0.04 * free;
    // 이동 관성 (카메라가 위아래·앞뒤로 움직이면 총이 살짝 늦게 따라옴)
    _q1.copy(this._camQuat).invert();
    _v2.copy(this._camVel).applyQuaternion(_q1);
    _v2.multiplyScalar(-0.006).clampLength(0, 0.022);
    this._lag.x = damp(this._lag.x, _v2.x, 9, dt);
    this._lag.y = damp(this._lag.y, _v2.y, 9, dt);
    this._lag.z = damp(this._lag.z, _v2.z, 9, dt);
    pos.addScaledVector(this._lag, free);
    // 거치: 비조준이면 lowerM 만큼 내려앉고, 조준 중에는 순간 스프링만 (정렬 유지)
    const lowerM = CONFIG.aim.rest?.lowerM ?? 0;
    pos.y -= lowerM * restBlend * free;
    pos.y += this._settle.x * lowerM * (0.5 + 0.5 * free);
    // 조정간 튕김: 손이 지렛대로 가는 동안 총이 살짝 기울었다 돌아옴 (비조준에서만)
    const sa = this._selAge;
    const sw = sa < 0.1 ? sa / 0.1 : sa < 0.2 ? 1 : sa < 0.34 ? 1 - (sa - 0.2) / 0.14 : 0;
    rz += 0.05 * sw * free; pos.y += 0.004 * sw * free;
    // 탄창 끼움·노리쇠 놓음의 툭 (충격 1 → 약 3mm·0.4°)
    pos.y += this._jolt.x * 0.09;
    rx += this._jolt.x * 0.2;
    // 동작 (재장전 등): 화면 안으로 끌어올리고 손잡이 중심으로 기울임
    const act = this._actionPose();
    if (act) {
      pos.add(act.pos);
      prx += act.rot.x; pry += act.rot.y; prz += act.rot.z;
    }

    // 조준선 프레임 회전 (YXZ: yaw → pitch → roll)
    _e3.set(rx, ry, rz, 'YXZ');
    _q2.setFromEuler(_e3);
    this._gunLocal.compose(pos, _q2, ONE);
    if (prx || pry || prz) {
      const ap = POSE.pivot;
      _e3.set(prx, pry, prz, 'YXZ');
      _q3.setFromEuler(_e3);
      _m1.makeRotationFromQuaternion(_q3);
      _m1.setPosition(ap[0], ap[1], ap[2]);
      _m1.multiply(_m2.makeTranslation(-ap[0], -ap[1], -ap[2]));
      this._gunLocal.multiply(_m1);
    }
    // 반동: 개머리판 쪽을 중심으로 들림·옆·기울기 + 뒤로
    if (kick.back || kick.up || kick.side || kick.roll) {
      const kp = POSE.kickPivot;
      _e3.set(kick.up || 0, kick.side || 0, kick.roll || 0, 'YXZ');
      _q3.setFromEuler(_e3);
      _m1.makeRotationFromQuaternion(_q3);
      _m1.setPosition(kp[0], kp[1], kp[2] + (kick.back || 0));
      _m1.multiply(_m2.makeTranslation(-kp[0], -kp[1], -kp[2]));
      this._gunLocal.multiply(_m1);
    }
    // 월드 (카메라 기준): 조준선 프레임 = 원점(눈) + _aimQuat
    _m3.makeRotationFromQuaternion(this._aimQuat);
    this._gunWorld.multiplyMatrices(_m3, this._gunLocal);
  }

  // -----------------------------------------------------------------
  // 동작 애니메이션 (weapon.action 진행률 p 와 진행표 비율로 키를 잡는다)
  //  키프레임 표는 동작이 시작될 때 한 번 만든다 (weapon.action 은 동작마다 새 객체) → 프레임마다 배열을 만들지 않음
  //  출력 _actOut: pos (조준선 프레임 이동), rot (손잡이 중심 기울임 pitch·yaw·roll), leftW (왼손 → 탄창),
  //               rightW (오른손 → 장전 손잡이), bolt (m), mag [x, y, z, 앞으로 젖힘, 기울임] (걸쇠 축 기준, 총 공간)
  // -----------------------------------------------------------------
  _actionPose() {
    const o = this._actOut;
    o.pos.set(0, 0, 0); o.rot.set(0, 0, 0);
    o.leftW = 0; o.rightW = 0; o.bolt = 0;
    const mg = o.mag; mg[0] = mg[1] = mg[2] = mg[3] = mg[4] = 0;
    const act = this._actionRef;
    if (!act) return null;
    if (this._tracksFor !== act) { this._tracksFor = act; this._tracks = buildActionTracks(act.kind, act.timeline || {}, this.dims); }
    const T = this._tracks;
    if (!T) return null;
    const p = act.duration > 0 ? clamp(act.t / act.duration, 0, 1) : 0;
    for (const pose of T.poses) {
      const w = keys(p, pose.w);
      if (w === 0) continue;
      o.rot.x += pose.rot[0] * w; o.rot.y += pose.rot[1] * w; o.rot.z += pose.rot[2] * w;
      o.pos.x += pose.move[0] * w; o.pos.y += pose.move[1] * w; o.pos.z += pose.move[2] * w;
    }
    if (T.mag) {
      keysV(p, T.mag, mg);
      if (T.weigh) {
        // 무게 가늠: 손으로 두 번 들썩 (위로 들었다 놓음 + 살짝 젖힘)
        const u = (p - T.weigh[0]) / (T.weigh[1] - T.weigh[0]);
        if (u > 0 && u < 1) {
          const k = Math.sin(u * Math.PI * 4) * Math.sin(u * Math.PI);
          mg[1] += k * 0.012; mg[3] += k * 0.06;
        }
      }
    }
    if (T.leftW) o.leftW = keys(p, T.leftW);
    if (T.rightW) o.rightW = keys(p, T.rightW);
    if (T.bolt) {
      // 노리쇠: 당김(빠르게 뒤로) → 잡고 있음 → 놓으면 튕겨 닫힘
      const { bp, br } = T.bolt, travel = this.dims.boltTravel;
      if (p >= bp - 0.012 && p < br) o.bolt = travel * clamp((p - (bp - 0.012)) / 0.035, 0, 1) ** 0.6;
      else if (p >= br && p < br + 0.012) o.bolt = travel * (1 - (p - br) / 0.012);
    }
    return o;
  }

  /** 탄창 월드 행렬: 끼워진 상태(흔들림·기울임 포함)는 총 × 걸쇠 축, 손에 들린 동안도 같은 경로 (손이 탄창을 따라감) */
  _computeMag() {
    const mg = this._actOut.mag;
    const P = this.points.magPivot;
    _e3.set(mg[3], 0, mg[4], 'XYZ');
    _q1.setFromEuler(_e3);
    _v1.set(P.x + mg[0], P.y + mg[1], P.z + mg[2]);
    _m1.compose(_v1, _q1, ONE);
    this._magWorld.multiplyMatrices(this._gunWorld, _m1);
  }

  // -----------------------------------------------------------------
  // 손·팔
  // -----------------------------------------------------------------
  _computeHands() {
    const F = this.frames, o = this._actOut;
    // 오른손: 손잡이 ↔ 장전 손잡이 (노리쇠와 함께 움직임) + 조정간 튕김
    _m1.compose(F.gripR.pos, F.gripR.quat, ONE);
    // 조정간 튕김: 손이 살짝 앞·위로 갔다 옴 (검지를 펴서 지렛대를 누름)
    const sa = this._selAge;
    const sw = sa < 0.1 ? sa / 0.1 : sa < 0.2 ? 1 : sa < 0.34 ? 1 - (sa - 0.2) / 0.14 : 0;
    this._indexLift = sw;
    if (sw > 0) {
      _m2.makeRotationX(0.2 * sw).setPosition(0.004 * sw, 0.018 * sw, -0.028 * sw);
      _m1.premultiply(_m2);
    }
    this._handR.multiplyMatrices(this._gunWorld, _m1);
    if (o.rightW > 0) {
      _m2.compose(F.chargeR.pos, F.chargeR.quat, ONE);
      _m3.multiplyMatrices(this.rifleBones[RIFLE_BONES.bolt].matrixWorld, _m2);
      blendMatrix(this._handR, _m3, o.rightW);
    }
    // 왼손: 아래 덮개 ↔ 탄창
    _m1.compose(F.guardL.pos, F.guardL.quat, ONE);
    this._handL.multiplyMatrices(this._gunWorld, _m1);
    if (o.leftW > 0) {
      _m2.compose(F.magL.pos, F.magL.quat, ONE);
      _m3.multiplyMatrices(this._magWorld, _m2);
      blendMatrix(this._handL, _m3, o.leftW);
    }
    this.armBones[ARM_BONES.handL].matrixWorld.copy(this._handL);
    this.armBones[ARM_BONES.handR].matrixWorld.copy(this._handR);
  }

  /** 두 관절 IK: 어깨(카메라 공간) → 팔꿈치 → 손목(손 행렬의 원점). 손이 닿지 않으면 어깨를 손 쪽으로 끌어온다 (화면 밖) */
  _solveArm(shoulderLocal, poleLocal, handM, upperIdx, foreIdx) {
    const L1 = ARM_DIMS.upper, L2 = ARM_DIMS.fore;
    const k = this._ik || (this._ik = { S: new THREE.Vector3(), W: new THREE.Vector3(), E: new THREE.Vector3(), d: new THREE.Vector3(), pole: new THREE.Vector3(), up: new THREE.Vector3(), fwd: new THREE.Vector3() });
    const S = k.S.copy(shoulderLocal).applyQuaternion(this._camQuat);
    const W = k.W.setFromMatrixPosition(handM);
    const d = k.d.subVectors(W, S);
    let dist = d.length();
    if (dist < 1e-6) { d.set(0, 0, -1); dist = 1e-6; } else d.multiplyScalar(1 / dist);
    const maxD = (L1 + L2) * 0.985, minD = Math.abs(L1 - L2) + 0.04;
    if (dist > maxD || dist < minD) {
      dist = clamp(dist, minD, maxD);
      S.copy(W).addScaledVector(d, -dist);
    }
    const a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    const pole = k.pole.copy(poleLocal).applyQuaternion(this._camQuat);
    pole.addScaledVector(d, -pole.dot(d));
    if (pole.lengthSq() < 1e-8) pole.set(0, -1, 0);
    pole.normalize();
    const E = k.E.copy(S).addScaledVector(d, a).addScaledVector(pole, h);
    // 상완: 어깨 → 팔꿈치, 위 힌트 = 카메라 위
    k.up.set(0, 1, 0).applyQuaternion(this._camQuat);
    k.fwd.subVectors(E, S);
    frameMatrix(this.armBones[upperIdx].matrixWorld, S, k.fwd, k.up);
    // 하완: 팔꿈치 → 손목, 위 힌트 = 손등 방향 (손을 비틀면 소매도 같이 비틀림)
    k.fwd.subVectors(W, E);
    k.up.set(handM.elements[4], handM.elements[5], handM.elements[6]);
    frameMatrix(this.armBones[foreIdx].matrixWorld, E, k.fwd, k.up);
  }

  // -----------------------------------------------------------------
  // 화염·탄피·빛
  // -----------------------------------------------------------------
  _updateFlash(dt) {
    const a = this._flashAge;
    const on = a < FLASH_TIME || this._flashFrames < 1;
    if (!on || a > 0.2) {
      this.flash.visible = false;
      this._flashLevel = 0;
      return;
    }
    this._flashFrames++;
    const k = clamp(1 - a / FLASH_TIME, 0.35, 1);
    this._flashLevel = k;
    this.flash.visible = true;
    // 화염 공간: 총구 + 총열 방향, 매 발 무작위 회전·크기
    _m1.makeRotationZ(this._flashRoll);
    _m1.setPosition(this.points.muzzle);
    _m2.makeScale(this._flashScale, this._flashScale, this._flashScale * (0.85 + 0.3 * k));
    this.flash.matrix.multiplyMatrices(this._gunWorld, _m1).multiply(_m2);
    this.flash.matrixWorld.copy(this.flash.matrix);
    this.flashMat.color.copy(FLASH_COLOR).multiplyScalar(k);
  }

  _updateCasings(dt) {
    // 새 탄피 (사격 후 EJECT_AT 초) / 고장 해결의 불발탄
    if (this._ejectPending && this._boltAge >= EJECT_AT) { this._ejectPending = false; this._spawnCasing(false); }
    if (this._ejectLive) { this._ejectLive = false; this._spawnCasing(true); }
    let nC = 0, nL = 0;
    const g = CONFIG.ballistics?.gravity ?? 9.81;
    for (const c of this.casings) {
      if (!c.alive) continue;
      c.age += dt;
      if (c.age > CASING_LIFE) { c.alive = false; continue; }
      c.vel.y -= g * dt;
      c.vel.multiplyScalar(1 - 0.4 * dt);
      c.pos.addScaledVector(c.vel, dt);
      _q1.setFromAxisAngle(_v1.copy(c.spin).normalize(), c.spin.length() * dt);
      c.quat.premultiply(_q1);
      _v2.subVectors(c.pos, this._camPos);
      _m1.compose(_v2, c.quat, ONE);
      if (c.live) this.liveMesh.setMatrixAt(nL++, _m1);
      else this.casingMesh.setMatrixAt(nC++, _m1);
    }
    this.casingMesh.count = nC; this.casingMesh.visible = nC > 0;
    this.liveMesh.count = nL; this.liveMesh.visible = nL > 0;
    if (nC) this.casingMesh.instanceMatrix.needsUpdate = true;
    if (nL) this.liveMesh.instanceMatrix.needsUpdate = true;
  }

  _spawnCasing(live) {
    const max = live ? 2 : this.maxCasings;
    let c = null, n = 0, oldest = null;
    for (const k of this.casings) {
      if (k.live !== live) continue;
      n++;
      if (!k.alive) { c = k; break; }
      if (!oldest || k.age > oldest.age) oldest = k;
    }
    if (!c && n < max) { c = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion(), spin: new THREE.Vector3(), live, alive: false, age: 0 }; this.casings.push(c); }
    if (!c) c = oldest;
    if (!c) return;
    const r = this.rng;
    c.alive = true; c.age = 0;
    c.pos.copy(this.points.ejection).applyMatrix4(this._gunWorld).add(this._camPos);
    // 총 공간 속도: 오른쪽·위·조금 앞 (이 계열은 탄피를 오른쪽 앞으로 세게 던진다). 손으로 당긴 불발탄은 힘없이 떨어짐
    if (live) _v1.set(r.range(0.9, 1.5), r.range(0.1, 0.5), r.range(-0.2, 0.2));
    else _v1.set(r.range(2.8, 3.8), r.range(1.0, 1.7), r.range(-1.2, -0.5));
    _q1.setFromRotationMatrix(this._gunWorld);
    c.vel.copy(_v1).applyQuaternion(_q1).add(this._camVel);
    c.quat.copy(_q1).multiply(_q2.setFromEuler(_e3.set(r.range(-0.2, 0.2), r.range(-0.3, 0.3), r.range(0, 6.28), 'XYZ')));
    c.spin.set(r.range(-30, 30), r.range(-40, -15), r.range(-12, 12)).applyQuaternion(_q1);
    if (live) c.spin.multiplyScalar(0.4);
  }

  _applyLighting(L) {
    const D = DEFAULT_LIGHT;
    const shade = clamp(L?.shade ?? D.shade, 0, 1);
    const sunVis = clamp(L?.sunVisible ?? D.sunVisible, 0, 1);
    this.sun.color.copy(L?.sunColor || D.sunColor);
    this.sun.intensity = sunVis;
    this.sun.position.copy(L?.sunDir || D.sunDir).normalize();
    this.sun.updateMatrixWorld();
    // 캐노피 아래 하늘빛: 어둡고 녹색 (월드 셰이더의 canopySkyTint 와 같은 식)
    const t = CONFIG.lighting.canopyTint;
    const hemiI = (L?.hemiIntensity ?? D.hemiIntensity) * (1 - 0.62 * shade);
    this.hemi.color.copy(L?.skyColor || D.skyColor).multiply(_c1.setRGB(lerp(1, t[0], shade), lerp(1, t[1], shade), lerp(1, t[2], shade)));
    this.hemi.groundColor.copy(L?.groundColor || D.groundColor);
    this.hemi.intensity = hemiI;
    // 가짜 환경 반사 색 (하늘 쪽 = 반구광 하늘색, 땅 쪽 = 땅색). 햇빛이 들면 조금 밝게
    this.env.sky.value.copy(this.hemi.color).multiplyScalar(hemiI * (0.55 + 0.25 * sunVis));
    this.env.ground.value.copy(this.hemi.groundColor).multiplyScalar(hemiI * 0.5);
    // 총구 화염 점광원 (화면 모델 장면에만). 월드 쪽 플래시 값이 더 크면 그것을 따름
    const f = Math.max(this._flashLevel, clamp(L?.flash ?? 0, 0, 1) * 0.6);
    this.flashLight.intensity = f * 2.2;
    if (f > 0) this.flashLight.position.copy(this.points.muzzle).setZ(this.points.muzzle.z - 0.05).applyMatrix4(this._gunWorld);
  }
}

/** a ← a 와 b 의 보간 (위치 lerp + 회전 slerp, 배율 1) */
function blendMatrix(a, b, w) {
  if (w <= 0) return a;
  a.decompose(_v1, _q1, _s1);
  b.decompose(_v2, _q2, _s1);
  _v1.lerp(_v2, w);
  _q1.slerp(_q2, w);
  return a.compose(_v1, _q1, ONE);
}
