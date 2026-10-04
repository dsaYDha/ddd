// 게임 조립·메인 루프
//  2단계: 전투 (CombatSystem + BulletWorld — 실제 투사체), 플레이어 Person (부위별 캡슐 + 제압) 과 Shooter (무기 + 조준),
//  1인칭 화면 모델(WeaponView, 두 번째 그리기), 착탄·연기 효과(CombatFX), F8 표적(TargetRange + TargetMeshes), F7 제압 테스트,
//  절차 총소리(WeaponAudio). 프레임 순서: 입력·이동 → combat.update (탄 이동·제압 감소) → 표적·F7 → 사수 (발사 — 탄은
//  이번 프레임 끝 위치로 미리 진행) → 반동을 시선에 → 카메라 → 조준선을 카메라에 다시 맞춤 → 화면 모델·효과 → 월드 → 화면 모델 그리기.
//  3단계: 플레이어 부상(Injuries — F8 표적·4단계 적과 같은 컴포넌트). 입력 잠금(충격·사망) → 이동 → 부상 갱신·효과 적용
//  (이동 제한·조준 배율·무기 배율) → 전투. 표현: 화면 충격·이명·순간 흐림·넘어지는 시점·심박·터널 시야·앓는 숨,
//  혈액 60% 미만 회색·흐림·먼 소리, 사망 화면 (Enter 다시 시작). H 붕대 · G 지혈대 · F 총 줍기 · F9 피격 테스트 · F6 대퇴 부상.
//  4단계: 적 병사 AI (ai/EnemyManager — 같은 이동·사격·제압·부상 규칙), 화면 모델(SoldierMeshes), 동물 정적(Wildlife → Ambience),
//  위치 소리는 HRTF (AudioEngine.listener = 카메라). 프레임 순서: … combat.update → 표적·F7 → 적 (감지·판단·이동·사격) → 플레이어 사수 …
//  F4 적 생성 메뉴 · F2 AI 디버그 · F9 무적 켜기/끄기.
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
import { SoldierMeshes, buildSoldierGeometry } from '../render/SoldierMesh.js';
import { NavGrid } from '../ai/NavGrid.js';
import { EnemyManager } from '../ai/EnemyManager.js';
import { AIDebug } from '../ui/AIDebug.js';
import { CombatSystem } from '../combat/CombatSystem.js';
import { BulletWorld } from '../combat/BulletWorld.js';
import { Shooter } from '../combat/Shooter.js';
import { TargetRange } from '../combat/TargetRange.js';
import { SuppressionTest } from '../combat/SuppressionTest.js';
import { Injuries, makeTestHit } from '../combat/Injuries.js';
import { InjuryAudio } from '../audio/InjuryAudio.js';
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

