// 사람 부위별 피격 판정 캡슐 (머리·목·가슴 상부(심장)·복부·골반·상완·하완·대퇴·하퇴) — 순수 로직.
//  플레이어와 4단계 적 병사, F8 표적이 모두 이 함수로 몸을 만든다 → 표적 모습(TargetMesh)과 판정이 같은 캡슐.
//
//  국소 좌표: x 오른쪽, y 위, z 앞. 원점 = 발 위치(이동 컴포넌트 position), 눈은 원점 바로 위 (0, 눈높이, 0)
//  — 카메라가 motor.position 바로 위에 있으므로 판정 머리와 시점이 어긋나지 않게 몸을 눈 기준으로 배치한다.
//  · 서기: 키 1.78m(정수리), 눈 1.65, 어깨 너비 약 0.45m, 가슴 두께 0.23m (몸통은 좌우 2개 캡슐 → 두께보다 넓음)
//  · 앉기: 오른 무릎을 꿇고 뒤꿈치에 살짝 앉은 자세, 상체를 앞으로 숙이고 머리는 세움 — 눈 = stance.eyeHeight.crouch
//  · 엎드리기: 바라보는 방향으로 길게 엎드림 (머리가 앞), 팔꿈치로 상체를 받침 — 눈 = stance.eyeHeight.prone
//  팔: 'rifle' = 사격 자세 (손이 조준선에 붙은 총을 잡음, 하완이 앞으로) / 'down' = 표적용 (팔을 내림)
//  팔꿈치·무릎은 2관절 IK 로 풀어서 자세가 섞여도 팔다리 길이가 변하지 않는다.
//  자세 전환은 관절 위치를 smoothstep(진행도)로 보간 (HumanMotor 눈높이 보간과 같은 곡선).
//  기울이기(lean): 머리 1 · 가슴 약 0.7 · 복부 약 0.35 비율로 옆으로 이동 (카메라처럼 살짝 낮아짐).
//
//  pose 확장(선택): bodyPitch (rad, 엎드린 몸이 경사를 따라 앞쪽이 들리는 각 — 엎드리기 비율만큼 적용),
//                   eyeHeight (m, 실제 눈높이 — 물에서 머리를 드는 등 표 값과 다르면 상체를 그만큼 올림),
//                   fall {ax, az, angle, lift} (3단계: 쓰러진 몸 — 발을 축으로 수평축 (ax, 0, az) 둘레 angle rad 회전 후
//                   lift m 올림. TargetMesh 가 같은 회전을 메시에 건다 → 쓰러진 시체의 판정 = 보이는 모습)
//  반환 배열 확장: out.eye (월드 눈 위치), out.chest (가슴 상부 중심) — 조준·시야 판정용
import { CONFIG } from '../config.js';
import { smoothstep } from '../core/math.js';

export const PARTS = ['head', 'neck', 'upperChest', 'abdomen', 'pelvis', 'upperArmL', 'upperArmR', 'forearmL', 'forearmR', 'thighL', 'thighR', 'shinL', 'shinR'];
/** 근접 통과 거리를 재는 '머리·몸통' 부위 */
export const NEAR_PARTS = new Set(['head', 'neck', 'upperChest', 'abdomen', 'pelvis']);

export function partLabel(part) {
  return CONFIG.hitboxes.labels[part] ?? part;
}

// ---------------------------------------------------------------
// 골격 (해부학 비율 — 화면 모델 비율과 같은 '모양' 상수, 반경은 CONFIG.hitboxes.radius)
// ---------------------------------------------------------------
// 관절 번호 (작업 버퍼 = 점 × 3)
const EYE = 0, HEAD_A = 1, HEAD_B = 2, NECK_A = 3, NECK_B = 4, CHEST_A = 5, CHEST_B = 6, ABD_A = 7, ABD_B = 8,
  PEL_A = 9, PEL_B = 10, SHO_L = 11, SHO_R = 12, HIP_L = 13, HIP_R = 14, ANK_L = 15, ANK_R = 16,
  KPOLE_L = 17, KPOLE_R = 18, HAND_L = 19, HAND_R = 20, EPOLE_L = 21, EPOLE_R = 22;
