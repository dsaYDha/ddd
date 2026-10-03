// =====================================================================
//  난이도 자동 측정 (헤드리스) — 2단계 '맞히기가 매우 어렵다' 기준을 실제 모듈로 잰다
//    npm run aim                               → 시드 3개 (1, 2, 3), 조건별 시드 최소~최대
//    node scripts/aim-sim.mjs seed=7           → 시드 하나
//    node scripts/aim-sim.mjs seeds=1,2,3,4,5 rounds=2000 info=0
//    node scripts/aim-sim.mjs seeds=1,2,3,4,5,6,7,8,9,10 only=2,3   → 조정할 때 일부 조건만 (조건마다 난수열이 고정 → 같은 결과)
//  하나라도 기준을 벗어나거나(FAIL) config 가 사용자 지정 수치와 다르면 종료 코드 1.
//
//  가상 사수 규칙 ("표적 중심을 정확히 겨누되 흔들림·반동은 그대로 받는 가상 사수", 조건당 1,000발)
//   · 실제 모듈: CombatSystem(평지 월드 createFlatWorld(0)) + People + Shooter(Weapon + AimModel). 탄은 실제 투사체
//     (중력·공기 저항·영점·고유 산포·캡슐 판정). 사수 Person = 원점, 조건별 자세, 팔 'rifle'.
//     표적 Person = 북쪽(−Z) 거리 d 에 서서 사수를 바라봄, 팔 'down'. 명중 = 그 표적에게 난 combat 'hit' (부위 무관).
//   · 60Hz 고정 간격. 게임과 같은 순서: combat.update(dt) → shooter.update(…) (발사) → 시선 += viewKick.
//     측정 전 2초 동안 조준(비조준 조건은 비조준)을 유지 → 가늠자 전환이 끝나고 흔들림이 정상 상태.
//   · 표적 중심 = 표적 히트박스 경계 상자 중심 (hitboxBounds — 서 있으면 발 위 약 0.88m).
//     정확히 겨눔 = 눈에서 그 점으로 시선(yaw/pitch)을 맞춤. 흔들림은 보정하지 않는다
//     (조준 모델에 넘기는 lookDelta 는 0 — 쏘는 사이에 부드럽게 다시 겨눈다고 본다).
//   · 단발: 1초에 1발. 매 발 직전에 중심을 다시 겨눔 (반동 60% 잔량 제거 = 1초 사이에 표적을 다시 잡음).
//     흔들림 시계는 계속 흐른다 (발 사이에 조준 모델을 초기화하지 않음).
//   · #1 비조준: 조준 안 함 (ads 0), 가만히 서서 1초에 1발, 시선을 중심에 (지향사격 총구 방향 = 조준선).
//   · #4 연발: 중심을 겨누고 30발(600rpm)을 쥔 채 반동을 보정하지 않음 (시선 += viewKick 만 — 40% 자동 회복 포함),
//     놓고 3초 쉰 뒤 다시 겨눔. 1,000발이 넘을 때까지 (34회). 연발 순번별 명중률 (1, 2, 3, 4~30).
//     다시 겨누어 방아쇠를 당기기까지 0 ~ 호흡 한 번(무작위)이 더 걸린다 — 연발 한 주기(쏘는 2.9초 + 쉬는 3초)가 호흡의
//     약 1.5배라, 이게 없으면 매 연발 1발째가 늘 같은 두 호흡 위상에서 나가 1~3발째 명중률이 시드마다 치우친다
//     (판정하는 4~30발째는 반동으로 이미 표적 위라 무관). 요약의 1~3발째는 시드를 합산한 값.
//   · 심박·스태미나: #5 '달린 직후' = 심박 160 고정 + 스태미나 50 (달리기로 절반을 쓴 상태). 나머지는 심박 70 + 스태미나 100.
//     호흡수는 넘기지 않는다 → AimModel 이 심박에서 정함 (CONFIG.aim.breath — 4단계 적 병사와 같은 경로).
//   · #6 제압 85: 사수의 제압 수치를 매 프레임 85 로 다시 맞춤 (감소 없음), 효과는 Suppression.effects().
//     심박 = HumanMotor 심박 모델이 쉬는 상태에서 그 긴장으로 수렴하는 값: rest + (max − rest) × min(1, stressWeight × stress),
//     stress = effects().heartStress (게임의 motor.stress 와 같은 연결 — effects() 가 이미 수치/100 배라 다시 곱하지 않는다.
//     HumanMotor 에 stress 가 연결되면 npm run check [15] 가 실제 HumanMotor 도 같은 심박으로 수렴하는지 확인). 계산한 심박을 출력한다.
//   · 사용자 지정 수치 점검 (측정 전): config 가 사용자가 정한 수치 그대로인지 — 흔들림 1.0/0.6/0.3/0.15°, 심박 70 → ×1 · 170 → ×2.5,
//     숨 참기 4초 ×0.3 → 3초 ×1.8 · 스태미나 −15 · 5초, 지향사격 3.5/2.5/1.5° · 이동 ×2, 조준 0.35초 · 달린 직후 0.5초 · 이동 ×0.5,
//     반동 1.8°±0.3 · ±0.9° · 자동 회복 40% · 연발 ×1.0 → ×1.6 (5발째) · 자세 1.0/0.75/0.5/0.45, 제압 흔들림 최대 ×2.5
//     (85 이상 추가 배율까지 곱한 값) + 미세 떨림, 완전 제압 85, 산포 4~5 MOA, 600rpm · 715m/s · 영점 100m · 30발.
//     하나라도 다르면 FAIL (종료 코드 1) — 기준 게임이 아닌 것을 잰 결과이므로. 조정은 자유 변수(8자 모양·표류·떨림·방아쇠 등)로만.
//   · 기능 고장(발당 0.05%)·빈 탄창: 다음 발 전에 무기를 reset (탄창 채움·고장 해제 — 조준 모델은 그대로).
//     실제로 나간 발('fired')만 센다 → 고장 난 시도는 발수에 들어가지 않는다.
//   · 보고: 발수, 명중, 명중률, 95% 신뢰구간 (Wilson), 기준 PASS/FAIL, 쓴 수치. 기준 경계 2%p 이내면 '경계 근접' 표시.
//   · 참고 조건 (판정 없음): 서서 조준 15/50/100m, 앉아 조준 30m, 엎드려 조준 30m, 거치(앉아서 통나무) 30/100m,
//     숨 참기 서서 30m (1초 참고 쏜 뒤 놓음, 숨이 돌아오면 다시 — 일찍 놓으면 회복·스태미나·쿨다운이 참은 비율만큼:
//     AimModel f = max(minFraction 0.4, 참은 시간/4초). 쏘는 순간은 참는 중이라 명중률은 f 와 거의 무관 —
//     minFraction 1 이면 시드 1~3 에서 86.8~88.8%, 지금 87.7~89.8%),
//     이동 1m/s 조준 30m (흔들림 배율만 — 위치는 고정).
// =====================================================================
import { CONFIG } from '../src/config.js';
import { RNG, hash2 } from '../src/core/rng.js';
import { CombatSystem } from '../src/combat/CombatSystem.js';
import { createFlatWorld } from '../src/combat/BulletWorld.js';
import { Shooter } from '../src/combat/Shooter.js';
import { Suppression } from '../src/combat/Suppression.js';
import { breathRateFor, heartSwayMul, staminaSwayMul } from '../src/combat/AimModel.js';
import { yawPitchFromDir } from '../src/combat/geom.js';

