// 1인칭 카메라: 눈높이(빠진 깊이 반영) + 걸음 흔들림 + 호흡 흔들림 + 기울이기
//  2단계: 가늠자 조준(ads 0~1) 중에는 걸음·호흡·진흙 기우뚱을 (1 − 0.8·ads) 로 줄이고 시야각 × aim.adsFovMul (확대 아님),
//         근접 통과 움찔(addShake — 가까울수록 크게, 약 0.3초), 제압 미세 떨림(tremorDeg), 발사 순간의 짧은 화면 튐(punch, 약 0.15초).
//         반동으로 '남는' 시선 변화는 PlayerController 의 yaw/pitch 에 이미 들어 있다 (여기 것은 잠깐 보이는 흔들림뿐).
//  3단계: impact(옆, 뒤, 세기) — 총에 맞은 강한 충격 (맞은 방향으로 머리가 젖혀졌다 돌아옴, 약 0.8초),
//         knockdown() — 넘어지며 땅으로 떨어지는 굴림, downed (Game 이 채움) — 쓰러져 있는 동안 기운 채,
//         death 0~1 (Game 이 채움) — 시점이 땅에 떨어져 옆으로 누움.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { clamp, lerp } from '../core/math.js';
import { surfaceProps } from '../world/Surfaces.js';

const DEG = Math.PI / 180;
const SHAKE_TAU = 0.09;    // 움찔 감쇠 시간상수 (s) — 약 0.3초면 사라짐
const PUNCH_TAU = 0.05;    // 발사 튐 감쇠 (s) — 약 0.15초

export class CameraRig {
  constructor(camera, motor, breathCycle) {
    this.camera = camera;
    this.motor = motor;
    this.breath = breathCycle;
    this.camera.rotation.order = 'YXZ';
    this.eyeY = motor.position.y + motor.eyeHeight;
    this.eyeVel = 0;
    this.bobAmp = 0;
    this.bobSurface = 1;
    this.lurch = 0;
    this.dip = 0;
    this.dipVel = 0;
    this.leanSmooth = 0;
    // 2단계 (Game 이 매 프레임 채움)
    this.baseFov = camera.fov;   // 설정 시야각
    this.ads = 0;                // 가늠자 조준 정도 0~1
    this.holdingBreath = false;  // 숨 참는 중 → 호흡 흔들림 거의 멈춤
    this.tremorDeg = 0;          // 제압 미세 떨림 (°)
    this._t = 0;
    this._shake = 0;             // 움찔 진폭 (rad)
    this._shakePh = [0, 0, 0];
    this._punch = 0;             // 발사 튐 (rad, 위)
    this._punchRoll = 0;
    this._right = new THREE.Vector3();
    // 3단계 피격
    this._imp = { p: 0, y: 0, r: 0, vp: 0, vy: 0, vr: 0 };   // 충격 스프링 (rad)
    this._knock = 0;             // 넘어짐 굴림 (rad, 감쇠)
    this._knockSide = 1;
    this.downed = false;         // 쓰러져 있음 → 기운 시점
    this._downRoll = 0;
    this.death = 0;              // 0~1 죽어서 쓰러짐
    this.deathSide = 1;
    this.groundY = null;         // 죽음 시점이 내려갈 땅 높이 (Game 이 채움)
    motor.on('land', (e) => { this.dipVel -= Math.min(1.6, e.speed * 0.35) * CONFIG.camera.landingDip * 10; });
    motor.on('suction', (e) => { this.dipVel -= 0.25 * e.intensity; });
  }

  /** 근접 통과 움찔 (°) — 겹치면 큰 쪽, 방향은 매번 새로 */
  addShake(deg) {
    const a = Math.max(0, deg) * DEG;
    if (a <= this._shake) return;
    this._shake = a;
    for (let i = 0; i < 3; i++) this._shakePh[i] = Math.random() * Math.PI * 2;
  }

  /**
   * 총에 맞은 충격: side (+ 오른쪽에서 맞음), back (+ 앞에서 맞아 뒤로 밀림), strength 0~1.5.
   * 머리가 맞은 방향 반대로 확 젖혀졌다가 스프링으로 돌아옴 + 움찔.
   */
  impact(side, back, strength = 1) {
    const I = this._imp, k = Math.max(0, strength);
    I.vp += (0.6 + 0.6 * back) * 0.9 * k;            // 위로 젖혀짐
    I.vy += -side * 0.9 * k + (Math.random() - 0.5) * 0.6 * k;
    I.vr += (side * 1.1 + (Math.random() - 0.5) * 0.8) * k;
    this.addShake(2.2 * k);
  }