// F9 피격 테스트 메뉴 (makeTestHit 종류 + applyHit 옵션) — 실제 탄과 같은 판정·효과 경로
const HIT_TESTS = [
  { label: '머리 (치명)', kind: 'head' },
  { label: '목 (치명)', kind: 'neck' },
  { label: '심장·대혈관 — 가슴 정면 (치명)', kind: 'heart' },
  { label: '상부 척추 — 등 (치명)', kind: 'spine' },
  { label: '가슴 — 폐 (중상)', kind: 'lung' },
  { label: '복부', kind: 'abdomen' },
  { label: '골반', kind: 'pelvis' },
  { label: '오른 상완 (방아쇠 팔)', kind: 'upperArmR', opts: { forceArterial: false } },
  { label: '오른 상완 — 동맥', kind: 'upperArmR', opts: { forceArterial: true } },
  { label: '왼 상완 (지지 팔)', kind: 'upperArmL', opts: { forceArterial: false } },
  { label: '오른 하완', kind: 'forearmR' },
  { label: '왼 하완', kind: 'forearmL' },
  { label: '왼 대퇴', kind: 'thighL', opts: { forceArterial: false } },
  { label: '왼 대퇴 — 동맥', kind: 'thighL', opts: { forceArterial: true } },
  { label: '오른 하퇴', kind: 'shinR' },
  { label: '저속 탄 (관통 뒤 30%) → 심장: 가슴 중상으로', kind: 'lowSpeed' },
  { label: '저속 탄 (관통 뒤 30%) → 대퇴: 스침으로', kind: 'thighR', opts: { retained: 0.3, forceArterial: false } },
  { label: '스침 — 가슴 옆 1cm', kind: 'graze', opts: { part: 'upperChest' } },
  { label: '스침 — 머리 옆 1cm', kind: 'graze', opts: { part: 'head' } },
  { label: '무적 켜기 / 끄기 (4단계 테스트 — 맞아도 다치지 않음)', kind: 'invulnerable' },
  { label: '부상 초기화 (테스트 전용 — 게임에선 치유 없음)', kind: 'reset' },
];
// F4 적 생성 메뉴: 거리 후보 (m)·인원 범위 — CONFIG.ai.spawn
const SPAWN_KINDS = [{ key: 'patrol', label: '순찰 분대' }, { key: 'ambush', label: '매복조 (앞쪽 오솔길)' }];
const AID_LABEL = { bandage: '붕대', tourniquet: '지혈대' };

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
    // 3단계: 부상 — 사람 공용 컴포넌트 (F8 표적·4단계 적과 같은 규칙)
    this.injuries = new Injuries({ isPlayer: true, motor: this.motor, name: 'player' });
    this.playerPerson = this.combat.addPerson({ name: 'player', isPlayer: true, noiseSource: this.motor, getPose: () => this._playerHitPose(), injuries: this.injuries });
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

    // ---- 4단계: 적 AI — 길찾기 격자 (지형 비용·오솔길·은폐), 감지·판단·분대, 동물 활동도
    this.menu.setProgress(0.73, 'AI 길찾기 격자 준비 중…');
    await nextFrame();
    this.nav = new NavGrid(this.query, data.layout);
    this.enemies = new EnemyManager({ query: this.query, combat: this.combat, noise: this.noise, layout: data.layout, nav: this.nav });
    const inj0 = this.injuries;
    this.enemies.setTarget({
      person: this.playerPerson, motor: this.motor, injuries: inj0,
      get alive() { return !inj0.dead; },
      exposure: () => this.exposure.value,
    });
    this._spawn = { open: false, index: 0, kind: 0, size: 5, mg: true, dist: 1 };
    this._aiMs = 0;
    this._aiRays = { last: 0, perFrame: 0 };
    this._listener = { x: st.x, y: 0, z: st.z, yaw: st.yaw };
    this._vegCache = new Map();

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
    this.injuryAudio = new InjuryAudio(this.audio);
    this.ambience.setWildlife(this.enemies.wildlife);   // 4단계: 움직이는 사람·총성 주변 동물 정적
    this.audio.listener = this._listener;

    // ---- 사격 화면·효과 — 로딩 중에 만들어 아래 셰이더 미리 컴파일에 포함 (첫 발·첫 F8 에서 끊기지 않게)
    this.menu.setProgress(0.8, '무기 준비 중…');
    await nextFrame();
    const qKey = this.settings.get('quality');
    this.weaponView = new WeaponView(renderer, { quality: qKey, weaponData });
    this.weaponView.attach(this.shooter);
    this.combatFX = new CombatFX(this.scene, { textures: this.world.textures, quality: qKey, groundHeight: (x, z) => this.query.getTerrainHeight(x, z) });
    this.combatFX.setTracers(this.combat.ballistics.projectiles);
    this.targetMeshes = new TargetMeshes(this.scene, { leafMaterial: this.world.materials.leaves, stemMaterial: this.world.materials.stem, buildShrub: PG.buildShrub });
    this.soldierMeshes = new SoldierMeshes(this.scene, { query: this.query });
    this._vmLight = {
      sunColor: new THREE.Color(), sunDir: new THREE.Vector3(0, 1, 0), skyColor: new THREE.Color(), groundColor: new THREE.Color(),
      hemiIntensity: 1, shade: -1, sunVisible: 1, flash: 0,
    };
    this._mz = new THREE.Vector3();
    this._md = new THREE.Vector3();
    this._wireCombat();
    this._wireEnemies();
    this._resetInjuryState();

    // ---- UI
    this.hud = new HUD(this.uiEl);
    // 약한 비네트 (색보정의 일부 — config.lighting.vignette)
    this.uiEl.insertAdjacentHTML('afterbegin', `<div id="grade-vignette" style="position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center, rgba(0,0,0,0) 58%, rgba(0,0,0,${CONFIG.lighting.vignette}) 100%)"></div>`);
    this.debug = new DebugOverlay(this.uiEl);
    this.aiDebug = new AIDebug(this.scene, this.uiEl);
    this.controller.on('toast', (msg) => this.hud.toast(msg));
    this._wireInjuries();
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
    this.menu.on('debug', (v) => { this.debug.toggle(v); this._syncHitLog(); });
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
    // 4단계 병사·구덩이 재질도 (위장 무늬 셰이더) — 첫 적을 부를 때 끊기지 않게
    const warmS = new THREE.Mesh(buildSoldierGeometry({ x: 0, y: 0, z: 0, yaw: 0, stance: 'stand', stanceFrom: 'stand', stanceProgress: 1, arms: 'rifle' }), this.soldierMeshes.material);
    const warmP = new THREE.Mesh(this.soldierMeshes._pitGeo, this.soldierMeshes.pitMaterial);
    for (const w of [warmS, warmP]) {
      w.castShadow = w.receiveShadow = true;
      w.frustumCulled = false;
      w.position.set(this.motor.position.x, this.motor.position.y - 3, this.motor.position.z);
      this.scene.add(w);
    }
    for (const t of [this.combatFX.fxAtlas?.texture, this.weaponView.textures?.flash]) if (t) try { renderer.initTexture(t); } catch { /* 일부 환경 미지원 */ }
    try {
      // 병렬 컴파일 확장이 없으면 compileAsync가 경고를 내므로 동기 컴파일 사용
      if (this.renderer.extensions.has('KHR_parallel_shader_compile')) await this.renderer.compileAsync(this.scene, this.camera);
      else this.renderer.compile(this.scene, this.camera);
    } catch { /* 일부 환경 미지원 */ }
    this.renderer.render(this.scene, this.camera);
    this.scene.remove(warm);
    warm.geometry.dispose();
    this.scene.remove(warmS); this.scene.remove(warmP);
    warmS.geometry.dispose();
    this.menu.setProgress(1, '준비 완료');
    this.menu.ready();
    this.menu.sync({ debug: this.debug.visible });

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
    this.hud.toast('마우스를 누른 채 끌어서 시점 이동 · 우클릭 조준 · V 사격 · Esc 메뉴', 4);
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
    this.menu.sync({ debug: this.debug.visible });
    this.audio.suspend();
  }

  /** F9·F6 피격 테스트: 지금 자세의 판정 캡슐에 실제 탄과 같은 명중을 만들어 같은 경로로 적용 */
  testHit(kind, opts = {}) {
    if (kind === 'reset') { this._resetInjuries(); this.hud.toast('부상 초기화 (테스트)'); return null; }
    if (kind === 'invulnerable') {
      this.injuries.invulnerable = !this.injuries.invulnerable;
      this.hud.toast(this.injuries.invulnerable ? '무적 켜짐 (테스트) — 맞아도 다치지 않음' : '무적 꺼짐', 2);
      return null;
    }
    if (this.injuries.dead) return null;
    this.playerPerson.refresh();
    const hit = makeTestHit(this.playerPerson, kind, opts);
    if (!hit) return null;
    hit.shooter = null;
    const r = this.injuries.applyHit(hit, opts);
    hit.wound = r;
    this._onPlayerHit(hit);
    return r;
  }

  /** Enter (사망 화면): 시작 지점에서 다시 — 부상·무기·탄·표적·효과 초기화 */
  restart() {
    const st = this.data.layout.start;
    const m = this.motor;
    this.targetRange.clear();
    if (this.suppressionTest.active) this.suppressionTest.stop('restart');
    this.enemies.clear();
    this.enemies.wildlife.reset();
    this.soldierMeshes.clear();
    this.aiDebug.clear();
    this.combat.reset();
    this.combatFX.clear();
    this._resetInjuries();
    for (const k of [...m.restrictions.keys()]) m.clearRestriction(k);
    m.stance = m.stanceFrom = 'stand';
    m.stanceProgress = 1;
    m.eyeHeight = CONFIG.stance.eyeHeight.stand;
    m.stamina = CONFIG.stamina.max;
    m.exhausted = false;
    m.heartRate = CONFIG.heart.rest;
    m.stress = 0;
    this.teleport(st.x, st.z, st.yaw);
    const sh = this.shooter;
    sh.weapon.reset();
    sh.aim.reset();
    this.playerPerson.suppression.reset();
    this.hud.toast('다시 시작');
  }

  /** 부상·표현 상태 초기화 (다시 시작, F9 초기화) */
  _resetInjuries() {
    this.injuries.reset();
    this.injuries.apply(this.motor, this.shooter);
    if (this._droppedMesh) this._droppedMesh.visible = false;
    this.weaponView.visible = true;
    this.rig.resetInjury();
    this.controller.locked = false;
    this.hud.setDeath(null);
    this.hud.setBlackout(0);
    this.hud.setHitTest(null);
    this._resetInjuryState();
  }

  _resetInjuryState() {
    this._inj = {
      tinnitus: 0, blur: 0, deathT: -1, deathShown: false, filter: '', stainT: 1.5, pickup: null,
      hitTest: false, hitIndex: 0,
    };
    if (this.renderer) this.renderer.domElement.style.filter = '';
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
    if (e.code === K.debug) { this.debug.toggle(); this._syncHitLog(); }
    const J = this._inj;
    // 사망 화면: Enter 로 다시 시작 (다른 키는 무시)
    if (this.injuries.dead) {
      if (!this.paused && e.code === K.restart && J.deathShown) this.restart();
      return;
    }
    // 4단계: F2 AI 디버그, F4 적 생성 메뉴 (열려 있는 동안 ↑↓·←→·Enter)
    if (!this.paused && e.code === K.aiDebug) {
      this.hud.toast(this.aiDebug.toggle() ? 'AI 디버그 켜짐 (F2)' : 'AI 디버그 꺼짐', 1.2);
      return;
    }
    if (!this.paused && e.code === K.spawnMenu) {
      this._spawn.open = !this._spawn.open;
      if (this._spawn.open && J.hitTest) { J.hitTest = false; this.hud.setHitTest(null); }
      this._showSpawnMenu();
      return;
    }
    if (this._spawn.open && !this.paused && this._spawnKey(e.code)) return;
    // F9 피격 테스트 메뉴 (열려 있는 동안 ↑↓·Enter)
    if (!this.paused && e.code === K.hitTest) {
      J.hitTest = !J.hitTest;
      if (J.hitTest && this._spawn.open) { this._spawn.open = false; this._showSpawnMenu(); }
      this.hud.setHitTest(J.hitTest ? HIT_TESTS : null, J.hitIndex);
      return;
    }
    if (J.hitTest && !this.paused) {
      if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        J.hitIndex = (J.hitIndex + (e.code === 'ArrowUp' ? -1 : 1) + HIT_TESTS.length) % HIT_TESTS.length;
        this.hud.setHitTest(HIT_TESTS, J.hitIndex);
        return;
      }
      if (e.code === K.restart) {
        const t = HIT_TESTS[J.hitIndex];
        this.testHit(t.kind, t.opts || {});
        return;
      }
    }
    if (!this.paused && e.code === K.incapacitate) {
      // F6: 대퇴 부상 (왼쪽, 동맥 아님) — 1단계 '거동 불능' 시험 키를 실제 부상으로
      if (this.testHit('thighL', { forceArterial: false })) this.hud.toast('F6 — 왼 대퇴 부상 (테스트)');
    }
    if (!this.paused && (e.code === K.bandage || e.code === K.tourniquet)) {
      this.injuries.startAid(e.code === K.bandage ? 'bandage' : 'tourniquet');
    }
    if (!this.paused && e.code === K.pickup) this._startPickup();
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
    // 4단계 HRTF 듣는 사람 = 카메라 (지난 프레임 끝 위치 — 이번 프레임에 나는 소리들의 기준)
    const L = this._listener, cp = this.camera.position;
    L.x = cp.x; L.y = cp.y; L.z = cp.z; L.yaw = this.controller.yaw;
    // 그리기 통계: 지난 프레임의 월드 + 화면 모델 합계를 기억하고 지움 (renderer.info.autoReset = false)
    const ri = this.renderer.info.render;
    this._renderStats.calls = ri.calls;
    this._renderStats.triangles = ri.triangles;
    this.renderer.info.reset();

    // 3단계: 충격(조작 불가)·사망이면 입력 잠금 → 이동 → 부상 (출혈·처치·효과를 이동 제한·조준·무기에)
    const inj = this.injuries;
    this.controller.locked = inj.dead || inj.stunned;
    this.controller.update(dt);
    m.update(dt);
    inj.update(dt, { speed: Math.hypot(m.velocity.x, m.velocity.z) });
    inj.apply(m, this.shooter);
    this._updatePickup(dt);
    this.noise.rainIntensity = this.atmosphere.rainIntensity;
    this.noise.update(dt);
    this.breath.update(dt, m.breath);

    // 전투: 탄 이동·제압 감소 → 표적 걷기·F7 사수 → 플레이어 사격 (쏜 탄은 이번 프레임 끝 위치로 미리 진행 — 순서 중요)
    this.combat.update(dt);
    this.targetRange.update(dt);
    this.suppressionTest.update(dt);
    // 4단계: 적 (감지 → 소리 → 분대 → 병사 판단·이동·사격). 시간은 F3 에 (구조적 예산: 레이·경로·판단 분산)
    const t0 = performance.now();
    this.enemies.update(dt);
    this._aiMs += (performance.now() - t0 - this._aiMs) * 0.1;
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
    this.soldierMeshes.update(this.enemies.soldiers, this.enemies.pits);
    this._pushPlantsBySoldiers();
    // 총구 화염 빛: 월드에 점광원을 더하지 않고 반구광을 잠깐 밝힘 (Atmosphere 가 매 프레임 값을 다시 정하므로 누적되지 않음)
    const flash = this.combatFX.flash;
    if (flash > 0) this.atmosphere.hemi.intensity = this.atmosphere.state.hemiIntensity * (1 + 0.8 * flash);

    // 소리
    const preset = CONFIG.timeOfDay.presets[this.atmosphere.tod];
    this._envTimer -= dt;
    if (this._envTimer <= 0) { this._envTimer = 1; this.nearWater = this._nearWater(); }
    this.ambience.update(dt, { dawn: preset.ambienceDawn, day: preset.ambienceDay, dusk: preset.ambienceDusk },
      this.atmosphere.rainIntensity, this.atmosphere.state.wind, this.query.getCanopyCover(m.position.x, m.position.z), this.nearWater);
    const look = this._updateInjuryLook(dt, sup);
    this.breathing.holding = this.rig.holdingBreath;
    this.breathing.update(dt, this.breath, look.body);
    this.weaponAudio.update(dt);
    this.weaponAudio.setMuffle(Math.max(sup.muffle, look.muffle));

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
    this.hud.tunnel = Math.max(sup.tunnel, look.tunnel);
    this.hud.update(dt, m, this.controller.quiet);
    this._ringAge += dt;
    this.noiseRing.visible = this.debug.visible;
    this.noiseRing.material.opacity = Math.max(0, 0.8 - this._ringAge * 1.2);
    if (this.debug.visible) {
      this._rayTimer -= dt;
      if (this._rayTimer <= 0) { this._rayTimer = 0.125; this._debugRays(); }
    }
    const st = this.enemies.stats;
    this._aiRays.perFrame += ((st.rays - this._aiRays.last) - this._aiRays.perFrame) * 0.05;
    this._aiRays.last = st.rays;
    this.aiDebug.update(this.enemies.soldiers, this.camera, this.enemies.time);
    this.debug.update(dt, {
      motor: m, yaw: this.controller.yaw, exposure: this.exposure, rays: this.rays,
      noiseMask: this.noise.maskFactor(), wetness: this.atmosphere.wetness, rain: this.atmosphere.rainIntensity,
      tod: this.atmosphere.tod, weather: this.atmosphere.weather, quality: this.settings.get('quality'),
      render: this._renderStats, veg: this.world.stats, testPoints: this.data.testPoints,
      combat: { shooter: sh, stats: this.combat.stats(this.playerPerson), suppression: this.playerPerson.suppression, stress: m.stress },
      injury: inj,
      ai: {
        manager: this.enemies, raysPerFrame: this._aiRays.perFrame, ms: this._aiMs, invulnerable: inj.invulnerable,
        wildlife: this.enemies.wildlife.around(m.position.x, m.position.z, 30),
      },
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
    m.stress = Math.max(sup.heartStress, this.injuries.effects().heartStress);   // 겁(제압)과 통증·출혈 중 큰 쪽
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
      if (e.person === this.playerPerson) return;   // 내 몸: _onPlayerHit (몸 안에서 울리는 소리·화면 충격)
      fx.bodyHit(e);
      const w = e.wound;
      if (w) {
        fx.blood({ point: e.point, normal: e.normal, dir: e.dir, severity: w.severity, arterial: w.arterial });
        // 치명·동맥이면 발밑 땅에 바로 어두운 얼룩 (쓰러진 자리에는 출혈 때마다 더 생긴다)
        if (!w.alreadyDead && (w.severity === 'lethal' || w.arterial)) fx.bloodStain(e.person.position, 0.8);
      }
      const a = spatial(e.point);
      wa.impact({ material: 'body', distance: a.distance, pan: a.pan, behind: a.behind, speed: e.speed });
    });
    this.playerPerson.on('hit', (e) => this._onPlayerHit(e));
    c.on('nearPass', (e) => { if (e.person === this.playerPerson && e.graze) this._onPlayerHit({ ...e, wound: e.graze }); });
    // 초음속 탄이 플레이어 곁을 지나감: '딱' (발사음보다 먼저) + 화면 움찔 + 총 움찔 — 가까울수록 크게
    c.on('flyby', (e) => {
      if (e.person !== this.playerPerson) return;
      const a = spatial(e.point);
      wa.crack({ missDistance: e.distance, pan: a.pan, pos: e.point, gain: e.projectile?.weapon?.sound?.crack ?? 1 });
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
    // 히트마커 없음: 피격 로그는 F3 디버그를 켰을 때만 (쓰러지는 모습만 보고 판단)
    tr.on('state', () => { this.targetMeshes.sync(tr); this._syncHitLog(); });
    tr.on('log', () => this._syncHitLog());
    // 사람 개체: 신음·거친 숨·기침, 땅 핏자국, 쓰러지는 소리
    const ia = this.injuryAudio;
    const at = { x: 0, y: 0, z: 0 };
    tr.on('vocal', (e) => {
      at.x = e.position.x; at.y = e.position.y + 0.4; at.z = e.position.z;
      const a = spatial(at);
      ia.vocal(e.kind, { distance: a.distance, pan: a.pan, behind: a.behind, stage: e.stage });
    });
    tr.on('bleed', (e) => fx.bloodStain(e.position, 0.6 + Math.min(1.2, e.rate / 15)));
    tr.on('fall', (e) => {
      const p = e.target.pos;
      at.x = p.x; at.y = p.y + 0.4; at.z = p.z;
      const a = spatial(at);
      const E = CONFIG.injury.entity;
      ia.bodyFall({ distance: a.distance, pan: a.pan, behind: a.behind, delay: e.kind === 'collapse' ? E.fallTime * 0.85 : 0.35, heavy: e.kind !== 'sit' });
    });
  }

  _syncHitLog() {
    const tr = this.targetRange;
    this.hud?.setHitLog(tr.active && this.debug?.visible ? tr.log : null);
  }

  // =================================================================
  // 4단계: 적 병사 — 소리(HRTF 위치)·총구 화염·피·쓰러짐
  // =================================================================
  _wireEnemies() {
    const em = this.enemies, wa = this.weaponAudio, ia = this.injuryAudio, fs = this.footsteps, fx = this.combatFX;
    const EN = CONFIG.audio.enemy;
    const sp = {};
    const spatial = (p) => WeaponAudio.spatial(this.camera.position, this.controller.yaw, p, sp);
    const at = (p, dy = 0) => ({ x: p.x, y: p.y + dy, z: p.z });
    // 적 총성: 무기마다 다른 소리 (5.56 소총은 높고 짧게, 경기관총은 낮고 무겁게) + 사이 식생만큼 더 작고 어둡게 + 먼 총구 화염
    this.combat.on('shot', (e) => {
      if (e.shooter?.faction !== 'enemy') return;
      const a = spatial(e.origin);
      wa.shot({ own: false, distance: a.distance, pan: a.pan, behind: a.behind, pos: at(e.origin), profile: e.weapon?.sound, veg: this._vegBetween(e.shooter, e.origin, a.distance) });
      fx.muzzle({ position: e.origin, dir: e.dir, own: false });
    });
    // 고함 (분대 의사소통·비명·도움 요청) — 목소리 높이는 병사마다
    em.on('shout', (e) => {
      const s = e.soldier, a = spatial(e.position);
      const weak = s.alive ? Math.max(0.45, Math.min(1, s.injuries.blood / 80)) : 0.5;
      ia.shout(e.kind, { distance: a.distance, pan: a.pan, behind: a.behind, pos: at(e.position), voice: this._voiceOf(s), weak });
    });
    // 탄창 교환·노리쇠 (가까울 때만)
    em.on('mech', (e) => {
      const p = e.soldier.eye, a = spatial(p);
      if (a.distance > EN.mechRange) return;
      wa.mech(MECH_SOUND[e.kind] ?? e.kind, { pos: at(p, -0.25), distance: a.distance });
    });
    // 발소리·헤치는 소리
    em.on('footstep', (e) => {
      const p = e.soldier.motor.position, a = spatial(p);
      if (a.distance > EN.footstepRange) return;
      fs.play(e.evt, { distance: a.distance, pan: a.pan, pos: at(p, 0.1) });
    });
    em.on('rustle', (e) => {
      const p = e.soldier.motor.position, a = spatial(p);
      if (a.distance > EN.footstepRange) return;
      fs.rustle(e.evt, { distance: a.distance, pan: a.pan, pos: at(p, 0.6) });
    });
    // 부상병: 신음·거친 숨·기침, 땅 핏자국, 쓰러지는 소리
    em.on('vocal', (e) => {
      const p = at(e.position ?? e.soldier.motor.position, 0.4), a = spatial(p);
      if (a.distance > EN.vocalRange) return;
      ia.vocal(e.kind, { distance: a.distance, pan: a.pan, behind: a.behind, stage: e.stage, pos: p });
    });
    em.on('bleed', (e) => fx.bloodStain(e.position, 0.6 + Math.min(1.2, (e.rate ?? 0) / 15)));
    em.on('fall', (e) => {
      const p = at(e.soldier.motor.position, 0.4), a = spatial(p);
      const E = CONFIG.injury.entity;
      ia.bodyFall({ distance: a.distance, pan: a.pan, behind: a.behind, pos: p, delay: e.kind === 'collapse' ? E.fallTime * 0.85 : 0.35, heavy: e.kind !== 'sit' });
    });
    em.on('clear', () => this._vegCache.clear());
  }

  /** 병사 목소리 (고함 합성): 기본 높이·포먼트 배율 */
  _voiceOf(s) {
    const v = s.voice ?? 0.5;
    return { f0: 102 + 46 * v, formant: 0.93 + 0.14 * (1 - v) };
  }

  /**
   * 총성이 지나오는 식생 (0 = 트임, 1 = 빽빽): 총구 → 듣는 사람 시야 투과율. 같은 사수는 vegCacheSec 동안 재사용
   * (기관총 연발마다 레이를 쏘지 않게)
   */
  _vegBetween(shooter, origin, distance) {
    const EN = CONFIG.audio.enemy, now = this.enemies.time;
    const c = this._vegCache.get(shooter);
    if (c && now - c.t < EN.vegCacheSec) return c.v;
    const cam = this.camera.position;
    const dx = cam.x - origin.x, dy = cam.y - origin.y, dz = cam.z - origin.z;
    const L = Math.min(150, distance || Math.hypot(dx, dy, dz));
    const r = this.query.raycastWorld(origin, { x: dx, y: dy, z: dz }, Math.max(0.1, L - 0.3), 'vision');
    const v = r.hit && r.object?.type === 'terrain' ? 1 : 1 - (r.hit ? 0 : r.transmittance);
    this._vegCache.set(shooter, { t: now, v });
    return v;
  }

  /** 식물 밀림: 카메라에 가장 가까운 살아 있는 병사 3명 (셰이더 uPush 1~3번 칸) */
  _pushPlantsBySoldiers() {
    const slots = shared.uPush.value, cam = this.camera.position, R = CONFIG.interaction.pushRadius;
    const near = this._pushNear || (this._pushNear = []);
    near.length = 0;
    for (const s of this.enemies.soldiers) {
      if (!s.alive || s.inPit) continue;
      const p = s.motor.position;
      const d = (p.x - cam.x) ** 2 + (p.z - cam.z) ** 2;
      if (d > 60 * 60) continue;
      near.push({ s, d });
    }
    near.sort((a, b) => a.d - b.d);
    for (let i = 1; i <= 3; i++) {
      const n = near[i - 1];
      if (!n) { slots[i].set(0, -1e4, 0, 0); continue; }
      const p = n.s.motor.position;
      slots[i].set(p.x, p.y, p.z, R * (n.s.motor.stance === 'prone' ? 1.25 : 1));
    }
  }

  // ---- F4 적 생성 메뉴 ------------------------------------------------
  _spawnItems() {
    const S = this._spawn, D = CONFIG.ai.spawn.distances;
    return [
      { label: '종류', value: SPAWN_KINDS[S.kind].label },
      { label: '인원', value: `${S.size}명` },
      { label: '경기관총 포함', value: S.mg ? '예' : '아니오' },
      { label: '거리', value: `${D[S.dist]} m` },
      { label: '▷ 생성' },
      { label: '모두 제거' },
    ];
  }

  _showSpawnMenu() {
    this.hud.setSpawnMenu(this._spawn.open ? this._spawnItems() : null, this._spawn.index);
  }

  /** 메뉴가 열려 있을 때의 키 — 처리했으면 true */
  _spawnKey(code) {
    const S = this._spawn, items = this._spawnItems();
    const sizes = CONFIG.ai.spawn.sizes, D = CONFIG.ai.spawn.distances;
    const change = (dir) => {
      if (S.index === 0) S.kind = (S.kind + dir + SPAWN_KINDS.length) % SPAWN_KINDS.length;
      else if (S.index === 1) S.size = Math.max(Math.min(...sizes) - 1, Math.min(Math.max(...sizes), S.size + dir));
      else if (S.index === 2) S.mg = !S.mg;
      else if (S.index === 3) S.dist = (S.dist + dir + D.length) % D.length;
      else return false;
      return true;
    };
    if (code === 'ArrowUp' || code === 'ArrowDown') {
      S.index = (S.index + (code === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    } else if (code === 'ArrowLeft' || code === 'ArrowRight') {
      if (!change(code === 'ArrowLeft' ? -1 : 1)) return true;
    } else if (code === 'Enter') {
      if (S.index === 4) this._doSpawn();
      else if (S.index === 5) { this.enemies.clear(); this.soldierMeshes.clear(); this.aiDebug.clear(); this.hud.toast('적 모두 제거'); }
      else change(1);
    } else return false;
    this._showSpawnMenu();
    return true;
  }

  _doSpawn() {
    const S = this._spawn, em = this.enemies, m = this.motor;
    const d = CONFIG.ai.spawn.distances[S.dist];
    const left = CONFIG.ai.maxActive - em.active.length;
    if (left <= 0) { this.hud.toast(`적이 이미 ${CONFIG.ai.maxActive}명 — 더 부를 수 없음`, 2); return; }
    const near = { x: m.position.x, z: m.position.z };
    const kind = SPAWN_KINDS[S.kind].key;
    const sq = kind === 'patrol'
      ? em.spawnPatrol({ near, distance: d, size: S.size, mg: S.mg })
      : em.spawnAmbush({ near, yaw: this.controller.yaw, distance: d, size: S.size, mg: S.mg });
    if (!sq) { this.hud.toast('생성할 자리를 찾지 못함', 2); return; }
    const n = sq.members.length;
    const mg = sq.members.some((x) => x.weaponData.bipod);
    const where = kind === 'patrol' ? `${d}m 밖에서 이쪽으로 순찰` : `앞쪽 오솔길 약 ${d}m 에 매복`;
    this.hud.toast(`${SPAWN_KINDS[S.kind].label.split(' ')[0]} ${n}명${mg ? ' (경기관총)' : ''} — ${where}${n < S.size ? ` · 최대 ${CONFIG.ai.maxActive}명이라 ${n}명만` : ''}`, 3);
  }

  // =================================================================
  // 3단계: 플레이어 부상
  // =================================================================
  _wireInjuries() {
    const inj = this.injuries, ia = this.injuryAudio, hud = this.hud;
    inj.on('forceStance', () => this.rig.knockdown());
    inj.on('death', (e) => {
      this._inj.deathT = 0;
      this._inj.deathCause = e.label;
      this._inj.pickup = null;
      this.rig.deathSide = Math.random() < 0.5 ? -1 : 1;
      this.weaponView.visible = false;   // 쓰러지며 총을 놓침
      this._inj.hitTest = false;
      hud.setHitTest(null);
    });
    inj.on('drop', () => { this._dropRifle(); hud.toast('총을 떨어뜨렸다 — F 로 줍기', 2.2); });
    inj.on('pickup', () => {
      if (this._droppedMesh) this._droppedMesh.visible = false;
      this.weaponView.visible = true;
      hud.toast('총을 주웠다');
    });
    inj.on('aidStart', (e) => {
      ia.aidStart(e.kind);
      hud.toast(`${AID_LABEL[e.kind]}를 감는다 (${e.duration.toFixed(1)}초) — 움직이거나 맞으면 취소`, Math.min(4, e.duration));
    });
    inj.on('aidEnd', (e) => {
      ia.aidEnd(e.kind);
      const left = e.kind === 'bandage' ? inj.bandages : inj.tourniquets;
      hud.toast(`${AID_LABEL[e.kind]}를 감았다 (남은 ${AID_LABEL[e.kind]} ${left}개)`, 1.8);
    });
    inj.on('aidCancel', (e) => {
      if (e.reason === 'move' || e.reason === 'hit') hud.toast(`처치 취소 — ${e.reason === 'move' ? '움직임' : '피격'}`);
    });
    inj.on('aidRefused', (e) => {
      const msg = { none: `${AID_LABEL[e.kind]}가 없다`, noWound: '감을 상처가 없다', noLimb: '지혈대는 팔다리에만 감을 수 있다', busy: '이미 처치 중이다' }[e.reason];
      if (msg) hud.toast(msg);
    });
    inj.on('cough', () => {
      ia.ownCough();
      this.rig.addShake(1.4);
      this.shooter.aim.addShake(CONFIG.injury.cough.swayKick);
    });
    inj.on('stumble', () => {
      this.rig.dipVel -= 0.9;
      this.rig.addShake(1.2);
      this.shooter.aim.addShake(0.8);
    });
  }

  /** 내가 맞음 (실제 탄·근접 통과 스침·F9 테스트): 화면 충격·이명·순간 흐림·몸 소리·땅 핏자국 */
  _onPlayerHit(e) {
    const r = e.wound;
    if (!r || r.alreadyDead) return;
    if (r.ignored) {
      // F9 무적: 맞은 줄만 알게 (약한 충격·번쩍임) — 부상·출혈 없음
      this.rig.impact(0, 1, 0.3);
      this.hud.hitFlash(0.25);
      return;
    }
    const P = CONFIG.injury.player;
    const yaw = this.controller.yaw;
    let side = 0, back = 1;
    if (e.dir) {
      // 탄 진행 방향 → 시선 기준: 오른쪽에서 날아와 왼쪽으로 가면 side +, 앞에서 와서 뒤로 가면 back +
      side = -(e.dir.x * Math.cos(yaw) - e.dir.z * Math.sin(yaw));
      back = e.dir.x * Math.sin(yaw) + e.dir.z * Math.cos(yaw);
    }
    const k = r.severity === 'lethal' ? 1.4 : r.severity === 'graze' ? 0.55 : 1;
    this.rig.impact(side, back, k);
    this.shooter.aim.addShake(3 * k);
    this.hud.hitFlash(0.55 + 0.45 * k);
    this.injuryAudio.selfHit({ severity: r.severity });
    if (r.severity !== 'lethal') {
      this.injuryAudio.tinnitus(P.tinnitus, r.severity === 'graze' ? 0.6 : 1);
      this._inj.tinnitus = P.tinnitus;
    }
    this._inj.blur = Math.max(this._inj.blur, P.blur * (r.severity === 'graze' ? 0.6 : 1));
    this.combatFX.bloodStain(this.motor.position, r.severity === 'graze' ? 0.45 : 0.8);
  }

  /** 떨어뜨린 총: 화면 모델의 소총 지오메트리를 그대로 (표적 재질 — 숲 그늘을 받음) 발 앞 땅에 옆으로 눕힌다 */
  _dropRifle() {
    const m = this.motor, yaw = this.controller.yaw;
    if (!this._droppedMesh) {
      const mesh = this._droppedMesh = new THREE.Mesh(this.weaponView.rifleMesh.geometry, this.targetMeshes.material);
      mesh.name = 'droppedRifle';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
    const mesh = this._droppedMesh;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const x = m.position.x + fx * 0.55 + rx * 0.3, z = m.position.z + fz * 0.55 + rz * 0.3;
    const y = this.query.getSupportHeight(x, z) + 0.035;
    mesh.position.set(x, y, z);
    mesh.rotation.set(0, yaw + (Math.random() - 0.5) * 1.6, Math.PI / 2);   // 총 길이 축(−Z)을 수평으로, 옆으로 누움
    mesh.visible = true;
    this.weaponView.visible = false;
  }

  /** F: 떨어뜨린 총 줍기 시작 (pickupRange 안, 2초 — 움직이거나 맞으면 취소) */
  _startPickup() {
    const inj = this.injuries, J = this._inj;
    if (!inj.weaponDropped || J.pickup || inj.dead) return;
    if (inj.stunned || inj.aid) return;
    const A = CONFIG.injury.arm, p = this._droppedMesh.position, m = this.motor.position;
    if (Math.hypot(p.x - m.x, p.z - m.z) > A.pickupRange) { this.hud.toast('총이 손에 닿지 않는다 — 더 다가가라'); return; }
    J.pickup = { t: 0, hits: inj.wounds.length };
    this.hud.toast(`총을 줍는다 (${A.pickupTime}초)`, A.pickupTime);
  }

  _updatePickup(dt) {
    const J = this._inj, pk = J.pickup;
    if (!pk) return;
    const inj = this.injuries, m = this.motor;
    if (inj.dead || !inj.weaponDropped) { J.pickup = null; return; }
    if (Math.hypot(m.velocity.x, m.velocity.z) > CONFIG.injury.aid.moveCancelSpeed || inj.wounds.length !== pk.hits) {
      J.pickup = null;
      this.hud.toast('줍기 취소');
      return;
    }
    pk.t += dt;
    if (pk.t >= CONFIG.injury.arm.pickupTime) { J.pickup = null; inj.pickUpWeapon(); }
  }

  /**
   * 부상 표현 한 프레임: 쓰러진 시점·죽음·의식 상실 검은 화면·사망 화면, 화면 흐림·회색 (canvas CSS filter — 바뀔 때만),
   * 터널 시야·먹먹함·앓는 숨 값을 돌려줌 (재사용 객체)
   */
  _updateInjuryLook(dt, sup) {
    const inj = this.injuries, J = this._inj, P = CONFIG.injury.player, T = CONFIG.injury.thresholds;
    const out = this._look || (this._look = { tunnel: 0, muffle: 0, body: { heartRate: 70, exhausted: false, pain: 0, chest: false } });
    const m = this.motor, fx = inj.effects();
    this.rig.downed = !inj.dead && fx.downed;
    J.tinnitus = Math.max(0, J.tinnitus - dt);
    J.blur = Math.max(0, J.blur - dt);
    const loss = inj.bloodLossFactor;
    const faint = inj.dead ? 1 : Math.min(1, Math.max(0, (T.faint - inj.blood) / (T.faint - T.dead)));
    // 처치 소리
    if (inj.aid) this.injuryAudio.aidTick(inj.aid.kind, inj.aid.t / inj.aid.duration, dt);
    // 피를 흘리는 동안 발밑에 어두운 얼룩
    const rate = inj.bleedRate;
    if (rate > 0 && !inj.dead) {
      J.stainT -= dt * Math.min(3, 0.5 + rate / 8);
      if (J.stainT <= 0) { J.stainT = 1.6; this.combatFX.bloodStain(m.position, 0.5 + Math.min(1, rate / 20)); }
    }
    // 죽음: 시점이 땅으로 떨어지고 검게 꺼진 뒤 사망 화면
    let black = 0;
    if (inj.dead) {
      J.deathT += dt;
      const bleed = inj.cause === 'bleed';
      this.rig.groundY = this.query.getSupportHeight(m.position.x, m.position.z);
      this.rig.death = smoothstep(0, bleed ? 1.6 : 1.0, J.deathT);
      const fadeStart = bleed ? 0 : P.deathScreenDelay - 0.45;
      const fadeLen = bleed ? P.faintFade : 0.45;
      black = Math.min(1, Math.max(0, (J.deathT - fadeStart) / fadeLen));
      const showAt = bleed ? P.faintFade + 0.4 : P.deathScreenDelay;
      if (!J.deathShown && J.deathT >= showAt) {
        J.deathShown = true;
        this.hud.setDeath({ cause: J.deathCause || inj.causeLabel, time: inj.deathTime });
      }
    } else if (faint > 0.75) {
      // 의식이 꺼져 감: 심장 박동에 맞춰 가장자리부터 어두워짐
      black = (faint - 0.75) * 1.2 * (0.75 + 0.25 * Math.sin(this.hud.pulse * Math.PI * 2));
    }
    this.hud.setBlackout(black);
    // 화면: 맞은 순간 흐림, 혈액 60% 미만 회색·흐림·어두움
    const blurPx = faint * 2.4 + (J.blur / Math.max(0.01, P.blur)) * 4;
    const grey = Math.min(0.95, faint * 0.9);
    const bright = 1 - 0.3 * faint;
    let f = '';
    if (blurPx > 0.05 || grey > 0.01) f = `grayscale(${grey.toFixed(2)}) blur(${blurPx.toFixed(1)}px) brightness(${bright.toFixed(2)})`;
    if (f !== J.filter) { J.filter = f; this.renderer.domElement.style.filter = f; }
    // 터널 시야 (다치면 좁아지고 피를 잃을수록 더), 먹먹함 (이명 순간 + 60% 미만 멀어짐)
    out.tunnel = inj.dead ? 0 : (inj.hasWounds ? 0.22 + 0.55 * loss : 0);
    out.muffle = Math.max(faint * 0.65, (J.tinnitus / P.tinnitus) * 0.75);
    // 앓는 숨
    const B = out.body;
    B.heartRate = m.heartRate;
    B.exhausted = m.exhausted;
    B.pain = inj.dead ? 0 : (inj.hasWounds ? (inj.wounds.every((w) => w.type === 'graze') ? 0.3 : 0.65) + 0.35 * loss : 0);
    B.chest = !inj.dead && fx.cough;
    return out;
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
