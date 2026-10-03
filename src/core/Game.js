// 게임 조립·메인 루프
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Settings } from './Settings.js';
import { Input } from './Input.js';
import { NoiseEvents } from './NoiseEvents.js';
import { generateWorld, NO_WATER } from '../world/WorldGen.js';
import { World } from '../world/World.js';
import { HumanMotor } from '../human/HumanMotor.js';
import { computeExposure } from '../human/Exposure.js';
import { PlayerController } from '../player/PlayerController.js';
import { CameraRig } from '../player/CameraRig.js';
import { BreathCycle } from '../player/BreathCycle.js';
import { Atmosphere } from '../render/Atmosphere.js';
import { installFogChunks } from '../render/Materials.js';
import { AudioEngine } from '../audio/AudioEngine.js';
import { Footsteps } from '../audio/Footsteps.js';
import { Ambience } from '../audio/Ambience.js';
import { Breathing } from '../audio/Breathing.js';
import { HUD } from '../ui/HUD.js';
import { DebugOverlay } from '../ui/DebugOverlay.js';
import { Menu } from '../ui/Menu.js';
import { surfaceProps } from '../world/Surfaces.js';

const OBJECT_LABEL = {
  terrain: '지형', bigTree: '큰 나무', canopy: '캐노피', palm: '야자수', banana: '바나나', bamboo: '대나무',
  bambooDense: '밀집 대나무', vegetation: '풀·덤불', log: '통나무', rock: '바위', root: '뿌리', dike: '논둑', water: '물',
};

const INCAPACITATED = { canStand: false, canCrouch: false, canSprint: false, canJump: false, maxSpeedMultiplier: 0.5 };

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

export class Game {
  constructor(appEl, uiEl) {
    this.appEl = appEl;
    this.uiEl = uiEl;
    this.settings = new Settings();
    this.menu = new Menu(uiEl, this.settings);
    this.paused = true;
    this.started = false;
    this.timer = new THREE.Timer();
    this.exposure = { value: 0, stance: 1, concealment: 0, light: 1 };
    this._exposureTimer = 0;
    this._envTimer = 0;
    this._rayTimer = 0;
    this.nearWater = 0;
    this.rays = { vision: '-', bullet: '-' };
  }

  async init() {
    const q = CONFIG.graphics[this.settings.get('quality')];
    installFogChunks();

    // ---- 렌더러
    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: this.settings.get('quality') !== 'low', powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = q.shadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setSize(window.innerWidth, window.innerHeight);
    this.appEl.appendChild(renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.settings.get('fov'), window.innerWidth / window.innerHeight, CONFIG.camera.near, CONFIG.camera.far);
    this.scene.add(this.camera);

    // ---- 월드
    this.menu.setProgress(0.05, '지형 생성 중…');
    await nextFrame();
    const data = this.data = generateWorld(CONFIG.world.seed, (p, msg) => this.menu.setProgress(0.05 + p * 0.5, msg));
    this.menu.setProgress(0.6, '식생·텍스처 생성 중…');
    await nextFrame();
    this.world = new World(this.scene, data);
    this.query = this.world.query;

    // ---- 플레이어 (사람 공용 이동 컴포넌트)
    this.noise = new NoiseEvents();
    const st = data.layout.start;
    this.motor = new HumanMotor(this.query, { x: st.x, z: st.z, yaw: st.yaw, noise: this.noise, name: 'player' });
    this.input = new Input(renderer.domElement);
    this.controller = new PlayerController(this.motor, this.input, this.settings);
    this.breath = new BreathCycle();
    this.rig = new CameraRig(this.camera, this.motor, this.breath);

    // ---- 대기
    this.menu.setProgress(0.75, '대기·빛 설정 중…');
    await nextFrame();
    this.atmosphere = new Atmosphere(this.scene, renderer, data, this.query);
    this.atmosphere.onEnvMap = (tex) => this.world.setEnvMap(tex);
    this.atmosphere.setTimeOfDay(this.settings.get('timeOfDay'), true);
    this.atmosphere.setWeather(this.settings.get('weather'), true);

    // ---- 소리
    this.audio = new AudioEngine();
    this.footsteps = new Footsteps(this.audio);
    this.ambience = new Ambience(this.audio);
    this.breathing = new Breathing(this.audio);
    this.motor.on('footstep', (e) => this.footsteps.play(e));
    this.motor.on('land', (e) => this.footsteps.land({ ...e, sound: surfaceProps(e.surface).sound }));
    this.motor.on('suction', (e) => this.footsteps.suction(e));
    this.motor.on('slide', (e) => this.footsteps.slide(e));
    this.motor.on('stance', (e) => this.footsteps.stance(e));

    // ---- UI
    this.hud = new HUD(this.uiEl);
    this.debug = new DebugOverlay(this.uiEl);
    this.controller.on('toast', (msg) => this.hud.toast(msg));
    this._buildNoiseRing();

    // ---- 설정 반영
    this.applyQuality();
    this.settings.on('change', ({ key, value }) => {
      if (key === 'fov') { this.camera.fov = value; this.camera.updateProjectionMatrix(); }
      if (key === 'quality') this.applyQuality(true);
      if (key === 'timeOfDay') this.atmosphere.setTimeOfDay(value);
      if (key === 'weather') this.atmosphere.setWeather(value);
      if (key === 'volume') this.audio.setVolume(value * CONFIG.audio.master / 0.8);
    });

    // ---- 입력·창
    this.input.on('lockchange', (locked) => (locked ? this._resume() : this._pause()));
    this.input.on('lockerror', () => this.menu.lockFailed());
    this.input.on('keydown', (e) => this._globalKey(e));
    this.menu.on('play', () => this.play());
    this.menu.on('debug', (v) => this.debug.toggle(v));
    this.menu.on('incapacitate', (v) => this.setIncapacitated(v));
    window.addEventListener('resize', () => this._resize());

    // ---- 셰이더 미리 컴파일 (첫 프레임 끊김 방지)
    this.menu.setProgress(0.85, '셰이더 준비 중…');
    await nextFrame();
    this.world.update(this.camera, true);
    this.rig.update(0, this.controller.yaw, this.controller.pitch);
    this.atmosphere.update(0.016, this.motor.position, this.camera);
    this.world.update(this.camera, true);
    try { await this.renderer.compileAsync(this.scene, this.camera); } catch { /* 일부 환경 미지원 */ }
    this.renderer.render(this.scene, this.camera);
    this.menu.setProgress(1, '준비 완료');
    this.menu.ready();
    this.menu.sync({ debug: this.debug.visible, incapacitated: this.motor.hasRestriction('incapacitated') });

    this.timer.connect?.(document);
    renderer.setAnimationLoop(() => this._frame());
    window.game = this; // 콘솔 디버그용
  }

