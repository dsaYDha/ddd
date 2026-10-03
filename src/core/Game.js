// 게임 조립·메인 루프
//  2단계: 전투 (CombatSystem + BulletWorld — 실제 투사체), 플레이어 Person (부위별 캡슐 + 제압) 과 Shooter (무기 + 조준),
//  1인칭 화면 모델(WeaponView, 두 번째 그리기), 착탄·연기 효과(CombatFX), F8 표적(TargetRange + TargetMeshes), F7 제압 테스트,
//  절차 총소리(WeaponAudio). 프레임 순서: 입력·이동 → combat.update (탄 이동·제압 감소) → 표적·F7 → 사수 (발사 — 탄은
//  이번 프레임 끝 위치로 미리 진행) → 반동을 시선에 → 카메라 → 조준선을 카메라에 다시 맞춤 → 화면 모델·효과 → 월드 → 화면 모델 그리기.
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
import { installShaderChunks, shared } from '../render/Materials.js';
import * as PG from '../render/PlantGeometry.js';
import { WeaponView } from '../render/WeaponView.js';
import { CombatFX } from '../render/CombatFX.js';
import { TargetMeshes } from '../render/TargetMesh.js';
import { CombatSystem } from '../combat/CombatSystem.js';
import { BulletWorld } from '../combat/BulletWorld.js';
import { Shooter } from '../combat/Shooter.js';
import { TargetRange } from '../combat/TargetRange.js';
import { SuppressionTest } from '../combat/SuppressionTest.js';
import { WeaponAudio } from '../audio/WeaponAudio.js';
import { AudioEngine } from '../audio/AudioEngine.js';
import { Footsteps } from '../audio/Footsteps.js';
import { Ambience } from '../audio/Ambience.js';
import { Breathing } from '../audio/Breathing.js';
import { HUD } from '../ui/HUD.js';
import { DebugOverlay } from '../ui/DebugOverlay.js';
import { Menu } from '../ui/Menu.js';
import { surfaceProps } from '../world/Surfaces.js';
import { smoothstep } from './math.js';

const OBJECT_LABEL = {
  terrain: '지형', bigTree: '큰 나무', canopy: '캐노피', palm: '야자수', banana: '바나나', bamboo: '대나무',
  bambooDense: '밀집 대나무', vegetation: '풀·덤불', log: '통나무', rock: '바위', root: '뿌리', dike: '논둑', water: '물',
  midTree: '중층 나무', sapling: '어린 나무', saplingCrown: '어린 나무 잎', treeFern: '나무고사리', treeFernCrown: '나무고사리 잎',
  bananaLeaves: '바나나 잎', vineWall: '덩굴 벽', buttress: '판근',
};