const FPS = 60;
const DT = 1 / FPS;
const WARMUP = 2 * FPS;           // 측정 전 2초 (가늠자 전환 + 흔들림 정상 상태)
const AUTO_REST = 3 * FPS;        // 연발 사이 3초
const HOLD_FIRE_AT = FPS;         // 숨 참기: 참은 지 1초에 쏨
const W = CONFIG.weapons[CONFIG.weapons.default];
const NEAR_EDGE = 0.02;           // 기준 경계까지 이보다 가까우면 '경계 근접'

// ---------------------------------------------------------------------
// 명령줄: seed=N | seeds=a,b,c | rounds=N | info=0 (참고 조건 생략) | only=2,3,a (그 조건만 — 조정용)
// ---------------------------------------------------------------------
const ARGS = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.indexOf('=');
  return i > 0 ? [a.slice(0, i), a.slice(i + 1)] : [a, '1'];
}));
const SEEDS = ARGS.seed !== undefined ? [Number(ARGS.seed) >>> 0]
  : ARGS.seeds !== undefined ? ARGS.seeds.split(',').map((s) => Number(s) >>> 0) : [1, 2, 3];
const ROUNDS = Math.max(1, Number(ARGS.rounds) || 1000);
const WITH_INFO = ARGS.info !== '0';
const ONLY = ARGS.only !== undefined ? new Set(ARGS.only.split(',')) : null;