const NPTS = 23;
const ELB_L = 23, ELB_R = 24, KNEE_L = 25, KNEE_R = 26;   // IK 결과
const NWORK = 27;

// 팔다리 길이 (m): 상완, 하완(손 중간까지), 대퇴, 하퇴(발목까지)
const L_UPPER_ARM = 0.3, L_FOREARM = 0.29, L_THIGH = 0.415, L_SHIN = 0.405;
// 몸통 좌우 2개 캡슐의 중심 간격 절반 (m) — 가슴·복부·골반이 두께보다 넓게
const SPREAD = { upperChest: 0.05, abdomen: 0.05, pelvis: 0.06 };

// 서 있는 자세 (1.78m 병사). 몸통·머리 점만 — 다리·팔 목표는 자세별로 따로
const STAND = {
  eye: [0, 1.65, 0],
  headA: [0, 1.615, 0.01], headB: [0, 1.68, 0],
  neckA: [0, 1.445, -0.02], neckB: [0, 1.545, 0],
  chestA: [0, 1.25, 0], chestB: [0, 1.35, -0.005],
  abdA: [0, 1.05, 0.005], abdB: [0, 1.14, 0],
  pelA: [0, 0.875, -0.01], pelB: [0, 0.945, -0.005],
  shoulderL: [-0.175, 1.425, -0.01], shoulderR: [0.175, 1.425, -0.01],
  hipL: [-0.09, 0.9, 0], hipR: [0.09, 0.9, 0],
};
const TORSO_KEYS = ['neckA', 'neckB', 'chestA', 'chestB', 'abdA', 'abdB', 'pelA', 'pelB', 'shoulderL', 'shoulderR', 'hipL', 'hipR'];
const HEAD_KEYS = ['eye', 'headA', 'headB'];
const KEY_INDEX = {
  eye: EYE, headA: HEAD_A, headB: HEAD_B, neckA: NECK_A, neckB: NECK_B, chestA: CHEST_A, chestB: CHEST_B,
  abdA: ABD_A, abdB: ABD_B, pelA: PEL_A, pelB: PEL_B, shoulderL: SHO_L, shoulderR: SHO_R, hipL: HIP_L, hipR: HIP_R,
};

/** 서 있는 몸통을 골반 중심 기준으로 앞으로 tilt 숙이고, 머리는 세운 채 목 끝에 붙인 뒤 눈이 (0, eyeH, 0)에 오게 옮김 */
function bentBody(tilt, eyeH) {
  const pc = [0, (STAND.pelA[1] + STAND.pelB[1]) / 2, (STAND.pelA[2] + STAND.pelB[2]) / 2];
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const out = {};
  for (const k of TORSO_KEYS) {
    const p = STAND[k], y = p[1] - pc[1], z = p[2] - pc[2];
    out[k] = [p[0], y * c - z * s, y * s + z * c];
  }
  const nt = out.neckB;
  for (const k of HEAD_KEYS) {
    const p = STAND[k];
    out[k] = [p[0], nt[1] + p[1] - STAND.neckB[1], nt[2] + p[2] - STAND.neckB[2]];
  }
  const dy = eyeH - out.eye[1], dz = -out.eye[2];
  for (const k in out) { out[k][1] += dy; out[k][2] += dz; }
  return out;
}

const addV = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const lerpV = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * 자세 표 하나 (Float64Array NPTS×3) 만들기.
 * legs: { ankleL, ankleR (엉덩이 관절 기준 변위), poleL, poleR (무릎 방향) }
 * arms: (body, knees) => { handL, handR, poleL, poleR } — 손 목표(국소 절대 좌표)와 팔꿈치 방향
 */
function makeTable(body, legs, armsFn) {
  const T = new Float64Array(NPTS * 3);
  const put = (i, p) => { T[i * 3] = p[0]; T[i * 3 + 1] = p[1]; T[i * 3 + 2] = p[2]; };
  for (const k in KEY_INDEX) put(KEY_INDEX[k], body[k]);
  const ankL = addV(body.hipL, legs.ankleL), ankR = addV(body.hipR, legs.ankleR);
  put(ANK_L, ankL); put(ANK_R, ankR); put(KPOLE_L, legs.poleL); put(KPOLE_R, legs.poleR);
  // 손 목표가 무릎 위치를 참조할 수 있게 표 만들 때 한 번 풀어 둔다
  const kneeL = ikPoint(body.hipL, ankL, L_THIGH, L_SHIN, legs.poleL);
  const kneeR = ikPoint(body.hipR, ankR, L_THIGH, L_SHIN, legs.poleR);
  const a = armsFn(body, { kneeL, kneeR });
  put(HAND_L, a.handL); put(HAND_R, a.handR); put(EPOLE_L, a.poleL); put(EPOLE_R, a.poleR);
  return T;
}