const INCAPACITATED = { canStand: false, canCrouch: false, canSprint: false, canJump: false, maxSpeedMultiplier: 0.5 };

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// 무기 기계음 이벤트 → WeaponAudio.mech 종류 ('dryFire' 는 따로 — 고장 순간 겹치는 '딸깍'은 WeaponAudio 가 거른다)
const MECH_SOUND = {
  magOut: 'magOut', magIn: 'magIn', boltPull: 'boltPull', boltRelease: 'boltRelease', modeChange: 'selector',
  magCheckStart: 'magCheck', clearStart: 'clearPull', malfunction: 'malfunction',
};
const PRONE_BODY = 1.45;   // 엎드린 몸 길이 (Hitboxes 와 같음) — 몸이 경사를 따라 눕는 각을 잴 때

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
    this._renderStats = { calls: 0, triangles: 0 };   // 지난 프레임 (월드 + 화면 모델) 그리기 통계
  }

  async init() {
    const q = CONFIG.graphics[this.settings.get('quality')];
    installShaderChunks();

    // ---- 렌더러
    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: this.settings.get('quality') !== 'low', powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = q.shadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.info.autoReset = false;   // 월드 + 화면 모델 두 번 그린 것을 합쳐 F3 에 (프레임 시작에 직접 지움)
    this.appEl.appendChild(renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.settings.get('fov'), window.innerWidth / window.innerHeight, CONFIG.camera.near, CONFIG.camera.far);
    this.scene.add(this.camera);

    // ---- 월드
    this.menu.setProgress(0.05, '지형 생성 중…');
    await nextFrame();
    const data = this.data = generateWorld(CONFIG.world.seed, (p, msg) => this.menu.setProgress(0.05 + p * 0.5, msg));
    this.menu.setProgress(0.58, '식생·텍스처 생성 중…');
    await nextFrame();
    const antialias = !!renderer.getContext().getContextAttributes()?.antialias;
    this.world = new World(this.scene, data, { antialias, onProgress: (p, msg) => this.menu.setProgress(0.58 + p * 0.15, msg) });
    this.query = this.world.query;

    // ---- 플레이어 (사람 공용 이동 컴포넌트)
    this.noise = new NoiseEvents();
    const st = data.layout.start;
    this.motor = new HumanMotor(this.query, { x: st.x, z: st.z, yaw: st.yaw, noise: this.noise, name: 'player' });
    this.input = new Input(renderer.domElement);
    this.controller = new PlayerController(this.motor, this.input, this.settings);
    this.breath = new BreathCycle();
    this.rig = new CameraRig(this.camera, this.motor, this.breath);

    // ---- 전투 (2단계): 실제 투사체 탄도 · 사람 공용 제압 · 사수 (무기 + 조준)
    const weaponData = CONFIG.weapons[CONFIG.weapons.default];
    this.combat = new CombatSystem(this.query, this.noise, { world: new BulletWorld(this.query) });
    this._hitPose = { x: 0, y: 0, z: 0, yaw: 0, stance: 'stand', stanceFrom: 'stand', stanceProgress: 1, lean: 0, arms: 'rifle', eyeHeight: 1.65, bodyPitch: 0 };
    this.playerPerson = this.combat.addPerson({ name: 'player', isPlayer: true, noiseSource: this.motor, getPose: () => this._playerHitPose() });
    this.shooter = new Shooter(this.combat, this.playerPerson, weaponData);
    this.controller.aim = this.shooter.aim;
    this.motor.loadKg = CONFIG.load.baseKg + this.shooter.weapon.weightKg;
    this.targetRange = new TargetRange(this.combat, this.query);
    this.suppressionTest = new SuppressionTest(this.combat, this.query, this.playerPerson, weaponData);
    this._shotPose = {
      eye: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, stance: 'stand', stanceFrom: 'stand', stanceProgress: 1, speed: 0, sprinting: false,
      heartRate: 70, stamina: 100, breathRate: 0.25, suppression: 0, suppressionEffects: null, lookDeltaYaw: 0, lookDeltaPitch: 0,
    };
    this._supFx = this.playerPerson.suppression.effects({});
    this._firedQueue = [];

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
    this.motor.on('rustle', (e) => this.footsteps.rustle(e));
    this.weaponAudio = new WeaponAudio(this.audio);   // 파형 은행은 audio.init (시작 클릭) 때 만들어진다

    // ---- 사격 화면·효과 — 로딩 중에 만들어 아래 셰이더 미리 컴파일에 포함 (첫 발·첫 F8 에서 끊기지 않게)
    this.menu.setProgress(0.8, '무기 준비 중…');
    await nextFrame();
    const qKey = this.settings.get('quality');
    this.weaponView = new WeaponView(renderer, { quality: qKey, weaponData });
    this.weaponView.attach(this.shooter);
    this.combatFX = new CombatFX(this.scene, { textures: this.world.textures, quality: qKey, groundHeight: (x, z) => this.query.getTerrainHeight(x, z) });
    this.combatFX.setTracers(this.combat.ballistics.projectiles);
    this.targetMeshes = new TargetMeshes(this.scene, { leafMaterial: this.world.materials.leaves, stemMaterial: this.world.materials.stem, buildShrub: PG.buildShrub });
    this._vmLight = {
      sunColor: new THREE.Color(), sunDir: new THREE.Vector3(0, 1, 0), skyColor: new THREE.Color(), groundColor: new THREE.Color(),
      hemiIntensity: 1, shade: -1, sunVisible: 1, flash: 0,
    };
    this._mz = new THREE.Vector3();
    this._md = new THREE.Vector3();
    this._wireCombat();

    // ---- UI
    this.hud = new HUD(this.uiEl);
    // 약한 비네트 (색보정의 일부 — config.lighting.vignette)
    this.uiEl.insertAdjacentHTML('afterbegin', `<div id="grade-vignette" style="position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center, rgba(0,0,0,0) 58%, rgba(0,0,0,${CONFIG.lighting.vignette}) 100%)"></div>`);
    this.debug = new DebugOverlay(this.uiEl);
    this.controller.on('toast', (msg) => this.hud.toast(msg));
    this._buildNoiseRing();

    // ---- 설정 반영
    this.applyQuality();
    this.settings.on('change', ({ key, value }) => {
      if (key === 'fov') { this.rig.baseFov = value; this.camera.fov = value; this.camera.updateProjectionMatrix(); }
      if (key === 'quality') this.applyQuality(true);
      if (key === 'timeOfDay') this.atmosphere.setTimeOfDay(value);
      if (key === 'weather') this.atmosphere.setWeather(value);
      if (key === 'volume') this.audio.setVolume(value * CONFIG.audio.master / 0.8);
    });

    // ---- 입력·창
    this.input.on('lockchange', (locked) => {
      if (locked) { this.input.dragLook = false; this._resume(); } else if (!this.input.dragLook) this._pause();
    });
    this.input.on('lockerror', () => this._onLockError());
    this.input.on('keydown', (e) => this._globalKey(e));
    this.menu.on('play', () => this.play());
    this.menu.on('debug', (v) => this.debug.toggle(v));
    this.menu.on('incapacitate', (v) => this.setIncapacitated(v));
    window.addEventListener('resize', () => this._resize());

    // ---- 셰이더 미리 컴파일 (첫 프레임 끊김 방지)
    this.menu.setProgress(0.85, '셰이더 준비 중…');
    await nextFrame();
    this.world.update(this.camera, true);
    this.rig.baseFov = this.settings.get('fov');
    this.rig.update(0, this.controller.yaw, this.controller.pitch);
    this.atmosphere.update(0.016, this.motor.position, this.camera);
    this.world.update(this.camera, true);
    // F8 마네킹 재질(그림자 포함)은 표적을 세울 때 처음 쓰이므로, 땅속에 보이지 않는 조각을 한 프레임 두어 미리 준비
    const warm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), this.targetMeshes.material);
    warm.castShadow = warm.receiveShadow = true;
    warm.frustumCulled = false;
    warm.position.set(this.motor.position.x, this.motor.position.y - 3, this.motor.position.z);
    this.scene.add(warm);
    for (const t of [this.combatFX.fxAtlas?.texture, this.weaponView.textures?.flash]) if (t) try { renderer.initTexture(t); } catch { /* 일부 환경 미지원 */ }
    try {
      // 병렬 컴파일 확장이 없으면 compileAsync가 경고를 내므로 동기 컴파일 사용
      if (this.renderer.extensions.has('KHR_parallel_shader_compile')) await this.renderer.compileAsync(this.scene, this.camera);
      else this.renderer.compile(this.scene, this.camera);
    } catch { /* 일부 환경 미지원 */ }
    this.renderer.render(this.scene, this.camera);
    this.scene.remove(warm);
    warm.geometry.dispose();
    this.menu.setProgress(1, '준비 완료');
    this.menu.ready();
    this.menu.sync({ debug: this.debug.visible, incapacitated: this.motor.hasRestriction('incapacitated') });

    this.timer.connect?.(document);
    renderer.setAnimationLoop(() => this._frame());
    window.game = this; // 콘솔 디버그용
    this.shared = shared;
  }

  applyQuality(runtime = false) {
    const q = CONFIG.graphics[this.settings.get('quality')];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    const shadowsChanged = this.renderer.shadowMap.enabled !== q.shadows;
    this.renderer.shadowMap.enabled = q.shadows;
    this.world.setQuality(q);
    this.atmosphere?.setSettings(q);
    this.weaponView?.setQuality(this.settings.get('quality'));
    this.combatFX?.setQuality(this.settings.get('quality'));
    if (runtime && shadowsChanged) this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    this.world.update(this.camera, true);
  }

  play() {
    this.audio.init();
    this.audio.setVolume(this.settings.get('volume') * CONFIG.audio.master / 0.8);
    this.ambience.start();
    if (this.input.dragLook) { this._resume(); return; }
    this.input.requestLock();
    // 잠금이 한 번도 된 적 없는데 응답이 없으면 끌어서 보기로 전환
    clearTimeout(this._lockTimer);
    this._lockTimer = setTimeout(() => { if (!this.input.locked && !this._lockWorked && this.paused) this._startDragLook(); }, 700);
  }

  _onLockError() {
    // 처음부터 잠금이 안 되는 환경 → 끌어서 보기. 잠금이 되던 환경이면(Esc 직후 재시도 제한) 다시 클릭 안내
    if (this._lockWorked) this.menu.lockFailed();
    else this._startDragLook();
  }

  _startDragLook() {
    clearTimeout(this._lockTimer);
    this.input.dragLook = true;
    this._resume();
    this.hud.toast('마우스를 누른 채 끌어서 시점 이동 · 우클릭 조준 · F 사격 · Esc 메뉴', 4);
  }

  _resume() {
    if (this.input.locked) this._lockWorked = true;
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
    this.rig.update(0, this.controller.yaw, this.controller.pitch);   // 카메라를 먼저 옮긴 뒤 주변 식생을 한 번에 갱신
    this.world.update(this.camera, true);
  }

  _globalKey(e) {
    const K = CONFIG.controls;
    if (e.code === 'Escape' && this.input.dragLook && !this.paused) { this._pause(); return; }
    if (e.code === K.debug) this.debug.toggle();
    if (e.code === K.incapacitate) this.setIncapacitated(!this.motor.hasRestriction('incapacitated'));
    if (!this.paused && e.code === K.suppressionTest) {
      if (this.suppressionTest.toggle()) this.hud.toast(`제압 테스트 — 주변으로 빗나가는 연발 (${CONFIG.testRange.suppression.duration}초)`, 2.2);
    }
    if (!this.paused && e.code === K.targets) {
      const on = this.targetRange.toggle(this.camera.position, this.controller.yaw);
      this.hud.toast(on ? `표적 ${this.targetRange.targets.length}개 배치 (F8로 제거)` : '표적 제거');
    }
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
    // 그리기 통계: 지난 프레임의 월드 + 화면 모델 합계를 기억하고 지움 (renderer.info.autoReset = false)
    const ri = this.renderer.info.render;
    this._renderStats.calls = ri.calls;
    this._renderStats.triangles = ri.triangles;
    this.renderer.info.reset();

    this.controller.update(dt);
    m.update(dt);
    this.noise.rainIntensity = this.atmosphere.rainIntensity;
    this.noise.update(dt);
    this.breath.update(dt, m.breath);

    // 전투: 탄 이동·제압 감소 → 표적 걷기·F7 사수 → 플레이어 사격 (쏜 탄은 이번 프레임 끝 위치로 미리 진행 — 순서 중요)
    this.combat.update(dt);
    this.targetRange.update(dt);
    this.suppressionTest.update(dt);
    const sup = this._updateShooter(dt);
    const sh = this.shooter;

    this.rig.ads = sh.aim.ads;
    this.rig.holdingBreath = sh.aim.holdState === 'holding';
    this.rig.tremorDeg = sup.tremorDeg;
    this.rig.update(dt, this.controller.yaw, this.controller.pitch);
    // 조준선·총구를 이번 프레임 카메라 위치에 다시 맞춤 → 화면 모델의 가늠자·가늠쇠가 그 선 위에 놓인다
    sh.refreshSight(this.camera.position, this.controller.yaw, this.controller.pitch);
    this.atmosphere.update(dt, m.position, this.camera);
    // 플레이어가 지나가면 식물이 밀려남 (셰이더 유니폼 — 4단계 적 병사는 1~3번 칸을 쓴다)
    shared.uPush.value[0].set(m.position.x, m.position.y, m.position.z, CONFIG.interaction.pushRadius * (m.stance === 'prone' ? 1.25 : 1));
    this.world.update(this.camera);
    this._autoQuality(dt);

    // 화면 모델 (월드 해·반구광 + 캐노피 그늘·햇빛 얼룩) → 이번 프레임에 쏜 발의 총구 연기 (갱신된 총구 위치) → 효과·표적
    this._updateViewLighting(dt);
    this.weaponView.update(dt, this.camera, { shooter: sh, motor: m, sprinting: m.gait === 'sprint', lighting: this._vmLight });
    if (this._firedQueue.length) {
      this.weaponView.getMuzzle(this._mz, this._md);
      for (const e of this._firedQueue) this.combatFX.muzzle({ position: this._mz, dir: this._md, ads: e.ads });
      this._firedQueue.length = 0;
    }
    this.combatFX.update(dt, this.camera, {});
    this.targetMeshes.update(dt);
    // 총구 화염 빛: 월드에 점광원을 더하지 않고 반구광을 잠깐 밝힘 (Atmosphere 가 매 프레임 값을 다시 정하므로 누적되지 않음)
    const flash = this.combatFX.flash;
    if (flash > 0) this.atmosphere.hemi.intensity = this.atmosphere.state.hemiIntensity * (1 + 0.8 * flash);

    // 소리
    const preset = CONFIG.timeOfDay.presets[this.atmosphere.tod];
    this._envTimer -= dt;
    if (this._envTimer <= 0) { this._envTimer = 1; this.nearWater = this._nearWater(); }
    this.ambience.update(dt, { dawn: preset.ambienceDawn, day: preset.ambienceDay, dusk: preset.ambienceDusk },
      this.atmosphere.rainIntensity, this.atmosphere.state.wind, this.query.getCanopyCover(m.position.x, m.position.z), this.nearWater);
    this.breathing.holding = this.rig.holdingBreath;
    this.breathing.update(dt, this.breath, m);
    this.weaponAudio.update(dt);
    this.weaponAudio.setMuffle(sup.muffle);

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
    this.hud.tunnel = sup.tunnel;
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
      render: this._renderStats, veg: this.world.stats, testPoints: this.data.testPoints,
      combat: { shooter: sh, stats: this.combat.stats(this.playerPerson), suppression: this.playerPerson.suppression, stress: m.stress },
    });

    this.renderer.render(this.scene, this.camera);
    this.weaponView.render(this.renderer);   // 깊이만 지우고 화면 모델 (총이 나무·풀에 파묻히지 않게)
    this.input.endFrame();
  }

  /** 플레이어 사격 한 프레임: 자세·입력 → Shooter → 반동을 시선에, 숨 참기 대가, 오염도, 장비 무게, 제압 긴장. 제압 효과를 돌려줌 */
  _updateShooter(dt) {
    const m = this.motor, c = this.controller, sh = this.shooter;
    const sup = this.playerPerson.suppression.effects(this._supFx);   // 이미 수치/100 배 — 다시 곱하지 않는다
    const P = this._shotPose;
    // 눈: 카메라와 같은 부드러운 눈높이 + 기울이기 (탄이 화면에 보이는 가늠자 위치에서 나가게)
    P.eye.x = m.position.x + Math.cos(c.yaw) * m.leanOffset;
    P.eye.y = this.rig.eyeY - Math.abs(m.leanOffset) * 0.06;
    P.eye.z = m.position.z - Math.sin(c.yaw) * m.leanOffset;
    P.yaw = c.yaw;
    P.pitch = c.pitch;
    P.stance = m.stance;
    P.stanceFrom = m.stanceFrom;
    P.stanceProgress = m.stanceProgress;
    P.speed = m.speed;
    P.sprinting = m.gait === 'sprint';
    P.heartRate = m.heartRate;
    P.stamina = m.stamina;
    P.breathRate = this.breath.rate;
    P.suppression = this.playerPerson.suppression.value;
    P.suppressionEffects = sup;
    P.lookDeltaYaw = c.lookDeltaYaw;
    P.lookDeltaPitch = c.lookDeltaPitch;
    const k = sh.update(dt, P, c.weaponInput, this.query);
    // 반동: 시선을 밀어 올림 (자동 회복 40% 포함) — 나머지는 플레이어가 마우스로 끌어내려야 한다
    if (k.viewKickYaw || k.viewKickPitch) c.addLook(k.viewKickYaw, k.viewKickPitch);
    if (k.staminaCost) m.stamina = Math.max(0, m.stamina - k.staminaCost);
    sh.weapon.updateFouling(dt, { stance: m.stance, surface: m.surface, moving: m.speed > 0.1, waterDepth: m.ground.waterDepth });
    m.loadKg = CONFIG.load.baseKg + sh.weapon.weightKg;   // 탄을 쓰면 가벼워짐
    m.stress = sup.heartStress;
    return sup;
  }

  /** 플레이어 피격 판정 자세 (CombatSystem.update 가 매 프레임 부름) — 재사용 객체 */
  _playerHitPose() {
    const m = this.motor, P = this._hitPose;
    P.x = m.position.x; P.y = m.position.y; P.z = m.position.z;
    P.yaw = m.yaw;
    P.stance = m.stance;
    P.stanceFrom = m.stanceFrom;
    P.stanceProgress = m.stanceProgress;
    P.lean = m.leanOffset;
    P.eyeHeight = m.eyeHeight;
    P.bodyPitch = 0;
    if (m.stance === 'prone' || m.stanceFrom === 'prone') {
      // 엎드린 몸은 경사를 따라 눕는다 (머리 쪽이 높으면 +) — 다리가 땅에 박히거나 뜨지 않게
      const fx = -Math.sin(m.yaw), fz = -Math.cos(m.yaw);
      const hf = this.query.getSupportHeight(P.x + fx * 0.3, P.z + fz * 0.3);
      const hb = this.query.getSupportHeight(P.x - fx * (PRONE_BODY - 0.15), P.z - fz * (PRONE_BODY - 0.15));
      P.bodyPitch = Math.atan2(hf - hb, PRONE_BODY + 0.15);
    }
    return P;
  }

  /** 화면 모델 빛: 월드 해·반구광 + 총 위치의 캐노피 그늘과 햇빛 얼룩 (월드 셰이더 patchCanopy 와 같은 식) */
  _updateViewLighting(dt) {
    const a = this.atmosphere, s = a.state, L = this._vmLight;
    L.sunColor.setRGB(s.sunColor[0], s.sunColor[1], s.sunColor[2]).multiplyScalar(s.sunIntensity);
    L.sunDir.copy(a.sunDir);
    L.skyColor.setRGB(s.skyColor[0], s.skyColor[1], s.skyColor[2]);
    L.groundColor.setRGB(s.groundColor[0], s.groundColor[1], s.groundColor[2]);
    L.hemiIntensity = s.hemiIntensity;
    const cam = this.camera.position, yaw = this.controller.yaw;
    const gx = cam.x - Math.sin(yaw) * 0.4, gz = cam.z - Math.cos(yaw) * 0.4;   // 총몸 (눈 앞 0.4m)
    const ci = shared.uCanopyInfo.value;
    const shade = this.query.getCanopyCover(gx, gz);
    const sx = gx + ci.z, sz = gz + ci.w;   // 해 쪽으로 투영한 캐노피
    const sunCover = Math.min(1, this.query.getCanopyCover(sx, sz) * (1 + 0.2 * shared.uSunLow.value));
    const thr = sunCover * 0.9;
    const lit = smoothstep(thr - 0.045, thr + 0.045, this._fleckAt(sx, sz));
    const sunVisible = 1 + (lit - 1) * shared.uFleckInfo.value.y;
    // 1m 칸·얼룩 가장자리에서 총 밝기가 튀지 않게 부드럽게 (처음엔 바로)
    if (L.shade < 0) { L.shade = shade; L.sunVisible = sunVisible; } else {
      const k = 1 - Math.exp(-8 * dt);
      L.shade += (shade - L.shade) * k;
      L.sunVisible += (sunVisible - L.sunVisible) * k;
    }
    L.flash = this.combatFX.flash;
  }

  /** 햇빛 얼룩 텍스처 값 0~1 (셰이더와 같은 좌표: 해 방위로 늘인 행렬 × 1/타일 + 흔들림, 반복) */
  _fleckAt(x, z) {
    const img = shared.uFleckTex.value?.image;
    if (!img || !img.data) return 0.5;
    const M = shared.uFleckMat.value, F = shared.uFleckInfo.value;
    const u = (x * M.x + z * M.y) * F.x + F.z, v = (x * M.z + z * M.w) * F.x + F.w;
    const W = img.width, H = img.height;
    const px = (u - Math.floor(u)) * W, py = (v - Math.floor(v)) * H;
    const i = Math.min(W - 1, px | 0), j = Math.min(H - 1, py | 0);
    return img.data[(j * W + i) * 4] / 255;
  }

  /** 사격·전투 이벤트 → 효과·소리·HUD */
  _wireCombat() {
    const sh = this.shooter, fx = this.combatFX, wa = this.weaponAudio, cam = this.camera;
    const sp = {};
    const spatial = (p) => WeaponAudio.spatial(cam.position, this.controller.yaw, p, sp);

    // 내 사격
    sh.on('fired', (e) => {
      this._firedQueue.push(e);    // 총구 연기는 화면 모델이 이번 프레임 자세로 갱신된 뒤 (_frame)
      wa.shot({ own: true, timeOffset: e.timeOffset });
      this.rig.punch(0.45 * (sh.aim.stanceRecoilMul ?? 1));
    });
    for (const [ev, kind] of Object.entries(MECH_SOUND)) sh.on(ev, (e) => wa.mech(kind, { duration: e?.duration, rounds: e?.rounds }));
    sh.on('dryFire', () => wa.mech('dryClick'));
    sh.on('holdBreath', (e) => {
      if (e.state === 'holding') wa.breath('hold');
      else if (e.state === 'recovering') wa.breath('release');
    });
    // 탄창·노리쇠·'딸깍' 소음 → 4단계 적이 듣는다 (무기는 자기 위치를 모름 → 플레이어 위치에서)
    sh.on('noise', (e) => {
      const p = this.motor.position;
      this.noise.emitNoise({ x: p.x, y: p.y + 1, z: p.z }, e.radius, e.kind, this.motor, { cause: e.cause });
    });
    sh.on('magCheckResult', (e) => this.hud.toast(`탄창: ${e.label}`));
    sh.on('modeChange', (e) => this.hud.toast(CONFIG.weapons.modeLabels?.[e.mode] ?? e.mode, 1.2));
    sh.on('noMags', (e) => this.hud.toast(e.reason === 'full' ? '탄창이 이미 가득하다' : '남은 탄창이 없다'));

    // 탄도 → 효과·소리 (거리만큼 늦게 들림)
    const c = this.combat;
    c.on('impact', (e) => {
      fx.impact(e);
      const a = spatial(e.point);
      wa.impact({ material: e.material, distance: a.distance, pan: a.pan, behind: a.behind, ricochet: e.ricochet, speed: e.speed, underwater: e.underwater });
    });
    c.on('partial', (e) => {
      fx.partial(e);
      const a = spatial(e.point);
      wa.impact({ material: e.material, distance: a.distance, pan: a.pan, behind: a.behind, speed: e.speedBefore, gain: 0.5 });
    });
    c.on('foliage', (e) => fx.foliage(e));
    c.on('hit', (e) => {
      fx.bodyHit(e);
      const a = spatial(e.point);
      wa.impact({ material: 'body', distance: a.distance, pan: a.pan, behind: a.behind, speed: e.speed });
    });
    // 초음속 탄이 플레이어 곁을 지나감: '딱' (발사음보다 먼저) + 화면 움찔 + 총 움찔 — 가까울수록 크게
    c.on('flyby', (e) => {
      if (e.person !== this.playerPerson) return;
      const a = spatial(e.point);
      wa.crack({ missDistance: e.distance, pan: a.pan });
      const shake = CONFIG.suppression.effects.shakeDeg * Math.min(1, 0.6 / Math.max(0.3, e.distance));
      this.rig.addShake(shake);
      sh.aim.addShake(shake);
    });

    // F7: 먼 가상 사수의 총성 (거리/음속 뒤) + 먼 총구 화염·연기
    const st = this.suppressionTest;
    st.on('remoteShot', (e) => {
      const a = spatial(e.origin);
      wa.shot({ own: false, distance: a.distance, pan: a.pan, behind: a.behind });
      const v = e.projectile?.vel, l = v ? Math.hypot(v.x, v.y, v.z) : 0;
      fx.muzzle({ position: e.origin, dir: l > 0 ? { x: v.x / l, y: v.y / l, z: v.z / l } : undefined, own: false });
    });
    st.on('state', (e) => {
      this.hud.setF7(e.active);
      if (!e.active && e.reason === 'done') this.hud.toast('제압 테스트 끝');
    });

    // F8: 표적 메시·피격 로그
    const tr = this.targetRange;
    tr.on('state', (e) => {
      this.targetMeshes.sync(tr);
      this.hud.setHitLog(e.active ? tr.log : null);
    });
    tr.on('log', () => this.hud.setHitLog(tr.active ? tr.log : null));
  }

  /** 첫 실행 때 프레임이 계속 낮으면 품질을 한 단계 낮추고 알림 (config.performance) */
  _autoQuality(dt) {
    const P = CONFIG.performance;
    if (!P.autoQuality || this._aqDone) return;
    const a = this._aq || (this._aq = { t: 0, frames: 0, real: 0, last: performance.now() });
    const now = performance.now();
    const real = (now - a.last) / 1000;
    a.last = now;
    a.t += dt;
    if (a.t < 3) return;              // 시작 직후(셰이더 준비·청크 갱신)는 제외
    a.frames++; a.real += real;
    if (a.real < 6) return;
    const fps = a.frames / a.real;
    this._aqDone = true;
    let checked = false;
    try { checked = localStorage.getItem('jungle-fps-autoq') === '1'; localStorage.setItem('jungle-fps-autoq', '1'); } catch { /* 무시 */ }
    if (checked || fps >= P.autoQualityMinFps) return;
    const order = ['high', 'medium', 'low'];
    const i = order.indexOf(this.settings.get('quality'));
    if (i < 0 || i >= order.length - 1) return;
    this.settings.set('quality', order[i + 1]);
    this.hud.toast(`프레임이 낮아 그래픽 품질을 '${CONFIG.graphics[order[i + 1]].label}'으로 낮췄습니다 (Esc 메뉴에서 변경)`, 4);
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
