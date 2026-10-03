// 1인칭 카메라: 눈높이(빠진 깊이 반영) + 걸음 흔들림 + 호흡 흔들림 + 기울이기
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { clamp, lerp } from '../core/math.js';
import { surfaceProps } from '../world/Surfaces.js';

const DEG = Math.PI / 180;

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
    motor.on('land', (e) => { this.dipVel -= Math.min(1.6, e.speed * 0.35) * CONFIG.camera.landingDip * 10; });
    motor.on('suction', (e) => { this.dipVel -= 0.25 * e.intensity; });
  }

  update(dt, yaw, pitch) {
    const m = this.motor;
    const C = CONFIG.camera;
    const sp = surfaceProps(m.surface);

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
    const bobV = -Math.cos(ph) * vAmp * this.bobAmp * this.bobSurface;
    const bobL = Math.sin(ph * 0.5) * lAmp * this.bobAmp * Math.sqrt(this.bobSurface);
    const bobR = Math.sin(ph * 0.5) * rAmp * DEG * this.bobAmp * this.bobSurface;
    // 진흙: 걸음마다 무겁게 기우뚱 (발을 빼며 몸이 앞뒤·좌우로 쏠림)
    const mud = clamp((sp.stepPulse - 0.2) / 0.55, 0, 1);
    this.lurch = lerp(this.lurch, mud * this.bobAmp, 1 - Math.exp(-3 * dt));
    const lurchRoll = Math.sin(ph * 0.5) * B.mudLurchRollDeg * DEG * this.lurch;
    const lurchPitch = -Math.cos(ph) * B.mudLurchPitchDeg * DEG * this.lurch;

    // 호흡 흔들림 (스태미나·심박 연동)
    const br = C.breath;
    const b = this.breath;
    const amp = lerp(br.restAmplitude, br.exhaustedAmplitude, Math.pow(b.intensity, 1.4));
    const chest = b.chest;
    const breathPitch = chest * amp;
    const breathYaw = Math.sin(b.phase * Math.PI * 2 + 1.3) * amp * 0.35;
    const breathV = chest * br.verticalAmplitude * Math.pow(b.intensity, 1.5);

    // 기울이기
    this.leanSmooth = m.leanOffset;
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

    const cam = this.camera;
    cam.position.set(
      m.position.x + right.x * (this.leanSmooth + bobL),
      this.eyeY + bobV + breathV + this.dip - Math.abs(m.leanOffset) * 0.06,
      m.position.z + right.z * (this.leanSmooth + bobL),
    );
    cam.rotation.set(
      pitch + breathPitch + lurchPitch,
      yaw + breathYaw,
      -m.leanRoll - bobR - lurchRoll,
    );
  }
}