/** 표 만들기용 IK (배열 버전) */
function ikPoint(S, Tg, L1, L2, pole) {
  const w = new Float64Array(9);
  w.set(S, 0); w.set(Tg, 3); w.set(pole, 6);
  const o = new Float64Array(3);
  solveIK(w, 0, 1, 2, o, 0, L1, L2);
  return [o[0], o[1], o[2]];
}

// 사격 자세 손: 조준선(눈)에 붙은 총 — 오른손 권총손잡이, 왼손 총열덮개 (눈 기준 변위)
const RIFLE_HANDS = { R: [0.09, -0.18, 0.22], L: [0.03, -0.13, 0.45], poleR: [1, -1, -0.2], poleL: [-0.4, -1, 0] };
const RIFLE_HANDS_PRONE = { R: [0.09, -0.17, 0.12], L: [0.02, -0.12, 0.32], poleR: [1, -0.45, 0], poleL: [-0.5, -1, 0] };
const rifleArms = (H) => (b) => ({ handR: addV(b.eye, H.R), handL: addV(b.eye, H.L), poleR: H.poleR, poleL: H.poleL });

// 앉기·엎드리기 눈높이는 이동 컴포넌트와 같은 값 (모듈을 읽을 때 한 번 — 몸 모양 상수).
// 서기 몸은 1.65m 눈높이에 맞춘 해부학 비율 그대로. 실제 눈높이가 다르면 pose.eyeHeight 로 보정된다.
const EYE_CROUCH = Math.min(1.2, Math.max(0.9, CONFIG.stance.eyeHeight.crouch));
const EYE_PRONE = Math.min(0.45, Math.max(0.25, CONFIG.stance.eyeHeight.prone));
const STANCE_BODY = {
  stand: bentBody(0, STAND.eye[1]),
  crouch: bentBody(18 * Math.PI / 180, EYE_CROUCH),
  prone: bentBody(80 * Math.PI / 180, EYE_PRONE),
};
const STANCE_LEGS = {
  stand: { ankleL: [-0.01, -0.815, -0.02], ankleR: [0.01, -0.815, -0.02], poleL: [0, 0, 1], poleR: [0, 0, 1] },
  // 오른 무릎은 땅에 꿇고 정강이는 뒤로, 왼발은 앞에 디뎌 무릎을 세움
  crouch: { ankleL: [-0.04, -0.248, 0.411], ankleR: [0.02, -0.183, -0.076], poleL: [0, 1, 1], poleR: [0, -1, 1] },
  // 다리를 뒤로 거의 곧게 뻗고 살짝 벌림 (무릎이 땅을 파고들지 않게 바깥쪽으로 아주 조금 굽힘)
  prone: { ankleL: [-0.11, -0.03, -0.81], ankleR: [0.11, -0.03, -0.81], poleL: [-1, -0.3, 0], poleR: [1, -0.3, 0] },
};
const STANCE_ARMS = {
  stand: {
    rifle: rifleArms(RIFLE_HANDS),
    down: () => ({ handL: [-0.185, 0.82, 0.04], handR: [0.185, 0.82, 0.04], poleL: [0, 0, -1], poleR: [0, 0, -1] }),
  },
  crouch: {
    rifle: rifleArms(RIFLE_HANDS),
    // 오른손은 꿇은 다리 허벅지 위, 왼손은 세운 무릎 위
    down: (b, k) => ({ handR: addV(lerpV(b.hipR, k.kneeR, 0.55), [0.03, 0.085, 0]), handL: addV(k.kneeL, [0, 0.075, -0.02]), poleL: [-0.4, -0.2, -1], poleR: [0.4, -0.2, -1] }),
  },
  prone: {
    rifle: rifleArms(RIFLE_HANDS_PRONE),
    // 팔꿈치로 받치고 손은 머리 앞 땅 위
    down: () => ({ handL: [-0.12, 0.07, 0.22], handR: [0.12, 0.07, 0.22], poleL: [-1, -0.35, 0], poleR: [1, -0.35, 0] }),
  },
};
const TABLES = {};
for (const st of ['stand', 'crouch', 'prone']) {
  TABLES[st] = {};
  for (const arms of ['rifle', 'down']) TABLES[st][arms] = makeTable(STANCE_BODY[st], STANCE_LEGS[st], STANCE_ARMS[st][arms]);
}

