// 월드 공간 사격 효과 — 착탄(재질별)·부분 관통·잎 파편·피격 먼지·총구 연기·예광탄·탄흔.
//  미리 만든 풀 4개 = 그리기 호출 최대 4개 (효과가 없으면 0개):
//   ① 부드러운 입자: 먼지·흙 튐 줄기·물기둥·물방울·물결 고리·연기·불꽃·원거리 총구 화염·예광
//      (카메라를 향한 사각형을 CPU 에서 세움, 속도 방향으로 늘이기, 수면에 눕히기 / 매 프레임 뒤→앞 정렬, 알파 혼합)
//   ② 파편: 흙덩이·진흙덩이·나무 조각·껍질·돌 조각·대나무·덩굴 섬유·옷 보풀 — 불규칙 팔면체를 늘이고 굴림 (불투명)
//   ③ 잎 조각: 월드 잎 아틀라스(world.textures.atlas)에서 잎이 적당히 찬 작은 창을 골라 씀, 팔랑이며 떨어짐 (알파 테스트)
//   ④ 탄흔: 나무 구멍(어두운 구멍 + 밝게 뜯긴 생나무 테두리)·진흙 자국·바위 깨진 자국·흙 고랑·대나무 구멍
//      (3단계: 땅의 어두운 핏자국도 같은 풀 — 진흙 자국 칸을 검붉게 물들임. 피는 작은 튐·방울·얼룩만, 고어 없음)
//      — 인스턴스 풀(품질별 96~160), 가장 오래된 것부터 재사용, polygonOffset, 수명 끝에 서서히 사라짐
//  조명: 모두 내장 Lambert + 캐노피 조명 패치(월드 표면과 같은 그늘·햇빛 얼룩·녹색 하늘빛) + 프로젝트 높이 안개 청크
//        (Materials.addPatch 로 안개 유니폼이 묶임) → 숲속의 어두운 녹색 빛·ACES 톤에서 표면과 같이 어두워지고 안개에 묻힌다.
//        연기·먼지 판은 법선을 대부분 위로 돌려 보는 방향과 무관하게 하늘빛을 받는다. 불꽃·예광만 발광.
//  월드 장면에 광원을 추가하지 않는다 (셰이더 재컴파일·비용): 총구 화염 빛은 flash 값(0~1, 약 50ms)만 내보내고
//  통합 쪽이 반구광을 잠깐 밝힌다.
//  효과 크기·수명·색은 화면 연출 상수(게임 수치 아님). 중력은 CONFIG.ballistics.gravity, 바람은 env.wind
//  (없으면 셰이더 바람 shared.uWindDir × uWind — 식물이 흔들리는 방향·세기와 같게).
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { RNG } from '../core/rng.js';
import { addPatch, patchCanopy, shared } from './Materials.js';
import { ATLAS, makeLeafAtlas } from './Textures.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------
// 품질별 한도 — 풀은 가장 큰 크기로 한 번만 만들고, 살아 있는 개수만 제한한다
// ---------------------------------------------------------------
const QUALITY = {
  low: { spawn: 0.55, particles: 260, debris: 160, leaves: 80, decals: 96 },
  medium: { spawn: 0.85, particles: 420, debris: 280, leaves: 150, decals: 128 },
  high: { spawn: 1.0, particles: 600, debris: 400, leaves: 220, decals: 160 },
};
const MAX = { particles: 600, debris: 400, leaves: 220, decals: 160 };

const FLASH_TIME = 0.05;          // 총구 화염 빛 (flash 1 → 0, s)
const DECAL_FADE = 8;             // 탄흔이 사라지는 시간 (수명 끝, s)
const SMOKE_WIND = 0.9;           // env.wind 가 없을 때: 셰이더 바람 세기 1 = 이만큼 m/s
const SMALL_DIST = 70;            // 이보다 먼 착탄은 작은 파편·잎 생략 (한 픽셀도 안 됨)
const HAZE_LIGHT = 0.3;           // 먼지·연기가 받는 공기 산란광 (안개 색 × 이 값)
const TRACER_GLOW = 3;            // 예광 발광 배율 (톤 매핑 전) — 너무 크면 ACES 가 채도를 빼 하얗게 날아감
const EMISSIVE_FOG_CUT = 0.1;     // 발광 1 당 안개를 덜 받는 비율 (최대 0.7)

// 입자 모드
const BILL = 0, STREAK = 1, FLAT = 2;

// ---------------------------------------------------------------
// 색 (sRGB → 선형). 파편·먼지·물보라는 '조명을 받는 반사율' — 숲속 빛이 곱해진다
// ---------------------------------------------------------------
const _col = new THREE.Color();
const lin = (hex) => { _col.set(hex); return [_col.r, _col.g, _col.b]; };
const lins = (list) => list.map(lin);
const PAL = {
  dirtSpray: lin('#42321f'), dirtBurst: lin('#4a3a29'), dirtDust: lin('#ab9473'), dirtClod: lins(['#4a3726', '#3b2c1f', '#5a442e']),
  humusSpray: lin('#33281c'), humusBurst: lin('#3e3224'), humusDust: lin('#9c8b6e'), humusClod: lins(['#2e241a', '#3a2c1f', '#251c14']),
  mudSpray: lin('#4a3826'), mudBurst: lin('#3e2f20'), mudWet: lin('#8d7d66'), mudMist: lin('#806d55'), mudClod: lins(['#251b11', '#2f2317', '#1d150d']),
  wood: lins(['#cdb085', '#bb9d6c', '#dcc59a']), bark: lins(['#4a3828', '#5c4834', '#3c2d20']), woodSpray: lin('#6e5638'), woodBurst: lin('#5a4630'), woodDust: lin('#c4b092'),
  rockChip: lins(['#8e8a80', '#a5a196', '#76726a']), rockSpray: lin('#a29d92'), rockDust: lin('#d2ccbe'),
  water: lin('#e6e9e2'), waterMist: lin('#e8ebe4'), ring: lin('#d4dacf'),
  bamboo: lins(['#dccd94', '#cbbb7c', '#97a85a']), bambooSpray: lin('#b9ae7c'), bambooDust: lin('#cdc49c'),
  fiber: lins(['#77693f', '#5e683a', '#8b7b4f']), fiberSpray: lin('#5f5a38'), fiberDust: lin('#a69e7c'),
  cloth: lin('#aaa787'), clothFiber: lins(['#575c39', '#4b4f31', '#6d6c4c']),
  shred: lins(['#4f6a2a', '#5f7a33', '#3f5722']),
  smoke: lin('#d8d9d4'),
  blood: lin('#4a0a08'), bloodMist: lin('#5e1410'),
  // 발광 (선형, 톤 매핑 전 HDR 배율은 emissive)
  spark: [1.0, 0.58, 0.24], flash: [1.0, 0.7, 0.36], tracer: [1.0, 0.26, 0.05],
};
// 잎 조각 틴트 (아틀라스 녹색에 곱함): 싱싱한 잎 / 마른 낙엽 (PlantGeometry DEAD 와 같은 계열)
const LEAF_FRESH = [[1, 1, 1], [0.86, 0.92, 0.82], [1.12, 1.08, 0.78], [0.78, 0.84, 0.74]];
const LEAF_DEAD = [[1.5, 1.08, 0.52], [1.3, 0.9, 0.46], [1.18, 0.96, 0.6], [1.62, 1.2, 0.62]];