  /** 넘어짐: 시점이 옆으로 굴러 땅으로 떨어짐 (감쇠, 쓰러진 기울기는 downed 가 유지) */
  knockdown(side = Math.random() < 0.5 ? -1 : 1) {
    this._knockSide = side;
    this._knock = 0.55;
    this.dipVel -= 1.2;
  }

  /** 다시 시작: 피격 표현 초기화 */
  resetInjury() {
    const I = this._imp;
    I.p = I.y = I.r = I.vp = I.vy = I.vr = 0;
    this._knock = 0; this._downRoll = 0; this.downed = false; this.death = 0;
  }

  /** 발사 순간 화면이 짧게 튐 (°) */
  punch(deg) {
    this._punch = Math.min(this._punch + Math.max(0, deg) * DEG, 2 * DEG);
    this._punchRoll += (Math.random() - 0.5) * deg * 0.8 * DEG;
  }

  update(dt, yaw, pitch) {
    const m = this.motor;
    const C = CONFIG.camera;
    const sp = surfaceProps(m.surface);
    this._t += dt;

    // 눈높이: 임계 감쇠 스프링 (발 디딤·자세 전환·빠짐을 부드럽게)
    const target = m.position.y + m.eyeHeight;
    const w = C.eyeHeightSmoothing;
    if (Math.abs(target - this.eyeY) > 1.5) { this.eyeY = target; this.eyeVel = 0; }
    // 5단계: 프레임이 아주 낮으면 (dt 0.1) 한 번에 적분하는 스프링이 발산한다 → 0.02초 이하로 나눠 적분
    const steps = Math.max(1, Math.ceil(dt / 0.02)), h = dt / steps;
    for (let k = 0; k < steps; k++) {
      this.eyeVel += (w * w * (target - this.eyeY) - 2 * w * this.eyeVel) * h;
      this.eyeY += this.eyeVel * h;
      // 착지 딥
      this.dipVel += (-60 * this.dip - 12 * this.dipVel) * h;
      this.dip += this.dipVel * h;
    }

    // 가늠자 조준 중엔 머리 흔들림을 줄임 (뺨을 개머리판에 붙이고 버팀)
    const steady = 1 - 0.8 * clamp(this.ads, 0, 1);

    // 걸음 흔들림
    const gait = m.gait;
    const B = C.bob;
    let vAmp = B.walkVertical, lAmp = B.walkLateral, rAmp = B.walkRoll;
    if (gait === 'sprint') { vAmp = B.sprintVertical; lAmp = B.sprintLateral; rAmp = B.sprintRoll; }
    let stanceMul = 1;
    if (m.stance === 'crouch') stanceMul = B.crouchMul;
    if (m.stance === 'prone') stanceMul = B.proneMul;
    if (gait === 'quiet') stanceMul *= 0.7;
    this.bobSurface = lerp(this.bobSurface, sp.bob, 1 - Math.exp(-3 * dt));
    const targetAmp = m.moveFactor * stanceMul * (m.grounded ? 1 : 0.2);
    this.bobAmp = lerp(this.bobAmp, targetAmp, 1 - Math.exp(-6 * dt));
    const ph = m.gaitPhase * Math.PI * 2;      // 한 걸음 = 2π
    const bobV = -Math.cos(ph) * vAmp * this.bobAmp * this.bobSurface * steady;
    const bobL = Math.sin(ph * 0.5) * lAmp * this.bobAmp * Math.sqrt(this.bobSurface) * steady;
    const bobR = Math.sin(ph * 0.5) * rAmp * DEG * this.bobAmp * this.bobSurface * steady;
    // 진흙: 걸음마다 무겁게 기우뚱 (발을 빼며 몸이 앞뒤·좌우로 쏠림)
    const mud = clamp((sp.stepPulse - 0.2) / 0.55, 0, 1);
    this.lurch = lerp(this.lurch, mud * this.bobAmp, 1 - Math.exp(-3 * dt));
    const lurchRoll = Math.sin(ph * 0.5) * B.mudLurchRollDeg * DEG * this.lurch * steady;
    const lurchPitch = -Math.cos(ph) * B.mudLurchPitchDeg * DEG * this.lurch * steady;

    // 호흡 흔들림 (스태미나·심박 연동) — 숨 참는 동안 거의 멈춤
    const br = C.breath;
    const b = this.breath;
    const amp = lerp(br.restAmplitude, br.exhaustedAmplitude, Math.pow(b.intensity, 1.4)) * steady * (this.holdingBreath ? 0.25 : 1);
    const chest = b.chest;
    const breathPitch = chest * amp;
    const breathYaw = Math.sin(b.phase * Math.PI * 2 + 1.3) * amp * 0.35;
    const breathV = chest * br.verticalAmplitude * Math.pow(b.intensity, 1.5) * steady * (this.holdingBreath ? 0.25 : 1);

    // 근접 통과 움찔 + 제압 미세 떨림 + 발사 튐 (보이는 흔들림일 뿐 — 조준선은 AimModel 이 따로 흔든다)
    let shY = 0, shP = 0, shR = 0;
    if (this._shake > 1e-5) {
      const s = this._shake, t = this._t, P = this._shakePh;
      shY = s * Math.sin(t * 69 + P[0]);
      shP = s * 0.8 * Math.sin(t * 82 + P[1]);
      shR = s * 0.6 * Math.sin(t * 57 + P[2]);
      this._shake *= Math.exp(-dt / SHAKE_TAU);
    } else this._shake = 0;
    if (this.tremorDeg > 1e-4) {
      const a = this.tremorDeg * 0.5 * DEG, t = this._t;
      shY += a * 0.5 * (Math.sin(t * 47.1) + Math.sin(t * 71.3 + 1.7));
      shP += a * 0.5 * (Math.sin(t * 53.7 + 0.4) + Math.sin(t * 64.9 + 2.9));
    }
    const punchP = this._punch, punchR = this._punchRoll;
    const pk = Math.exp(-dt / PUNCH_TAU);
    this._punch *= pk;
    this._punchRoll *= pk;

    // 3단계: 피격 충격 스프링 (약간 덜 감쇠 — 휘청) + 넘어짐 굴림 + 쓰러진 기울기 + 죽음
    const I = this._imp, kw = 9, kz = 0.55;
    for (const [a, v] of [['p', 'vp'], ['y', 'vy'], ['r', 'vr']]) {
      I[v] += (-kw * kw * I[a] - 2 * kz * kw * I[v]) * dt;
      I[a] += I[v] * dt;
    }
    this._knock *= Math.exp(-dt / 0.45);
    const downTarget = this.downed ? 0.11 * this._knockSide : 0;
    this._downRoll += (downTarget - this._downRoll) * (1 - Math.exp(-2.5 * dt));
    const dk = clamp(this.death, 0, 1);
    const deathRoll = dk * 1.35 * this.deathSide, deathPitch = -dk * 0.35;
    let deathDrop = 0;
    if (dk > 0 && Number.isFinite(this.groundY)) deathDrop = Math.max(0, (this.eyeY - (this.groundY + 0.12)) * dk);

    // 기울이기
    this.leanSmooth = m.leanOffset;
    const right = this._right.set(Math.cos(yaw), 0, -Math.sin(yaw));

    const cam = this.camera;
    cam.position.set(
      m.position.x + right.x * (this.leanSmooth + bobL),
      this.eyeY + bobV + breathV + this.dip - Math.abs(m.leanOffset) * 0.06 - deathDrop,
      m.position.z + right.z * (this.leanSmooth + bobL),
    );
    cam.rotation.set(
      pitch * (1 - dk) + breathPitch + lurchPitch + shP + punchP + I.p + deathPitch,
      yaw + breathYaw + shY + I.y,
      -m.leanRoll - bobR - lurchRoll + shR + punchR + I.r + this._knock * this._knockSide + this._downRoll + deathRoll,
    );

    // 시야각: 조준하면 살짝 좁힘 (스코프 없음 — 확대가 아니라 집중)
    const fov = this.baseFov * lerp(1, CONFIG.aim.adsFovMul ?? 1, clamp(this.ads, 0, 1));
    if (Math.abs(cam.fov - fov) > 1e-4) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }
}
