// 1인칭 카메라: 눈높이(빠진 깊이 반영) + 걸음 흔들림 + 호흡 흔들림 + 기울이기
//  2단계: 가늠자 조준(ads 0~1) 중에는 걸음·호흡·진흙 기우뚱을 (1 − 0.8·ads) 로 줄이고 시야각 × aim.adsFovMul (확대 아님),
//         근접 통과 움찔(addShake — 가까울수록 크게, 약 0.3초), 제압 미세 떨림(tremorDeg), 발사 순간의 짧은 화면 튐(punch, 약 0.15초).
//         반동으로 '남는' 시선 변화는 PlayerController 의 yaw/pitch 에 이미 들어 있다 (여기 것은 잠깐 보이는 흔들림뿐).
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
    const diff = target - this.eyeY;
    if (Math.abs(diff) > 1.5) { this.eyeY = target; this.eyeVel = 0; }
    this.eyeVel += (w * w * diff - 2 * w * this.eyeVel) * dt;
    this.eyeY += this.eyeVel * dt;

    // 착지 딥
    this.dipVel += (-60 * this.dip - 12 * this.dipVel) * dt;
    this.dip += this.dipVel * dt;

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

    // 기울이기
    this.leanSmooth = m.leanOffset;
    const right = this._right.set(Math.cos(yaw), 0, -Math.sin(yaw));

    const cam = this.camera;
    cam.position.set(
      m.position.x + right.x * (this.leanSmooth + bobL),
      this.eyeY + bobV + breathV + this.dip - Math.abs(m.leanOffset) * 0.06,
      m.position.z + right.z * (this.leanSmooth + bobL),
    );
    cam.rotation.set(
      pitch + breathPitch + lurchPitch + shP + punchP,
      yaw + breathYaw + shY,
      -m.leanRoll - bobR - lurchRoll + shR + punchR,
    );

    // 시야각: 조준하면 살짝 좁힘 (스코프 없음 — 확대가 아니라 집중)
    const fov = this.baseFov * lerp(1, CONFIG.aim.adsFovMul ?? 1, clamp(this.ads, 0, 1));
    if (Math.abs(cam.fov - fov) > 1e-4) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }
}