// ---------------------------------------------------------------
// 효과 사양 (연출 상수). 각도 °, 길이 m, 시간 s, 속도 m/s
//  입자: mode, cell, n(기본 개수), speed, cone(축 둘레 반각), size(시작) → to(끝), life, alpha, color, drag(1/s, 공기 대비),
//        grav(g 배율, 음수 = 떠오름), wind(바람 따라감 0~1), lift(표면에서 띄우기 × 크기), grow(커지는 곡선 지수),
//        fadeIn, fadeOut(지수), stretch(속도 늘이기 s), emissive, delay, offset(축 방향 출발 거리), jitter, kill(바닥 닿으면 사라짐)
// ---------------------------------------------------------------
const P_SPEC = {
  dirtBurst: { mode: BILL, cell: 'puff', n: 2, speed: [0.8, 1.8], cone: 12, size: [0.14, 0.2], to: [0.6, 0.8], life: [0.35, 0.5], alpha: 1, color: PAL.dirtBurst, drag: 6, lift: 0.4, grow: 3, fadeOut: 1.2 },
  dirtSpray: { mode: STREAK, cell: 'spray', n: 14, speed: [3, 7.5], cone: 13, size: [0.14, 0.26], life: [0.45, 0.85], alpha: 1, color: PAL.dirtSpray, drag: 0.8, grav: 1, stretch: 0.055, kill: true, fadeOut: 1.0 },
  dirtDust: { mode: BILL, cell: 'puff', n: 4, speed: [0.4, 1.4], cone: 62, size: [0.1, 0.16], to: [0.85, 1.15], life: [2.2, 3.2], alpha: 0.8, color: PAL.dirtDust, drag: 2.8, wind: 1, lift: 0.3, grow: 2.6, fadeIn: 0.12, fadeOut: 1.6, delay: [0.03, 0.08], offset: [0.02, 0.08] },
  dirtPlume: { mode: BILL, cell: 'puff', n: 2, speed: [0.4, 1.0], cone: 15, size: [0.12, 0.18], to: [0.6, 0.85], life: [1.4, 2.2], alpha: 0.6, color: PAL.dirtDust, drag: 2.4, wind: 1, lift: 0.2, grow: 2.4, fadeIn: 0.1, fadeOut: 1.6, delay: [0.1, 0.2], offset: [0.25, 0.55] },
  humusBurst: { mode: BILL, cell: 'puff', n: 2, speed: [0.6, 1.4], cone: 12, size: [0.12, 0.18], to: [0.5, 0.7], life: [0.32, 0.45], alpha: 1, color: PAL.humusBurst, drag: 6, lift: 0.4, grow: 3, fadeOut: 1.2 },
  humusSpray: { mode: STREAK, cell: 'spray', n: 9, speed: [2.5, 6], cone: 16, size: [0.12, 0.22], life: [0.4, 0.7], alpha: 0.85, color: PAL.humusSpray, drag: 1, grav: 1, stretch: 0.055, kill: true, fadeOut: 1.4 },
  humusDust: { mode: BILL, cell: 'puff', n: 4, speed: [0.4, 1.2], cone: 62, size: [0.1, 0.15], to: [0.75, 1.05], life: [1.8, 2.6], alpha: 0.72, color: PAL.humusDust, drag: 2.8, wind: 1, lift: 0.3, grow: 2.6, fadeIn: 0.12, fadeOut: 1.5, delay: [0.03, 0.08], offset: [0.02, 0.06] },
  mudBurst: { mode: BILL, cell: 'puff', n: 2, speed: [0.5, 1.2], cone: 14, size: [0.12, 0.18], to: [0.5, 0.7], life: [0.28, 0.4], alpha: 1, color: PAL.mudBurst, drag: 6, lift: 0.4, grow: 3, fadeOut: 1.2 },
  mudSpray: { mode: STREAK, cell: 'spray', n: 10, speed: [2.5, 6], cone: 18, size: [0.14, 0.24], life: [0.4, 0.7], alpha: 1, color: PAL.mudSpray, drag: 0.8, grav: 1, stretch: 0.05, kill: true, fadeOut: 0.9 },
  mudBlob: { mode: STREAK, cell: 'drop', n: 6, speed: [2, 4.5], cone: 30, size: [0.05, 0.09], life: [0.6, 1.0], alpha: 1, color: PAL.mudBurst, drag: 0.4, grav: 1, stretch: 0.02, kill: true, fadeOut: 0.3 },
  mudDrops: { mode: STREAK, cell: 'drop', n: 12, speed: [2, 5.5], cone: 38, size: [0.022, 0.038], life: [0.6, 1.0], alpha: 0.95, color: PAL.mudWet, drag: 0.5, grav: 1, stretch: 0.04, kill: true, fadeOut: 0.4, jitter: 0.03 },
  mudMist: { mode: BILL, cell: 'puff', n: 2, speed: [0.3, 0.8], cone: 30, size: [0.1, 0.14], to: [0.45, 0.6], life: [0.7, 1.1], alpha: 0.38, color: PAL.mudMist, drag: 3, wind: 1, lift: 0.35, grow: 2.2, fadeOut: 1.4 },
  woodSpray: { mode: STREAK, cell: 'spray', n: 5, speed: [3, 7], cone: 28, size: [0.06, 0.11], life: [0.22, 0.38], alpha: 0.9, color: PAL.woodSpray, drag: 1.5, grav: 1, stretch: 0.04, fadeOut: 1.2 },
  woodBurst: { mode: BILL, cell: 'puff', n: 2, speed: [0.6, 1.4], cone: 18, size: [0.1, 0.14], to: [0.48, 0.6], life: [0.25, 0.36], alpha: 1, color: PAL.woodBurst, drag: 6, lift: 0.45, grow: 3, fadeOut: 1.2 },
  woodDust: { mode: BILL, cell: 'puff', n: 3, speed: [0.5, 1.4], cone: 35, size: [0.12, 0.16], to: [0.65, 0.85], life: [1.1, 1.7], alpha: 0.72, color: PAL.woodDust, drag: 3, wind: 1, lift: 0.4, grow: 2.6, fadeIn: 0.05, fadeOut: 1.5, delay: [0.02, 0.06] },
  rockSpray: { mode: STREAK, cell: 'spray', n: 6, speed: [4, 9], cone: 30, size: [0.06, 0.11], life: [0.18, 0.32], alpha: 0.9, color: PAL.rockSpray, drag: 2, grav: 1, stretch: 0.03, fadeOut: 1.2 },
  rockDust: { mode: BILL, cell: 'puff', n: 3, speed: [1.2, 2.6], cone: 35, size: [0.1, 0.14], to: [0.65, 0.85], life: [1.1, 1.8], alpha: 0.78, color: PAL.rockDust, drag: 4, wind: 1, lift: 0.35, grow: 3, fadeOut: 1.5 },
  spark: { mode: STREAK, cell: 'spark', n: 6, speed: [8, 18], cone: 40, size: [0.012, 0.018], life: [0.05, 0.14], alpha: 1, color: PAL.spark, emissive: 5, drag: 1.5, grav: 1, stretch: 0.014, fadeOut: 0.6 },
  waterColumn: { mode: STREAK, cell: 'spray', n: 10, speed: [3, 7], cone: 6, size: [0.08, 0.16], life: [0.9, 1.3], alpha: 0.9, color: PAL.water, drag: 0.6, grav: 1, stretch: 0.07, kill: true, fadeOut: 0.7, jitter: 0.03 },
  waterCrown: { mode: STREAK, cell: 'drop', n: 10, speed: [1.6, 3.6], cone: 50, size: [0.03, 0.05], life: [0.7, 1.0], alpha: 0.9, color: PAL.water, drag: 0.5, grav: 1, stretch: 0.05, kill: true, fadeOut: 0.5, jitter: 0.05 },
  waterDrop: { mode: STREAK, cell: 'drop', n: 16, speed: [2, 5.5], cone: 38, size: [0.014, 0.024], life: [0.8, 1.2], alpha: 0.9, color: PAL.water, drag: 0.5, grav: 1, stretch: 0.03, kill: true, fadeOut: 0.5, jitter: 0.04 },
  waterMist: { mode: BILL, cell: 'puff', n: 2, speed: [0.4, 0.9], cone: 20, size: [0.12, 0.18], to: [0.6, 0.8], life: [0.8, 1.4], alpha: 0.45, color: PAL.waterMist, drag: 2.5, wind: 1, lift: 0.4, grow: 2.2, fadeOut: 1.5, offset: [0.05, 0.15] },
  waterRing: { mode: FLAT, cell: 'ring', n: 2, speed: [0, 0], cone: 0, size: [0.05, 0.07], to: [0.75, 1.0], life: [1.1, 1.5], alpha: 0.55, color: PAL.ring, grow: 1.8, fadeOut: 1.3, delay: [0, 0.15] },
  bambooSpray: { mode: STREAK, cell: 'spray', n: 6, speed: [3, 7], cone: 30, size: [0.07, 0.12], life: [0.22, 0.38], alpha: 0.9, color: PAL.bambooSpray, drag: 1.5, grav: 1, stretch: 0.04, fadeOut: 1.2 },
  bambooDust: { mode: BILL, cell: 'puff', n: 2, speed: [0.4, 1.1], cone: 35, size: [0.08, 0.11], to: [0.4, 0.52], life: [0.8, 1.2], alpha: 0.5, color: PAL.bambooDust, drag: 3, wind: 1, lift: 0.4, grow: 2.4, fadeOut: 1.5 },
  fiberSpray: { mode: STREAK, cell: 'spray', n: 4, speed: [2, 5], cone: 35, size: [0.05, 0.09], life: [0.2, 0.35], alpha: 0.85, color: PAL.fiberSpray, drag: 2, grav: 1, stretch: 0.04, fadeOut: 1.2 },
  fiberDust: { mode: BILL, cell: 'puff', n: 1, speed: [0.3, 0.8], cone: 30, size: [0.07, 0.1], to: [0.32, 0.42], life: [0.8, 1.2], alpha: 0.4, color: PAL.fiberDust, drag: 3, wind: 1, lift: 0.4, grow: 2.4, fadeOut: 1.5 },
  clothPuff: { mode: BILL, cell: 'puff', n: 2, speed: [0.8, 1.6], cone: 30, size: [0.06, 0.09], to: [0.32, 0.42], life: [0.55, 0.95], alpha: 0.62, color: PAL.cloth, drag: 4, wind: 1, lift: 0.3, grow: 2.6, fadeOut: 1.4 },
  smoke: { mode: BILL, cell: 'puff', n: 4, speed: [2.5, 6], cone: 7, size: [0.05, 0.08], to: [0.45, 0.85], life: [1.6, 3.0], alpha: 0.34, color: PAL.smoke, drag: 3.2, grav: -0.015, wind: 1, grow: 1.7, fadeIn: 0.07, fadeOut: 0.8, offset: [0.04, 0.22], jitter: 0.02 },
  blast: { mode: BILL, cell: 'puff', n: 2, speed: [5, 9], cone: 6, size: [0.05, 0.07], to: [0.24, 0.32], life: [0.2, 0.32], alpha: 0.55, color: PAL.smoke, drag: 7, wind: 0.5, grow: 2.5, fadeOut: 1.2, offset: [0.02, 0.06] },
  groundBlast: { mode: BILL, cell: 'puff', n: 2, speed: [0.8, 2], cone: 25, size: [0.1, 0.15], to: [0.5, 0.7], life: [1.0, 1.6], alpha: 0.3, color: PAL.dirtDust, drag: 2.5, wind: 1, lift: 0.4, grow: 2.2, fadeOut: 1.4 },
  // 3단계 피격: 작은 피 안개 + 방울 (고어 없음 — 멀리선 거의 안 보일 만큼)
  bloodMist: { mode: BILL, cell: 'puff', n: 2, speed: [0.3, 0.9], cone: 25, size: [0.03, 0.05], to: [0.14, 0.22], life: [0.22, 0.4], alpha: 0.5, color: PAL.bloodMist, drag: 5, grow: 2.5, fadeOut: 1.3 },
  bloodDrops: { mode: STREAK, cell: 'drop', n: 6, speed: [0.8, 2.6], cone: 32, size: [0.008, 0.016], life: [0.5, 0.9], alpha: 0.95, color: PAL.blood, drag: 0.6, grav: 1, stretch: 0.03, kill: true, fadeOut: 0.4, jitter: 0.02 },
  remoteFlash: { mode: BILL, cell: 'flash', n: 1, speed: [0, 0], cone: 0, size: [0.28, 0.42], life: [0.035, 0.05], alpha: 1, color: PAL.flash, emissive: 10, fadeOut: 0.5, offset: [0.05, 0.1] },
};
//  파편: size(대표 크기) × shape [x, y, z] 배율 (z 가 길면 가시·섬유), bounce(튕김 0 = 붙음), spin(rad/s)
const D_SPEC = {
  dirtClod: { n: 10, speed: [2, 7], cone: 26, size: [0.007, 0.022], shape: [1, 0.8, 1], life: [2.5, 4], bounce: 0.15, spin: 20, drag: 0.4, colors: PAL.dirtClod },
  humusClod: { n: 6, speed: [2, 6], cone: 28, size: [0.007, 0.02], shape: [1, 0.8, 1], life: [2.5, 4], bounce: 0.1, spin: 18, drag: 0.4, colors: PAL.humusClod },
  mudClod: { n: 8, speed: [1.5, 4.5], cone: 30, size: [0.012, 0.032], shape: [1, 0.75, 1.1], life: [3, 5], bounce: 0, spin: 10, drag: 0.3, colors: PAL.mudClod },
  splinter: { n: 10, speed: [4, 10], cone: 40, size: [0.02, 0.06], shape: [0.09, 0.07, 1], life: [3, 5], bounce: 0.3, spin: 26, drag: 0.8, colors: PAL.wood },
  barkChip: { n: 5, speed: [2, 6], cone: 50, size: [0.008, 0.018], shape: [1, 0.3, 0.9], life: [3, 5], bounce: 0.25, spin: 22, drag: 0.8, colors: PAL.bark },
  rockChip: { n: 7, speed: [5, 12], cone: 45, size: [0.004, 0.012], shape: [1, 0.7, 1], life: [2, 3.5], bounce: 0.35, spin: 30, drag: 0.3, colors: PAL.rockChip },
  bambooFiber: { n: 10, speed: [3, 8], cone: 40, size: [0.04, 0.1], shape: [0.07, 0.05, 1], life: [3, 5], bounce: 0.3, spin: 24, drag: 1, colors: PAL.bamboo },
  vineFiber: { n: 10, speed: [1.5, 5], cone: 50, size: [0.04, 0.09], shape: [0.06, 0.05, 1], life: [3, 5], bounce: 0.2, spin: 18, drag: 1.4, colors: PAL.fiber },
  clothFiber: { n: 4, speed: [1, 3], cone: 50, size: [0.004, 0.01], shape: [1, 0.4, 1.4], life: [1.5, 2.5], bounce: 0.1, spin: 16, drag: 2, colors: PAL.clothFiber },
  leafShred: { n: 3, speed: [1, 3], cone: 40, size: [0.004, 0.008], shape: [1, 0.25, 1.2], life: [2, 3.5], bounce: 0, spin: 14, drag: 3, colors: PAL.shred },
};
//  잎: size(한 변), fall(떨어지는 속도), sway(좌우 흔들림 진폭), freq(Hz)
const L_SPEC = {
  litter: { n: 8, speed: [1.5, 4], cone: 35, size: [0.045, 0.085], life: [3, 6], tints: LEAF_DEAD, fall: [0.6, 1.1], sway: [0.08, 0.2], freq: [0.7, 1.3] },
  fresh: { n: 6, speed: [0.5, 2], cone: 60, size: [0.04, 0.075], life: [4, 7], tints: LEAF_FRESH, fall: [0.45, 0.9], sway: [0.1, 0.26], freq: [0.6, 1.2] },
  bits: { n: 2, speed: [1, 3], cone: 45, size: [0.022, 0.045], life: [3, 5], tints: LEAF_FRESH, fall: [0.6, 1.1], sway: [0.06, 0.15], freq: [0.8, 1.5] },
};
//  탄흔: cell, size [폭], aspect(세로/가로), life
const DECAL_SPEC = {
  wood: { cells: 'hole', size: [0.08, 0.105], aspect: 1, life: 90 },
  mud: { cells: 'splat', size: [0.24, 0.34], aspect: 1, life: 60 },
  rock: { cells: 'chip', size: [0.09, 0.12], aspect: 1, life: 90 },
  dirt: { cells: 'scuff', size: [0.13, 0.18], aspect: 1.3, life: 45 },
  bamboo: { cells: 'bhole', size: [0.05, 0.065], aspect: 1, life: 90 },
  blood: { cells: 'splat', size: [0.16, 0.3], aspect: 1, life: 240 },
};
// 핏자국 색 (진흙 자국 칸 × 이 배율 → 어두운 검붉은 얼룩)
const BLOOD_TINT = [1.55, 0.42, 0.36];

// ---------------------------------------------------------------
// 효과 아틀라스 (1024×512, 128px 칸 8×4) — 픽셀 계산, 외부 파일 없음
//  입자 칸은 흰색 + 알파(색은 인스턴스가 곱함), 탄흔 칸은 sRGB 반사율 + 알파.
//  투명 픽셀에도 이웃 색을 채워 둔다 (밉맵·선형 보간 때 검은 테두리가 생기지 않게).
// ---------------------------------------------------------------
const AW = 1024, AH = 512, CS = 128, COLS = AW / CS;
const CELL = {
  puff: [0, 1, 2, 3], spray: [4, 5], spark: [6], ring: [7],
  drop: [8], flash: [9],
  hole: [16, 17], splat: [18, 19], chip: [20, 21], scuff: [22, 23], bhole: [24],
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; };

/** 주기 값 노이즈 (0~1) */
function valueNoise(seed, n = 32) {
  const rng = new RNG(seed);
  const g = new Float32Array(n * n);
  for (let i = 0; i < g.length; i++) g[i] = rng.float();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % n) + n) % n, y0 = ((yi % n) + n) % n, x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
    const a = g[y0 * n + x0], b = g[y0 * n + x1], c = g[y1 * n + x0], d = g[y1 * n + x1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
function fbm(nz, x, y, oct = 4) {
  let s = 0, a = 0.5, f = 1, t = 0;
  for (let o = 0; o < oct; o++) { s += a * nz(x * f, y * f); t += a; a *= 0.5; f *= 2.07; }
  return s / t;
}
/** 각도에 대해 주기적인 들쭉날쭉함 (-1~1 근처) — 테두리 모양용. 사인 합을 표로 미리 구해 둠 (픽셀마다 수십 번 부름) */
function polarNoise(rng, harmonics = 7, k0 = 2) {
  const terms = [];
  for (let k = k0; k < k0 + harmonics; k++) terms.push([k, rng.range(0, TAU), rng.range(0.4, 1) / Math.sqrt(k)]);
  const norm = terms.reduce((s, t) => s + t[2], 0) * 0.6;
  const N = 1024, lut = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * TAU;
    let s = 0;
    for (const [k, ph, a] of terms) s += a * Math.sin(k * th + ph);
    lut[i] = s / norm;
  }
  return (th) => {
    let x = (th / TAU) % 1;
    if (x < 0) x += 1;
    const f = x * N, i = f | 0, t = f - i;
    return lut[i] + (lut[i + 1] - lut[i]) * t;
  };
}