// ---------------------------------------------------------------------
// 조건
//  range: 명중률 기준 [하한, 상한] (하한 0 = '이하' 기준). 연발은 4~30발째 명중률에 적용.
// ---------------------------------------------------------------------
const MAIN = [
  { id: 1, label: '서서 비조준 사격 30m', proto: 'single', stance: 'stand', distance: 30, ads: false, range: [0, 0.10], need: '≤ 10%' },
  { id: 2, label: '서서 조준 단발 30m (1초 간격)', proto: 'single', stance: 'stand', distance: 30, ads: true, range: [0.35, 0.50], need: '35~50%' },
  { id: 3, label: '엎드려 조준 단발 50m', proto: 'single', stance: 'prone', distance: 50, ads: true, range: [0.60, 0.75], need: '60~75%' },
  { id: 4, label: '서서 연발 30발 30m', proto: 'auto', stance: 'stand', distance: 30, ads: true, range: [0, 0.03], need: '4발째부터 ≤ 3%' },
  { id: 5, label: '달린 직후 (심박 160) 서서 조준 30m', proto: 'single', stance: 'stand', distance: 30, ads: true, hr: 160, stamina: 50, range: [0, 0.20], need: '≤ 20%' },
  { id: 6, label: '제압 85 서서 조준 30m', proto: 'single', stance: 'stand', distance: 30, ads: true, sup: 85, range: [0, 0.10], need: '≤ 10%' },
];
const INFO = [
  { id: 'a', label: '서서 조준 15m', proto: 'single', stance: 'stand', distance: 15, ads: true },
  { id: 'b', label: '서서 조준 50m', proto: 'single', stance: 'stand', distance: 50, ads: true },
  { id: 'c', label: '서서 조준 100m', proto: 'single', stance: 'stand', distance: 100, ads: true },
  { id: 'd', label: '앉아 조준 30m', proto: 'single', stance: 'crouch', distance: 30, ads: true },
  { id: 'e', label: '엎드려 조준 30m', proto: 'single', stance: 'prone', distance: 30, ads: true },
  { id: 'f', label: '거치 조준 30m (앉아서 통나무)', proto: 'single', stance: 'crouch', distance: 30, ads: true, rested: true },
  { id: 'g', label: '거치 조준 100m (앉아서 통나무)', proto: 'single', stance: 'crouch', distance: 100, ads: true, rested: true },
  { id: 'h', label: '숨 참기 서서 조준 30m', proto: 'hold', stance: 'stand', distance: 30, ads: true },
  { id: 'i', label: '이동 1m/s 서서 조준 30m', proto: 'single', stance: 'stand', distance: 30, ads: true, speed: 1 },
];
// 조건마다 고정된 난수열 번호 — only= 로 일부만 돌려도 같은 시드면 같은 결과
[...MAIN, ...INFO].forEach((c, i) => { c.salt = i + 1; });

// 입력 (재사용 — Shooter 는 읽기만 한다)
const IN = {
  hip: {},
  hipFire: { trigger: true, triggerPressed: true },
  aim: { aim: true },
  aimFire: { aim: true, trigger: true, triggerPressed: true },
  aimHold: { aim: true, trigger: true },
  breath: { aim: true, holdBreath: true },
  breathFire: { aim: true, holdBreath: true, trigger: true, triggerPressed: true },
};
const LOG_SUPPORT = Object.freeze({ type: 'log' });   // 거치 조건의 가상 받침 (Rest.detectRest 가 object 이름으로 씀)

/** 제압 수치 value 의 지속 효과 (Suppression.effects() 그대로 — 게임과 같은 식) */
function supEffects(value) {
  const s = new Suppression();
  s.value = value;
  return s.effects();
}

/** 제압 수치 → 그 긴장에서 쉬는 사람의 심박이 수렴하는 값 (HumanMotor 심박 모델 + motor.stress = effects().heartStress) */
function stressHeartRate(value) {
  const stress = Math.min(1, Math.max(0, supEffects(value).heartStress));
  const H = CONFIG.heart;
  return { hr: H.rest + (H.max - H.rest) * Math.min(1, H.stressWeight * stress), stress };
}

/**
 * 사용자 지정 수치 점검 — 측정하는 게임이 사용자 기준 수치 그대로인지. [짧은 이름, 항목, 일치 여부, 지금 값]
 * 제압 흔들림은 config 값이 아니라 Suppression.effects() 가 실제로 내는 배율(85 이상 추가 배율 포함)을 0~100 전 구간에서 본다.
 */