// 기울이기 이동 비율 (점별) — 엉덩이 아래는 고정, 위로 갈수록 크게
const LEAN_W = new Float64Array(NPTS);
LEAN_W[EYE] = 1; LEAN_W[HEAD_A] = 1; LEAN_W[HEAD_B] = 1; LEAN_W[NECK_A] = 0.85; LEAN_W[NECK_B] = 0.95;
LEAN_W[CHEST_A] = 0.62; LEAN_W[CHEST_B] = 0.78; LEAN_W[ABD_A] = 0.25; LEAN_W[ABD_B] = 0.45; LEAN_W[PEL_B] = 0.08;
LEAN_W[SHO_L] = 0.78; LEAN_W[SHO_R] = 0.78;
const LEAN_HAND = { rifle: 0.95, down: 0.6 };
// 실제 눈높이(pose.eyeHeight)가 표와 다를 때 상체를 올리는 비율
const EYE_W = new Float64Array(NPTS);
EYE_W[EYE] = 1; EYE_W[HEAD_A] = 1; EYE_W[HEAD_B] = 1; EYE_W[NECK_A] = 0.95; EYE_W[NECK_B] = 1;
EYE_W[CHEST_A] = 0.8; EYE_W[CHEST_B] = 0.9; EYE_W[ABD_A] = 0.45; EYE_W[ABD_B] = 0.6; EYE_W[PEL_A] = 0.15; EYE_W[PEL_B] = 0.25;
EYE_W[SHO_L] = 0.85; EYE_W[SHO_R] = 0.85; EYE_W[HIP_L] = 0.1; EYE_W[HIP_R] = 0.1;
const EYE_HAND = { rifle: 1, down: 0.6 };

// 캡슐 정의: [부위, 점 A, 점 B, 반경 키, 좌우 간격(0이면 1개)]
const CAPS = [
  ['head', HEAD_A, HEAD_B, 'head', 0],
  ['neck', NECK_A, NECK_B, 'neck', 0],
  ['upperChest', CHEST_A, CHEST_B, 'upperChest', SPREAD.upperChest],
  ['abdomen', ABD_A, ABD_B, 'abdomen', SPREAD.abdomen],
  ['pelvis', PEL_A, PEL_B, 'pelvis', SPREAD.pelvis],
  ['upperArmL', SHO_L, ELB_L, 'upperArm', 0],
  ['upperArmR', SHO_R, ELB_R, 'upperArm', 0],
  ['forearmL', ELB_L, HAND_L, 'forearm', 0],
  ['forearmR', ELB_R, HAND_R, 'forearm', 0],
  ['thighL', HIP_L, KNEE_L, 'thigh', 0],
  ['thighR', HIP_R, KNEE_R, 'thigh', 0],
  ['shinL', KNEE_L, ANK_L, 'shin', 0],
  ['shinR', KNEE_R, ANK_R, 'shin', 0],
];
const CAPSULE_COUNT = CAPS.reduce((n, c) => n + (c[4] ? 2 : 1), 0);