function paintPuff(seed) {
  const n1 = valueNoise(seed, 16), n2 = valueNoise(seed + 7, 32);
  const ox = (seed % 7) * 1.37, oy = (seed % 5) * 2.11;
  return (u, v, o) => {
    const r = Math.hypot(u, v);
    const big = fbm(n1, u * 1.7 + ox, v * 1.7 + oy, 3);
    const fine = fbm(n2, u * 4.6 + oy, v * 4.6 + ox, 3);
    const edge = 0.8 + (big - 0.5) * 0.4;
    let a = 1 - sstep(edge - 0.55, edge + 0.1, r);
    a *= 0.78 + 0.85 * (big - 0.45) + 0.4 * (fine - 0.5);
    a *= 1 - sstep(0.76, 0.88, r);
    const l = 0.9 + 0.2 * (fine - 0.5);
    o[0] = l; o[1] = l; o[2] = l; o[3] = clamp01(a);
  };
}
function paintSpray(seed) {
  const rng = new RNG(seed);
  const nz = valueNoise(seed, 32);
  const strands = [];
  for (let k = 0; k < 7; k++) strands.push({ u: rng.range(-0.55, 0.55), w: rng.range(0.08, 0.2), top: rng.range(0.4, 0.9), skew: rng.range(-0.12, 0.12), a: rng.range(0.5, 0.9) });
  return (u, v, o) => {
    // 머리(+v, 진행 방향)는 넓고 덩어리지고 꼬리(-v)는 가는 가닥으로 흩어짐
    const head = (v + 1) * 0.5;
    const cw = 0.18 + 0.4 * head;
    const core = Math.exp(-((u / cw) ** 2)) * sstep(-0.9, -0.2, v) * (1 - sstep(0.62, 0.95, v));
    let a = core * 0.9;
    for (const s of strands) {
      const du = (u - s.u * (0.4 + 0.6 * head) - s.skew * v) / (s.w * (0.5 + 0.5 * head));
      const along = sstep(-0.97, -0.55, v) * (1 - sstep(s.top - 0.3, s.top, v));
      a = Math.max(a, Math.exp(-du * du) * along * s.a);
    }
    a *= 0.4 + 1.0 * fbm(nz, u * 3.4 + 2, v * 4.5 + 1, 3);
    a *= 1 - sstep(0.7, 0.86, Math.abs(u));
    a *= 1 - sstep(0.8, 0.9, Math.abs(v));
    o[0] = 1; o[1] = 1; o[2] = 1; o[3] = clamp01(a);
  };
}
function paintSpark() {
  return (u, v, o) => {
    const across = Math.exp(-((u / 0.42) ** 2));
    const along = sstep(-0.88, -0.25, v) * (1 - sstep(0.5, 0.86, v));
    const head = 0.45 + 0.55 * sstep(-1, 0.55, v);
    o[0] = 1; o[1] = 1; o[2] = 1; o[3] = clamp01(across * along * head * 1.15);
  };
}
function paintRing(seed) {
  const rng = new RNG(seed);
  const pn = polarNoise(rng, 8, 3);
  const pn2 = polarNoise(rng, 6, 5);
  return (u, v, o) => {
    const r = Math.hypot(u, v), th = Math.atan2(v, u);
    const wob = pn(th) * 0.025;
    const d1 = (r - 0.78 - wob) / 0.05, d2 = (r - 0.6 - wob * 0.7) / 0.04;
    let a = Math.exp(-d1 * d1) * (0.7 + 0.3 * pn2(th)) + 0.4 * Math.exp(-d2 * d2);
    a *= 1 - sstep(0.8, 0.9, r);
    o[0] = 1; o[1] = 1; o[2] = 1; o[3] = clamp01(a);
  };
}
function paintDrop() {
  return (u, v, o) => {
    const r = Math.hypot(u, v);
    o[0] = 1; o[1] = 1; o[2] = 1; o[3] = clamp01(1 - sstep(0.2, 0.82, r));
  };
}
function paintFlash(seed) {
  const rng = new RNG(seed);
  const pn = polarNoise(rng, 5, 7);
  return (u, v, o) => {
    const r = Math.hypot(u, v), th = Math.atan2(v, u);
    const spikes = Math.pow(Math.abs(Math.cos(th * 2.5 + 0.3)), 14) * (1 - sstep(0.1, 0.92 + 0.05 * pn(th), r));
    const core = Math.exp(-((r / 0.26) ** 2));
    const glow = Math.exp(-((r / 0.55) ** 2)) * 0.35;
    o[0] = 1; o[1] = 1; o[2] = 1; o[3] = clamp01(core + spikes * 0.9 + glow) * (1 - sstep(0.78, 0.88, r));
  };
}
/** 나무 탄흔: 어두운 구멍 + 결 방향(+v)으로 길게 뜯긴 밝은 생나무 테두리 + 짓눌린 껍질 + 갈라진 금 */
function paintHole(seed) {
  const rng = new RNG(seed);
  const pn = polarNoise(rng, 8), pn2 = polarNoise(rng, 6, 3);
  const nz = valueNoise(seed, 32);
  const cracks = [];
  for (let k = rng.int(3, 5); k > 0; k--) cracks.push({ th: rng.chance(0.6) ? (rng.chance(0.5) ? 1 : -1) * Math.PI / 2 + rng.range(-0.35, 0.35) : rng.range(0, TAU), len: rng.range(0.6, 0.9), w: rng.range(0.014, 0.026) });
  return (u, v, o) => {
    const r = Math.hypot(u, v), th = Math.atan2(v, u);
    const grainDir = Math.pow(Math.abs(Math.sin(th)), 5);
    const rimR = 0.46 + 0.1 * pn(th) + 0.3 * grainDir * (0.65 + 0.35 * pn2(th));
    const holeR = 0.15 + 0.015 * pn2(th * 1.3);
    const grain = fbm(nz, u * 3, v * 15, 3);
    let cr = 0.2, cg = 0.15, cb = 0.1, a = 0;
    if (r < rimR + 0.1) { a = 0.55 * (1 - sstep(rimR, rimR + 0.1, r)); cr = 0.17; cg = 0.12; cb = 0.08; }
    if (r < rimR) {
      const l = 0.66 + 0.3 * grain;
      const inner = 1 - sstep(holeR, holeR + 0.16, r);
      const k = l * (1 - 0.5 * inner);
      cr = 0.8 * k; cg = 0.66 * k; cb = 0.47 * k; a = 0.97;
    }
    for (const c of cracks) {
      if (r <= holeR || r >= c.len) continue;
      const dist = Math.abs(angDiff(th, c.th)) * r;
      const k = Math.exp(-((dist / c.w) ** 2)) * (1 - r / c.len);
      if (k > 0.04) {
        const m = Math.min(1, k * 1.4);
        cr += (0.1 - cr) * m; cg += (0.07 - cg) * m; cb += (0.05 - cb) * m; a = Math.max(a, 0.75 * k);
      }
    }
    if (r < holeR + 0.045) { cr = 0.16; cg = 0.105; cb = 0.07; a = 1; }
    if (r < holeR) { cr = 0.03; cg = 0.024; cb = 0.018; a = 1; }
    a *= 1 - sstep(0.8, 0.9, r);
    o[0] = cr; o[1] = cg; o[2] = cb; o[3] = clamp01(a);
  };
}
/** 진흙 자국: 젖은 검은 진흙 덩어리 + 튄 방향(+v)으로 흩어진 방울 */
function paintSplat(seed) {
  const rng = new RNG(seed);
  const pn = polarNoise(rng, 9);
  const nz = valueNoise(seed, 32);
  const drops = [];
  for (let k = 0; k < 15; k++) {
    const th = rng.chance(0.65) ? Math.PI / 2 + rng.gauss() * 0.55 : rng.range(0, TAU);
    const rad = rng.range(0.6, 0.86);
    const sz = rng.range(0.025, 0.07), e = rng.range(1, 1.9);
    drops.push({ x: Math.cos(th) * rad, y: Math.sin(th) * rad, s: sz, e, c: Math.cos(th), sn: Math.sin(th), reach: sz * e * 1.05 });
  }
  return (u, v, o) => {
    const r = Math.hypot(u, v), th = Math.atan2(v, u);
    const dirK = Math.pow(Math.max(0, Math.sin(th)), 3);
    const edge = 0.5 + 0.1 * pn(th) + 0.16 * dirK;
    let a = 1 - sstep(edge - 0.05, edge + 0.02, r);
    for (const d of drops) {
      const dx = u - d.x, dy = v - d.y;
      if (dx > d.reach || dx < -d.reach || dy > d.reach || dy < -d.reach) continue;
      const along = dx * d.c + dy * d.sn, across = -dx * d.sn + dy * d.c;
      const dd = Math.hypot(along / d.e, across) / d.s;
      if (dd < 1) a = Math.max(a, 1 - sstep(0.7, 1.0, dd));
    }
    const n = fbm(nz, u * 5, v * 5, 3);
    const rim = sstep(edge - 0.2, edge, r);
    const w = 0.09 + 0.06 * n + 0.1 * rim;
    o[0] = w * 1.3; o[1] = w * 0.98; o[2] = w * 0.7;
    o[3] = clamp01(a * 0.95) * (1 - sstep(0.8, 0.9, r));
  };
}
/** 바위 깨진 자국: 밝은 새 깨짐면 + 어두운 구멍 + 돌가루 + 금 */
function paintChip(seed) {
  const rng = new RNG(seed);
  const pn = polarNoise(rng, 5, 3), pn2 = polarNoise(rng, 9, 4);
  const nz = valueNoise(seed, 32);
  const cracks = [];
  for (let k = rng.int(3, 5); k > 0; k--) cracks.push({ th: rng.range(0, TAU), len: rng.range(0.55, 0.85), w: rng.range(0.012, 0.022) });
  return (u, v, o) => {
    const r = Math.hypot(u, v), th = Math.atan2(v, u);
    const chipR = 0.4 + 0.13 * pn(th) + 0.05 * pn2(th);
    const pitR = 0.12 + 0.025 * pn2(th * 1.7);
    const n = fbm(nz, u * 6, v * 6, 3);
    let cr = 0.79, cg = 0.77, cb = 0.71;
    let a = 0.5 * Math.pow(Math.max(0, 1 - r / 0.95), 1.3) * (0.55 + 0.6 * Math.max(0, pn2(th * 1.3)));
    if (r < chipR) {
      const l = (0.5 + 0.12 * n) * (r > chipR - 0.05 ? 0.8 : 1);
      cr = l * 1.03; cg = l; cb = l * 0.93; a = 0.96;
    }
    for (const c of cracks) {
      if (r <= pitR || r >= c.len) continue;
      const dist = Math.abs(angDiff(th, c.th)) * r;
      const k = Math.exp(-((dist / c.w) ** 2)) * (1 - r / c.len);
      if (k > 0.05) { cr += (0.2 - cr) * k; cg += (0.19 - cg) * k; cb += (0.17 - cb) * k; a = Math.max(a, 0.7 * k); }
    }
    if (r < pitR) { cr = 0.12; cg = 0.115; cb = 0.105; a = 1; }
    a *= 1 - sstep(0.8, 0.9, r);
    o[0] = cr; o[1] = cg; o[2] = cb; o[3] = clamp01(a);
  };
}
/** 흙 고랑: 탄이 지나간 방향(+v)으로 긴 젖은 속흙 + 앞쪽에 흩어진 흙 부스러기 */
function paintScuff(seed) {
  const nz = valueNoise(seed, 32), nz2 = valueNoise(seed + 3, 32);
  const rng = new RNG(seed);
  const crumbs = [];
  for (let k = 0; k < 26; k++) {
    // 앞쪽(+v)으로 흩어진 흙 부스러기
    const cv = rng.range(0.3, 0.86), cu = rng.gauss() * 0.24 * (0.6 + cv);
    crumbs.push({ u: cu, v: cv, r: rng.range(0.018, 0.05), l: rng.range(0.22, 0.36) });
  }
  return (u, v, o) => {
    const ex = u / 0.5, ey = (v + 0.06) / 0.84;
    const e = Math.hypot(ex, ey) + 0.2 * (fbm(nz, u * 3 + 1, v * 3 + 2, 3) - 0.5);
    let a = 0.9 * (1 - sstep(0.76, 1.0, e));
    const n = fbm(nz2, u * 8, v * 8, 3);
    const l = 0.16 + 0.06 * n;
    let cr = l * 1.15, cg = l * 0.88, cb = l * 0.62;
    for (const c of crumbs) {
      const d = Math.hypot(u - c.u, v - c.v);
      if (d < c.r) { const k = 1 - sstep(c.r * 0.6, c.r, d); if (k > 0.01) { a = Math.max(a, 0.85 * k); cr = c.l * 1.25; cg = c.l * 0.95; cb = c.l * 0.66; } }
    }
    a *= 1 - sstep(0.8, 0.9, Math.max(Math.abs(u), Math.abs(v)));
    o[0] = cr; o[1] = cg; o[2] = cb; o[3] = clamp01(a);
  };
}
/** 대나무 구멍: 작은 구멍 + 섬유 방향(+v)으로 갈라진 밝은 속살 + 짓눌린 겉껍질 */
function paintBambooHole(seed) {
  const rng = new RNG(seed);
  const ph = rng.range(0, TAU);
  return (u, v, o) => {
    const r = Math.hypot(u, v);
    let cr = 0.36, cg = 0.37, cb = 0.2, a = 0;
    if (r < 0.36) a = 0.38 * (1 - sstep(0.2, 0.36, r));
    const wav = 0.02 * Math.sin(v * 9 + ph);
    const cw = 0.04 * (1 - Math.abs(v)) + 0.008;
    const du = Math.abs(u - wav);
    if (Math.abs(v) < 0.86 && du < cw) {
      a = Math.max(a, 0.93 * (1 - sstep(0.6, 0.86, Math.abs(v))));
      if (du < cw * 0.35) { cr = 0.1; cg = 0.08; cb = 0.05; } else { cr = 0.85; cg = 0.8; cb = 0.6; }
    }
    if (r < 0.21) { cr = 0.82; cg = 0.75; cb = 0.53; a = 1; }
    if (r < 0.15) { cr = 0.06; cg = 0.05; cb = 0.03; a = 1; }
    a *= 1 - sstep(0.8, 0.9, r);
    o[0] = cr; o[1] = cg; o[2] = cb; o[3] = clamp01(a);
  };
}