function specChecks() {
  const A = CONFIG.aim, S = A.sway, HB = A.holdBreath, HS = A.hipSpread, R = W.recoil, RS = A.recoilStanceMul;
  const SE = CONFIG.suppression.effects;
  const same = (a, b) => Math.abs(a - b) < 1e-9;
  const g = R.burstGrowth || [];
  let supMax = 0, supMono = true;
  for (let v = 0, prev = 0; v <= 100; v += 0.5) {
    const m = supEffects(v).swayMul;
    if (!(m >= prev - 1e-12)) supMono = false;
    prev = m;
    supMax = Math.max(supMax, m);
  }
  return [
    ['흔들림', '흔들림 서기·앉기·엎드리기·거치 1.0/0.6/0.3/0.15°', S.stand === 1 && S.crouch === 0.6 && S.prone === 0.3 && S.rested === 0.15,
      `${S.stand}/${S.crouch}/${S.prone}/${S.rested}°`],
    ['심박', '심박 70 → ×1.0 · 170 → ×2.5', same(heartSwayMul(70), 1) && same(heartSwayMul(170), 2.5) && same(heartSwayMul(190), 2.5),
      `70 → ×${heartSwayMul(70)} · 170 → ×${heartSwayMul(170)}`],
    ['스태미나', '스태미나가 낮으면 흔들림 추가', same(staminaSwayMul(100), 1) && staminaSwayMul(0) > 1, `0 → ×${staminaSwayMul(0)}`],
    ['숨 참기', '숨 참기 4초 ×0.3 → 3초 ×1.8 · −15 · 5초', HB.duration === 4 && HB.swayMul === 0.3 && HB.recoverTime === 3 &&
      HB.recoverSwayMul === 1.8 && HB.staminaCost === 15 && HB.cooldown === 5,
      `${HB.duration}초 ×${HB.swayMul} → ${HB.recoverTime}초 ×${HB.recoverSwayMul} · −${HB.staminaCost} · ${HB.cooldown}초`],
    ['지향사격', '지향사격 3.5/2.5/1.5° · 이동 ×2', HS.stand === 3.5 && HS.crouch === 2.5 && HS.prone === 1.5 && A.hipMoveMul === 2,
      `${HS.stand}/${HS.crouch}/${HS.prone}° · ×${A.hipMoveMul}`],
    ['조준 전환', '조준 0.35초 · 달린 직후 0.5초 · 이동 ×0.5', A.adsTime === 0.35 && A.sprintDelay === 0.5 && A.adsMoveMul === 0.5,
      `${A.adsTime}초 · ${A.sprintDelay}초 · ×${A.adsMoveMul}`],
    ['반동', '반동 1.8°±0.3 · ±0.9° · 회복 40%', R.vertical === 1.8 && R.verticalJitter === 0.3 && R.horizontal === 0.9 && R.autoRecover === 0.4,
      `${R.vertical}°±${R.verticalJitter} · ±${R.horizontal}° · ${R.autoRecover * 100}%`],
    ['연발', '연발 ×1.0 → ×1.6 (5발째)', g[0] === 1 && g[4] === 1.6 && Math.max(...g) === 1.6 && g.every((x, i) => i === 0 || x >= g[i - 1]),
      `×${g.join('→×')}`],
    ['자세 반동', '자세 반동 1.0/0.75/0.5 · 거치 0.45', RS.stand === 1 && RS.crouch === 0.75 && RS.prone === 0.5 && RS.rested === 0.45,
      `${RS.stand}/${RS.crouch}/${RS.prone}/${RS.rested}`],
    ['제압 흔들림', '제압 흔들림 최대 ×2.5 + 미세 떨림', SE.swayMaxMul === 2.5 && supMax <= 2.5 + 1e-9 && same(supEffects(100).swayMul, 2.5) && supMono &&
      supEffects(85).tremorDeg > 0, `0~100 최대 ×${+supMax.toFixed(4)} (85 → ×${+supEffects(85).swayMul.toFixed(4)})`],
    ['완전 제압', '완전 제압 85 이상', CONFIG.suppression.levels.pinned === 85, `${CONFIG.suppression.levels.pinned}`],
    ['산포', '고유 산포 4~5 MOA', W.dispersionMOA >= 4 && W.dispersionMOA <= 5, `${W.dispersionMOA} MOA`],
    ['무기', '600rpm · 715m/s · 영점 100m · 30발', W.rpm === 600 && W.muzzleVelocity === 715 && W.zeroRange === 100 && W.magCapacity === 30,
      `${W.rpm}rpm · ${W.muzzleVelocity}m/s · ${W.zeroRange}m · ${W.magCapacity}발`],
  ];
}