// ---------------------------------------------------------------
// 2관절 IK: 뿌리 S → 목표 T, 길이 L1·L2, pole 방향으로 관절을 꺾는다.
// 손이 닿지 않으면 목표 쪽으로 쭉 뻗고 끝점(T)을 실제 닿는 곳으로 고쳐 쓴다.
// w: 작업 버퍼, si/ti/pi: 점 번호, o/oi: 관절 결과를 쓸 버퍼·번호
// ---------------------------------------------------------------
function solveIK(w, si, ti, pi, o, oi, L1, L2) {
  const sx = w[si * 3], sy = w[si * 3 + 1], sz = w[si * 3 + 2];
  let ux = w[ti * 3] - sx, uy = w[ti * 3 + 1] - sy, uz = w[ti * 3 + 2] - sz;
  const d = Math.sqrt(ux * ux + uy * uy + uz * uz);
  let px = w[pi * 3], py = w[pi * 3 + 1], pz = w[pi * 3 + 2];
  if (d < 1e-6) {
    const pl = Math.sqrt(px * px + py * py + pz * pz) || 1;
    o[oi * 3] = sx + (px / pl) * L1; o[oi * 3 + 1] = sy + (py / pl) * L1; o[oi * 3 + 2] = sz + (pz / pl) * L1;
    return;
  }
  ux /= d; uy /= d; uz /= d;
  const dc = Math.min(Math.max(d, Math.abs(L1 - L2) + 1e-4), L1 + L2 - 1e-4);
  if (dc !== d) {
    // 끝점을 닿는 거리로 (팔을 쭉 뻗음)
    w[ti * 3] = sx + ux * dc; w[ti * 3 + 1] = sy + uy * dc; w[ti * 3 + 2] = sz + uz * dc;
  }
  const a = (L1 * L1 - L2 * L2 + dc * dc) / (2 * dc);
  const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  // pole 에서 축 성분을 뺀 방향
  const pu = px * ux + py * uy + pz * uz;
  px -= pu * ux; py -= pu * uy; pz -= pu * uz;
  let pl = Math.sqrt(px * px + py * py + pz * pz);
  if (pl < 1e-6) {
    // pole 이 축과 나란하면 아무 수직 방향 (위 또는 앞)
    if (Math.abs(uy) < 0.9) { px = -uy * ux; py = 1 - uy * uy; pz = -uy * uz; } else { px = -uz * ux; py = -uz * uy; pz = 1 - uz * uz; }
    pl = Math.sqrt(px * px + py * py + pz * pz);
  }
  o[oi * 3] = sx + ux * a + (px / pl) * h;
  o[oi * 3 + 1] = sy + uy * a + (py / pl) * h;
  o[oi * 3 + 2] = sz + uz * a + (pz / pl) * h;
}

// ---------------------------------------------------------------
// buildHitboxes
// ---------------------------------------------------------------
const W = new Float64Array(NWORK * 3);   // 국소 좌표 작업 버퍼 (단일 스레드 → 공용)

/**
 * pose: { x, y, z (발, 월드), yaw, stance: 'stand'|'crouch'|'prone', stanceFrom?, stanceProgress? (0..1),
 *         lean? (m, + 오른쪽), arms?: 'rifle'|'down', bodyPitch?, eyeHeight? }
 * @returns {Array<{part, a:{x,y,z}, b:{x,y,z}, r, near, off}>} — out 배열과 캡슐 객체를 재사용 (out.eye, out.chest 포함)
 *   near: 머리·몸통(NEAR_PARTS) 여부, off: 좌우 쌍 캡슐이면 부위 중심선에서의 옆 변위 (hitNormal 용, 아니면 0 벡터)
 */