/** 효과 아틀라스 텍스처 + 칸별 UV 사각형 (u0, v0, du, dv) */
function buildFxAtlas() {
  const data = new Uint8Array(AW * AH * 4);
  const px = new Float32Array(4);
  const paint = (cell, fn, round = true) => {
    const col = cell % COLS, row = Math.floor(cell / COLS);
    for (let y = 0; y < CS; y++) {
      const v = (y + 0.5) / (CS / 2) - 1;
      for (let x = 0; x < CS; x++) {
        const u = (x + 0.5) / (CS / 2) - 1;
        // 둥근 칸은 바깥 모서리를 계산하지 않음 (투명, 색은 가장자리 근처 값으로 남김)
        if (round && u * u + v * v > 1) { px[3] = 0; } else fn(u, v, px);
        const i = ((row * CS + y) * AW + col * CS + x) * 4;
        data[i] = Math.round(clamp01(px[0]) * 255);
        data[i + 1] = Math.round(clamp01(px[1]) * 255);
        data[i + 2] = Math.round(clamp01(px[2]) * 255);
        data[i + 3] = Math.round(clamp01(px[3]) * 255);
      }
    }
  };
  CELL.puff.forEach((c, i) => paint(c, paintPuff(101 + i * 13)));
  CELL.spray.forEach((c, i) => paint(c, paintSpray(201 + i * 7), false));
  paint(CELL.spark[0], paintSpark(), false);
  paint(CELL.ring[0], paintRing(301));
  paint(CELL.drop[0], paintDrop());
  paint(CELL.flash[0], paintFlash(401));
  CELL.hole.forEach((c, i) => paint(c, paintHole(501 + i * 11)));
  CELL.splat.forEach((c, i) => paint(c, paintSplat(601 + i * 11)));
  CELL.chip.forEach((c, i) => paint(c, paintChip(701 + i * 11)));
  CELL.scuff.forEach((c, i) => paint(c, paintScuff(801 + i * 11), false));
  paint(CELL.bhole[0], paintBambooHole(901));
  const tex = new THREE.DataTexture(data, AW, AH, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  // 칸 경계에서 이웃 칸이 번지지 않게 3px 안쪽만 씀 (내용은 칸 가장자리 9px 안쪽에서 이미 투명)
  const rects = new Float32Array((AW / CS) * (AH / CS) * 4);
  for (let i = 0; i < rects.length / 4; i++) {
    const col = i % COLS, row = Math.floor(i / COLS), inset = 3;
    rects[i * 4] = (col * CS + inset) / AW; rects[i * 4 + 1] = (row * CS + inset) / AH;
    rects[i * 4 + 2] = (CS - 2 * inset) / AW; rects[i * 4 + 3] = (CS - 2 * inset) / AH;
  }
  return { texture: tex, rects };
}

// ---------------------------------------------------------------
// 잎 조각: 월드 잎 아틀라스에서 '잎 한 장(또는 작은 잎 몇 장)'이 통째로 들어가는 정사각형 창을 고른다.
//  창 테두리가 거의 투명해야(잎을 자르지 않아야) 날카로운 직선 조각이 아닌 자연스러운 잎 모양이 된다.
//  알파는 DataTexture(Textures.makeLeafAtlas: 행 0 = 아래) 또는 캔버스에서 읽는다. 못 읽으면 칸 안의 고정 창.
// ---------------------------------------------------------------
// [영역, 창 크기 범위(px, 2048 기준), 개수] — 수관 가장자리 잎, 덩굴의 작은 둥근 잎, 대나무 잎, 묘목 잎
const LEAF_SEARCH = [
  ['clusterA', 40, 76, 5], ['clusterC', 56, 104, 5], ['clusterB', 30, 52, 4],
  ['vine', 20, 40, 4], ['bamboo', 34, 70, 3], ['seedling', 30, 56, 3],
];

/** 아틀라스 알파 읽기 (캔버스 좌표: x 오른쪽, y 아래) → { W, H, at(x, y) } 또는 null */
function atlasAlpha(tex) {
  const img = tex?.image;
  if (!img || !img.width || !img.height) return null;
  const W = img.width, H = img.height;
  if (img.data && img.data.length >= W * H * 4) {
    const d = img.data;
    // DataTexture 는 뒤집지 않고 올림 → 데이터 행 0 = v 0 (아래). flipY 면 행 0 = 위
    if (tex.flipY) return { W, H, at: (x, y) => d[(y * W + x) * 4 + 3] };
    return { W, H, at: (x, y) => d[((H - 1 - y) * W + x) * 4 + 3] };
  }
  if (typeof img.getContext === 'function') {
    try {
      const d = img.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
      return { W, H, at: (x, y) => d[(y * W + x) * 4 + 3] };
    } catch { return null; }
  }
  return null;
}

function pickLeafWindows(tex, rng) {
  const A = atlasAlpha(tex);
  const W = A?.W || 2048, H = A?.H || 1024;
  const sx = W / 2048, sy = H / 1024;
  const out = [];
  for (const [name, s0, s1, want] of LEAF_SEARCH) {
    const R = ATLAS[name];
    if (!R) continue;
    const rx = Math.round(R.x * sx), ry = Math.round(R.y * sy), rw = Math.round(R.w * sx), rh = Math.round(R.h * sy);
    const found = [];
    if (A) {
      for (let tries = 0; tries < 500; tries++) {
        const size = Math.round(rng.range(s0, s1) * sx);
        if (size + 8 >= rw || size + 8 >= rh) continue;
        const x0 = rx + rng.int(4, rw - size - 4), y0 = ry + rng.int(4, rh - size - 4);
        // 테두리: 네 변 각 10점 (불투명이면 잎을 자른 것)
        let edge = 0;
        for (let k = 0; k < 10; k++) {
          const t = Math.round((k + 0.5) * size / 10);
          if (A.at(x0 + t, y0) > 64) edge++;
          if (A.at(x0 + t, y0 + size - 1) > 64) edge++;
          if (A.at(x0, y0 + t) > 64) edge++;
          if (A.at(x0 + size - 1, y0 + t) > 64) edge++;
        }
        const edgeCov = edge / 40;
        if (edgeCov > 0.1) continue;
        // 안쪽 76%: 잎이 적당히 차 있어야 (너무 비면 줄기만, 너무 차면 덩어리)
        let fill = 0;
        for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
          if (A.at(x0 + Math.round(size * (0.12 + 0.76 * (i + 0.5) / 8)), y0 + Math.round(size * (0.12 + 0.76 * (j + 0.5) / 8))) > 127) fill++;
        }
        const cov = fill / 64;
        if (cov < 0.3 || cov > 0.85) continue;
        const cx = x0 + size / 2, cy = y0 + size / 2;
        if (found.some((f) => Math.hypot(f.cx - cx, f.cy - cy) < (f.size + size) * 0.35)) continue;
        found.push({ x0, y0, size, cx, cy, score: cov - 2 * edgeCov });
      }
      found.sort((a, b) => b.score - a.score);
    }
    for (const f of found.slice(0, want)) out.push(rectFromPixels(f.x0, f.y0, f.size, W, H));
    // 읽을 수 없거나 못 찾으면 칸 안의 고정 창
    if (!found.length) {
      const size = Math.round(s1 * sx);
      out.push(rectFromPixels(rx + (rw - size) * 0.5, ry + (rh - size) * 0.3, size, W, H));
    }
  }
  const rects = new Float32Array(out.length * 4);
  out.forEach((r, i) => rects.set(r, i * 4));
  return rects;
}
// 캔버스 좌표 → UV (캔버스 위쪽 = v 1: CanvasTexture flipY 와 Textures 의 DataTexture 둘 다)
function rectFromPixels(x, y, size, W, H) {
  return [x / W, 1 - (y + size) / H, size / W, size / H];
}

// ---------------------------------------------------------------
// 셰이더 패치: 인스턴스별 UV 창(aUvRect) · aFx = (투명도, 발광, 부드러운 법선 0~1, -)
// ---------------------------------------------------------------
function patchInstanceFx(material, key, o) {
  return addPatch(material, `combatFx_${key}`, (shader) => {
    const attrs = (o.uv ? 'attribute vec4 aUvRect;\n' : '') + (o.fx ? 'attribute vec4 aFx;\nvarying vec4 vFx;\n' : '');
    let vs = shader.vertexShader.replace('#include <common>', `#include <common>\n${attrs}`);
    if (o.uv) vs = vs.replace('#include <uv_vertex>', '#include <uv_vertex>\n  vMapUv = aUvRect.xy + uv * aUvRect.zw;');
    if (o.fx) vs = vs.replace('#include <color_vertex>', '#include <color_vertex>\n  vFx = aFx;');
    if (o.leafNormal) {
      // 얇은 잎 조각: 기울어도 하늘빛을 받게 법선을 위로 반쯤 섞음 (+ 아래 조각에서 뒷면 뒤집기 제거)
      vs = vs.replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
  transformedNormal = normalize( mix( normalize( transformedNormal ), normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ), 0.55 ) );`);
    }
    if (o.softNormal) {
      // 연기·먼지 판: 카메라를 향한 판 법선 대신 대부분 위를 향한 법선 → 보는 방향과 상관없이 하늘빛·햇빛을 받는다
      vs = vs.replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
  transformedNormal = mix( transformedNormal, normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) * length( transformedNormal ), aFx.z * 0.7 );`);
    }
    shader.vertexShader = vs;
    if (o.leafNormal) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>',
        THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', '/* 잎 조각: 앞뒤 같은 법선 */'));
    }
    if (!o.fx) return;
    let fs = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec4 vFx;');
    fs = fs.replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.a *= vFx.x;');
    if (o.emissive) {
      fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * vFx.y;');
      // 스스로 빛나는 불꽃·예광·원거리 총구 화염은 안개를 뚫고 보인다: 안개 섞기 전 색을 발광 세기만큼 일부 되살림
      // (프로젝트 안개 청크 내용과 무관하게 앞뒤로 감쌈)
      fs = fs.replace('#include <fog_fragment>', `#ifdef USE_FOG
  vec3 fxPreFog = gl_FragColor.rgb;
#endif
#include <fog_fragment>
#ifdef USE_FOG
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fxPreFog, clamp( vFx.y * ${EMISSIVE_FOG_CUT.toFixed(3)}, 0.0, 0.7 ) );
#endif`);
    }
    if (o.haze) {
      // 공기 속 산란광: 먼지·연기는 위(하늘)뿐 아니라 사방에서 오는 빛(안개처럼 밝은 공기)을 받는다.
      // 반구광만 쓰면 깊은 그늘에서 먼지가 땅처럼 새까매져 보이지 않으므로 숲속 안개 색의 일부를 더함
      fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  #ifdef USE_FOG
    totalEmissiveRadiance += diffuseColor.rgb * fogColor * mix( vec3( 1.0 ), uFogCanopy.rgb, uFogCanopy.a ) * ( ${HAZE_LIGHT.toFixed(3)} * vFx.z );
  #endif`);
    }
    shader.fragmentShader = fs;
  });
}

/**
 * 캐노피 빛(햇빛 얼룩·하늘 가림)을 입자 '중심'에서 한 번만 계산 (patchCanopy 뒤에 붙임).
 * 얼룩 무늬는 월드 xz 로 정해지므로 카메라를 향해 선 판에서는 세로줄마다 같은 값이 나와,
 * 얼룩 경계가 먼지 한가운데를 칼로 자른 듯한 세로 선으로 보인다 → 입자 하나는 통째로 그늘이거나 햇빛.
 */
function patchCenterLight(material) {
  return addPatch(material, 'combatFx_centerLight', (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <shadowmap_vertex>', `
  #ifdef USE_INSTANCING
    vPatchWorld = ( modelMatrix * vec4( instanceMatrix[ 3 ].xyz, 1.0 ) ).xyz;
  #endif
  #include <shadowmap_vertex>`);
  });
}