  applyQuality(runtime = false) {
    const q = CONFIG.graphics[this.settings.get('quality')];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    const shadowsChanged = this.renderer.shadowMap.enabled !== q.shadows;
    this.renderer.shadowMap.enabled = q.shadows;
    this.world.setQuality(q);
    this.atmosphere?.setSettings(q);
    if (runtime && shadowsChanged) this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    this.world.update(this.camera, true);
  }

  play() {
    this.audio.init();
    this.audio.setVolume(this.settings.get('volume') * CONFIG.audio.master / 0.8);
    this.ambience.start();
    this.input.requestLock();
  }

  _resume() {
    this.paused = false;
    this.started = true;
    this.menu.hide();
    this.audio.resume();
    this.timer.update();
  }

  _pause() {
    this.paused = true;
    this.menu.show(this.started);
    this.menu.sync({ debug: this.debug.visible, incapacitated: this.motor.hasRestriction('incapacitated') });
    this.audio.suspend();
  }

  setIncapacitated(on) {
    if (on) this.motor.setRestriction('incapacitated', INCAPACITATED);
    else this.motor.clearRestriction('incapacitated');
    this.hud?.toast(on ? '거동 불능 — 포복만 가능 (속도 50%)' : '거동 불능 해제');
  }

  teleport(x, z, yaw = this.controller.yaw) {
    this.controller.yaw = yaw;
    this.controller.pitch = 0;
    this.motor.teleport(x, z, yaw);
    this.rig.eyeY = this.motor.eyeY;
    this.world.update(this.camera, true);
  }

  _globalKey(e) {
    const K = CONFIG.controls;
    if (e.code === K.debug) this.debug.toggle();
    if (e.code === K.incapacitate) this.setIncapacitated(!this.motor.hasRestriction('incapacitated'));
    if (this.debug.visible && /^Digit[1-9]$/.test(e.code) && !this.paused) {
      const tp = this.data.testPoints.find((p) => p.key === e.code.slice(5));
      if (tp) { this.teleport(tp.x, tp.z, tp.yaw); this.hud.toast(tp.name); }
    }
  }