// ---------------------------------------------------------------------
// 장면: 평지 + 사수 + 표적
// ---------------------------------------------------------------------
function makeScene(cond, seed, salt) {
  const stance = cond.stance ?? 'stand';
  const distance = cond.distance ?? 30;
  const combat = new CombatSystem(null, null, { world: createFlatWorld(0), rng: new RNG(hash2(seed, salt * 2 + 1)) });
  const look = { yaw: 0, pitch: 0 };
  const eye = { x: 0, y: CONFIG.stance.eyeHeight[stance], z: 0 };
  const myPose = { x: 0, y: 0, z: 0, yaw: 0, stance, arms: 'rifle' };
  const me = combat.addPerson({ name: '가상 사수', isPlayer: true, getPose: () => { myPose.yaw = look.yaw; return myPose; } });
  const tPose = { x: 0, y: 0, z: -distance, yaw: Math.PI, stance: 'stand', arms: 'down' };   // yaw π = +Z(사수 쪽)을 바라봄
  const target = combat.addPerson({ name: '표적', getPose: () => tPose });
  const shooter = new Shooter(combat, me, W, { rng: new RNG(hash2(seed, salt * 2 + 2)) });

  let hr = cond.hr ?? 70;
  let stress = 0;
  if (cond.sup > 0) ({ hr, stress } = stressHeartRate(cond.sup));
  const sc = {
    cond, combat, shooter, me, target, look, eye, stress,
    proto: new RNG(hash2(hash2(seed, salt), 3)),   // 가상 사수 자신의 무작위 (연발 사이 다시 겨누는 시간) — 탄·조준 난수열과 따로
    supHold: cond.sup > 0 ? cond.sup : 0,
    fx: {},
    pose: {
      eye, yaw: 0, pitch: 0, stance, stanceFrom: stance, stanceProgress: 1, speed: cond.speed ?? 0, sprinting: false,
      heartRate: hr, stamina: cond.stamina ?? 100, breathRate: undefined, suppression: 0, suppressionEffects: null,
      lookDeltaYaw: 0, lookDeltaPitch: 0,
    },
    query: null, supportTop: 0,
    // 통계
    fired: 0, hits: 0, jams: 0, bursts: 0, ampSum: 0, ampMax: 0,
    firedBy: new Array(31).fill(0), hitBy: new Array(31).fill(0), burstOf: new Map(),
  };
  if (cond.rested) {
    // 총몸 바로 아래 통나무 윗면 (간격 2cm) — Rest.detectRest 가 실제 규칙으로 판정한다. 평지 월드라 탄은 막지 않음
    sc.query = {
      circleGrid: null,
      getSupportHeight(x, z, out) { if (out) out.obstacle = LOG_SUPPORT; return sc.supportTop; },
    };
  }
  combat.on('shot', (e) => { if (e.shooter === me) sc.burstOf.set(e.projectile, Math.min(30, shooter.weapon.burstIndex)); });
  combat.on('hit', (e) => {
    if (e.person !== target || e.shooter !== me) return;
    sc.hits++;
    sc.hitBy[sc.burstOf.get(e.projectile) ?? 0]++;
  });
  combat.on('end', (e) => sc.burstOf.delete(e.projectile));
  shooter.on('fired', (e) => {
    sc.fired++;
    sc.firedBy[Math.min(30, e.burstIndex)]++;
    const A = shooter.aim.swayAmpDeg;
    sc.ampSum += A;
    if (A > sc.ampMax) sc.ampMax = A;
  });
  shooter.on('malfunction', () => sc.jams++);
  return sc;
}

/** 시선을 표적 히트박스 경계 상자 중심에 정확히 */
function aimAtCentre(sc) {
  const c = sc.target.bounds.center, e = sc.eye;
  const r = yawPitchFromDir({ x: c.x - e.x, y: c.y - e.y, z: c.z - e.z });
  sc.look.yaw = r.yaw;
  sc.look.pitch = r.pitch;
  if (sc.query) {
    const R = CONFIG.aim.rest;
    sc.supportTop = e.y + Math.sin(r.pitch) * R.forward - R.below - 0.02;
  }
}

/** 60Hz 한 프레임 (게임 루프 순서) */
function step(sc, input) {
  const sup = sc.me.suppression;
  if (sc.supHold > 0) { sup.value = sc.supHold; sup.timeSinceEvent = 0; }   // 고정 (감소 없음)
  sc.combat.update(DT);
  const P = sc.pose;
  P.yaw = sc.look.yaw;
  P.pitch = sc.look.pitch;
  P.suppression = sup.value;
  P.suppressionEffects = sup.effects(sc.fx);
  const k = sc.shooter.update(DT, P, input, sc.query);
  sc.look.yaw += k.viewKickYaw;
  sc.look.pitch += k.viewKickPitch;
}

/** 다음 발 전에: 빈 약실·기능 고장이면 무기를 처음 상태로 (조준 모델은 그대로) */
function service(sc, mode = 'semi') {
  const w = sc.shooter.weapon;
  if (!w.chambered || w.malfunctioned || w.busy) {
    w.reset();
    if (mode !== w.mode) w.setMode(mode);
  }
}

/** 날아가는 탄이 다 끝날 때까지 */
function settle(sc) {
  for (let i = 0; i < 5 * FPS && sc.combat.ballistics.projectiles.length; i++) sc.combat.update(DT);
}

function warmUp(sc, input) {
  for (let i = 0; i < WARMUP; i++) { aimAtCentre(sc); step(sc, input); }
}