/** 불규칙한 팔면체 (파편 하나) — 반지름 약 1, 납작 음영 */
function chunkGeometry() {
  const rng = new RNG(5);
  const V = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((p) => p.map((c) => c * rng.range(0.72, 1.12)));
  const F = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
  const pos = [];
  for (const f of F) for (const i of f) pos.push(V[i][0], V[i][1], V[i][2]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function instAttr(n, size) {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(n * size), size);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

function makeInstanced(geometry, material, max, name, renderOrder) {
  const mesh = new THREE.InstancedMesh(geometry, material, max);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = instAttr(max, 3);
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = renderOrder;
  mesh.name = name;
  return mesh;
}

const rr = (rng, a) => (a[0] === a[1] ? a[0] : rng.range(a[0], a[1]));
const byDepthDesc = (a, b) => b.depth - a.depth;

function newParticle() {
  return {
    alive: false, age: 0, life: 1, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0,
    size0: 0.1, size1: 0.1, grow: 2, stretch: 0, rot: 0, rotV: 0, r: 1, g: 1, b: 1,
    alpha: 1, fadeIn: 0, fadeOut: 1, emissive: 0, drag: 0, grav: 0, wind: 0, cell: 0, mode: BILL,
    nx: 0, ny: 1, nz: 0, lift: 0, floor: -Infinity, kill: false, depth: 0, shown: false,
  };
}
function newDebris() {
  return {
    alive: false, age: 0, life: 1, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, ex: 0, ey: 0, ez: 0, wx: 0, wy: 0, wz: 0,
    sx: 0.01, sy: 0.01, sz: 0.01, r: 1, g: 1, b: 1, drag: 0, bounce: 0, settled: false,
    fmode: 0, fpx: 0, fpy: 0, fpz: 0, fnx: 0, fny: 1, fnz: 0,
  };
}
function newLeaf() {
  return {
    alive: false, age: 0, life: 1, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, size: 0.05, win: 0, r: 1, g: 1, b: 1,
    phase: 0, freq: 1, sway: 0.1, fall: 0.8, heading: 0, spin: 0, tumble: 0, tumbleV: 0, tilt: 0, settled: false,
    fmode: 0, fpx: 0, fpy: 0, fpz: 0, fnx: 0, fny: 1, fnz: 0,
  };
}

// 작업용 (할당 없이 재사용)
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export class CombatFX {
  /**
   * @param {THREE.Scene} scene
   * @param {{ textures?: object, quality?: string|object, rng?: RNG, groundHeight?: (x:number, z:number) => number }} opts
   *   textures: world.textures (atlas = 잎 아틀라스 — 없으면 새로 그림)
   *   groundHeight: 지형 높이 함수 (예: (x, z) => query.getTerrainHeight(x, z)) — 있으면 파편·잎이 땅에 내려앉고,
   *                 엎드려 쏠 때 총구 바람이 땅의 흙먼지를 일으킨다. 없으면 착탄면(위를 향한 면)을 바닥으로 본다.
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.rng = opts.rng ?? new RNG((Math.random() * 4294967296) >>> 0);
    this.groundHeight = typeof opts.groundHeight === 'function' ? opts.groundHeight : null;
    this.textures = opts.textures ?? {};
    let atlas = this.textures.atlas ?? null;
    this._ownLeafAtlas = null;
    if (!atlas && typeof document !== 'undefined') atlas = this._ownLeafAtlas = makeLeafAtlas();
    this.fxAtlas = buildFxAtlas();
    this._cells = this.fxAtlas.rects;
    this._leafRects = pickLeafWindows(atlas, new RNG(41));
    this._leafCount = Math.max(1, this._leafRects.length / 4);

    this.root = new THREE.Group();
    this.root.name = 'combatFX';
    this.root.matrixAutoUpdate = false;

    // ① 부드러운 입자 (물 다음, 비 앞에 그림 — 수면 위 물결 고리가 물에 덮이지 않게)
    {
      // 양면(수면 고리를 아래에서 봐도) + 한 번에 그리기 (투명 양면은 three 가 뒷면·앞면 두 번 그림 → 호출 2배)
      const mat = new THREE.MeshLambertMaterial({ map: this.fxAtlas.texture, transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
      patchInstanceFx(mat, 'particle', { uv: true, fx: true, emissive: true, softNormal: true, haze: true });
      patchCanopy(mat, { sun: 1, sky: 0.65 });
      patchCenterLight(mat);
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.setAttribute('aUvRect', instAttr(MAX.particles, 4));
      geo.setAttribute('aFx', instAttr(MAX.particles, 4));
      this.pMesh = makeInstanced(geo, mat, MAX.particles, 'fxParticles', 3);
    }
    // ② 파편
    {
      const mat = new THREE.MeshLambertMaterial({ flatShading: true });
      patchCanopy(mat, { sun: 1, sky: 0.65 });
      this.dMesh = makeInstanced(chunkGeometry(), mat, MAX.debris, 'fxDebris', 0);
    }
    // ③ 잎 조각 (수평으로 누운 사각형 — 법선 +Y)
    {
      const mat = new THREE.MeshLambertMaterial({ map: atlas, alphaTest: 0.5, side: THREE.DoubleSide });
      if (atlas) patchInstanceFx(mat, 'leaf', { uv: true, leafNormal: true });
      patchCanopy(mat, { sun: 1, sky: 0.62 });
      const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
      geo.setAttribute('aUvRect', instAttr(MAX.leaves, 4));
      this.lMesh = makeInstanced(geo, mat, MAX.leaves, 'fxLeaves', 0);
    }
    // ④ 탄흔 (물보다 먼저 — 얕은 물 아래 바닥의 자국은 수면에 덮인다)
    {
      const mat = new THREE.MeshLambertMaterial({
        map: this.fxAtlas.texture, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      });
      patchInstanceFx(mat, 'decal', { uv: true, fx: true });
      patchCanopy(mat, { sun: 1, sky: 0.7 });
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.setAttribute('aUvRect', instAttr(MAX.decals, 4));
      geo.setAttribute('aFx', instAttr(MAX.decals, 4));
      this.cMesh = makeInstanced(geo, mat, MAX.decals, 'fxDecals', 1);
      this.cMesh.receiveShadow = true;   // 붙은 표면과 같은 그림자
    }
    this.root.add(this.pMesh, this.dMesh, this.lMesh, this.cMesh);
    scene.add(this.root);

    // 풀
    this._pAll = Array.from({ length: MAX.particles }, newParticle);
    this._dAll = Array.from({ length: MAX.debris }, newDebris);
    this._lAll = Array.from({ length: MAX.leaves }, newLeaf);
    this._pFree = this._pAll.slice().reverse(); this._pAlive = [];
    this._dFree = this._dAll.slice().reverse(); this._dAlive = [];
    this._lFree = this._lAll.slice().reverse(); this._lAlive = [];
    this._decals = Array.from({ length: MAX.decals }, () => ({ alive: false, age: 0, life: 1, alpha: 1 }));
    this._dNext = 0;
    this._dUsed = 0;
    this._decalDirty = false;

    // 상태
    this._flashAge = Infinity;
    this._flashFresh = false;
    this._tracers = null;
    this._cam = new THREE.Vector3(0, 1.6, 0);
    this._camR = new THREE.Vector3(1, 0, 0);
    this._camU = new THREE.Vector3(0, 1, 0);
    this._camB = new THREE.Vector3(0, 0, 1);
    this._camF = new THREE.Vector3(0, 0, -1);
    this._hasCam = false;
    this._wind = { x: 0, z: 0 };
    // 착탄 맥락 (_setup 이 채움)
    this._P = new THREE.Vector3(); this._N = new THREE.Vector3(); this._D = new THREE.Vector3(); this._R = new THREE.Vector3();
    this._A = new THREE.Vector3(); this._A2 = new THREE.Vector3(); this._v = new THREE.Vector3();
    this._t1 = new THREE.Vector3(); this._t2 = new THREE.Vector3(); this._decX = new THREE.Vector3(); this._decY = new THREE.Vector3();
    this._muzzleP = new THREE.Vector3();
    this._k = 1; this._dist = 10; this._near = true;
    this._floor = -Infinity; this._fmode = 0;
    this.setQuality(opts.quality ?? CONFIG.defaults.quality);
  }

  // =============================================================
  // 공개 API
  // =============================================================

  /** 착탄: { point, normal, material, dir, speed, objectType, ricochet, underwater } */
  impact(e) {
    if (!e || !e.point) return;
    if (e.underwater) return;   // 물속 바닥: 수면에서 이미 물보라가 났고, 흙탕은 물에 가려 안 보인다
    const water = e.material === 'water';
    this._setup(e, water);
    switch (e.material) {
      case 'water': this._water(!!e.ricochet); break;
      case 'mud': this._mud(); break;
      case 'leaves': this._leaves(); break;
      case 'wood': this._wood(); break;
      case 'rock': this._rock(!!e.ricochet); break;
      case 'bamboo': this._bamboo(false); break;
      case 'fiber': this._fiber(false); break;
      default: this._dirt(); break;
    }
  }

  /** 부분 관통 입구 (대나무·덩굴 벽·나무고사리 줄기·리아나): { point, normal, material, dir } */
  partial(e) {
    if (!e || !e.point) return;
    if (e.material === 'water') { this.impact(e); return; }
    this._setup(e, false);
    if (e.material === 'bamboo') this._bamboo(true);
    else this._fiber(true);
  }

  /** 빽빽한 잎을 뚫고 지나감: { point, dir } → 잎 조각 몇 개가 팔랑이며 떨어짐 */
  foliage(e) {
    if (!e || !e.point) return;
    this._setup(e, false, true);
    if (!this._near) return;
    const D = this._D;
    this._emitLeaves(L_SPEC.fresh, this._cnt(L_SPEC.fresh.n, 2), this._P, D, 0.12);
    this._emitDebris(D_SPEC.leafShred, this._cnt(D_SPEC.leafShred.n), this._P, D);
  }

  /** 사람(표적) 명중: { point, normal, dir } → 옷 먼지·보풀 (피는 blood) */
  bodyHit(e) {
    if (!e || !e.point) return;
    this._setup(e, false);
    const A = this._axis(1, 0.25, 0, -0.35);   // 법선 + 탄이 온 쪽
    this._emit(P_SPEC.clothPuff, this._cnt(P_SPEC.clothPuff.n, 1), A);
    if (this._near) this._emitDebris(D_SPEC.clothFiber, this._cnt(D_SPEC.clothFiber.n), this._P, A);
  }

  /**
   * 3단계 피격 피: { point, normal, dir, severity, arterial } → 작은 피 안개 + 방울 (옷 먼지는 bodyHit 이 따로).
   *  치명·동맥이면 조금 더. 땅 얼룩은 bloodStain.
   */
  blood(e) {
    if (!e || !e.point) return;
    this._setup(e, false);
    const k = e.severity === 'lethal' || e.arterial ? 1.6 : e.severity === 'graze' ? 0.5 : 1;
    const A = this._axis(1, 0.2, 0.1, -0.2);
    this._emit(P_SPEC.bloodMist, this._cnt(P_SPEC.bloodMist.n * k, 1), A);
    if (this._near) this._emit(P_SPEC.bloodDrops, this._cnt(P_SPEC.bloodDrops.n * k, 1), A);
  }

  /** 땅의 어두운 핏자국: position {x,y,z} (지면 높이는 groundHeight 로 맞춤), size 배율 (0.5~2) */
  bloodStain(position, size = 1) {
    if (!position) return;
    let y = position.y;
    if (this.groundHeight) { const g = this.groundHeight(position.x, position.z); if (Number.isFinite(g)) y = g; }
    this._P.set(position.x + this.rng.range(-0.12, 0.12), y + 0.01, position.z + this.rng.range(-0.12, 0.12));
    this._N.set(0, 1, 0);
    this._D.set(0, -1, 0);
    const S = DECAL_SPEC.blood;
    const s = Math.min(2, Math.max(0.4, size));
    this._decal({ ...S, size: [S.size[0] * s, S.size[1] * s] }, 'none', BLOOD_TINT);
  }

  /** 발사: { position, dir, ads, own = true } → 습한 공기에 남는 총구 연기 + (own) 화염 빛 flash / (원거리) 화염 스프라이트 */
  muzzle(e) {
    if (!e || !e.position) return;
    const own = e.own !== false;
    // 쏜 프레임의 update 는 시간을 더하지 않음 → 그 프레임에 flash 를 읽으면 1 (그다음 약 50ms 동안 0 으로)
    if (own) { this._flashAge = 0; this._flashFresh = true; }
    const P = this._P.set(e.position.x, e.position.y, e.position.z);
    const D = this._D;
    if (e.dir) D.set(e.dir.x, e.dir.y, e.dir.z); else D.copy(this._camF);
    if (D.lengthSq() < 1e-8) D.set(0, 0, -1);
    D.normalize();
    this._N.set(0, 1, 0);
    this._dist = this._hasCam ? this._cam.distanceTo(P) : 1;
    this._k = this.q.spawn;
    this._near = this._dist < SMALL_DIST;
    this._floor = -Infinity; this._fmode = 0;
    const ads = Math.min(1, Math.max(0, e.ads ?? 0));
    // 조준 중엔 연기가 가늠쇠 바로 앞에 생기므로 조금 옅게 (그래도 연발이면 쌓여서 시야가 뿌옇게)
    const alphaMul = own ? 1 - 0.3 * ads : 1.2;
    this._emit(P_SPEC.smoke, Math.max(2, this._cnt(P_SPEC.smoke.n)), D, alphaMul);
    this._emit(P_SPEC.blast, this._cnt(P_SPEC.blast.n, 1), D, alphaMul);
    if (!own) this._emit(P_SPEC.remoteFlash, 1, D);
    // 엎드려 쏘면 총구 바람이 바닥 흙먼지·낙엽을 일으킨다
    if (this.groundHeight) {
      const gx = P.x + D.x * 0.5, gz = P.z + D.z * 0.5;
      const gy = this.groundHeight(gx, gz);
      if (Number.isFinite(gy) && P.y - gy < 0.5) {
        const A = this._A.set(D.x, 0.35, D.z).normalize();
        this._muzzleP.copy(P);
        this._P.set(gx, gy + 0.03, gz);
        this._emit(P_SPEC.groundBlast, this._cnt(P_SPEC.groundBlast.n, 1), A);
        this._P.copy(this._muzzleP);
      }
    }
  }

  /** 총구 화염 빛 0~1 (발사 순간 1 → FLASH_TIME 동안 0) — 통합 쪽이 월드 빛을 잠깐 밝힌다 */
  get flash() {
    const a = this._flashAge;
    return a < FLASH_TIME ? 1 - a / FLASH_TIME : 0;
  }

  /** 예광탄으로 그릴 탄 목록 (Ballistics.projectiles 를 그대로 넘겨도 됨 — tracer && alive 만 그림) */
  setTracers(list) {
    this._tracers = list || null;
  }

  /** 품질: 'low'|'medium'|'high' 또는 CONFIG.graphics 항목 */
  setQuality(q) {
    let key = typeof q === 'string' ? q : null;
    if (!key && q && typeof q === 'object') key = Object.keys(CONFIG.graphics).find((k) => CONFIG.graphics[k] === q) || (q.shadows === false ? 'low' : 'medium');
    if (!QUALITY[key]) key = 'medium';
    this.quality = key;
    this.q = QUALITY[key];
  }

  /**
   * @param {number} dt
   * @param {THREE.Camera} camera  월드 카메라 (판을 카메라 쪽으로 세우고 앞뒤 정렬)
   * @param {{ wind?: {x:number, z:number}, time?: number }} env  wind: m/s (없으면 셰이더 바람)
   */
  update(dt, camera, env = {}) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    if (this._flashFresh) this._flashFresh = false; else this._flashAge += dt;
    if (camera) {
      camera.updateMatrixWorld();
      const m = camera.matrixWorld.elements;
      this._camR.set(m[0], m[1], m[2]).normalize();
      this._camU.set(m[4], m[5], m[6]).normalize();
      this._camB.set(m[8], m[9], m[10]).normalize();
      this._camF.copy(this._camB).negate();
      this._cam.set(m[12], m[13], m[14]);
      this._hasCam = true;
    }
    if (env && env.wind) { this._wind.x = env.wind.x || 0; this._wind.z = env.wind.z || 0; } else {
      const w = shared.uWind.value * SMOKE_WIND, d = shared.uWindDir.value;
      this._wind.x = d.x * w; this._wind.z = d.y * w;
    }
    const g = CONFIG.ballistics?.gravity ?? 9.81;
    if (dt > 0) {
      this._stepParticles(dt, g);
      this._stepDebris(dt, g);
      this._stepLeaves(dt);
      this._stepDecals(dt);
    }
    this._writeParticles();
    this._writeDebris();
    this._writeLeaves();
    this._writeDecalsIfDirty();
  }

  /** 셰이더 미리 컴파일 (월드 컴파일 뒤에 만들었을 때 첫 착탄 끊김 방지) */
  prepare(renderer, camera) {
    try { renderer.compile(this.root, camera, this.scene); } catch { /* 일부 환경 미지원 */ }
  }

  /** 모든 효과 제거 (순간이동 등) */
  clear() {
    for (const [alive, free] of [[this._pAlive, this._pFree], [this._dAlive, this._dFree], [this._lAlive, this._lFree]]) {
      for (const it of alive) { it.alive = false; free.push(it); }
      alive.length = 0;
    }
    for (let i = 0; i < this._dUsed; i++) this._killDecal(i);
    this._dUsed = 0; this._dNext = 0;
    this._decalDirty = true;
    this._flashAge = Infinity;
    for (const m of [this.pMesh, this.dMesh, this.lMesh, this.cMesh]) { m.count = 0; m.visible = false; }
  }

  /** 디버그: 살아 있는 효과 수와 그리기 호출 수 */
  get stats() {
    const meshes = [this.pMesh, this.dMesh, this.lMesh, this.cMesh];
    return {
      particles: this._pAlive.length, debris: this._dAlive.length, leaves: this._lAlive.length,
      decals: this._decals.reduce((n, d) => n + (d.alive ? 1 : 0), 0),
      drawCalls: meshes.reduce((n, m) => n + (m.visible && m.count > 0 ? 1 : 0), 0),
    };
  }

  dispose() {
    this.scene.remove(this.root);
    for (const m of [this.pMesh, this.dMesh, this.lMesh, this.cMesh]) {
      m.geometry.dispose();
      m.material.dispose();
      m.dispose?.();
    }
    this.fxAtlas.texture.dispose();
    this._ownLeafAtlas?.dispose();
  }

  // =============================================================
  // 재질별 착탄
  // =============================================================

  /** 흙: 검은 흙 줄기가 솟구쳐 포물선으로 떨어지고, 흙덩이가 튀고, 먼지가 남아 바람에 흘러감 + 흙 고랑 */
  _dirt() {
    const A = this._axis(1, 0.6, 0.15);
    this._emit(P_SPEC.dirtBurst, this._cnt(P_SPEC.dirtBurst.n, 1), this._N);
    this._emit(P_SPEC.dirtSpray, this._cnt(P_SPEC.dirtSpray.n, 3), A);
    this._emit(P_SPEC.dirtDust, this._cnt(P_SPEC.dirtDust.n, 1), this._N);
    this._emit(P_SPEC.dirtPlume, this._cnt(P_SPEC.dirtPlume.n), A);
    if (this._near) this._emitDebris(D_SPEC.dirtClod, this._cnt(D_SPEC.dirtClod.n), this._P, A);
    this._decal(DECAL_SPEC.dirt, 'dir');
  }

  /** 낙엽 바닥: 흙(부엽토)이 조금 튀고 마른 잎 조각이 날렸다가 팔랑이며 내려앉음 */
  _leaves() {
    const A = this._axis(1, 0.6, 0.15);
    this._emit(P_SPEC.humusBurst, this._cnt(P_SPEC.humusBurst.n, 1), this._N);
    this._emit(P_SPEC.humusSpray, this._cnt(P_SPEC.humusSpray.n, 2), A);
    this._emit(P_SPEC.humusDust, this._cnt(P_SPEC.humusDust.n, 1), this._N);
    if (this._near) {
      this._emitDebris(D_SPEC.humusClod, this._cnt(D_SPEC.humusClod.n), this._P, A);
      this._emitLeaves(L_SPEC.litter, this._cnt(L_SPEC.litter.n, 2), this._P, A, 0.02);
    }
    this._decal(DECAL_SPEC.dirt, 'dir');
  }

  /** 나무: 밝은 생나무 가시·어두운 껍질 조각이 튀고 나무 가루, 결 방향으로 뜯긴 구멍 */
  _wood() {
    const A = this._axis(1, 0.3, 0);
    if (this._near) {
      this._emitDebris(D_SPEC.splinter, this._cnt(D_SPEC.splinter.n, 2), this._P, A);
      this._emitDebris(D_SPEC.barkChip, this._cnt(D_SPEC.barkChip.n), this._P, this._N);
    }
    this._emit(P_SPEC.woodBurst, this._cnt(P_SPEC.woodBurst.n, 1), this._N);
    this._emit(P_SPEC.woodSpray, this._cnt(P_SPEC.woodSpray.n, 2), A);
    this._emit(P_SPEC.woodDust, this._cnt(P_SPEC.woodDust.n, 1), this._N);
    this._decal(DECAL_SPEC.wood, 'up');
  }

  /** 바위: 돌가루가 확 퍼지고, 반사 방향으로 짧은 불꽃, 돌 조각 + 밝게 깨진 자국. 도탄이면 불꽃·가루 더 */
  _rock(ricochet) {
    const A = this._axis(1, 0.5, 0);
    this._emit(P_SPEC.rockDust, this._cnt(P_SPEC.rockDust.n, 1), this._N);
    this._emit(P_SPEC.rockSpray, this._cnt(P_SPEC.rockSpray.n, 1), A);
    const S = this._axis(0.4, 0.8, 0, 0, this._A2);
    this._emit(P_SPEC.spark, this._cnt(P_SPEC.spark.n * (ricochet ? 1.7 : 1), 2), S);
    if (ricochet) this._emit(P_SPEC.rockDust, 1, S);
    if (this._near) this._emitDebris(D_SPEC.rockChip, this._cnt(D_SPEC.rockChip.n), this._P, A);
    this._decal(DECAL_SPEC.rock, 'none');
  }

  /** 물: 물기둥이 솟았다가 무너지고, 물방울이 흩어지고, 물결 고리가 퍼짐 (수면 도탄이면 낮고 길게 튐) */
  _water(ricochet) {
    const N = this._N.set(0, 1, 0);
    if (!ricochet) {
      this._emit(P_SPEC.waterColumn, this._cnt(P_SPEC.waterColumn.n, 4), N);
      this._emit(P_SPEC.waterCrown, this._cnt(P_SPEC.waterCrown.n, 3), N);
      this._emit(P_SPEC.waterDrop, this._cnt(P_SPEC.waterDrop.n, 4), N);
    } else {
      // 얕은 각으로 튕김: 탄 진행 방향으로 낮게 흩어지는 물보라
      const A = this._A.set(this._D.x, 0.45, this._D.z).normalize();
      this._emit(P_SPEC.waterColumn, this._cnt(3, 1), A, 0.8, 0.55);
      this._emit(P_SPEC.waterDrop, this._cnt(P_SPEC.waterDrop.n, 3), A, 1, 0.8);
    }
    this._emit(P_SPEC.waterMist, this._cnt(P_SPEC.waterMist.n, 1), N);
    this._emit(P_SPEC.waterRing, this._cnt(P_SPEC.waterRing.n, 1), N);
  }

  /** 진흙: 무거운 검은 진흙덩이·젖은 줄기가 낮게 튀고, 넓은 진흙 자국 */
  _mud() {
    const A = this._axis(1, 0.5, 0.1);
    this._emit(P_SPEC.mudBurst, this._cnt(P_SPEC.mudBurst.n, 1), this._N);
    this._emit(P_SPEC.mudSpray, this._cnt(P_SPEC.mudSpray.n, 3), A);
    this._emit(P_SPEC.mudBlob, this._cnt(P_SPEC.mudBlob.n, 2), A);
    this._emit(P_SPEC.mudDrops, this._cnt(P_SPEC.mudDrops.n, 2), A);
    this._emit(P_SPEC.mudMist, this._cnt(P_SPEC.mudMist.n, 1), this._N);
    if (this._near) this._emitDebris(D_SPEC.mudClod, this._cnt(D_SPEC.mudClod.n, 2), this._P, A);
    this._decal(DECAL_SPEC.mud, 'dir');
  }

  /** 대나무: 섬유 조각이 입구 쪽과 출구 쪽(관통)으로 튀고 작은 잎 조각, 결 방향으로 갈라진 구멍 */
  _bamboo(through) {
    const A = this._axis(1, 0.3, 0);
    if (this._near) {
      const n = this._cnt(D_SPEC.bambooFiber.n * (through ? 0.6 : 1), 1);
      this._emitDebris(D_SPEC.bambooFiber, n, this._P, A);
      if (through) this._emitDebris(D_SPEC.bambooFiber, this._cnt(5, 1), this._P, this._D, 0.06);
      this._emitLeaves(L_SPEC.bits, this._cnt(L_SPEC.bits.n), this._P, A, 0.05);
    }
    this._emit(P_SPEC.bambooSpray, this._cnt(P_SPEC.bambooSpray.n, 1), A);
    if (through) this._emit(P_SPEC.bambooSpray, this._cnt(3, 1), this._D);
    this._emit(P_SPEC.bambooDust, this._cnt(P_SPEC.bambooDust.n, 1), this._N);
    this._decal(DECAL_SPEC.bamboo, 'up');
  }

  /** 덩굴·나무고사리 섬유: 섬유 부스러기 + 잎 조각 + 옅은 가루 (덩어리라 탄흔 없음) */
  _fiber(through) {
    const A = this._axis(1, 0.2, 0);
    if (this._near) {
      this._emitDebris(D_SPEC.vineFiber, this._cnt(D_SPEC.vineFiber.n * (through ? 0.7 : 1), 1), this._P, A);
      if (through) this._emitDebris(D_SPEC.vineFiber, this._cnt(4, 1), this._P, this._D, 0.08);
      this._emitLeaves(L_SPEC.bits, this._cnt(L_SPEC.bits.n * 2, 1), this._P, A, 0.06);
    }
    this._emit(P_SPEC.fiberSpray, this._cnt(P_SPEC.fiberSpray.n, 1), A);
    this._emit(P_SPEC.fiberDust, this._cnt(P_SPEC.fiberDust.n, 1), this._N);
  }

  // =============================================================
  // 맥락·생성 도우미
  // =============================================================

  /** 착탄 맥락: 점·법선(탄이 온 쪽)·탄 방향·반사 방향·거리 배율·바닥 */
  _setup(e, water, foliage = false) {
    const P = this._P.set(e.point.x, e.point.y, e.point.z);
    const D = this._D;
    if (e.dir) D.set(e.dir.x, e.dir.y, e.dir.z); else D.set(0, -1, 0);
    if (D.lengthSq() < 1e-10) D.set(0, -1, 0);
    D.normalize();
    const N = this._N;
    if (e.normal) N.set(e.normal.x, e.normal.y, e.normal.z); else N.copy(D).negate();
    if (N.lengthSq() < 1e-10) N.set(0, 1, 0);
    N.normalize();
    if (!foliage && N.dot(D) > 0) N.negate();   // 법선은 탄이 들어온 쪽(사수 쪽)
    this._R.copy(D).addScaledVector(N, -2 * D.dot(N));
    const dist = this._hasCam ? this._cam.distanceTo(P) : 10;
    this._dist = dist;
    // 멀수록 적게 (먼지·물보라는 크게 남고 작은 파편은 생략)
    this._k = this.q.spawn * (dist < 25 ? 1 : dist < 150 ? 1 - 0.55 * (dist - 25) / 125 : 0.45);
    this._near = dist < SMALL_DIST;
    // 바닥: 물 → 수면, 지형 함수 → 그 높이, 위를 향한 착탄면 → 그 평면, 아니면 없음
    if (water) { this._fmode = 3; this._floor = P.y; } else if (this.groundHeight) {
      this._fmode = 1;
      const gy = this.groundHeight(P.x, P.z);
      this._floor = Number.isFinite(gy) ? Math.min(gy, P.y) - 0.02 : -Infinity;
    } else if (N.y > 0.5 && !foliage) { this._fmode = 2; this._floor = P.y - 0.03; } else { this._fmode = 0; this._floor = -Infinity; }
  }

  /** 분출 축 = 법선·반사·위쪽·탄 방향의 섞음 (단위벡터) */
  _axis(kn, kr, ku, kd = 0, out = this._A) {
    const N = this._N, R = this._R, D = this._D;
    out.set(N.x * kn + R.x * kr + D.x * kd, N.y * kn + R.y * kr + ku + D.y * kd, N.z * kn + R.z * kr + D.z * kd);
    if (out.lengthSq() < 1e-8) out.copy(N);
    return out.normalize();
  }

  /** 기본 개수 × 품질·거리 배율 (확률 반올림), 최소 min */
  _cnt(base, min = 0) {
    return Math.max(min, Math.floor(base * this._k + this.rng.float()));
  }

  /** 축 a 둘레 반각 half(rad) 원뿔 안 균일 방향 → this._v */
  _cone(a, half) {
    const v = this._v;
    if (half <= 0) return v.copy(a);
    const cz = 1 - this.rng.float() * (1 - Math.cos(half));
    const sz = Math.sqrt(Math.max(0, 1 - cz * cz));
    const ph = this.rng.float() * TAU;
    const t1 = this._t1, t2 = this._t2;
    if (Math.abs(a.y) < 0.9) t1.set(0, 1, 0); else t1.set(1, 0, 0);
    t1.cross(a).normalize();
    t2.crossVectors(a, t1);
    const c = Math.cos(ph) * sz, s = Math.sin(ph) * sz;
    return v.set(a.x * cz + t1.x * c + t2.x * s, a.y * cz + t1.y * c + t2.y * s, a.z * cz + t1.z * c + t2.z * s);
  }

  _take(alive, free, limit) {
    let it = null;
    if (alive.length < limit && free.length) it = free.pop();
    else {
      // 가득 참: 수명이 가장 많이 지난 것을 재사용
      let best = -1, bi = -1;
      for (let i = 0; i < alive.length; i++) { const k = alive[i].age / alive[i].life; if (k > best) { best = k; bi = i; } }
      if (bi < 0) return null;
      it = alive[bi];
      it.alive = false;
      alive[bi] = alive[alive.length - 1];
      alive.pop();
    }
    it.alive = true;
    alive.push(it);
    return it;
  }

  _kill(alive, free, i) {
    const it = alive[i];
    it.alive = false;
    alive[i] = alive[alive.length - 1];
    alive.pop();
    free.push(it);
  }

  /** 입자 n개 (사양 S, 축 A, 시작점 this._P, 표면 법선 this._N). alphaMul·speedMul 로 상황별 조정 */
  _emit(S, n, A, alphaMul = 1, speedMul = 1) {
    const rng = this.rng, P = this._P, N = this._N;
    const cells = CELL[S.cell];
    const cone = (S.cone || 0) * DEG;
    for (let i = 0; i < n; i++) {
      const p = this._take(this._pAlive, this._pFree, this.q.particles);
      if (!p) return;
      const d = this._cone(A, cone);
      const sp = rr(rng, S.speed) * speedMul;
      const off = S.offset ? rr(rng, S.offset) : 0;
      const j = S.jitter || 0;
      p.px = P.x + A.x * off + (j ? rng.range(-j, j) : 0);
      p.py = P.y + A.y * off + (j ? rng.range(-j, j) : 0);
      p.pz = P.z + A.z * off + (j ? rng.range(-j, j) : 0);
      p.vx = d.x * sp; p.vy = d.y * sp; p.vz = d.z * sp;
      p.age = S.delay ? -rr(rng, S.delay) : 0;
      p.life = rr(rng, S.life);
      p.size0 = rr(rng, S.size);
      p.size1 = S.to ? rr(rng, S.to) : p.size0;
      p.grow = S.grow ?? 1;
      p.stretch = S.stretch ?? 0;
      p.rot = rng.float() * TAU;
      p.rotV = S.mode === BILL ? rng.range(-0.5, 0.5) : 0;
      const cv = 0.88 + 0.24 * rng.float();
      p.r = S.color[0] * cv; p.g = S.color[1] * cv; p.b = S.color[2] * cv;
      p.alpha = S.alpha * alphaMul;
      p.fadeIn = S.fadeIn ?? 0;
      p.fadeOut = S.fadeOut ?? 1;
      p.emissive = S.emissive ?? 0;
      p.drag = S.drag ?? 0;
      p.grav = S.grav ?? 0;
      p.wind = S.wind ?? 0;
      p.lift = S.lift ?? 0;
      p.mode = S.mode;
      p.cell = cells.length > 1 ? cells[rng.int(0, cells.length - 1)] : cells[0];
      p.nx = N.x; p.ny = N.y; p.nz = N.z;
      p.kill = !!S.kill;
      p.floor = this._floor;
      p.depth = 0;
      p.shown = false;
    }
  }

  /** 파편 n개 — 시작점 P 에서 축 A 원뿔로 (along: 축 방향으로 띄워 출발, 관통 출구 쪽) */
  _emitDebris(S, n, P, A, along = 0.01) {
    const rng = this.rng;
    const cone = (S.cone || 0) * DEG;
    for (let i = 0; i < n; i++) {
      const it = this._take(this._dAlive, this._dFree, this.q.debris);
      if (!it) return;
      const d = this._cone(A, cone);
      const sp = rr(rng, S.speed);
      it.px = P.x + A.x * along; it.py = P.y + A.y * along; it.pz = P.z + A.z * along;
      it.vx = d.x * sp; it.vy = d.y * sp; it.vz = d.z * sp;
      it.age = 0; it.life = rr(rng, S.life);
      const s = rr(rng, S.size);
      it.sx = s * S.shape[0] * rng.range(0.7, 1.3);
      it.sy = s * S.shape[1] * rng.range(0.7, 1.3);
      it.sz = s * S.shape[2];
      // 긴 조각은 날아가는 방향으로 누워서 출발
      it.ey = Math.atan2(d.x, d.z) + rng.range(-0.4, 0.4);
      it.ex = -Math.asin(Math.max(-1, Math.min(1, d.y))) + rng.range(-0.4, 0.4);
      it.ez = rng.range(0, TAU);
      const w = S.spin;
      it.wx = rng.range(-w, w); it.wy = rng.range(-w, w) * 0.5; it.wz = rng.range(-w, w);
      const c = S.colors[rng.int(0, S.colors.length - 1)], cv = rng.range(0.85, 1.12);
      it.r = c[0] * cv; it.g = c[1] * cv; it.b = c[2] * cv;
      it.drag = S.drag; it.bounce = S.bounce; it.settled = false;
      this._setFloor(it);
    }
  }

  /** 잎 조각 n개 — 튕겨 나갔다가 공기 저항으로 금방 느려지고 팔랑이며 떨어짐 */
  _emitLeaves(S, n, P, A, along = 0.03) {
    const rng = this.rng;
    const cone = (S.cone || 0) * DEG;
    for (let i = 0; i < n; i++) {
      const it = this._take(this._lAlive, this._lFree, this.q.leaves);
      if (!it) return;
      const d = this._cone(A, cone);
      const sp = rr(rng, S.speed);
      it.px = P.x + A.x * along + rng.range(-0.03, 0.03);
      it.py = P.y + A.y * along + rng.range(-0.03, 0.03);
      it.pz = P.z + A.z * along + rng.range(-0.03, 0.03);
      it.vx = d.x * sp; it.vy = d.y * sp; it.vz = d.z * sp;
      it.age = 0; it.life = rr(rng, S.life);
      it.size = rr(rng, S.size);
      it.win = rng.int(0, this._leafCount - 1);
      const t = S.tints[rng.int(0, S.tints.length - 1)], cv = rng.range(0.85, 1.1);
      it.r = t[0] * cv; it.g = t[1] * cv; it.b = t[2] * cv;
      it.phase = rng.float() * TAU;
      it.freq = rr(rng, S.freq);
      it.sway = rr(rng, S.sway);
      it.fall = rr(rng, S.fall);
      it.heading = rng.float() * TAU;
      it.spin = rng.range(-1.2, 1.2);
      it.tumble = rng.float() * TAU;
      it.tumbleV = rng.range(8, 16) * rng.sign();   // 처음엔 빙글빙글 돌다가 잦아듦
      it.tilt = rng.range(-0.3, 0.3);
      it.settled = false;
      this._setFloor(it);
    }
  }

  _setFloor(it) {
    const P = this._P, N = this._N;
    it.fmode = this._fmode === 3 ? 0 : this._fmode;   // 물에 떨어진 파편은 그냥 가라앉음 (수면에 가려짐)
    it.fpx = P.x; it.fpy = P.y; it.fpz = P.z;
    it.fnx = N.x; it.fny = N.y; it.fnz = N.z;
  }

  _floorAt(it) {
    if (it.fmode === 1) { const y = this.groundHeight(it.px, it.pz); return Number.isFinite(y) ? y : -Infinity; }
    if (it.fmode === 2) return it.fpy - (it.fnx * (it.px - it.fpx) + it.fnz * (it.pz - it.fpz)) / Math.max(0.3, it.fny);
    return -Infinity;
  }

  /** 탄흔 하나 — orient: 'dir' 세로축 = 표면에 투영한 탄 방향, 'up' = 위쪽(나뭇결·대나무 섬유), 'none' = 무작위 */
  _decal(S, orient, tint = null) {
    const limit = this.q.decals;
    const slot = this._dNext % limit;
    this._dNext = (slot + 1) % limit;
    if (slot >= this._dUsed) this._dUsed = slot + 1;
    const rng = this.rng, P = this._P, N = this._N, D = this._D;
    const rec = this._decals[slot];
    rec.alive = true; rec.age = 0; rec.life = S.life * rng.range(0.85, 1.15); rec.alpha = 1;
    // 세로축 (표면 위로 투영): 탄 방향 / 위쪽 / 아무 방향 (무작위 회전)
    const Y = this._decY;
    if (orient === 'dir') Y.copy(D); else Y.set(0, 1, 0);
    Y.addScaledVector(N, -Y.dot(N));
    if (Y.lengthSq() < 1e-6) { Y.set(1, 0, 0).addScaledVector(N, -N.x); if (Y.lengthSq() < 1e-6) Y.set(0, 0, 1).addScaledVector(N, -N.z); }
    Y.normalize();
    const roll = orient === 'none' ? rng.range(0, TAU) : rng.range(-0.25, 0.25);
    const X = this._decX.crossVectors(Y, N);   // X × Y = N
    if (roll) {
      const c = Math.cos(roll), s = Math.sin(roll);
      const xx = X.x * c + Y.x * s, xy = X.y * c + Y.y * s, xz = X.z * c + Y.z * s;
      Y.set(-X.x * s + Y.x * c, -X.y * s + Y.y * c, -X.z * s + Y.z * c);
      X.set(xx, xy, xz);
    }
    const w = rr(rng, S.size);
    // 비스듬히 맞을수록 탄 방향으로 길쭉 (흙 고랑)
    const obl = orient === 'dir' ? Math.min(1, Math.max(0, 1 - Math.abs(D.dot(N)))) : 0;
    const h = w * S.aspect * (1 + 0.9 * obl) * rng.range(0.9, 1.1);
    // 좌우 뒤집기로 같은 모양 반복을 숨김 — 행렬이 아니라 UV 로 (행렬을 뒤집으면 감기 방향이 바뀌어 뒷면으로 잘림:
    // InstancedMesh 는 인스턴스마다 앞뒷면을 따로 판단하지 않는다)
    const flip = rng.chance(0.5) && orient !== 'dir';
    const M = this.cMesh.instanceMatrix.array, o = slot * 16;
    M[o] = X.x * w; M[o + 1] = X.y * w; M[o + 2] = X.z * w; M[o + 3] = 0;
    M[o + 4] = Y.x * h; M[o + 5] = Y.y * h; M[o + 6] = Y.z * h; M[o + 7] = 0;
    M[o + 8] = N.x; M[o + 9] = N.y; M[o + 10] = N.z; M[o + 11] = 0;
    M[o + 12] = P.x + N.x * 0.002; M[o + 13] = P.y + N.y * 0.002; M[o + 14] = P.z + N.z * 0.002; M[o + 15] = 1;
    const cells = CELL[S.cells];
    const cell = cells[rng.int(0, cells.length - 1)];
    const uv = this.cMesh.geometry.attributes.aUvRect.array, c4 = cell * 4;
    uv[slot * 4] = this._cells[c4] + (flip ? this._cells[c4 + 2] : 0);
    uv[slot * 4 + 1] = this._cells[c4 + 1];
    uv[slot * 4 + 2] = flip ? -this._cells[c4 + 2] : this._cells[c4 + 2];
    uv[slot * 4 + 3] = this._cells[c4 + 3];
    const C = this.cMesh.instanceColor.array, cv = rng.range(0.9, 1.08);
    C[slot * 3] = cv * (tint ? tint[0] : 1); C[slot * 3 + 1] = cv * (tint ? tint[1] : 1); C[slot * 3 + 2] = cv * (tint ? tint[2] : 1);
    const F = this.cMesh.geometry.attributes.aFx.array;
    F[slot * 4] = 1; F[slot * 4 + 1] = 0; F[slot * 4 + 2] = 0; F[slot * 4 + 3] = 0;
    this._decalDirty = true;
  }

  _killDecal(i) {
    const rec = this._decals[i];
    rec.alive = false;
    const M = this.cMesh.instanceMatrix.array, o = i * 16;
    for (let k = 0; k < 16; k++) M[o + k] = 0;   // 크기 0 → 그려지지 않음
    this.cMesh.geometry.attributes.aFx.array[i * 4] = 0;
  }

  // =============================================================
  // 시뮬레이션
  // =============================================================

  _stepParticles(dt, g) {
    const list = this._pAlive, wx = this._wind.x, wz = this._wind.z;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.age += dt;
      if (p.age >= p.life) {
        // 한 번도 그려지지 않은 아주 짧은 입자(원거리 총구 화염·불꽃)는 프레임이 느려도 한 번은 보이게
        if (p.shown) { this._kill(list, this._pFree, i); continue; }
        p.age = p.life * 0.6;
      }
      if (p.age < 0) continue;   // 지연 생성 대기
      // 공기 저항: 바람에 대한 상대 속도가 drag(1/s)로 줄어듦 → 멈춘 연기·먼지는 바람을 따라 흘러감
      const k = Math.exp(-p.drag * dt);
      const ax = wx * p.wind, az = wz * p.wind;
      p.vx = ax + (p.vx - ax) * k;
      p.vz = az + (p.vz - az) * k;
      p.vy = p.vy * k - g * p.grav * dt;
      p.px += p.vx * dt; p.py += p.vy * dt; p.pz += p.vz * dt;
      p.rot += p.rotV * dt;
      if (p.kill && p.vy < 0 && p.py < p.floor) this._kill(list, this._pFree, i);
    }
  }

  _stepDebris(dt, g) {
    const list = this._dAlive;
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      d.age += dt;
      if (d.age >= d.life) { this._kill(list, this._dFree, i); continue; }
      if (d.settled) continue;
      const k = Math.exp(-d.drag * dt);
      d.vx *= k; d.vz *= k;
      d.vy = d.vy * k - g * dt;
      d.px += d.vx * dt; d.py += d.vy * dt; d.pz += d.vz * dt;
      d.ex += d.wx * dt; d.ey += d.wy * dt; d.ez += d.wz * dt;
      if (d.fmode && d.vy < 0) {
        const fy = this._floorAt(d);
        const half = Math.min(d.sx, d.sy, d.sz) * 0.5;
        if (d.py - half < fy) {
          d.py = fy + half;
          const sp = Math.hypot(d.vx, d.vy, d.vz);
          if (d.bounce > 0 && sp > 1.2) {
            d.vy = -d.vy * d.bounce; d.vx *= 0.45; d.vz *= 0.45;
            d.wx *= 0.5; d.wy *= 0.5; d.wz *= 0.5;
          } else {
            // 내려앉음: 긴 조각은 눕히고 납작한 조각은 엎어 둠
            d.settled = true;
            d.vx = d.vy = d.vz = 0;
            d.ex = 0; d.ez = this.rng.range(-0.25, 0.25);
            d.life = Math.max(d.life, d.age + 1.5);
          }
        }
      }
    }
  }

  _stepLeaves(dt) {
    const list = this._lAlive, wx = this._wind.x * 0.8, wz = this._wind.z * 0.8;
    const kb = Math.exp(-3.5 * dt);
    for (let i = list.length - 1; i >= 0; i--) {
      const L = list[i];
      L.age += dt;
      if (L.age >= L.life) { this._kill(list, this._lFree, i); continue; }
      if (L.settled) continue;
      // 처음 튕긴 속도는 넓은 잎이라 공기 저항으로 금방 사라지고 → 바람 + 좌우로 미끄러지며 떨어지는 운동
      L.vx = wx + (L.vx - wx) * kb;
      L.vz = wz + (L.vz - wz) * kb;
      const ph = L.phase + TAU * L.freq * L.age;
      const c = Math.cos(ph);
      // 흔들림 끝에서는 멈칫(활공), 가운데서 빨리 떨어짐
      const vyT = -L.fall * (0.4 + 1.2 * c * c);
      L.vy = vyT + (L.vy - vyT) * kb;
      const sw = L.sway * TAU * L.freq * c;
      const sx = Math.sin(L.heading), sz = Math.cos(L.heading);
      L.px += (L.vx + sx * sw) * dt; L.py += L.vy * dt; L.pz += (L.vz + sz * sw) * dt;
      L.heading += L.spin * dt;
      L.tumble += L.tumbleV * dt;
      L.tumbleV *= Math.exp(-2.2 * dt);
      if (L.fmode && L.vy < 0) {
        const fy = this._floorAt(L);
        if (L.py < fy + 0.004) {
          L.py = fy + 0.004;
          L.settled = true;
          L.life = Math.max(L.life, L.age + 2);
        }
      }
    }
  }

  _stepDecals(dt) {
    for (let i = 0; i < this._dUsed; i++) {
      const rec = this._decals[i];
      if (!rec.alive) continue;
      rec.age += dt;
      if (rec.age >= rec.life) { this._killDecal(i); this._decalDirty = true; continue; }
      const left = rec.life - rec.age;
      if (left < DECAL_FADE) {
        this.cMesh.geometry.attributes.aFx.array[i * 4] = rec.alpha * left / DECAL_FADE;
        this._decalDirty = true;
      }
    }
  }

  // =============================================================
  // 인스턴스 버퍼 쓰기
  // =============================================================

  _writeParticles() {
    const mesh = this.pMesh, list = this._pAlive;
    if (!this._hasCam) return;
    const cam = this._cam, f = this._camF;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.depth = (p.px - cam.x) * f.x + (p.py - cam.y) * f.y + (p.pz - cam.z) * f.z;
    }
    list.sort(byDepthDesc);   // 먼 것부터 (알파 혼합 순서)
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.age < 0) continue;
      n = this._writeParticle(p, n);
    }
    n = this._writeTracers(n);
    this._flush(mesh, n, true);
  }

  /** 입자 하나를 인스턴스 n 에 씀 → 다음 n */
  _writeParticle(p, n) {
    const t = p.age / p.life;
    const s = p.size0 + (p.size1 - p.size0) * (1 - Math.pow(1 - t, p.grow));
    const fin = p.fadeIn > 0 ? Math.min(1, p.age / p.fadeIn) : 1;
    const a = p.alpha * fin * Math.pow(1 - t, p.fadeOut);
    if (a < 0.002 || s <= 0) return n;
    const lift = p.lift * s;
    const cx = p.px + p.nx * lift, cy = p.py + p.ny * lift, cz = p.pz + p.nz * lift;
    const M = this.pMesh.instanceMatrix.array, o = n * 16;
    let done = false;
    if (p.mode === STREAK) {
      // 속도 방향으로 늘인 판: 세로축 = 화면에 투영한 속도, 판은 카메라를 향함
      let tx = this._cam.x - cx, ty = this._cam.y - cy, tz = this._cam.z - cz;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      const sp = Math.hypot(p.vx, p.vy, p.vz);
      const vd = p.vx * tx + p.vy * ty + p.vz * tz;
      let yx = p.vx - tx * vd, yy = p.vy - ty * vd, yz = p.vz - tz * vd;
      const yl = Math.hypot(yx, yy, yz);
      if (yl > 1e-3 && sp > 0.05) {
        yx /= yl; yy /= yl; yz /= yl;
        const len = s + yl * p.stretch;
        const xx = yy * tz - yz * ty, xy = yz * tx - yx * tz, xz = yx * ty - yy * tx;   // X = Y × T
        const back = len * 0.5 - s * 0.5;   // 머리가 입자 위치, 꼬리가 뒤로
        writeCols(M, o, xx * s, xy * s, xz * s, yx * len, yy * len, yz * len, tx, ty, tz, cx - yx * back, cy - yy * back, cz - yz * back);
        done = true;
      }
    } else if (p.mode === FLAT) {
      // 면에 누운 판 (수면 물결): X = t1, Y = N × t1
      const nx = p.nx, ny = p.ny, nz = p.nz;
      let ax = 0, ay = 1, az = 0;
      if (Math.abs(ny) > 0.9) { ax = 1; ay = 0; }
      let t1x = ay * nz - az * ny, t1y = az * nx - ax * nz, t1z = ax * ny - ay * nx;
      const tl = Math.hypot(t1x, t1y, t1z) || 1;
      t1x /= tl; t1y /= tl; t1z /= tl;
      const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x;
      const c = Math.cos(p.rot) * s, sn = Math.sin(p.rot) * s;
      writeCols(M, o, t1x * c + t2x * sn, t1y * c + t2y * sn, t1z * c + t2z * sn,
        -t1x * sn + t2x * c, -t1y * sn + t2y * c, -t1z * sn + t2z * c, nx, ny, nz, cx, cy, cz);
      done = true;
    }
    if (!done) {
      const R = this._camR, U = this._camU, B = this._camB;
      const c = Math.cos(p.rot) * s, sn = Math.sin(p.rot) * s;
      writeCols(M, o, R.x * c + U.x * sn, R.y * c + U.y * sn, R.z * c + U.z * sn,
        -R.x * sn + U.x * c, -R.y * sn + U.y * c, -R.z * sn + U.z * c, B.x, B.y, B.z, cx, cy, cz);
    }
    const C = this.pMesh.instanceColor.array;
    C[n * 3] = p.r; C[n * 3 + 1] = p.g; C[n * 3 + 2] = p.b;
    const uv = this.pMesh.geometry.attributes.aUvRect.array, cells = this._cells;
    uv[n * 4] = cells[p.cell * 4]; uv[n * 4 + 1] = cells[p.cell * 4 + 1]; uv[n * 4 + 2] = cells[p.cell * 4 + 2]; uv[n * 4 + 3] = cells[p.cell * 4 + 3];
    const F = this.pMesh.geometry.attributes.aFx.array;
    F[n * 4] = a; F[n * 4 + 1] = p.emissive; F[n * 4 + 2] = p.mode === FLAT ? 0 : 1; F[n * 4 + 3] = 0;
    p.shown = true;
    return n + 1;
  }

  /** 예광: 이번 프레임에 날아간 구간(최대 10m)을 빛나는 줄로 — 멀어도 1~2픽셀 굵기 유지 */
  _writeTracers(n) {
    const list = this._tracers;
    if (!list || !list.length) return n;
    const M = this.pMesh.instanceMatrix.array, C = this.pMesh.instanceColor.array;
    const uv = this.pMesh.geometry.attributes.aUvRect.array, F = this.pMesh.geometry.attributes.aFx.array;
    const cell = CELL.spark[0] * 4, cells = this._cells;
    for (let i = 0; i < list.length && n < MAX.particles; i++) {
      const pr = list[i];
      if (!pr || !pr.alive || !pr.tracer || !pr.pos) continue;
      if ((pr.dist ?? 10) < 4) continue;   // 총구 바로 앞은 아직 불이 붙지 않음
      const hx = pr.pos.x, hy = pr.pos.y, hz = pr.pos.z;
      const sp = Math.hypot(pr.vel.x, pr.vel.y, pr.vel.z);
      if (sp < 1) continue;
      const dx = pr.vel.x / sp, dy = pr.vel.y / sp, dz = pr.vel.z / sp;
      const seg = pr.prev ? Math.hypot(hx - pr.prev.x, hy - pr.prev.y, hz - pr.prev.z) : 6;
      const len = Math.min(10, Math.max(2, seg));
      const mx = hx - dx * len * 0.5, my = hy - dy * len * 0.5, mz = hz - dz * len * 0.5;
      let tx = this._cam.x - mx, ty = this._cam.y - my, tz = this._cam.z - mz;
      const dist = Math.hypot(tx, ty, tz) || 1;
      tx /= dist; ty /= dist; tz /= dist;
      // 길이 축 = 탄 방향의 시선 수직 성분 × 길이 (멀어지는 탄은 짧게 줄어든 줄 = 실제 투영과 같음)
      const dd = dx * tx + dy * ty + dz * tz;
      const qx = dx - tx * dd, qy = dy - ty * dd, qz = dz - tz * dd;
      const ql = Math.hypot(qx, qy, qz);
      if (ql < 1e-3) continue;   // 정면으로 날아오거나 멀어짐 — 점
      // 폭 축 = (길이 축 × 시선) — 거리와 무관하게 약 2~3픽셀
      const w = Math.max(0.03, dist * 0.005);
      const k = w / ql;
      const xx = (qy * tz - qz * ty) * k, xy = (qz * tx - qx * tz) * k, xz = (qx * ty - qy * tx) * k;
      writeCols(M, n * 16, xx, xy, xz, qx * len, qy * len, qz * len, tx, ty, tz, mx, my, mz);
      C[n * 3] = PAL.tracer[0]; C[n * 3 + 1] = PAL.tracer[1]; C[n * 3 + 2] = PAL.tracer[2];
      uv[n * 4] = cells[cell]; uv[n * 4 + 1] = cells[cell + 1]; uv[n * 4 + 2] = cells[cell + 2]; uv[n * 4 + 3] = cells[cell + 3];
      F[n * 4] = 0.95; F[n * 4 + 1] = TRACER_GLOW; F[n * 4 + 2] = 0; F[n * 4 + 3] = 0;
      n++;
    }
    return n;
  }

  _writeDebris() {
    const list = this._dAlive, mesh = this.dMesh;
    const M = mesh.instanceMatrix.array, C = mesh.instanceColor.array;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      const sh = Math.min(1, (d.life - d.age) / 0.4);   // 수명 끝에 작아지며 사라짐
      if (sh <= 0) continue;
      _p.set(d.px, d.py, d.pz);
      _q.setFromEuler(_e.set(d.ex, d.ey, d.ez, 'YXZ'));
      _s.set(d.sx * sh, d.sy * sh, d.sz * sh);
      _m.compose(_p, _q, _s).toArray(M, n * 16);
      C[n * 3] = d.r; C[n * 3 + 1] = d.g; C[n * 3 + 2] = d.b;
      n++;
    }
    this._flush(mesh, n, false);
  }

  _writeLeaves() {
    const list = this._lAlive, mesh = this.lMesh;
    const M = mesh.instanceMatrix.array, C = mesh.instanceColor.array, uv = mesh.geometry.attributes.aUvRect.array;
    const rects = this._leafRects;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const L = list[i];
      const sh = Math.min(1, (L.life - L.age) / 0.5);
      if (sh <= 0) continue;
      let tiltX = 0, roll = 0;
      if (!L.settled) {
        const ph = L.phase + TAU * L.freq * L.age;
        // 흔들리는 방향으로 앞뒤로 기울고(진자) + 처음의 빙글빙글 돌기
        tiltX = 0.6 * Math.sin(ph) + L.tilt + L.tumble * Math.min(1, Math.abs(L.tumbleV) / 6);
        roll = 0.25 * Math.sin(2 * ph);
      }
      _p.set(L.px, L.py, L.pz);
      _q.setFromEuler(_e.set(tiltX, L.heading, roll, 'YXZ'));
      const s = L.size * sh;
      _s.set(s, s, s);
      _m.compose(_p, _q, _s).toArray(M, n * 16);
      C[n * 3] = L.r; C[n * 3 + 1] = L.g; C[n * 3 + 2] = L.b;
      const w = L.win * 4;
      uv[n * 4] = rects[w]; uv[n * 4 + 1] = rects[w + 1]; uv[n * 4 + 2] = rects[w + 2]; uv[n * 4 + 3] = rects[w + 3];
      n++;
    }
    this._flush(mesh, n, false, true);
  }

  _writeDecalsIfDirty() {
    const mesh = this.cMesh;
    if (this._decalDirty) {
      this._decalDirty = false;
      const n = this._dUsed;
      mesh.count = n;
      markRange(mesh.instanceMatrix, n * 16);
      markRange(mesh.instanceColor, n * 3);
      markRange(mesh.geometry.attributes.aUvRect, n * 4);
      markRange(mesh.geometry.attributes.aFx, n * 4);
    }
    let any = false;
    for (let i = 0; i < this._dUsed && !any; i++) any = this._decals[i].alive;
    mesh.visible = any;
  }

  /** count 와 바뀐 범위만 올림 */
  _flush(mesh, n, fx, uvOnly = false) {
    mesh.count = n;
    mesh.visible = n > 0;
    if (!n) return;
    markRange(mesh.instanceMatrix, n * 16);
    markRange(mesh.instanceColor, n * 3);
    const at = mesh.geometry.attributes;
    if (fx || uvOnly) markRange(at.aUvRect, n * 4);
    if (fx) markRange(at.aFx, n * 4);
  }
}

function markRange(attr, count) {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count);
  attr.needsUpdate = true;
}

/** 열 우선 4×4 행렬 (X, Y, Z 축 열 + 위치) */
function writeCols(M, o, xx, xy, xz, yx, yy, yz, zx, zy, zz, px, py, pz) {
  M[o] = xx; M[o + 1] = xy; M[o + 2] = xz; M[o + 3] = 0;
  M[o + 4] = yx; M[o + 5] = yy; M[o + 6] = yz; M[o + 7] = 0;
  M[o + 8] = zx; M[o + 9] = zy; M[o + 10] = zz; M[o + 11] = 0;
  M[o + 12] = px; M[o + 13] = py; M[o + 14] = pz; M[o + 15] = 1;
}