export function buildHitboxes(pose, out = []) {
  const R = CONFIG.hitboxes.radius;
  const to = TABLES[pose.stance] ? pose.stance : 'stand';
  const from = TABLES[pose.stanceFrom] ? pose.stanceFrom : to;
  const arms = pose.arms === 'down' ? 'down' : 'rifle';
  const B = TABLES[to][arms];
  const A = TABLES[from][arms];
  const prog = pose.stanceProgress ?? 1;
  const k = from === to ? 1 : smoothstep(0, 1, prog);

  // 1) 자세 보간
  for (let i = 0; i < NPTS * 3; i++) W[i] = A[i] + (B[i] - A[i]) * k;

  // 2) 실제 눈높이 보정 (물에서 머리를 드는 등)
  if (Number.isFinite(pose.eyeHeight) && pose.eyeHeight > 0) {
    let d = pose.eyeHeight - W[EYE * 3 + 1];
    d = d < -0.3 ? -0.3 : d > 0.6 ? 0.6 : d;
    if (Math.abs(d) > 1e-4) {
      for (let i = 0; i < NPTS; i++) if (EYE_W[i]) W[i * 3 + 1] += d * EYE_W[i];
      W[HAND_L * 3 + 1] += d * EYE_HAND[arms];
      W[HAND_R * 3 + 1] += d * EYE_HAND[arms];
    }
  }

  // 3) 기울이기: 상체를 옆으로 (카메라처럼 |lean|·0.06 만큼 낮아짐)
  const lean = pose.lean || 0;
  if (lean) {
    const drop = Math.abs(lean) * 0.06;
    for (let i = 0; i < NPTS; i++) {
      const w = LEAN_W[i];
      if (!w) continue;
      W[i * 3] += lean * w;
      W[i * 3 + 1] -= drop * w;
    }
    const hw = LEAN_HAND[arms];
    W[HAND_L * 3] += lean * hw; W[HAND_L * 3 + 1] -= drop * hw;
    W[HAND_R * 3] += lean * hw; W[HAND_R * 3 + 1] -= drop * hw;
  }

  // 4) 팔꿈치·무릎 IK
  solveIK(W, SHO_L, HAND_L, EPOLE_L, W, ELB_L, L_UPPER_ARM, L_FOREARM);
  solveIK(W, SHO_R, HAND_R, EPOLE_R, W, ELB_R, L_UPPER_ARM, L_FOREARM);
  solveIK(W, HIP_L, ANK_L, KPOLE_L, W, KNEE_L, L_THIGH, L_SHIN);
  solveIK(W, HIP_R, ANK_R, KPOLE_R, W, KNEE_R, L_THIGH, L_SHIN);

  // 5) 월드 변환: 발 위치 + yaw (+ 엎드린 몸의 경사)
  const yaw = pose.yaw || 0;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);   // 앞
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);    // 오른쪽
  let pitch = 0;
  if (pose.bodyPitch) {
    const wp = (to === 'prone' ? k : 0) + (from === 'prone' && from !== to ? 1 - k : 0);
    pitch = Math.max(-0.6, Math.min(0.6, pose.bodyPitch)) * wp;
  }
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // up' = up·cos - fwd·sin, fwd' = fwd·cos + up·sin
  XF[0] = pose.x; XF[1] = pose.y; XF[2] = pose.z;
  XF[3] = rx; XF[4] = 0; XF[5] = rz;
  XF[6] = -fx * sp; XF[7] = cp; XF[8] = -fz * sp;
  XF[9] = fx * cp; XF[10] = sp; XF[11] = fz * cp;
  const fall = pose.fall;
  if (fall && fall.angle) {
    // Rodrigues: v' = v cos + (k × v) sin + k (k·v)(1 − cos), k = 수평 단위축
    let kx = fall.ax, kz = fall.az;
    const kl = Math.hypot(kx, kz) || 1;
    kx /= kl; kz /= kl;
    const c = Math.cos(fall.angle), s = Math.sin(fall.angle);
    for (let i = 3; i < 12; i += 3) {
      const vx = XF[i], vy = XF[i + 1], vz = XF[i + 2];
      const kv = kx * vx + kz * vz;
      // k × v = (ky vz − kz vy, kz vx − kx vz, kx vy − ky vx), ky = 0
      XF[i] = vx * c + (-kz * vy) * s + kx * kv * (1 - c);
      XF[i + 1] = vy * c + (kz * vx - kx * vz) * s;
      XF[i + 2] = vz * c + (kx * vy) * s + kz * kv * (1 - c);
    }
    XF[1] += fall.lift || 0;
  }

  let n = 0;
  for (let c = 0; c < CAPS.length; c++) {
    const def = CAPS[c];
    const part = def[0], ia = def[1], ib = def[2], spread = def[4];
    const r = R[def[3]];
    const near = NEAR_PARTS.has(part);
    for (let side = spread ? -1 : 0; side <= (spread ? 1 : 0); side += 2) {
      const off = spread * side;
      let cap = out[n];
      if (!cap) { cap = { part, a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 0, z: 0 }, r, near, off: { x: 0, y: 0, z: 0 } }; out[n] = cap; }
      cap.part = part; cap.r = r; cap.near = near;
      toWorld(W[ia * 3] + off, W[ia * 3 + 1], W[ia * 3 + 2], cap.a);
      toWorld(W[ib * 3] + off, W[ib * 3 + 1], W[ib * 3 + 2], cap.b);
      // 몸통 쌍 캡슐: 부위 중심선에서 이 캡슐 축까지의 옆 방향 변위 (월드) — hitNormal 이 타원 단면 법선을 구할 때 씀
      cap.off.x = XF[3] * off; cap.off.y = XF[4] * off; cap.off.z = XF[5] * off;
      n++;
      if (!spread) break;
    }
  }
  out.length = n;
  toWorld(W[EYE * 3], W[EYE * 3 + 1], W[EYE * 3 + 2], out.eye || (out.eye = { x: 0, y: 0, z: 0 }));
  toWorld((W[CHEST_A * 3] + W[CHEST_B * 3]) / 2, (W[CHEST_A * 3 + 1] + W[CHEST_B * 3 + 1]) / 2,
    (W[CHEST_A * 3 + 2] + W[CHEST_B * 3 + 2]) / 2, out.chest || (out.chest = { x: 0, y: 0, z: 0 }));
  vitalZones(out);
  return out;
}