function runSingle(sc, rounds) {
  const base = sc.cond.ads ? IN.aim : IN.hip;
  const fire = sc.cond.ads ? IN.aimFire : IN.hipFire;
  warmUp(sc, base);
  while (sc.fired < rounds) {
    service(sc);
    aimAtCentre(sc);
    step(sc, fire);
    for (let i = 1; i < FPS; i++) { aimAtCentre(sc); step(sc, base); }
  }
  settle(sc);
}

function runAuto(sc, rounds) {
  const w = sc.shooter.weapon;
  w.setMode('auto');
  warmUp(sc, IN.aim);
  while (sc.fired < rounds) {
    service(sc, 'auto');
    aimAtCentre(sc);
    const start = sc.fired;
    step(sc, IN.aimFire);
    // 30발이 나가거나 무기가 멈출 때까지 쥠 — 반동 보정 없음 (시선은 viewKick 만 받는다)
    for (let f = 0; f < 4 * FPS && sc.fired - start < 30 && w.chambered && !w.malfunctioned; f++) step(sc, IN.aimHold);
    sc.bursts++;
    for (let i = 0; i < AUTO_REST; i++) step(sc, IN.aim);   // 놓고 3초 (자동 회복 40% 만 시선에)
    // 다시 겨누어 당기기까지 0 ~ 호흡 한 번 (무작위) — 연발이 호흡 위상에 고정되지 않게 (머리말 참고)
    const n = Math.floor(sc.proto.float() * FPS / breathHzOf(sc));
    for (let i = 0; i < n; i++) { aimAtCentre(sc); step(sc, IN.aim); }
  }
  settle(sc);
}

/** 조준 모델의 8자 궤적이 도는 호흡수 (Hz) — 호흡수를 넘기지 않으면 AimModel 이 심박에서 정한다 */
function breathHzOf(sc) {
  const hz = sc.pose.breathRate > 0 ? sc.pose.breathRate : breathRateFor(sc.pose.heartRate);
  return hz * (CONFIG.aim.sway.rateMul ?? 1);
}

function runHold(sc, rounds) {
  const aim = sc.shooter.aim;
  warmUp(sc, IN.aim);
  while (sc.fired < rounds) {
    service(sc);
    for (let i = 0; i < HOLD_FIRE_AT; i++) { aimAtCentre(sc); step(sc, IN.breath); }
    aimAtCentre(sc);
    step(sc, IN.breathFire);
    // 바로 놓고, 숨이 돌아온(idle) 뒤 1초 더 — 그다음 다시 참는다
    let idle = 0;
    for (let i = 0; i < 20 * FPS && idle < FPS; i++) {
      aimAtCentre(sc);
      step(sc, IN.aim);
      idle = aim.holdState === 'idle' ? idle + 1 : 0;
    }
  }
  settle(sc);
}

function runCondition(cond, seed, salt) {
  const sc = makeScene(cond, seed, salt);
  if (cond.proto === 'auto') runAuto(sc, ROUNDS);
  else if (cond.proto === 'hold') runHold(sc, ROUNDS);
  else runSingle(sc, ROUNDS);
  const sum = (a, i0, i1) => a.slice(i0, i1 + 1).reduce((s, v) => s + v, 0);
  const r = {
    fired: sc.fired, hits: sc.hits, rate: sc.hits / sc.fired, jams: sc.jams, bursts: sc.bursts,
    amp: sc.ampSum / Math.max(1, sc.fired), ampMax: sc.ampMax,
    hr: sc.pose.heartRate, stamina: sc.pose.stamina, stress: sc.stress,
    breathHz: breathRateFor(sc.pose.heartRate),
  };
  if (cond.proto === 'auto') {
    r.byRound = [1, 2, 3].map((i) => ({ fired: sc.firedBy[i], hits: sc.hitBy[i], rate: sc.hitBy[i] / Math.max(1, sc.firedBy[i]) }));
    const f = sum(sc.firedBy, 4, 30), h = sum(sc.hitBy, 4, 30);
    r.late = { fired: f, hits: h, rate: h / Math.max(1, f) };
  }
  r.judged = cond.proto === 'auto' ? r.late : r;
  return r;
}