  _resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  _buildNoiseRing() {
    const pts = [];
    for (let i = 0; i <= 64; i++) pts.push(new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2), 0, Math.sin((i / 64) * Math.PI * 2)));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    this.noiseRing = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0, depthTest: false, fog: false }));
    this.noiseRing.renderOrder = 20;
    this.noiseRing.frustumCulled = false;
    this.scene.add(this.noiseRing);
    this._ringAge = 10;
    this.noise.on('noise', (e) => {
      if (e.source !== this.motor) return;
      this.noiseRing.position.set(e.x, e.y - 0.4, e.z);
      this.noiseRing.scale.setScalar(Math.max(0.1, e.radius));
      this._ringAge = 0;
    });
  }

  // -----------------------------------------------------------------
  _frame() {
    this.timer.update();
    if (this.paused) {
      this.input.endFrame();
      return;
    }
    const dt = Math.min(0.1, this.timer.getDelta());
    const m = this.motor;

    this.controller.update(dt);
    m.update(dt);
    this.noise.rainIntensity = this.atmosphere.rainIntensity;
    this.noise.update(dt);
    this.breath.update(dt, m.breath);
    this.rig.update(dt, this.controller.yaw, this.controller.pitch);
    this.atmosphere.update(dt, m.position, this.camera);
    this.world.update(this.camera);

    // 소리
    const preset = CONFIG.timeOfDay.presets[this.atmosphere.tod];
    this._envTimer -= dt;
    if (this._envTimer <= 0) { this._envTimer = 1; this.nearWater = this._nearWater(); }
    this.ambience.update(dt, { dawn: preset.ambienceDawn, day: preset.ambienceDay, dusk: preset.ambienceDusk },
      this.atmosphere.rainIntensity, this.atmosphere.state.wind, this.query.getCanopyCover(m.position.x, m.position.z), this.nearWater);
    this.breathing.update(dt, this.breath, m);

    // 노출도 (4단계 적 시야용)
    this._exposureTimer -= dt;
    if (this._exposureTimer <= 0) {
      this._exposureTimer = 0.1;
      const a = this.atmosphere;
      const off = { x: a.sunDir.x / Math.max(0.12, a.sunDir.y) * 20, z: a.sunDir.z / Math.max(0.12, a.sunDir.y) * 20 };
      const daylight = Math.min(1, a.state.sunIntensity / 4.2 * 0.7 + a.state.hemiIntensity / 1.25 * 0.3);
      this.exposure = computeExposure(m, this.query, { daylight, sunOffset: off });
      m.exposure = this.exposure.value;
    }

    // UI
    this.hud.update(dt, m, this.controller.quiet);
    this._ringAge += dt;
    this.noiseRing.visible = this.debug.visible;
    this.noiseRing.material.opacity = Math.max(0, 0.8 - this._ringAge * 1.2);
    if (this.debug.visible) {
      this._rayTimer -= dt;
      if (this._rayTimer <= 0) { this._rayTimer = 0.125; this._debugRays(); }
    }
    this.debug.update(dt, {
      motor: m, yaw: this.controller.yaw, exposure: this.exposure, rays: this.rays,
      noiseMask: this.noise.maskFactor(), wetness: this.atmosphere.wetness, rain: this.atmosphere.rainIntensity,
      tod: this.atmosphere.tod, weather: this.atmosphere.weather, quality: this.settings.get('quality'),
      render: this.renderer.info.render, veg: this.world.instanced.stats, testPoints: this.data.testPoints,
    });

    this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
  }

  _nearWater() {
    const p = this.motor.position;
    let n = 0;
    for (let a = 0; a < 8; a++) {
      for (const r of [6, 15]) {
        const x = p.x + Math.cos(a * 0.785) * r, z = p.z + Math.sin(a * 0.785) * r;
        if (this.query.getWaterLevel(x, z) !== NO_WATER) n++;
      }
    }
    return n / 16;
  }

  _debugRays() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const o = this.camera.position;
    const v = this.query.raycastWorld(o, dir, 150, 'vision');
    const b = this.query.raycastWorld(o, dir, 150, 'bullet');
    const lbl = (r) => (r.object ? OBJECT_LABEL[r.object.type] || r.object.type : '');
    this.rays.vision = v.hit
      ? `${lbl(v)} ${v.distance.toFixed(1)}m 에서 차단 (남은 가시도 ${v.transmittance.toFixed(2)})`
      : `150m 내 차단 없음 (가시도 ${v.transmittance.toFixed(2)})`;
    const partial = b.passed.filter((p) => p.block === 'partial').map((p) => `${OBJECT_LABEL[p.type] || p.type} ${p.distance.toFixed(1)}m`);
    this.rays.bullet = (b.hit ? `${lbl(b)} ${b.distance.toFixed(1)}m 에서 정지` : '150m 내 정지 없음') + (partial.length ? `  · 부분 관통: ${partial.join(', ')}` : '');
  }
}