/**
 * 3단계 치명 부위 (가슴 상부 캡슐 안): out.heart (심장·대혈관 구 중심), out.spineA→spineB (상부 척추 선, 위→아래),
 * out.torsoUp (몸통 축 위 방향), out.torsoFwd (가슴이 향한 방향) — 모두 월드. 반경은 CONFIG.injury.
 * 국소 몸통 축 u = 가슴 캡슐 아래→위, 앞 f = z 축에서 u 성분을 뺀 방향 (숙이거나 엎드리면 아래를 향함).
 */
function vitalZones(out) {
  const J = CONFIG.injury;
  const ax = W[CHEST_A * 3], ay = W[CHEST_A * 3 + 1], az = W[CHEST_A * 3 + 2];
  let ux = W[CHEST_B * 3] - ax, uy = W[CHEST_B * 3 + 1] - ay, uz = W[CHEST_B * 3 + 2] - az;
  let l = Math.hypot(ux, uy, uz) || 1;
  ux /= l; uy /= l; uz /= l;
  let fx = -uz * ux, fy = -uz * uy, fz = 1 - uz * uz;          // z − (z·u)u
  l = Math.hypot(fx, fy, fz) || 1;
  fx /= l; fy /= l; fz /= l;
  const mx = (ax + W[CHEST_B * 3]) / 2, my = (ay + W[CHEST_B * 3 + 1]) / 2, mz = (az + W[CHEST_B * 3 + 2]) / 2;
  const H = J.heartOffset;
  toWorld(mx + fx * H.forward + ux * H.up - H.left, my + fy * H.forward + uy * H.up, mz + fz * H.forward + uz * H.up,
    out.heart || (out.heart = { x: 0, y: 0, z: 0 }));
  // 척추 위 끝: 목 아래 끝(NECK_A) 높이를 몸통 축에 투영, 등 쪽으로 back
  const S = J.spine;
  const h = (W[NECK_A * 3] - mx) * ux + (W[NECK_A * 3 + 1] - my) * uy + (W[NECK_A * 3 + 2] - mz) * uz;
  const tx = mx + ux * h - fx * S.back, ty = my + uy * h - fy * S.back, tz = mz + uz * h - fz * S.back;
  toWorld(tx, ty, tz, out.spineA || (out.spineA = { x: 0, y: 0, z: 0 }));
  toWorld(tx - ux * S.length, ty - uy * S.length, tz - uz * S.length, out.spineB || (out.spineB = { x: 0, y: 0, z: 0 }));
  // 방향 (원점 이동 없이 회전만)
  dirToWorld(ux, uy, uz, out.torsoUp || (out.torsoUp = { x: 0, y: 0, z: 0 }));
  dirToWorld(fx, fy, fz, out.torsoFwd || (out.torsoFwd = { x: 0, y: 0, z: 0 }));
}