// ---------------------------------------------------------------------
// 통계 · 출력 도우미
// ---------------------------------------------------------------------
/** Wilson 95% 신뢰구간 */
function wilson(k, n, z = 1.96) {
  if (!(n > 0)) return [0, 1];
  const p = k / n, z2 = z * z, den = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const inRange = (p, [lo, hi]) => p >= lo - 1e-12 && p <= hi + 1e-12;
/** 기준 경계까지 여유 (하한 0 이면 상한만 본다) */
const margin = (pMin, pMax, [lo, hi]) => Math.min(lo > 0 ? pMin - lo : Infinity, hi - pMax);
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
// 한글은 터미널에서 두 칸 → 표 정렬용 폭
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const widthOf = (s) => { let w = 0; for (const ch of s) w += WIDE.test(ch) ? 2 : 1; return w; };
const padW = (s, n) => s + ' '.repeat(Math.max(0, n - widthOf(s)));
const padL = (s, n) => ' '.repeat(Math.max(0, n - widthOf(s))) + s;

function paramsLine(cond, r) {
  const st = { stand: '서기', crouch: '앉기', prone: '엎드리기' }[cond.stance];
  const parts = [`${st}`, `${cond.distance}m`, cond.ads ? (cond.rested ? '조준·거치' : '조준') : '비조준'];
  parts.push(`심박 ${r.hr.toFixed(cond.sup ? 1 : 0)}(×${heartSwayMul(r.hr).toFixed(2)})`);
  parts.push(`스태미나 ${r.stamina}(×${staminaSwayMul(r.stamina).toFixed(2)})`);
  parts.push(`호흡 ${r.breathHz.toFixed(2)}Hz`);
  if (cond.sup) {
    const fx = supEffects(cond.sup);
    parts.push(`제압 ${cond.sup}(흔들림 ×${fx.swayMul.toFixed(3)}, 떨림 ${fx.tremorDeg.toFixed(3)}°, 긴장 ${r.stress.toFixed(3)})`);
  }
  if (cond.speed) parts.push(`이동 ${cond.speed}m/s`);
  if (!cond.ads) parts.push(`퍼짐 반각 ${CONFIG.aim.hipSpread[cond.stance]}°`);
  parts.push(`흔들림 진폭 평균 ${r.amp.toFixed(3)}°`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------
const A = CONFIG.aim, S = A.sway, R = W.recoil;
const t0 = performance.now();
console.log(`\n난이도 자동 측정 — 가상 사수 (표적 중심을 정확히 겨누고 흔들림·반동은 그대로), 조건당 ${ROUNDS}발, 시드 ${SEEDS.join(', ')}`);
console.log(`  무기 ${W.label} · 초속 ${W.muzzleVelocity}m/s · 영점 ${W.zeroRange}m · 고유 산포 ${W.dispersionMOA} MOA · ${W.rpm}rpm`);
console.log(`  반동 수직 ${R.vertical}°±${R.verticalJitter} · 수평 ±${R.horizontal}° · 자동 회복 ${R.autoRecover * 100}% · 연발 ×${R.burstGrowth.join('→×')} · 자세 ${Object.entries(A.recoilStanceMul).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
console.log(`  흔들림 서기 ${S.stand}° · 앉기 ${S.crouch}° · 엎드리기 ${S.prone}° · 거치 ${S.rested}° | 8자 가로/세로 ${S.figureAspect} · 깊이 ±${S.depthVar} · 표류 ${S.drift} · 손떨림 ${S.tremorDeg}° · 방아쇠 ${S.triggerJerkDeg}°`);
console.log(`  심박 ${A.heart.restBpm}→×1 · ${A.heart.maxBpm}→×${A.heart.maxMul} | 스태미나 ${A.stamina.below} 아래 최대 ×${A.stamina.maxMul} (지수 ${A.stamina.exponent}) | 호흡 ${A.breath.baseHz}+${A.breath.hrHz}·n^${A.breath.hrExp}Hz | 비조준 퍼짐 ${A.hipSpread.stand}/${A.hipSpread.crouch}/${A.hipSpread.prone}°`);
const E = CONFIG.suppression.effects;
const pinnedNote = E.pinnedSwayMul !== 1 ? `, ${CONFIG.suppression.levels.pinned} 이상 ×${E.pinnedSwayMul} 추가` : '';
console.log(`  제압 흔들림 ×1 → ×${+supEffects(100).swayMul.toFixed(4)} (수치에 비례${pinnedNote}) · 떨림 ${E.tremorDeg}° · 심박 긴장 ${E.heartStress} (stressWeight ${CONFIG.heart.stressWeight})`);

// 사용자 지정 수치 점검 — 다르면 이 측정은 기준 게임의 것이 아니다
const spec = specChecks();
const specFails = spec.filter(([, , ok]) => !ok);
console.log(specFails.length
  ? `  사용자 지정 수치 점검: FAIL ${specFails.length}건 — config 가 사용자 기준과 다름 (측정은 바뀐 수치로 진행)`
  : `  사용자 지정 수치 점검: ${spec.length}개 항목 모두 그대로 (${spec.map(([name]) => name).join(' · ')})`);
for (const [, label, , got] of specFails) console.log(`    FAIL  ${label} — 지금 ${got}`);

const conds = (WITH_INFO ? [...MAIN, ...INFO] : MAIN).filter((c) => !ONLY || ONLY.has(String(c.id)));
const results = new Map(conds.map((c) => [c, []]));   // 조건 → 시드별 결과
let failed = 0;

for (const seed of SEEDS) {
  console.log(`\n[시드 ${seed}]`);
  console.log(`  ${padW('조건', 40)}${padL('발수', 6)}${padL('명중', 6)}${padL('명중률', 9)}   ${padW('95% 신뢰구간', 16)}${padW('기준', 16)}판정`);
  for (const c of conds) {
    const r = runCondition(c, seed, c.salt);
    results.get(c).push(r);
    const j = r.judged;
    const [lo, hi] = wilson(j.hits, j.fired);
    const label = `${c.id}  ${c.label}${c.proto === 'auto' ? ' (4~30발째)' : ''}`;
    let verdict = '참고';
    if (c.range) {
      const ok = inRange(j.rate, c.range);
      if (!ok) failed++;
      verdict = ok ? 'PASS' : 'FAIL';
      if (ok && margin(j.rate, j.rate, c.range) < NEAR_EDGE) verdict += ' (경계 근접)';
    }
    console.log(`  ${padW(label, 40)}${padL(String(j.fired), 6)}${padL(String(j.hits), 6)}${padL(pct(j.rate), 9)}   ${padW(`${pct(lo)} ~ ${pct(hi)}`, 16)}${padW(c.need ?? '', 16)}${verdict}`);
    if (c.proto === 'auto') {
      const b = r.byRound.map((x, i) => `${i + 1}발째 ${pct(x.rate)} (${x.hits}/${x.fired})`).join(' · ');
      console.log(`       연발 ${r.bursts}회 · 총 ${r.fired}발 중 명중 ${r.hits} (${pct(r.rate)}) · ${b}`);
    }
    if (c.range) console.log(`       ${paramsLine(c, r)}${r.jams ? ` · 기능 고장 ${r.jams}회 (해결 후 계속)` : ''}`);
  }
}

// 요약: 시드 최소~최대
const span = (arr, f) => { const v = arr.map(f); return [Math.min(...v), Math.max(...v)]; };
const showSpan = ([a, b]) => (a === b ? pct(a) : `${(a * 100).toFixed(1)} ~ ${pct(b)}`);
console.log(`\n[요약] 시드 ${SEEDS.join(', ')} — 조건별 명중률 최소 ~ 최대`);
console.log(`  ${padW('조건', 40)}${padW('명중률', 18)}${padW('기준', 16)}판정`);
for (const c of MAIN) {
  const rs = results.get(c);
  if (!rs) continue;
  const s = span(rs, (r) => r.judged.rate);
  const ok = rs.every((r) => inRange(r.judged.rate, c.range));
  const m = margin(s[0], s[1], c.range);
  const verdict = ok ? `PASS  여유 ${(m * 100).toFixed(1)}%p${m < NEAR_EDGE ? ' (경계 근접 — 조정 필요)' : ''}` : 'FAIL';
  console.log(`  ${padW(`${c.id}  ${c.label}${c.proto === 'auto' ? ' (4~30발째)' : ''}`, 40)}${padW(showSpan(s), 18)}${padW(c.need, 16)}${verdict}`);
  if (c.proto === 'auto') {
    // 1~3발째는 시드당 연발 횟수(34)만큼이라 시드 하나로는 흔들린다 → 시드를 합산해서 (참고)
    const b = [0, 1, 2].map((i) => {
      const h = rs.reduce((a, r) => a + r.byRound[i].hits, 0), n = rs.reduce((a, r) => a + r.byRound[i].fired, 0);
      return `${i + 1}발째 ${pct(h / Math.max(1, n))} (${h}/${n})`;
    }).join(' · ');
    console.log(`       ${b}  — 1~3발째 시드 합산 (참고, 시드별 1발째 ${showSpan(span(rs, (r) => r.byRound[0].rate))})`);
  }
}
if (WITH_INFO && INFO.some((c) => results.has(c))) {
  console.log('\n[참고] 판정 없음 — 같은 가상 사수 규칙');
  for (const c of INFO) {
    const rs = results.get(c);
    if (!rs) continue;
    const amp = span(rs, (r) => r.amp);
    console.log(`  ${padW(`${c.id}  ${c.label}`, 40)}${padW(showSpan(span(rs, (r) => r.rate)), 18)}흔들림 진폭 평균 ${amp[0].toFixed(3)}~${amp[1].toFixed(3)}°`);
  }
}
const sec = (performance.now() - t0) / 1000;
const problems = [];
if (specFails.length) problems.push(`사용자 지정 수치와 다름 ${specFails.length}건`);
if (failed) problems.push(`기준 벗어남 ${failed}건`);
console.log(problems.length ? `\n${problems.join(' · ')} (${sec.toFixed(1)}s)` : `\n모든 난이도 기준 통과 · 사용자 지정 수치 그대로 (${sec.toFixed(1)}s)`);
process.exitCode = problems.length ? 1 : 0;
