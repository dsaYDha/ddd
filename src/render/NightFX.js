// =====================================================================
//  NightFX — 6단계 밤 화면 효과 (절차 생성)
//   · 반딧불이: 카메라 둘레 반경 R 칸을 셰이더에서 감아 도는 점들 (CPU 갱신 없음) — 천천히 떠다니며 깜빡임. 밤에만, 물가에서 더.
//   · 조명탄: 타는 동안 아주 밝은 불빛(가산 스프라이트) + 낙하산 아래로 흔들리는 연기 꼬리 몇 개
//   · 적 손전등 (가린 빨간 불빛): 렌즈 불빛 (이쪽을 향할수록 밝게) + 발 앞 땅에 흐린 빛 웅덩이
//   · 플레이어 손전등 (L): 카메라에 붙은 SpotLight — 밤 임무에서만 장면에 넣는다 (빛 개수가 바뀌면 셰이더를 다시 컴파일하므로
//     임무 시작 때 한 번만, 켜고 끄는 건 세기로)
//  스프라이트·점은 사용자 안개 청크와 맞지 않아 fog: false.
// =====================================================================
import * as THREE from 'three';
import { CONFIG } from '../config.js';

function glowTexture(size = 64, core = 0.18) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  const grd = g.createRadialGradient(r, r, 0, r, r, r);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(core, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.18)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class NightFX {
  /** @param {THREE.Scene} scene  @param {THREE.Camera} camera */
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.root = new THREE.Group();
    this.root.name = 'nightFX';
    scene.add(this.root);
    const glow = this._glow = glowTexture(64, 0.12);

    // ---- 반딧불이
    const N = CONFIG.night.fireflies.count, R = CONFIG.night.fireflies.radius;
    const base = new Float32Array(N * 3), phase = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      base[i * 3] = (Math.random() * 2 - 1) * R;
      base[i * 3 + 1] = 0.3 + Math.random() * 2.6;
      base[i * 3 + 2] = (Math.random() * 2 - 1) * R;
      phase[i] = Math.random() * 100;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(base, 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.fireflyMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uR: { value: R }, uAmt: { value: 0 }, uMap: { value: glow }, uScale: { value: 300 } },
      vertexShader: /* glsl */`
        attribute float aPhase;
        uniform float uTime, uR, uScale;
        uniform vec3 uCam;
        varying float vBlink;
        void main() {
          vec3 p = position;
          // 카메라 둘레로 감기 (끝없이 이어진 반딧불 들판)
          p.xz = mod( p.xz - uCam.xz + uR, 2.0 * uR ) + uCam.xz - uR;
          p.y += uCam.y - 1.6;
          // 천천히 떠다님
          float t = uTime * 0.35 + aPhase;
          p += vec3( sin( t * 1.3 ) * 0.6, sin( t * 0.9 + 1.7 ) * 0.35, cos( t * 1.1 ) * 0.6 );
          // 깜빡임: 대부분 꺼져 있다가 1~2초 반짝
          float b = sin( uTime * ( 0.6 + fract( aPhase * 0.37 ) * 0.9 ) + aPhase * 6.0 );
          vBlink = smoothstep( 0.55, 0.95, b );
          vec4 mv = modelViewMatrix * vec4( p, 1.0 );
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uScale * 0.06 / max( 0.5, -mv.z );
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        uniform float uAmt;
        varying float vBlink;
        void main() {
          float a = texture2D( uMap, gl_PointCoord ).a * vBlink * uAmt;
          if ( a < 0.01 ) discard;
          gl_FragColor = vec4( vec3( 0.75, 1.0, 0.35 ) * 2.2 * a, a );
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    this.fireflies = new THREE.Points(g, this.fireflyMat);
    this.fireflies.frustumCulled = false;
    this.fireflies.visible = false;
    this.fireflies.renderOrder = 5;
    this.root.add(this.fireflies);

    // ---- 조명탄 불빛 (최대 4) + 연기 꼬리
    this.flareSprites = [];
    for (let i = 0; i < 4; i++) {
      const m = new THREE.SpriteMaterial({ map: glow, color: 0xfff1d0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false });
      const sp = new THREE.Sprite(m);
      sp.visible = false;
      sp.renderOrder = 6;
      this.root.add(sp);
      // 빛번짐: 밤 공기(습기·연무)에 퍼지는 넓고 흐린 빛무리
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xffe2b0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false }));
      halo.visible = false;
      halo.renderOrder = 5;
      this.root.add(halo);
      const smoke = [];
      for (let k = 0; k < 5; k++) {
        const sm = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0x8a8a84, transparent: true, opacity: 0.18, depthWrite: false, fog: false }));
        sm.visible = false;
        this.root.add(sm);
        smoke.push(sm);
      }
      this.flareSprites.push({ sp, halo, smoke });
    }

    // ---- 적 손전등: 렌즈 + 땅의 빛 웅덩이 (최대 6)
    this.lamps = [];
    const poolGeo = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
    for (let i = 0; i < 6; i++) {
      const lens = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xff5a3a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false }));
      lens.visible = false;
      lens.renderOrder = 6;
      const pool = new THREE.Mesh(poolGeo, new THREE.MeshBasicMaterial({ map: glow, color: 0x6a2a18, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
      pool.visible = false;
      pool.renderOrder = 3;
      this.root.add(lens, pool);
      this.lamps.push({ lens, pool });
    }

    // ---- 플레이어 손전등 (밤 임무에서만 장면에)
    const FL = CONFIG.night.flashlight;
    this.flashlight = new THREE.SpotLight(0xffe0b0, 0, FL.range, FL.angle * Math.PI / 180, 0.55, 1.4);
    this.flashlight.castShadow = false;
    this.flashlight.position.set(0.12, -0.18, -0.05);
    this.flashTarget = new THREE.Object3D();
    this.flashTarget.position.set(0, -0.35, -5);
    camera.add(this.flashTarget);
    this.flashlight.target = this.flashTarget;
    this.lightActive = false;
    this.lampOn = false;
    this.lampLevel = 0;
    this._v = new THREE.Vector3();
    this.time = 0;
  }

  /** 밤 임무 시작·끝: 손전등 빛을 장면에 넣거나 뺌 (셰이더 다시 컴파일 — 화면 전환 중에만) */
  setLightActive(on) {
    if (on === this.lightActive) return;
    this.lightActive = on;
    if (on) this.camera.add(this.flashlight); else this.camera.remove(this.flashlight);
  }

  /**
   * @param {number} dt
   * @param {{ night: number, nearWater: number, flares: Array, lamps: Array<{x,y,z,dx,dy,dz,ground:{x,y,z}}>, lampOn: boolean, query }} env
   */
  update(dt, env) {
    this.time += dt;
    const cam = this.camera.position;
    // 반딧불이
    const amt = Math.max(0, Math.min(1, (env.night - 0.4) / 0.4)) * (0.45 + 0.55 * (env.nearWater ?? 0)) * (1 - 0.8 * (env.rain ?? 0));
    this.fireflies.visible = amt > 0.02;
    const u = this.fireflyMat.uniforms;
    u.uTime.value = this.time;
    u.uCam.value.copy(cam);
    u.uAmt.value = amt;
    u.uScale.value = window.innerHeight || 800;
    // 조명탄
    const fl = env.flares ?? [];
    for (let i = 0; i < this.flareSprites.length; i++) {
      const S = this.flareSprites[i], f = fl[i];
      const on = f && f.phase === 'burn' && f.intensity > 0.01;
      S.sp.visible = S.halo.visible = !!on;
      for (const sm of S.smoke) sm.visible = !!on;
      if (!on) continue;
      S.sp.position.set(f.x, f.y, f.z);
      S.halo.position.copy(S.sp.position);
      const d = cam.distanceTo(S.sp.position);
      // 불꽃 (멀어도 눈부신 점 + 둘레 번짐) · 넓은 빛무리 (거리에 비례 — 화면에서 늘 비슷한 크기)
      const sz = Math.max(3, d * 0.06) * (0.8 + 0.4 * f.intensity);
      S.sp.scale.set(sz, sz, 1);
      S.sp.material.opacity = Math.min(1, f.intensity * 1.2);
      S.sp.material.color.setRGB(1.6 * f.flick, 1.45 * f.flick, 1.1 * f.flick);
      const hs = Math.max(12, d * 0.3);
      S.halo.scale.set(hs, hs, 1);
      S.halo.material.opacity = 0.22 * f.intensity * f.flick;
      // 연기 꼬리: 지나온 자리 위쪽 (흔들림 반대로 처짐)
      for (let k = 0; k < S.smoke.length; k++) {
        const sm = S.smoke[k], up = (k + 1) * 3.2;
        sm.position.set(f.x - f.drift.x * k * 0.8 + Math.sin(this.time * 0.3 + k) * 0.8, f.y + up, f.z - f.drift.z * k * 0.8);
        const s2 = 1.6 + k * 0.9;
        sm.scale.set(s2, s2, 1);
        sm.material.opacity = 0.16 * (1 - k / S.smoke.length) * Math.min(1, f.intensity * 2);
      }
    }
    // 적 손전등
    const L = env.lamps ?? [];
    for (let i = 0; i < this.lamps.length; i++) {
      const it = this.lamps[i], lp = L[i];
      it.lens.visible = it.pool.visible = !!lp;
      if (!lp) continue;
      it.lens.position.set(lp.x, lp.y, lp.z);
      const vx = cam.x - lp.x, vy = cam.y - lp.y, vz = cam.z - lp.z, vl = Math.hypot(vx, vy, vz) || 1;
      const facing = Math.max(0, (vx * lp.dx + vy * lp.dy + vz * lp.dz) / vl);
      const k = 0.18 + 0.82 * facing ** 3;
      const s = Math.max(0.12, vl * 0.006) * (0.6 + 0.8 * k);
      it.lens.scale.set(s, s, 1);
      it.lens.material.opacity = Math.min(1, 0.35 + 0.65 * k);
      it.lens.material.color.setRGB(1.4 * k + 0.3, 0.45 * k + 0.1, 0.25 * k + 0.05);
      const g = lp.ground;
      it.pool.position.set(g.x, g.y + 0.03, g.z);
      it.pool.scale.setScalar(1.6);
    }
    // 내 손전등
    const FL = CONFIG.night.flashlight;
    const target = env.lampOn ? 1 : 0;
    this.lampLevel += (target - this.lampLevel) * Math.min(1, dt * 25);
    this.flashlight.intensity = this.lightActive ? this.lampLevel * 55 : 0;
    this.flashlight.distance = FL.range;
  }

  clear() {
    for (const S of this.flareSprites) { S.sp.visible = S.halo.visible = false; for (const sm of S.smoke) sm.visible = false; }
    for (const it of this.lamps) it.lens.visible = it.pool.visible = false;
    this.fireflies.visible = false;
  }
}