// 국소 → 월드 변환 계수: [원점 x,y,z, right x,y,z, up' x,y,z, fwd' x,y,z]
const XF = new Float64Array(12);
function toWorld(lx, ly, lz, o) {
  o.x = XF[0] + XF[3] * lx + XF[6] * ly + XF[9] * lz;
  o.y = XF[1] + XF[4] * lx + XF[7] * ly + XF[10] * lz;
  o.z = XF[2] + XF[5] * lx + XF[8] * ly + XF[11] * lz;
  return o;
}
function dirToWorld(lx, ly, lz, o) {
  o.x = XF[3] * lx + XF[6] * ly + XF[9] * lz;
  o.y = XF[4] * lx + XF[7] * ly + XF[10] * lz;
  o.z = XF[5] * lx + XF[8] * ly + XF[11] * lz;
  return o;
}

export const HITBOX_CAPSULES = CAPSULE_COUNT;

/**
 * 피격 지점의 몸 표면 법선 (입사각·피격 효과 방향용).
 * 한 개짜리 캡슐은 캡슐 법선. 좌우 쌍 캡슐(가슴·복부·골반)은 두 캡슐 사이 홈이 아니라 실제 몸통처럼
 * 폭 (간격 + r) × 두께 r 인 타원 단면으로 보고 법선을 구한다 → 정중앙 명중은 정면(0°), 옆구리는 비스듬히.
 */
export function hitNormal(cap, p, out = { x: 0, y: 1, z: 0 }) {
  const o = cap.off;
  const s2 = o ? o.x * o.x + o.y * o.y + o.z * o.z : 0;
  const ax = cap.a.x - (o ? o.x : 0), ay = cap.a.y - (o ? o.y : 0), az = cap.a.z - (o ? o.z : 0);
  const ux = cap.b.x - cap.a.x, uy = cap.b.y - cap.a.y, uz = cap.b.z - cap.a.z;
  const l2 = ux * ux + uy * uy + uz * uz;
  let t = l2 > 0 ? ((p.x - ax) * ux + (p.y - ay) * uy + (p.z - az) * uz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  let vx = p.x - (ax + ux * t), vy = p.y - (ay + uy * t), vz = p.z - (az + uz * t);
  if (s2 > 1e-12) {
    const s = Math.sqrt(s2), lx = o.x / s, ly = o.y / s, lz = o.z / s;
    const vl = vx * lx + vy * ly + vz * lz;
    const A = s + cap.r, Bd = cap.r;
    // 옆 성분은 1/A², 나머지(두께·위아래 끝)는 1/r² — 타원 x²/A² + z²/r² = 1 의 기울기
    const kl = vl / (A * A) - vl / (Bd * Bd);
    vx = vx / (Bd * Bd) + lx * kl; vy = vy / (Bd * Bd) + ly * kl; vz = vz / (Bd * Bd) + lz * kl;
  }
  const l = Math.hypot(vx, vy, vz);
  if (l < 1e-12) { out.x = 0; out.y = 1; out.z = 0; return out; }
  out.x = vx / l; out.y = vy / l; out.z = vz / l;
  return out;
}

/** 넓은 단계 판정용 경계 구 (캡슐 끝점 AABB 중심 + 가장 먼 끝점 거리 + 반경) */
export function hitboxBounds(caps, out = { center: { x: 0, y: 0, z: 0 }, radius: 0 }) {
  if (!caps.length) { out.radius = -1; return out; }
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < caps.length; i++) {
    const { a, b } = caps[i];
    if (a.x < x0) x0 = a.x; if (a.x > x1) x1 = a.x; if (b.x < x0) x0 = b.x; if (b.x > x1) x1 = b.x;
    if (a.y < y0) y0 = a.y; if (a.y > y1) y1 = a.y; if (b.y < y0) y0 = b.y; if (b.y > y1) y1 = b.y;
    if (a.z < z0) z0 = a.z; if (a.z > z1) z1 = a.z; if (b.z < z0) z0 = b.z; if (b.z > z1) z1 = b.z;
  }
  const c = out.center;
  c.x = (x0 + x1) / 2; c.y = (y0 + y1) / 2; c.z = (z0 + z1) / 2;
  let r = 0;
  for (let i = 0; i < caps.length; i++) {
    const { a, b } = caps[i];
    const da = Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z), db = Math.hypot(b.x - c.x, b.y - c.y, b.z - c.z);
    r = Math.max(r, Math.max(da, db) + caps[i].r);
  }
  out.radius = r;
  return out;
}
