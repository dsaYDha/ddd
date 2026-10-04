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
//  5단계: 화면 흐름 (Screens: 타이틀 → 임무 선택 → 브리핑 → 플레이 → 결과, Esc 계속/설정/조작법/임무 포기), 임무 진행
//  (mission/MissionRuntime — 디렉터·시계·날씨·발자국·소품·결과), 정보 제한 (종이 지도 M · 손목 나침반/시계 N — 꺼내고 넣는 데 1초,
//  드는 동안 사격 불가·느린 걸음), 탄약 (AmmoPouch — V 탄창 채우기, T 길게 주머니 무게), F 상호작용 (문서 3초 · 적 소총 줍기 2초),
//  무전 자막·잡음, 천둥·번개, 소리 믹스 (효과음/환경음/무전 음량, 총성 압축·환경음 낮춤, 지형 잔향). F2~F9 는 설정의 디버그 모드에서만.
//  6단계: 부비트랩 (combat/Traps — 발견·탐침 Y·해제 F·폭발 파편, render/TrapMesh), 밤 (world/Night — 빛 수준·암순응·조명탄·손전등 L,
//  render/NightFX·Atmosphere 달·별), 몸 (human/Endurance 피로·갈증·수통 U·개울 F, render/PlayerBody 내려다보는 몸·붕대),
//  총 다루기 (combat/Handling 총구 막힘·덤불 걸림), 소리 (audio/FieldAudio, 밤 환경음), F10 6단계 시험 메뉴 (디버그 모드).
//  7단계: 아군 분대 (ai/FriendSquad·Ally — 적과 같은 규칙, 분대 모드에서), J 명령 휠 (ui/OrderWheel — 좌클릭 수신호 · 우클릭 외치기,
//  수신호 팔 동작 FieldHands), 무전 지원 화력·보급 (combat/FireSupport — M 지도 연필로 지점 → 요청 메뉴, render/SupportMesh 크레이터·
//  상자·던진 탄창), F 상호작용 (아군 치료·무전기 줍기·물자 회수·보급 상자), 분대 말 자막·합성 목소리, 디버그 O/I/P.
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
import { Screens } from '../ui/Screens.js';
import { PaperMap } from '../ui/PaperMap.js';
import { WristGear } from '../ui/WristGear.js';
import { RefillView } from '../ui/RefillView.js';
import { MissionAudio } from '../audio/MissionAudio.js';
import { AmmoPouch } from '../combat/AmmoPouch.js';
import { Footprints } from '../world/Footprints.js';
import { MissionRuntime } from '../mission/MissionRuntime.js';
import { surfaceProps } from '../world/Surfaces.js';
import { smoothstep } from './math.js';
import { TrapField } from '../combat/Traps.js';
import { TrapMeshes } from '../render/TrapMesh.js';
import { Endurance } from '../human/Endurance.js';
import { DarkAdapt, ambientLight, lampLight } from '../world/Night.js';
import { NightFX } from '../render/NightFX.js';
import { PlayerBody } from '../render/PlayerBody.js';
import { FieldHands } from '../ui/FieldHands.js';
import { FieldAudio } from '../audio/FieldAudio.js';
import { muzzleBlock, snagDelay, foliageSigma } from '../combat/Handling.js';
import { FireSupport, SUPPORT_LABELS } from '../combat/FireSupport.js';
import { FriendSquad, iGa, ORDER_LABELS } from '../ai/FriendSquad.js';
import { OrderWheel } from '../ui/OrderWheel.js';
import { SupportMeshes } from '../render/SupportMesh.js';

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
// 6단계: 함정을 알아챘을 때 (숫자·표식 없이 무엇을 봤는지만)
const KNOWN_TEXT = {
  sight: {
    tripwire: '발목 높이에 가는 철선이 보인다 — 인계철선 (F 로 해제)',
    spikePit: '낙엽 더미가 부자연스럽다 — 덮어 놓은 구덩이 같다',
    mine: '흙을 새로 파서 덮은 자국 — 지뢰일지도 모른다',
  },
  probe: { mine: '탐침 끝에 단단한 것이 걸린다 — 지뢰다', spikePit: '탐침이 쑥 빠진다 — 아래가 비었다, 구덩이다' },
};
const MOON_KEYS = ['full', 'half', 'new'];
// 7단계: 분대원의 고함 (말 자막이 없는 것 — 재장전·도움) · 내 목소리 · 요청 거절 사유
const ALLY_SHOUT = { reload: '재장전!', help: '도와줘!' };
const PLAYER_VOICE = { f0: 112, formant: 0.98 };
const SUPPORT_REFUSED = {
  none: '남은 요청이 없다', day: '조명탄은 밤에만 쓴다', open: '헬기가 내릴 수 없다 — 논·강가 같은 트인 곳을 골라야 한다',
  busy: '같은 요청이 이미 진행 중이다', kind: '요청할 수 없다',
};
const SURF_SHALLOW = Object.keys(CONFIG.surfaces).indexOf('shallowWater'), SURF_DEEP = Object.keys(CONFIG.surfaces).indexOf('deepWater');
const SNAG_RNG = { chance: (p) => Math.random() < p };

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
    this.screens = new Screens(uiEl, this.settings);
    this.paused = true;
    this.started = false;
    this.mode = 'menu';          // 5단계: 'menu' (화면) | 'play' (임무 중) — 일시정지는 paused
    this.pendingDef = null;      // 브리핑 중인 임무
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
    this.screens.setProgress(0.05, '지형 생성 중…');
    await nextFrame();
    const data = this.data = generateWorld(CONFIG.world.seed, (p, msg) => this.screens.setProgress(0.05 + p * 0.5, msg));
    this.screens.setProgress(0.58, '식생·텍스처 생성 중…');
    await nextFrame();
    const antialias = !!renderer.getContext().getContextAttributes()?.antialias;
    this.world = new World(this.scene, data, { antialias, onProgress: (p, msg) => this.screens.setProgress(0.58 + p * 0.15, msg) });
    this.query = this.world.query;

    // ---- 플레이어 (사람 공용 이동 컴포넌트)
    this.noise = new NoiseEvents();
    const st = data.layout.start;
    this.motor = new HumanMotor(this.query, { x: st.x, z: st.z, yaw: st.yaw, noise: this.noise, name: 'player' });
    // 5단계: 발자국 (진흙·젖은 흙 — 플레이어·적 모두, 수색하는 적이 따라옴)
    this.footprints = new Footprints();
    this.motor.on('footstep', (e) => { if (this.mode === 'play') this.footprints.step(this.motor, e, 'player'); });
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
    // 5단계: 낱발 탄약 주머니 (무게는 장비에 더함) — V 로 탄창 채우기
    this.pouch = new AmmoPouch();
    this.motor.loadKg = CONFIG.load.baseKg + this.shooter.weapon.weightKg + this.pouch.weightKg;
    this.targetRange = new TargetRange(this.combat, this.query);
    this.suppressionTest = new SuppressionTest(this.combat, this.query, this.playerPerson, weaponData);
    this._shotPose = {
      eye: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, stance: 'stand', stanceFrom: 'stand', stanceProgress: 1, speed: 0, sprinting: false,
      heartRate: 70, stamina: 100, breathRate: 0.25, suppression: 0, suppressionEffects: null, lookDeltaYaw: 0, lookDeltaPitch: 0,
    };
    this._supFx = this.playerPerson.suppression.effects({});
    this._firedQueue = [];
    // ---- 6단계: 함정 · 피로/갈증 · 암순응 · 빛 수준
    this.traps = new TrapField({ query: this.query, combat: this.combat, noise: this.noise });
    this.endurance = new Endurance();
    this.adapt = new DarkAdapt();
    this.light = { day: 1, night: 0, nightAmb: 0, moon: 'half', ambient: 1, extra: 0, scene: 1, flare: 0, view: 1 };
    this._field = { probe: null, disarm: null, lamp: false, obstruct: 0, snag: 0, menu: { open: false, index: 0 }, pit: false, nearTrap: null, _nearT: 0 };

    // ---- 4단계: 적 AI — 길찾기 격자 (지형 비용·오솔길·은폐), 감지·판단·분대, 동물 활동도
    this.screens.setProgress(0.73, 'AI 길찾기 격자 준비 중…');
    await nextFrame();
    this.nav = new NavGrid(this.query, data.layout);
    this.enemies = new EnemyManager({ query: this.query, combat: this.combat, noise: this.noise, layout: data.layout, nav: this.nav, footprints: this.footprints });
    const inj0 = this.injuries;
    this.enemies.setTarget({
      person: this.playerPerson, motor: this.motor, injuries: inj0,
      get alive() { return !inj0.dead; },
      exposure: () => this.exposure.value,
      ambient: () => this.light.ambient,            // 6단계: 그 자리 빛 수준 (밤)
      lamp: () => this._lampForAI(),                // 6단계: 켜 둔 손전등
    });
    // 7단계: 무전 지원 화력·보급 (위험 근접 = 아군 실제 위치) · 분대원 밤 함정 발견·피로용 환경
    this.support = new FireSupport({ combat: this.combat, query: this.query, noise: this.noise, flares: this.enemies.flares, friendlies: () => this._friendlyPositions() });
    this.enemies.lightAtGround = (x, y, z) => this._lightAtGround(x, y, z);
    this.enemies.fieldEnv = { heat: 0, rain: 0, night: 0, wetness: 0 };
    this._squadUI = { radioCarried: false, mapMenu: null, ctx: null, signal: null, heli: null, heliStopAt: 0, craters: 0, treatAlly: null };
    this._spawn = { open: false, index: 0, kind: 0, size: 5, mg: true, dist: 1 };
    this._aiMs = 0;
    this._aiRays = { last: 0, perFrame: 0 };
    this._listener = { x: st.x, y: 0, z: st.z, yaw: st.yaw };
    this._vegCache = new Map();

    // ---- 대기
    this.screens.setProgress(0.75, '대기·빛 설정 중…');
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
    this.fieldAudio = new FieldAudio(this.audio);
    this.ambience.setWildlife(this.enemies.wildlife);   // 4단계: 움직이는 사람·총성 주변 동물 정적
    this.audio.listener = this._listener;

    // ---- 사격 화면·효과 — 로딩 중에 만들어 아래 셰이더 미리 컴파일에 포함 (첫 발·첫 F8 에서 끊기지 않게)
    this.screens.setProgress(0.8, '무기 준비 중…');
    await nextFrame();
    const qKey = this.settings.get('quality');
    this.weaponView = new WeaponView(renderer, { quality: qKey, weaponData });
    this.weaponView.attach(this.shooter);
    this.combatFX = new CombatFX(this.scene, { textures: this.world.textures, quality: qKey, groundHeight: (x, z) => this.query.getTerrainHeight(x, z) });
    this.combatFX.setTracers(this.combat.ballistics.projectiles);
    this.targetMeshes = new TargetMeshes(this.scene, { leafMaterial: this.world.materials.leaves, stemMaterial: this.world.materials.stem, buildShrub: PG.buildShrub });
    this.soldierMeshes = new SoldierMeshes(this.scene, { query: this.query });
    this.trapMeshes = new TrapMeshes(this.scene, this.query);
    this.playerBody = new PlayerBody(this.scene);
    this.nightFX = new NightFX(this.scene, this.camera);
    this.supportMeshes = new SupportMeshes(this.scene, this.query);
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
    // 5단계: 종이 지도 · 손목 나침반/시계 · 탄창 채우기 손 · 임무 소리 · 임무 진행
    this.paperMap = new PaperMap(this.uiEl);
    this.wristGear = new WristGear(this.uiEl);
    this.refillView = new RefillView(this.uiEl);
    this.fieldHands = new FieldHands(this.uiEl);
    this.orderWheel = new OrderWheel(this.uiEl);
    this.missionAudio = new MissionAudio(this.audio);
    this.screens.setProgress(0.84, '임무 지도 준비 중…');
    await nextFrame();
    this.runtime = new MissionRuntime(this);
    this.runtime.printMesh.setQuality(CONFIG.graphics[this.settings.get('quality')]);
    this.runtime.map();
    this.runtime.on('result', (e) => this._showResult(e.summary));
    this._wirePouch();
    this._wireField();
    this._wireSquad();
    this._hands = { busy: false, restricted: false, interact: null };

    // ---- 설정 반영
    this.applyQuality();
    this.settings.on('change', ({ key, value }) => {
      if (key === 'fov') { this.rig.baseFov = value; this.camera.fov = value; this.camera.updateProjectionMatrix(); }
      if (key === 'quality') this.applyQuality(true);
      if (key === 'timeOfDay') this.atmosphere.setTimeOfDay(value);
      if (key === 'weather') this.atmosphere.setWeather(value);
      if (key === 'volume') this.audio.setVolume(value * CONFIG.audio.master / 0.8);
      if (key === 'volEffects') this.audio.setCategoryVolume('effects', value);
      if (key === 'volAmbience') this.audio.setCategoryVolume('ambience', value);
      if (key === 'volRadio') this.audio.setCategoryVolume('radio', value);
      if (key === 'debugMode' && !value) this._debugOff();
    });

    // ---- 입력·창
    this.input.on('lockchange', (locked) => {
      if (locked) { this.input.dragLook = false; this._resume(); } else if (!this.input.dragLook) this._pause();
    });
    this.input.on('lockerror', () => this._onLockError());
    this.input.on('keydown', (e) => this._globalKey(e));
    this._wireScreens();
    window.addEventListener('resize', () => this._resize());

    // ---- 셰이더 미리 컴파일 (첫 프레임 끊김 방지)
    this.screens.setProgress(0.85, '셰이더 준비 중…');
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
    // 6단계 함정 재질 (정점색·금속 철선) — 첫 임무에서 끊기지 않게
    const warmT = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), this.trapMeshes.material);
    const warmW = new THREE.Mesh(this.trapMeshes.wireGeo, this.trapMeshes.wireMat);
    warmT.geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(warmT.geometry.attributes.position.count * 3).fill(1), 3));
    for (const w of [warmS, warmP, warmT, warmW]) {
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
    this.scene.remove(warmS); this.scene.remove(warmP); this.scene.remove(warmT); this.scene.remove(warmW);
    warmS.geometry.dispose(); warmT.geometry.dispose();
    this.screens.setProgress(1, '준비 완료');
    this.screens.show('title');
    this.screens.sync({ debug: this.debug.visible });

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
    this.runtime?.printMesh.setQuality(q);
    if (runtime && shadowsChanged) this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    this.world.update(this.camera, true);
  }

  /** 사용자 클릭 안에서 (작전 시작·계속): 소리 시작 + 마우스 잠금 → 잠기면 _resume */
  play() {
    this.audio.init();
    this.audio.setVolume(this.settings.get('volume') * CONFIG.audio.master / 0.8);
    this.audio.setCategoryVolume('effects', this.settings.get('volEffects'));
    this.audio.setCategoryVolume('ambience', this.settings.get('volAmbience'));
    this.audio.setCategoryVolume('radio', this.settings.get('volRadio'));
    this.ambience.start();
    if (this.input.dragLook) { this._resume(); return; }
    this.input.requestLock();
    // 잠금이 한 번도 된 적 없는데 응답이 없으면 끌어서 보기로 전환
    clearTimeout(this._lockTimer);
    this._lockTimer = setTimeout(() => { if (!this.input.locked && !this._lockWorked && this.paused) this._startDragLook(); }, 700);
  }

  _onLockError() {
    // 처음부터 잠금이 안 되는 환경 → 끌어서 보기. 잠금이 되던 환경이면(Esc 직후 재시도 제한) 다시 클릭 안내
    if (this._lockWorked) this.screens.lockFailed();
    else this._startDragLook();
  }

  _startDragLook() {
    clearTimeout(this._lockTimer);
    this.input.dragLook = true;
    this._resume();
    this.hud.toast('마우스를 누른 채 끌어서 시점 이동 · 우클릭 조준 · K 사격 · Esc 메뉴', 4);
  }

  _resume() {
    if (this.input.locked) this._lockWorked = true;
    if (this.mode !== 'play') return;      // 화면(타이틀·결과)에서는 게임을 돌리지 않음
    this.paused = false;
    this.started = true;
    this.screens.hide();
    this.audio.resume();
    this.timer.update();
  }

  _pause() {
    if (this.mode !== 'play') return;
    this.paused = true;
    const R = this.runtime;
    const left = R.mission ? R.mission.objectives.filter((o) => !o.done).map((o) => o.label) : [];
    this.screens.showPause(R.def ? `${R.def.briefing.title}${left.length ? ` — 남은 목표: ${left.join(', ')}` : R.mission?.phase === 'extract' ? ' — 회수 지점으로' : ''}` : '');
    this.screens.sync({ debug: this.debug.visible });
    this.audio.suspend();
  }

  // =================================================================
  // 5단계: 화면 흐름 · 임무 시작/끝
  // =================================================================
  _wireScreens() {
    const S = this.screens;
    S.on('pick', (e) => { this._pickType = e.type; this._briefing(e.type); });
    S.on('reroll', () => this._briefing(this._pickType));
    S.on('start', () => this._startMission(this.pendingDef));
    S.on('resume', () => this.play());
    S.on('abort', () => {
      if (this.mode !== 'play') return;
      this.runtime.abort();
      if (this.runtime.ending) this.runtime.ending.done = true;
      this._showResult(this.runtime.summary());
    });
    S.on('checkpoint', () => this._restoreCheckpoint());
    S.on('debug', (v) => { this.debug.toggle(!!v && this.settings.get('debugMode')); this._syncHitLog(); });
  }

  /** 임무 선택 → 새 시드로 임무를 만들고 브리핑 (지도 미리보기) */
  _briefing(type) {
    const seed = (Math.random() * 1e9) >>> 0;
    let def;
    const opts = { mode: this.settings.get('squadMode') ? 'squad' : 'solo' };   // 7단계: 분대 모드 (기본) / 단독 모드
    try { def = this.runtime.generate(type, seed, opts); } catch (err) { console.error(err); def = this.runtime.generate(type, seed + 1, opts); }
    this.pendingDef = def;
    this.paperMap.draw(this.runtime.map(), def.marks, def.briefing.title);
    this.screens.showBriefing(def, (canvas) => this.paperMap.drawTo(canvas));
  }

  _startMission(def) {
    if (!def) return;
    this.mode = 'play';
    this.runtime.start(def, { checkpoint: this.settings.get('checkpoint') });
    this.pendingDef = null;
    this.play();
  }

  _restoreCheckpoint() {
    this.mode = 'play';
    if (!this.runtime.restoreCheckpoint()) { this.mode = 'menu'; return; }
    this.play();
  }

  /** 결과 화면 (임무 성공·실패) — 마우스 잠금을 풀고 화면으로 */
  _showResult(summary) {
    this.runtime.stop();
    this.mode = 'menu';
    this.paused = true;
    this.input.exitLock();
    this.input.dragLook = false;
    this.hud.setDeath(null);
    this.hud.setBlackout(0);
    this.hud.clearRadio();
    this.paperMap.hideNow(); this.wristGear.hideNow(); this.refillView.hideNow(); this.orderWheel.hideNow();
    this.weaponAudio.setMuffle(0);
    this.audio.setMuffle?.(0);
    const R = this.runtime;
    this.screens.showResult(summary, { label: R.def?.briefing.title, checkpoint: !!R.checkpoint && !R.checkpointUsed && !summary.success });
  }

  /** 임무 시작 (또는 체크포인트): 플레이어를 x,z 에 — 부상·무기·탄·발자국·적·효과 초기화 */
  resetForMission(x, z, yaw) {
    const m = this.motor;
    this.targetRange.clear();
    if (this.suppressionTest.active) this.suppressionTest.stop('restart');
    this.enemies.clear();
    this.enemies.wildlife.reset();
    this.soldierMeshes.clear();
    this.aiDebug.clear();
    this.combat.reset();
    this.combatFX.clear();
    this.footprints.clear();
    this._resetInjuries();
    for (const k of [...m.restrictions.keys()]) m.clearRestriction(k);
    m.stance = m.stanceFrom = 'stand';
    m.stanceProgress = 1;
    m.eyeHeight = CONFIG.stance.eyeHeight.stand;
    m.stamina = CONFIG.stamina.max;
    m.exhausted = false;
    m.heartRate = CONFIG.heart.rest;
    m.stress = 0;
    this.controller.quiet = false;
    // 내 소총 (탄창 6개 가득) + 낱발 90
    const sh = this.shooter;
    if (sh.weapon.data !== CONFIG.weapons.rifle762) { sh.setWeapon(CONFIG.weapons.rifle762); this.weaponView.attach(sh); }
    sh.weapon.reset();
    sh.aim.reset();
    this.pouch.reset(CONFIG.ammo.loose);
    this.playerPerson.suppression.reset();
    this._hands = { busy: false, restricted: false, interact: null };
    this.paperMap.hideNow(); this.wristGear.hideNow(); this.refillView.hideNow();
    this.hud.clearRadio();
    this.hud.setBlackout(0);
    // 6단계: 함정·몸·밤 상태
    this.traps.clear();
    this.trapMeshes.clear();
    this.endurance.reset();
    this.adapt.reset();
    const F = this._field;
    F.probe = null; F.disarm = null; F.lamp = false; F.obstruct = 0; F.obGround = 0; F.snag = 0; F.pit = false;
    this.rig.pitDepth = 0;
    this.controller.aimDelay = 0; this.controller.blockFire = false;
    this.fieldHands.hideNow();
    this.fieldAudio.stopAll();
    this.nightFX.clear();
    this.atmosphere.setFlare(null);
    this.hud.thirstPulse = 0;
    // 7단계: 지원 화력 그림·명령 휠·무전기
    this.supportMeshes.clear();
    this.orderWheel.hideNow();
    const Q = this._squadUI;
    Q.radioCarried = false; Q.mapMenu = null; Q.ctx = null; Q.signal = null; Q.craters = 0; Q.treatAlly = null;
    if (Q.heli && this.missionAudio.heli === Q.heli) this.missionAudio.heliStop(0.5);
    Q.heli = null;
    this.controller.wheelOpen = false;
    this.teleport(x, z, yaw);
  }

  /** 체크포인트용 플레이어 상태 */
  snapshotPlayer() {
    const m = this.motor, sh = this.shooter;
    return {
      x: m.position.x, z: m.position.z, yaw: this.controller.yaw, stance: m.stance, stamina: m.stamina,
      weaponKey: Object.keys(CONFIG.weapons).find((k) => CONFIG.weapons[k] === sh.weapon.data), weapon: sh.weapon.snapshot(),
      loose: this.pouch.loose, looseInitial: this.pouch.initial, loaded: this.pouch.loaded, injuries: this.injuries.snapshot(),
      endurance: this.endurance.snapshot(), radio: this._squadUI.radioCarried,
    };
  }

  restorePlayer(P) {
    const sh = this.shooter;
    const data = CONFIG.weapons[P.weaponKey] ?? CONFIG.weapons.rifle762;
    sh.setWeapon(data, P.weapon);
    this.weaponView.attach(sh);
    this.pouch.reset(P.looseInitial);
    this.pouch.loose = P.loose; this.pouch.loaded = P.loaded;
    this.injuries.restore(P.injuries);
    this.injuries.apply(this.motor, sh);
    if (P.stance !== 'stand') this.motor.forceStance(P.stance, 0.1);
    this.motor.stamina = P.stamina;
    if (P.endurance) this.endurance.restore(P.endurance);
    this._squadUI.radioCarried = !!P.radio;
  }

  /** 7단계: 체크포인트 뒤 분대가 다시 생겼을 때 (MissionRuntime.start) — 무전기를 메고 있었으면 무전병 손에는 없음 */
  onSquadSpawned() {
    if (this._squadUI.radioCarried) for (const a of this.enemies.friends) a.hasRadio = false;
  }

  /** 7단계: 오인 사격 (MissionRuntime 이 집계 — 화면에는 알리지 않음, 분대원이 외침) */
  onFriendlyFire() { /* 결과 화면에서만 */ }

  /** 디버그 모드를 끄면 디버그 화면·메뉴를 닫음 */
  _debugOff() {
    if (this.debug.visible) this.debug.toggle(false);
    if (this.aiDebug.visible) this.aiDebug.toggle(false);
    this._spawn.open = false; this._showSpawnMenu();
    this._inj.hitTest = false; this.hud.setHitTest(null);
    this._field.menu.open = false; this.hud.setFieldMenu(null);
    this.trapMeshes.showAll = false;
    this._syncHitLog();
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
    this.rig.eyeVel = 0;
    this.rig.update(0, this.controller.yaw, this.controller.pitch);   // 카메라를 먼저 옮긴 뒤 주변 식생을 한 번에 갱신
    this.world.update(this.camera, true);
  }

  _globalKey(e) {
    const K = CONFIG.controls;
    if (this.mode !== 'play') return;          // 화면(타이틀·브리핑·결과)에서는 게임 키 없음
    if (e.code === 'Escape' && this.input.dragLook && !this.paused) { this._pause(); return; }
    const J = this._inj;
    // 사망 화면: Enter 로 결과 (임무 실패)
    if (this.injuries.dead) {
      if (!this.paused && e.code === K.restart && J.deathShown) this.runtime.resultAfterDeath();
      return;
    }
    if (!this.paused && e.code === K.pickup) this._startInteract();
    if (!this.paused && e.code === K.flashlight) this._toggleLamp();
    if (!this.paused && (e.code === K.bandage || e.code === K.tourniquet)) {
      this.injuries.startAid(e.code === K.bandage ? 'bandage' : 'tourniquet');
    }
    // 5단계: F2~F9 디버그·테스트 키는 설정의 '디버그 모드' 를 켰을 때만
    if (!this.settings.get('debugMode')) return;
    if (e.code === K.debug) { this.debug.toggle(); this._syncHitLog(); }
    // 4단계: F2 AI 디버그, F4 적 생성 메뉴 (열려 있는 동안 ↑↓·←→·Enter)
    if (!this.paused && e.code === K.aiDebug) {
      this.hud.toast(this.aiDebug.toggle() ? 'AI 디버그 켜짐 (F2)' : 'AI 디버그 꺼짐', 1.2);
      return;
    }
    if (!this.paused && e.code === K.spawnMenu) {
      this._spawn.open = !this._spawn.open;
      if (this._spawn.open && J.hitTest) { J.hitTest = false; this.hud.setHitTest(null); }
      if (this._spawn.open && this._field.menu.open) { this._field.menu.open = false; this._showFieldMenu(); }
      this._showSpawnMenu();
      return;
    }
    if (this._spawn.open && !this.paused && this._spawnKey(e.code)) return;
    // 6단계: F10 시험 메뉴 (함정 위치·시각·달·피로·갈증·조명탄)
    if (!this.paused && e.code === K.fieldDebug) {
      const M = this._field.menu;
      M.open = !M.open;
      if (M.open) {
        if (this._spawn.open) { this._spawn.open = false; this._showSpawnMenu(); }
        if (J.hitTest) { J.hitTest = false; this.hud.setHitTest(null); }
      }
      this._showFieldMenu();
      return;
    }
    if (this._field.menu.open && !this.paused && this._fieldKey(e.code)) return;
    // F9 피격 테스트 메뉴 (열려 있는 동안 ↑↓·Enter)
    if (!this.paused && e.code === K.hitTest) {
      J.hitTest = !J.hitTest;
      if (J.hitTest && this._spawn.open) { this._spawn.open = false; this._showSpawnMenu(); }
      if (J.hitTest && this._field.menu.open) { this._field.menu.open = false; this._showFieldMenu(); }
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
    // 7단계 디버그: O 분대 다시 생성 · I 지원 화력·보급 횟수 초기화 · P 탄창·낱발 처음 상태로
    if (!this.paused && e.code === K.allyRespawn) { this._debugRespawnSquad(); return; }
    if (!this.paused && e.code === K.supportReset) {
      this.support.resetCounts();
      this.hud.toast(`지원 횟수 초기화 — 박격포 ${this.support.left.mortar} · 포병 ${this.support.left.artillery} · 조명탄 ${this.support.left.illum} · 보급 ${this.support.left.resupply}`, 2.2);
      return;
    }
    if (!this.paused && e.code === K.ammoRefill) {
      this.shooter.weapon.reset();
      this.pouch.reset(CONFIG.ammo.loose);
      this.hud.toast(`탄약 처음 상태로 — 탄창 ${this.shooter.weapon.mags.length}개 가득 · 낱발 ${this.pouch.loose}발`, 2);
      return;
    }
    if (!this.paused && e.code === K.incapacitate) {
      // F6: 대퇴 부상 (왼쪽, 동맥 아님) — 1단계 '거동 불능' 시험 키를 실제 부상으로
      if (this.testHit('thighL', { forceArterial: false })) this.hud.toast('F6 — 왼 대퇴 부상 (테스트)');
    }
    if (!this.paused && e.code === K.suppressionTest) {
      if (this.suppressionTest.toggle()) this.hud.toast(`제압 테스트 — 주변으로 빗나가는 연발 (${CONFIG.testRange.suppression.duration}초)`, 2.2);
    }
    if (!this.paused && e.code === K.targets) {
      const on = this.targetRange.toggle(this.camera.position, this.controller.yaw);
      this.hud.toast(on ? `표적 ${this.targetRange.targets.length}개 배치 (F8로 제거)` : '표적 제거');
    }
    if (this.debug.visible && /^Digit[1-9]$/.test(e.code) && !this.paused && !this._squadUI.mapMenu) {
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
    this._lastDt = dt;
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
    // 5단계: 지도·나침반·탄창 채우기·줍기 → 손이 바쁨 (사격·조준 불가, 지도·나침반은 느린 걸음만) — 컨트롤러보다 먼저
    this._updateHands(dt);
    this._updateOrders(dt);
    this.controller.update(dt);
    m.update(dt);
    inj.update(dt, { speed: Math.hypot(m.velocity.x, m.velocity.z) });
    inj.apply(m, this.shooter);
    this._updatePickup(dt);
    this._updateInteract(dt);
    this._updatePouch(dt);
    this._updateField(dt);
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
    // 7단계: 지원 화력·보급 (무전 응답·날아오는 탄·헬기)
    if (this.mode === 'play') this._updateSupport(dt);
    // 5단계: 임무 (시계·날씨 → 대기 목표, 디렉터, 목표·회수·제한 시간, 발자국, 소품)
    if (this.mode === 'play') this.runtime.update(dt);
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
    this.supportMeshes.update(dt);
    this._pushPlantsBySoldiers();
    // 총구 화염 빛: 월드에 점광원을 더하지 않고 반구광을 잠깐 밝힘 (Atmosphere 가 매 프레임 값을 다시 정하므로 누적되지 않음)
    const flash = this.combatFX.flash;
    // 밤에는 총구 화염이 둘레를 훨씬 밝게 비춘다 (반구광에 더함) · 6단계 폭발 섬광
    if (flash > 0) this.atmosphere.hemi.intensity = this.atmosphere.state.hemiIntensity * (1 + 0.8 * flash) + 0.5 * flash * this.light.night;
    const boom = this.combatFX.boomFlash * (this._boomNear ?? 0);
    if (boom > 0) this.atmosphere.hemi.intensity += 3 * boom;
    this._updateFieldView(dt);

    // 소리
    const preset = CONFIG.timeOfDay.presets[this.atmosphere.tod];
    this._envTimer -= dt;
    if (this._envTimer <= 0) { this._envTimer = 1; this.nearWater = this._nearWater(); }
    // 5단계: 임무 시계의 시간대 섞기로 새벽 새·한낮 매미·해질녘 벌레 비중이 천천히 바뀜, 비 그친 뒤 잎에서 물방울
    const tw = this.runtime?.active ? this.runtime.clock.todBlend() : { dawn: preset.ambienceDawn, day: preset.ambienceDay, dusk: preset.ambienceDusk, nightAmb: preset.ambienceNight ?? 0 };
    this.ambience.update(dt, tw, this.atmosphere.rainIntensity, this.atmosphere.state.wind, this.query.getCanopyCover(m.position.x, m.position.z),
      this.nearWater, this.atmosphere.wetFactor);
    const look = this._updateInjuryLook(dt, sup);
    this.breathing.holding = this.rig.holdingBreath;
    look.body.rough = this.endurance.effects(this._endFx || (this._endFx = {})).roughBreath;
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
      this.exposure = computeExposure(m, this.query, { daylight, sunOffset: off, ambient: this.light.ambient, extra: this.light.extra });
      m.exposure = this.exposure.value;
      // 7단계: 병사(아군·적)를 표적으로 볼 때의 노출도도 같은 빛으로
      const env = this.enemies.env;
      env.daylight = daylight; env.sunOffset = off;
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
      mission: this.runtime?.active ? this.runtime : null,
      field: this.debug.visible ? {
        traps: this.traps, nearTrap: this._field.nearTrap, probe: this._field.probe ? this._field.probe.t / CONFIG.traps.probe.time : 0,
        disarm: this._field.disarm ? this._field.disarm.t / CONFIG.traps.disarm.time : 0, light: this.light, adapt: this.adapt,
        flares: this.enemies.flares.burning.length, lamp: this._field.lamp, night: this.enemies.night, endurance: this.endurance, obstruct: this._field.obstruct,
      } : null,
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
    m.loadKg = CONFIG.load.baseKg + sh.weapon.weightKg + this.pouch.weightKg + this.endurance.kg   // 탄을 쓰면 가벼워짐 (5단계: 낱발 주머니 · 6단계: 수통 물)
      + (this._squadUI.radioCarried ? CONFIG.allies.radioKg : 0);                                   // 7단계: 무전기를 멤
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
      // 5단계: 주운 적 소총이면 그 총의 소리 (더 높고 짧게) — 적도 아군 총성으로 착각할 수 있다 (EnemyManager)
      const wd = sh.weapon.data;
      wa.shot({ own: true, timeOffset: e.timeOffset, profile: wd.family === 'enemy' ? wd.sound : null });
      this.adapt.flash(CONFIG.night.adapt.ownShot * this.light.night);   // 6단계: 내 총구 화염을 보면 암순응이 깨짐
      this.audio.duck(CONFIG.audio.mix.duck, CONFIG.audio.mix.duckRelease);
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
    let fragFx = 0;
    c.on('impact', (e) => {
      // 6단계 파편: 착탄 효과는 일부만, 소리는 폭음이 덮음
      if (e.projectile?.fragment) { if ((fragFx = (fragFx + 1) % 4) === 0) fx.impact(e); return; }
      fx.impact(e);
      const a = spatial(e.point);
      wa.impact({ material: e.material, distance: a.distance, pan: a.pan, behind: a.behind, ricochet: e.ricochet, speed: e.speed, underwater: e.underwater });
    });
    c.on('partial', (e) => {
      if (e.projectile?.fragment) { if ((fragFx = (fragFx + 1) % 4) === 0) fx.partial(e); return; }
      fx.partial(e);
      const a = spatial(e.point);
      wa.impact({ material: e.material, distance: a.distance, pan: a.pan, behind: a.behind, speed: e.speedBefore, gain: 0.5 });
    });
    c.on('foliage', (e) => { if (!e.projectile?.fragment || (fragFx = (fragFx + 1) % 6) === 0) fx.foliage(e); });
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
      if (e.person !== this.playerPerson || e.projectile?.fragment) return;
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
      // 6단계: 밤에 시야 안의 가까운 적 총구 화염을 보면 암순응이 깨짐
      if (this.light.night > 0.3 && a.distance < CONFIG.night.adapt.flashRange && !a.behind) this.adapt.flash(CONFIG.night.adapt.enemyFlash * this.light.night);
      // 5단계 믹스: 가까운 총성 순간 환경음을 잠깐 낮춤 (거리에 따라)
      const MX = CONFIG.audio.mix;
      if (a.distance < MX.duckRange) this.audio.duck(MX.duck * (1 - a.distance / MX.duckRange), MX.duckRelease);
    });
    // 고함 (분대 의사소통·비명·도움 요청) — 목소리 높이는 병사마다
    em.on('shout', (e) => {
      const s = e.soldier;
      // 7단계 분대원: 말은 'say' (자막 + 말 같은 목소리), 아파서 지르는 비명만 그대로, 재장전·도움은 짧은 말로
      if (s.faction === 'friend') {
        if (e.said) return;
        if (e.kind !== 'scream') { if (ALLY_SHOUT[e.kind]) this._onSay({ soldier: s, text: ALLY_SHOUT[e.kind], kind: e.kind }); return; }
      }
      const a = spatial(e.position);
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

  // =================================================================
  // 6단계: 함정 · 밤 · 몸
  // =================================================================
  _wireField() {
    const T = this.traps, fa = this.fieldAudio, hud = this.hud;
    const sp = {};
    const spatial = (p) => WeaponAudio.spatial(this.camera.position, this.controller.yaw, p, sp);
    T.on('trip', (e) => {
      const p = e.trap.charge ?? e.trap, a = spatial({ x: p.x, y: p.y ?? 0, z: p.z });
      if (a.distance < 15) fa.trip({ distance: a.distance, pos: { x: p.x, y: p.y ?? 0, z: p.z } });
    });
    T.on('explode', (e) => {
      const p = e.point, a = spatial(p), B = CONFIG.traps.blast, d = a.distance;
      this.combatFX.explosion({ point: p });
      fa.explosion({ distance: d, pos: { x: p.x, y: p.y + 0.5, z: p.z }, pan: a.pan, behind: a.behind });
      this._boomNear = Math.max(0, 1 - d / 60);
      if (d < B.shakeRadius) {
        const k = 1 - d / B.shakeRadius;
        this.rig.addShake(5 * k);
        this.rig.dipVel -= 1.4 * k;
        this.shooter.aim.addShake(3.5 * k);
      }
      if (d < B.tinnitusRadius && !this.injuries.dead) {
        const tt = CONFIG.injury.player.tinnitus * 1.6;
        this.injuryAudio.tinnitus(tt, 1);
        this._inj.tinnitus = tt;
      }
      if (d < 70) this.adapt.flash(0.4 + 0.6 * (1 - d / 70));
      this.audio.duck(0.6, 2.5);
      if (e.victim === this.playerPerson && e.wound) this._onPlayerHit({ wound: e.wound, dir: null });
    });
    T.on('pit', (e) => {
      if (e.person !== this.playerPerson) return;
      fa.pitFall();
      this.rig.dipVel -= 2.5;
      if (e.wound) this._onPlayerHit({ wound: e.wound, dir: null });
      hud.toast('발밑이 꺼졌다 — 꼬챙이 구덩이!', 2.5);
    });
    T.on('known', (e) => {
      if (e.how === 'trigger' || e.how === 'ally') return;   // 7단계: 첨병이 찾은 함정은 '정지! 철선!' 외침으로
      const txt = (KNOWN_TEXT[e.how] ?? KNOWN_TEXT.sight)[e.trap.kind];
      if (txt) hud.toast(txt, 3.2);
      if (e.how === 'probe') fa.probeHit(e.trap.kind);
    });
    T.on('disarmed', () => { fa.snip(); hud.toast('철선을 끊었다', 2); });
    // 조명탄 (적이 쏨)
    const em = this.enemies;
    em.on('flareLaunch', (e) => {
      const p = e.soldier.motor.position, a = spatial(p);
      fa.flareLaunch({ distance: a.distance, pos: { x: p.x, y: p.y + 1.5, z: p.z } });
    });
    em.flares.on('ignite', (e) => {
      const f = e.flare, a = spatial(f);
      fa.flareIgnite(f, { distance: a.distance, pos: { x: f.x, y: f.y, z: f.z } });
    });
    // 수통
    const E = this.endurance;
    E.on('drinkStart', () => fa.canteenCap());
    E.on('drink', (e) => { fa.canteenCap(); hud.toast(e.left < 0.01 ? '마지막 물을 마셨다 — 수통이 비었다' : '물을 마셨다', 1.6); });
    E.on('drinkCancel', (e) => { if (e.reason === 'move') hud.toast('움직여서 마시기를 멈췄다', 1.4); });
    E.on('refillStart', () => hud.toast('수통에 물을 채운다…', 3));
    E.on('refill', () => hud.toast('수통 두 개를 가득 채웠다', 2));
    E.on('refillCancel', (e) => { if (e.reason === 'move') hud.toast('움직여서 채우기를 멈췄다', 1.6); });
    E.on('refused', (e) => {
      const msg = { empty: '수통이 비었다 — 개울에서 채워야 한다', water: '여기는 물을 뜰 수 없다', full: '수통이 이미 가득하다' }[e.reason];
      if (msg) hud.toast(msg, 1.8);
    });
  }

  /** 빛 수준 (낮 빛·달·트임·조명탄·적 손전등) → 노출도·적 시야·함정 발견·화면 밝기 */
  _updateLight() {
    const L = this.light, R = this.runtime, m = this.motor;
    const b = R?.active ? R.clock.todBlend() : null;
    const P = CONFIG.timeOfDay.presets[this.atmosphere.tod] ?? {};
    L.day = b ? b.light : (P.light ?? 1);
    L.night = 1 - L.day;
    L.nightAmb = b ? b.nightAmb : (P.ambienceNight ?? 0);
    L.moon = R?.active ? (R.def.moon ?? 'half') : this.atmosphere.moon;
    const p = m.position;
    const canopy = this.query.getCanopyCover(p.x, p.z);
    L.ambient = ambientLight(L.day, L.moon, canopy);
    L.flare = this.enemies.flares.lightAt(p.x, p.z, canopy);
    const lampOnMe = this.enemies.lampLightAt(p.x, p.y + 1.1, p.z);
    L.extra = Math.max(L.flare, lampOnMe);
    L.scene = Math.min(1, L.ambient + L.flare + (this._field.lamp ? 0.3 * L.night : 0));
    this.enemies.night = L.night;
    this.enemies.moon = L.moon;
    this.enemies.dayLight = L.day;
    this.noise.nightMask = L.nightAmb;
    // 7단계: 분대원 피로·갈증·첨병 함정 발견 환경 (1초에 한 번)
    const FE = this.enemies.fieldEnv;
    FE._t = (FE._t ?? 0) - (this._lastDt ?? 0.016);
    if (FE._t <= 0) { FE._t = 1; FE.heat = this._heat(); FE.rain = this.atmosphere.rainIntensity; FE.night = L.night; FE.wetness = this.atmosphere.wetFactor; }
  }

  /** 땅 한 점의 빛 (함정 발견): 그 자리 빛 수준 · 조명탄 · 내 손전등 */
  _lightAtGround(x, y, z) {
    const L = this.light;
    const canopy = this.query.getCanopyCover(x, z);
    let v = ambientLight(L.day, L.moon, canopy);
    v = Math.max(v, this.enemies.flares.lightAt(x, z, canopy));
    if (this._field.lamp && L.night > 0.2) v = Math.max(v, lampLight(this._lampObj(), x, y, z));
    return v;
  }

  /** 내 손전등 (카메라 앞 방향) — 적 AI·함정 발견용 */
  _lampObj() {
    const o = this._lamp || (this._lamp = { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: -1, range: 0, angle: 0, light: 1 });
    const FL = CONFIG.night.flashlight, cp = this.camera.position;
    const f = this._fwd || (this._fwd = new THREE.Vector3());
    this.camera.getWorldDirection(f);
    o.x = cp.x; o.y = cp.y - 0.15; o.z = cp.z;
    o.dx = f.x; o.dy = f.y; o.dz = f.z;
    o.range = FL.range; o.angle = FL.angle; o.light = FL.light;
    return o;
  }

  _lampForAI() { return this._field.lamp && !this.injuries.dead ? this._lampObj() : null; }

  _toggleLamp() {
    const F = this._field;
    F.lamp = !F.lamp;
    this.fieldAudio.click();
  }

  /** 한낮 더위 0~1 (시계·날씨) */
  _heat() {
    const R = this.runtime;
    const h = R?.active ? ((R.clock.hours % 24) + 24) % 24 : ({ dawn: 6.5, noon: 12.5, dusk: 17, predawn: 5, twilight: 19, night: 23 }[this.atmosphere.tod] ?? 12);
    const k = smoothstep(9, 12, h) * (1 - smoothstep(15.5, 18, h));
    return k * (1 - 0.7 * (this.atmosphere.state.overcast ?? 0));
  }

  /** 개울·강 물가인가 (발밑이나 바로 앞이 얕은 물 — 논·늪 제외) */
  _atStream() {
    const m = this.motor, q = this.query, p = m.position;
    const ok = (x, z) => {
      const sf = q.getSurfaceAt(x, z);
      return (sf === SURF_SHALLOW || sf === SURF_DEEP) && q.getWaterDepth(x, z) > 0.04;
    };
    if (ok(p.x, p.z)) return true;
    const fx = -Math.sin(this.controller.yaw), fz = -Math.cos(this.controller.yaw);
    return ok(p.x + fx * 0.8, p.z + fz * 0.8);
  }

  _updateField(dt) {
    const m = this.motor, inj = this.injuries, F = this._field, c = this.controller;
    this._updateLight();
    if (this.mode !== 'play') return;
    // ---- 함정: 밟음·걸림·플레이어 발견 (시선·빛·걸음걸이)
    const cam = this.camera;
    const fwd = this._fwd || (this._fwd = new THREE.Vector3());
    cam.getWorldDirection(fwd);
    this.traps.update(dt, {
      observer: { motor: m, eye: cam.position, fwd, light: (x, y, z) => this._lightAtGround(x, y, z) },
      rain: this.atmosphere.rainIntensity, wetness: this.atmosphere.wetFactor,
    });
    // 구덩이에 빠져 있으면 눈이 쑥 내려갔다가 기어 나오며 올라옴
    const stuck = this.traps.stuckLeft(this.playerPerson);
    this.rig.pitDepth = stuck > 0 ? CONFIG.traps.spikePit.depth * Math.min(1, stuck / 1.2) : 0;
    // 가장 가까운 함정 (F3)
    F._nearT -= dt;
    if (F._nearT <= 0 && this.debug.visible) { F._nearT = 0.5; F.nearTrap = this.traps.near(m.position.x, m.position.z, 40)[0] ?? null; }
    // ---- 몸: 피로·갈증
    const E = this.endurance;
    E.update(dt, { motor: m, heat: this._heat(), rain: this.atmosphere.rainIntensity, night: this.light.night, loadKg: m.loadKg, atWater: E.action?.kind === 'refill' ? this._atStream() : undefined });
    E.apply(m, this.shooter);
    const busyOther = this._hands.gear || this.pouch.refilling || !!this._hands.interact || !!F.probe || !!F.disarm || !!inj.aid || inj.dead || c.locked;
    // 수통 마시기 (U 누르고 있기 — 떼면 그만)
    if (c.drinkHeld && !E.busy && !busyOther && !F.drinkLatch) { F.drinkLatch = true; E.startDrink(); }
    if (!c.drinkHeld) { F.drinkLatch = false; if (E.action?.kind === 'drink') E.cancel('release'); }
    if ((inj.dead || c.locked) && E.busy) E.cancel('hit');
    if (E.action?.kind === 'drink') this.fieldAudio.drinkTick(dt);
    if (E.action?.kind === 'refill') {
      this.fieldAudio.refillTick(dt);
      F._refillNoise = (F._refillNoise ?? 0) - dt;
      if (F._refillNoise <= 0) {
        F._refillNoise = 1;
        const p = m.position;
        this.noise.emitNoise({ x: p.x, y: p.y + 0.3, z: p.z }, CONFIG.endurance.canteen.refillNoise, 'water', m, { cause: 'canteen' });
      }
    }
    // ---- 탐침 (Y 누르고 있기 · 멈춰서 2초)
    const P = CONFIG.traps.probe;
    if (!c.probeHeld) F.probeLatch = false;
    if (!F.probe && c.probeHeld && !F.probeLatch && !busyOther && !E.busy && m.speed < P.moveCancel) F.probe = { t: 0 };
    if (F.probe) {
      if (!c.probeHeld || m.speed > P.moveCancel || inj.dead || c.locked) F.probe = null;
      else {
        F.probe.t += dt;
        this.fieldAudio.probeTick(dt);
        if (F.probe.t >= P.time) {
          F.probe = null;
          F.probeLatch = true;
          const r = this.traps.probe(m, c.yaw);
          if (!r.found.length) this.hud.toast('탐침 — 앞 1m 땅에 걸리는 것 없음', 1.6);
        }
      }
    }
    // ---- 인계철선 해제 (F 로 시작한 5초 — 움직이거나 맞으면 취소)
    const D = F.disarm;
    if (D) {
      const tr = D.trap;
      if (inj.dead || tr.state !== 'armed') F.disarm = null;
      else if (Math.hypot(m.velocity.x, m.velocity.z) > CONFIG.traps.disarm.moveCancel || inj.wounds.length !== D.hits || inj.stunned) {
        F.disarm = null;
        this.hud.toast('해제를 멈췄다', 1.4);
      } else {
        D.t += dt;
        this.fieldAudio.disarmTick(dt);
        if (D.t >= CONFIG.traps.disarm.time) {
          F.disarm = null;
          const r = this.traps.disarm(tr, this.playerPerson, { armWounded: this.runtime.armsWounded() > 0 });
          if (r.failed) this.hud.toast('딸깍 — 손이 미끄러졌다!', 1.2);
          else if (r.refused === 'arm') this.hud.toast('팔을 다쳐 철선을 해제할 수 없다', 2);
        }
      }
    }
    // ---- 총구 막힘 · 덤불 걸림
    this._updateHandling(dt);
  }

  _updateHandling(dt) {
    const F = this._field, c = this.controller, sh = this.shooter, cp = this.camera.position, H = CONFIG.handling.muzzle;
    const fwd = this._fwd;
    const ads = sh.aim.ads ?? 0, yaw = c.yaw;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    // 총열 시작: 눈 아래 (조준 중엔 바로 아래, 비조준이면 오른쪽 아래)
    const start = this._mStart || (this._mStart = { x: 0, y: 0, z: 0 });
    start.x = cp.x + rx * 0.12 * (1 - ads); start.y = cp.y - 0.07 - 0.12 * (1 - ads); start.z = cp.z + rz * 0.12 * (1 - ads);
    let k = 0, ground = F.obGround ?? 0;
    if (!this.injuries.dead && !this._hands.busy && !this.injuries.weaponDropped) {
      const mb = muzzleBlock(this.query, start, fwd);
      k = mb.k;
      if (mb.type) ground = mb.type === 'ground' ? 1 : 0;
    }
    F.obstruct += (k - F.obstruct) * Math.min(1, dt * H.speed);
    // 땅에 닿으면 (엎드려 내려다볼 때 등) 총을 당기지 않고 총구만 들어 수평에 가깝게 — 줄기·바위는 들어 올리고 당김
    F.obGround = (F.obGround ?? 0) + (ground - (F.obGround ?? 0)) * Math.min(1, dt * H.speed);
    this.weaponView.obstruct = F.obstruct;
    this.weaponView.obstructGround = F.obGround;
    c.blockFire = F.obstruct > H.blockFire;
    // 덤불: 조준을 시작하는 순간 총 높이 잎이 빽빽하면 가끔 걸림 (0.3초)
    if (this.input.pressed(CONFIG.controls.aim) && !c.blockFire && !this._hands.busy) {
      const sig = foliageSigma(this.query, start.x + fwd.x * 0.5, start.y + fwd.y * 0.5, start.z + fwd.z * 0.5);
      const d = snagDelay(sig, SNAG_RNG);
      if (d > 0) {
        c.aimDelay = d;
        F.snag = 1;
        const p = this.motor.position;
        this.noise.emitNoise({ x: p.x, y: p.y + 1, z: p.z }, 6, 'rustle', this.motor, { cause: 'snag' });
        this.footsteps.rustle({ radius: 14, surfaceKey: 'brush' });
      }
    }
    F.snag = Math.max(0, F.snag - dt * 3.5);
    this.weaponView.snag = F.snag;
  }

  /** 화면: 함정 모델·몸·조명탄 빛·암순응·밤 효과·손 동작·갈증 맥박 */
  _updateFieldView(dt) {
    const F = this._field, L = this.light, m = this.motor, cam = this.camera;
    this.trapMeshes.update(this.traps, cam);
    this.playerBody.update({ motor: m, yaw: this.controller.yaw, pitch: this.controller.pitch, wounds: this.injuries.wounds, dead: this.injuries.dead, bodyPitch: this._hitPose.bodyPitch });
    // 조명탄 → 대기 방향광 (흔들리는 그림자)
    const fl = this.enemies.flares;
    const bf = fl.brightest(m.position.x, m.position.z);
    this.atmosphere.setFlare(bf ? { x: bf.x, y: bf.y, z: bf.z, k: fl.lightAt(m.position.x, m.position.z, 0) } : null);
    // 암순응: 밝은 빛을 정면으로 보면 깨짐 (조명탄 · 이쪽을 비추는 적 손전등 · 내 손전등에 비친 가까운 잎)
    const A = CONFIG.night.adapt, fwd = this._fwd;
    let glare = 0;
    const cosLook = Math.cos(A.lookDeg * Math.PI / 180);
    for (const f of fl.burning) {
      const dx = f.x - cam.position.x, dy = f.y - cam.position.y, dz = f.z - cam.position.z, dl = Math.hypot(dx, dy, dz) || 1;
      if ((dx * fwd.x + dy * fwd.y + dz * fwd.z) / dl > cosLook) glare = Math.max(glare, A.flareLook * f.intensity);
    }
    const lamps = this._lampList || (this._lampList = []);
    lamps.length = 0;
    for (const s of this.enemies.soldiers) {
      if (!s.lampOn || !s.lamp) continue;
      const lp = s.lamp;
      const dx = lp.x - cam.position.x, dy = lp.y - cam.position.y, dz = lp.z - cam.position.z, dl = Math.hypot(dx, dy, dz) || 1;
      if (dl > 160) continue;
      const gx = lp.x + lp.dx * CONFIG.night.enemyLamp.pool * 1.1, gz = lp.z + lp.dz * CONFIG.night.enemyLamp.pool * 1.1;
      lamps.push({ x: lp.x, y: lp.y, z: lp.z, dx: lp.dx, dy: lp.dy, dz: lp.dz, ground: { x: gx, y: this.query.getSupportHeight(gx, gz), z: gz }, d: dl });
      const toward = -(dx * lp.dx + dy * lp.dy + dz * lp.dz) / dl;
      if (dl < 30 && toward > 0.85 && (dx * fwd.x + dy * fwd.y + dz * fwd.z) / dl > cosLook) glare = Math.max(glare, A.lampLook);
    }
    lamps.sort((a, b) => a.d - b.d);
    if (lamps.length > 6) lamps.length = 6;
    if (F.lamp && L.night > 0.3) glare = Math.max(glare, 0.25);
    this.adapt.update(dt, L.scene, glare);
    this.renderer.toneMappingExposure = this.atmosphere.state.exposure * (1 + (this.adapt.exposureMul - 1) * L.night);
    this.nightFX.update(dt, { night: L.nightAmb, nearWater: this.nearWater, rain: this.atmosphere.rainIntensity, flares: fl.burning, lamps, lampOn: F.lamp && !this.injuries.dead });
    // 손 그림·지도 밝기 (밤엔 어둡게 — 손전등을 켜면 보임)
    L.view = Math.min(1, Math.max(0.05, L.scene * (0.7 + 0.3 * this.adapt.level) + (F.lamp ? 0.55 : 0)));
    this.fieldHands.setLight(L.view);
    this._setViewLight(L.view);
    // 손 동작 화면
    const E = this.endurance;
    const sig = this._squadUI.signal;
    const mode = sig ? 'signal' : E.action?.kind ?? (F.probe ? 'probe' : F.disarm ? 'disarm' : null);
    const prog = sig ? sig.t / sig.dur : E.action ? E.progress : F.probe ? F.probe.t / CONFIG.traps.probe.time : F.disarm ? F.disarm.t / CONFIG.traps.disarm.time : 0;
    this.fieldHands.update(dt, mode, prog);
    // 갈증 맥박 시야
    this.hud.thirstPulse = E.effects(this._endFx || (this._endFx = {})).pulse;
    this.fieldAudio.updateFlares(fl.list, cam.position);
  }

  /** 지도·손목 시계·탄창 채우기 그림 밝기 (밤) — 바뀔 때만 */
  _setViewLight(v) {
    const k = Math.round(v * 20) / 20;
    if (k === this._viewLightK) return;
    this._viewLightK = k;
    const b = (min) => `brightness(${Math.max(min, k).toFixed(2)})`;
    this.paperMap.el.style.filter = `drop-shadow(0 8px 24px rgba(0,0,0,0.6)) ${b(0.05)}`;
    this.wristGear.el.style.filter = `drop-shadow(0 6px 18px rgba(0,0,0,0.6)) ${b(0.3)}`;   // 나침반 바늘·눈금은 야광
    this.refillView.el.style.filter = `drop-shadow(0 6px 16px rgba(0,0,0,0.55)) ${b(0.08)}`;
  }

  // ---- F10 6단계 시험 메뉴 -----------------------------------------------
  _fieldItems() {
    const R = this.runtime;
    return [
      { label: '함정 위치 표시', value: this.trapMeshes.showAll ? '켬' : '끔' },
      { label: '▷ 가장 가까운 함정 앞으로 이동' },
      { label: '▷ 가장 가까운 함정 터뜨리기 (시험)' },
      { label: '시각 (←→ 1시간)', value: R?.active ? R.clock.label : '-' },
      { label: '달', value: CONFIG.night.moon[this.light.moon]?.label ?? '-' },
      { label: '피로', value: `${Math.round(this.endurance.fatigue)}` },
      { label: '갈증', value: `${Math.round(this.endurance.thirst)}` },
      { label: '▷ 조명탄 (근처 상공)' },
      { label: '▷ 손전등 든 적 순찰 (60m)' },
      { label: '▷ 암순응 끝까지' },
    ];
  }

  _showFieldMenu() {
    this.hud.setFieldMenu(this._field.menu.open ? this._fieldItems() : null, this._field.menu.index);
  }

  _fieldKey(code) {
    const M = this._field.menu, items = this._fieldItems(), R = this.runtime, m = this.motor;
    const change = (dir) => {
      switch (M.index) {
        case 0: this.trapMeshes.showAll = !this.trapMeshes.showAll; break;
        case 3:
          if (R?.active) {
            R.clock.start += dir;
            R.clock.update(0);
            this.atmosphere.setDynamic(R.clock.todBlend(), R.weather.params, true);
            this.nightFX.setLightActive(true);
          }
          break;
        case 4: {
          const i = (MOON_KEYS.indexOf(this.light.moon) + dir + MOON_KEYS.length) % MOON_KEYS.length;
          if (R?.active) R.def.moon = MOON_KEYS[i];
          this.atmosphere.setMoon(MOON_KEYS[i]);
          if (R?.active) this.atmosphere.setDynamic(R.clock.todBlend(), R.weather.params, true);
          break;
        }
        case 5: this.endurance.fatigue = Math.max(0, Math.min(100, Math.round(this.endurance.fatigue / 25) * 25 + dir * 25)); break;
        case 6: {
          const steps = [100, 75, 50, 30, 20, 8];
          let i = steps.findIndex((v) => this.endurance.thirst >= v - 0.5);
          if (i < 0) i = steps.length - 1;
          this.endurance.thirst = steps[Math.max(0, Math.min(steps.length - 1, i - dir))];
          break;
        }
        default: return false;
      }
      return true;
    };
    if (code === 'ArrowUp' || code === 'ArrowDown') {
      M.index = (M.index + (code === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    } else if (code === 'ArrowLeft' || code === 'ArrowRight') {
      if (!change(code === 'ArrowLeft' ? -1 : 1)) return true;
    } else if (code === 'Enter') {
      const near = this.traps.list.filter((t) => t.state === 'armed').map((t) => ({ t, d: this.traps.distanceTo(t, m.position.x, m.position.z) })).sort((a, b) => a.d - b.d)[0];
      if (M.index === 1) {
        if (!near) this.hud.toast('함정 없음');
        else {
          const t = near.t, dx = m.position.x - t.x, dz = m.position.z - t.z, dl = Math.hypot(dx, dz) || 1;
          const x = t.x + dx / dl * 4.5, z = t.z + dz / dl * 4.5;
          this.teleport(x, z, Math.atan2(-(t.x - x), -(t.z - z)));
          this.hud.toast(`${{ tripwire: '인계철선', spikePit: '꼬챙이 구덩이', mine: '지뢰' }[t.kind]} 4.5m 앞`, 2);
        }
      } else if (M.index === 2) {
        if (!near) this.hud.toast('함정 없음'); else this.traps.trigger(near.t, null, 'debug');
      } else if (M.index === 7) {
        const p = m.position, a = Math.random() * Math.PI * 2;
        const f = this.enemies.flares.launch({ x: p.x + Math.cos(a) * 60, y: p.y + 1, z: p.z + Math.sin(a) * 60 }, { x: p.x, z: p.z });
        this.fieldAudio.flareLaunch({ distance: 60, pos: f.from });
        this.nightFX.setLightActive(true);
      } else if (M.index === 8) {
        const sq = this.enemies.spawnPatrol({ near: { x: m.position.x, z: m.position.z }, distance: 60, size: 4, mg: false, lamps: 2 });
        this.hud.toast(sq ? '손전등 든 순찰 4명 — 60m 밖 (밤에만 켬)' : '생성할 자리를 찾지 못함', 2);
      } else if (M.index === 9) {
        this.adapt.level = 1;
      } else change(1);
    } else return false;
    this._showFieldMenu();
    return true;
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
      else if (S.index === 5) { this.enemies.clearEnemies(); this.hud.toast('적 모두 제거 (분대는 남김)'); }
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
  // 7단계: 분대 (말·명령 휠·탄약)·무전 지원 화력·보급
  // =================================================================
  _wireSquad() {
    const em = this.enemies, S = this.support, hud = this.hud, fa = this.fieldAudio;
    const sp = {};
    const spatial = (p) => WeaponAudio.spatial(this.camera.position, this.controller.yaw, p, sp);
    em.on('say', (e) => this._onSay(e));
    // 탄창 던지기: 손에서 내 가슴까지 날아옴 (그림) → 도착하면 받음
    em.on('ammoThrow', (e) => {
      const p = e.from.motor.position;
      const cam = this.camera.position;
      this.supportMeshes.throwMag({ x: p.x, y: p.y + 1.4, z: p.z }, () => ({ x: cam.x, y: cam.y - 0.45, z: cam.z }), e.flight);
    });
    em.on('ammoArrive', (e) => this._receiveMag(e));
    // 의무병이 나를 처치
    em.on('treat', (e) => {
      if (e.patient !== em.player) return;
      if (e.phase === 'start') {
        this.injuryAudio.aidStart(e.kind);
        hud.toast(`의무병 ${e.medic.name}${iGa(e.medic.name)} ${AID_LABEL[e.kind]}를 감는다 — 움직이지 마라 (${e.duration.toFixed(1)}초)`, Math.min(4, e.duration));
      } else if (e.phase === 'done') {
        this.injuryAudio.aidEnd(e.kind);
        hud.toast(`의무병이 ${e.wound?.label ?? '상처'}에 ${AID_LABEL[e.kind]}를 감았다`, 2.2);
      }
    });
    // 지원 화력: 날아오는 소리 → 탄착 (폭발·공중 폭발·조명탄) · 적 박격포 발사음 · 헬기 · 상자
    S.on('incoming', (e) => {
      const p = e.shell.point;
      const gy = this.query.getTerrainHeight(p.x, p.z);
      const pos = { x: p.x, y: gy + 30, z: p.z };
      fa.incoming({ kind: e.shell.kind === 'artillery' ? 'artillery' : 'mortar', distance: spatial(pos).distance, pos, eta: e.eta });
    });
    S.on('impact', (e) => this._onShellImpact(e));
    S.on('enemyLaunch', (e) => {
      const p = e.from;
      const pos = { x: p.x, y: this.query.getTerrainHeight(p.x, p.z) + 1, z: p.z };
      fa.mortarLaunch({ distance: spatial(pos).distance, pos });
    });
    S.on('heli', (e) => {
      const Q = this._squadUI;
      if (e.state === 'approach' && !this.missionAudio.heli) { this.missionAudio.heliStart(38); Q.heli = this.missionAudio.heli; Q.heliStopAt = this.enemies.time + 38 + 30; }
    });
    S.on('drop', (e) => this.supportMeshes.addCrate(e.crate, 14));
    S.on('dangerClose', () => hud.toast('위험 근접 경고 — 지도(M)에서 다시 확인해야 쏜다', 3.5));
    this.supportMeshes.onLand = (crate) => {
      const pos = { x: crate.x, y: crate.y + 0.3, z: crate.z };
      fa.crateThud({ distance: spatial(pos).distance, pos });
    };
  }

  /** 분대원·내 말: 들리는 거리 안이면 자막 (이름) + 말 같은 합성 목소리 */
  _onSay(e) {
    if (e.player) {
      this.hud.chatter('나', e.text, { me: true });
      this.injuryAudio.speak(e.text, { own: true, voice: PLAYER_VOICE });
      return;
    }
    const s = e.soldier;
    if (!s) return;
    const p = s.motor.position, pos = { x: p.x, y: p.y + 1.5, z: p.z };
    const a = WeaponAudio.spatial(this.camera.position, this.controller.yaw, pos, this._saySp || (this._saySp = {}));
    const range = e.quiet ? 10 : CONFIG.ai.hearing.shoutRadius * 1.6;
    if (a.distance > range || this.injuries.dead) return;
    this.hud.chatter(s.name, e.text, { far: a.distance > 35 });
    const weak = s.alive ? Math.max(0.5, Math.min(1, s.injuries.blood / 80)) : 0.5;
    this.injuryAudio.speak(e.text, { distance: a.distance, pan: a.pan, behind: a.behind, pos, voice: this._voiceOf(s), weak, loud: e.quiet ? 'quiet' : e.kind === 'ack' ? 'call' : 'shout' });
  }

  /** 던진 탄창을 받음: 내 소총이면 탄창째, 다른 총을 들고 있으면 낱발로 */
  _receiveMag(e) {
    if (this.injuries.dead || this.mode !== 'play') return;
    const w = this.shooter.weapon;
    if (w.data === CONFIG.weapons.rifle762) { w.mags.push({ rounds: e.rounds }); this.hud.toast(`${e.from.name}에게서 탄창을 받았다`, 1.8); }
    else { this.pouch.loose += e.rounds; this.hud.toast(`탄창을 받았다 — 이 총엔 맞지 않아 낱발로 챙겼다`, 2); }
    this.fieldAudio.magCatch();
    this.runtime?.noteSupply('ammoThrown');
  }

  /** 위험 근접 판정용 아군 실제 위치 (플레이어 + 살아 있는 분대원) */
  _friendlyPositions() {
    const out = this._fpos || (this._fpos = []);
    out.length = 0;
    if (!this.injuries.dead) out.push(this.motor.position);
    for (const a of this.enemies.friends) if (a.alive) out.push(a.motor.position);
    return out;
  }

  /** 포탄 탄착: 폭발·공중 폭발 효과·소리·흔들림·이명, 크레이터 */
  _onShellImpact(e) {
    if (e.illum) return;   // 조명탄은 Flares 가 (터지는 소리는 'ignite')
    const p = e.point, kind = e.shell.kind;
    const sp = this._shellSp || (this._shellSp = {});
    const a = WeaponAudio.spatial(this.camera.position, this.controller.yaw, p, sp), d = a.distance;
    const scale = kind === 'artillery' ? 2.2 : 1.5;
    this.combatFX.explosion({ point: p, scale, air: e.airburst });
    this.fieldAudio.explosion({ distance: d, pos: { x: p.x, y: p.y + 0.5, z: p.z }, pan: a.pan, behind: a.behind, scale });
    const B = CONFIG.traps.blast;
    this._boomNear = Math.max(0, 1 - d / (60 * scale));
    const shakeR = B.shakeRadius * scale, tinR = B.tinnitusRadius * scale;
    if (d < shakeR) {
      const k = 1 - d / shakeR;
      this.rig.addShake(6 * k);
      this.rig.dipVel -= 1.6 * k;
      this.shooter.aim.addShake(4 * k);
    }
    if (d < tinR && !this.injuries.dead) {
      const tt = CONFIG.injury.player.tinnitus * 1.6 * Math.min(1.5, scale / 1.5);
      this.injuryAudio.tinnitus(tt, 1);
      this._inj.tinnitus = tt;
    }
    if (d < 70 * scale) this.adapt.flash(0.4 + 0.6 * (1 - d / (70 * scale)));
    this.audio.duck(0.65, 2.8);
    if (this.support.craters.length !== this._squadUI.craters) { this._squadUI.craters = this.support.craters.length; this.supportMeshes.syncCraters(this.support.craters); }
  }

  /** 매 프레임: 지원 화력 갱신 · 헬기 소리 끝내기 */
  _updateSupport(dt) {
    this.support.update(dt);
    const Q = this._squadUI;
    if (Q.heli && this.enemies.time > Q.heliStopAt) {
      if (this.missionAudio.heli === Q.heli) this.missionAudio.heliStop(8);
      Q.heli = null;
    }
  }

  /** 무전을 쓸 수 있나: 무전기를 멨거나, 무전병이 살아 있고 의식이 있으며 radioRange m 안 */
  _radioAvailable() {
    const sq = this.enemies.friendSquad;
    if (!this.runtime?.squadMode || !sq) return { ok: false, reason: '무전기가 없다 — 단독 임무' };
    const r = sq.radioAccess(this.motor.position, this._squadUI.radioCarried);
    if (r.ok) return r;
    const n = r.ro?.name ?? '';
    const msg = { none: '무전기가 없다', down: `무전병 ${n}${iGa(n)} 쓰러졌다 — 무전기를 가져와야 한다 (F)`, far: `무전병 ${n}${iGa(n)} 곁에 없다 — 가까이 불러야 한다` }[r.reason];
    return { ok: false, reason: msg ?? '무전을 쓸 수 없다' };
  }

  /** 지도 격자 좌표 (100m 칸 — 지도에 적힌 동향·북향 두 자리씩) */
  _gridRef(p) {
    const md = this.runtime?.map?.() ?? null;
    const size = md?.size ?? 1000, half = md?.half ?? size / 2, grid = md?.grid ?? 100;
    const n = Math.round(size / grid);
    const e = Math.max(0, Math.min(n - 1, Math.floor((p.x + half) / grid)));
    const no = Math.max(0, Math.min(n - 1, n - 1 - Math.floor((p.z + half) / grid)));
    return `${String(e).padStart(2, '0')}${String(no).padStart(2, '0')}`;
  }

  /** J 명령 휠 · 지도 연필 (지원 요청) — 컨트롤러보다 먼저 (마우스 이동량을 휠·연필이 가져감) */
  _updateOrders(dt) {
    const K = CONFIG.controls, inp = this.input, W = this.orderWheel, Q = this._squadUI;
    const sq = this.enemies.friendSquad;
    const alive = this.mode === 'play' && !this.injuries.dead && !this.controller.locked;
    if (Q.signal) { Q.signal.t += dt; if (Q.signal.t >= Q.signal.dur || !alive) Q.signal = null; }
    // 명령 휠 (분대 모드)
    const want = alive && inp.isDown(K.orders) && !this._hands.gear;
    if (want && inp.pressed(K.orders) && (!this.runtime?.squadMode || !sq)) this.hud.toast('단독 임무 — 명령을 받을 분대가 없다', 1.6);
    if (!inp.isDown(K.orders)) Q.wheelDone = false;   // 명령을 내리면 휠이 닫힘 — 다시 누르면 열림
    const held = want && !!this.runtime?.squadMode && !!sq && !Q.wheelDone;
    if (held && !W.open) { W.show(); Q.ctx = this._orderContext(); } else if (!held && W.open) W.hide();
    let took = false;
    if (W.open) {
      const d = inp.consumeMouse();
      took = true;
      if (inp.dragLook) W.move(null, { x: inp.clientX - window.innerWidth / 2, y: inp.clientY - window.innerHeight / 2 });
      else W.move({ dx: d.dx, dy: d.dy });
      const key = W.selected;
      const method = key && inp.pressed('Mouse0') ? 'signal' : key && inp.pressed('Mouse2') ? 'shout' : null;
      if (method && this._issueOrder(key, method)) { Q.wheelDone = true; W.hide(); }
      W.update(dt);
    }
    // 지도 연필 (분대 모드 — 지도를 다 펼쳤을 때): 마우스로 지점 → 좌클릭 요청 메뉴
    const mapUp = alive && this.paperMap.state === 'up' && !!this.runtime?.squadMode;
    if (mapUp) {
      this.paperMap.cursorOn();
      const d = took ? { dx: 0, dy: 0 } : inp.consumeMouse();
      if (Q.mapMenu) this._mapMenuInput(d);
      else {
        if (inp.dragLook) this.paperMap.moveCursor(null, { x: inp.clientX, y: inp.clientY });
        else this.paperMap.moveCursor(d);
        if (inp.pressed('Mouse0')) this._openMapMenu();
      }
    } else if (this.paperMap.cursor || Q.mapMenu) {
      this.paperMap.cursorOff();
      Q.mapMenu = null;
      this.paperMap.setMenu(null);
    }
    this.controller.wheelOpen = W.open || mapUp;
  }

  /** 휠을 열 때 보던 곳 (저기로 이동·제압 사격 지점, 후퇴 방향) */
  _orderContext() {
    const cam = this.camera.position;
    const f = this._fwd || (this._fwd = new THREE.Vector3());
    this.camera.getWorldDirection(f);
    const r = this.query.raycastWorld({ x: cam.x, y: cam.y, z: cam.z }, { x: f.x, y: f.y, z: f.z }, 200, 'bullet');
    let point;
    if (r.hit && r.distance > 1.5) point = { x: cam.x + f.x * r.distance, y: cam.y + f.y * r.distance, z: cam.z + f.z * r.distance };
    else {
      const L = r.hit ? 6 : 60;
      point = { x: cam.x + f.x * L, y: 0, z: cam.z + f.z * L };
      point.y = this.query.getSupportHeight(point.x, point.z);
    }
    const hl = Math.hypot(f.x, f.z) || 1;
    return { point, dir: { x: f.x / hl, z: f.z / hl } };
  }

  /** 명령 내리기: 수신호 (손이 비어야 — 팔 동작 1.2초) / 외치기 */
  _issueOrder(key, method) {
    const sq = this.enemies.friendSquad, Q = this._squadUI;
    if (!sq) return false;
    if (method === 'signal') {
      if (this.injuries.aid || this.pouch.refilling || this.endurance.busy || this._hands.interact || this._field.probe || this._field.disarm || Q.signal) {
        this.hud.toast('손이 바쁘다 — 수신호를 할 수 없다', 1.4);
        return false;
      }
      Q.signal = { key, t: 0, dur: CONFIG.allies.signal.hold };
      this.fieldHands.signal(key);
    }
    const cam = this.camera.position, L = this.light;
    sq.issue(key, method, { ...Q.ctx, light: Math.max(L.ambient, L.flare), eye: { x: cam.x, y: cam.y + 0.15, z: cam.z } });
    if (method === 'signal') this.hud.toast(`수신호: ${ORDER_LABELS[key]}`, 1.2);
    return true;
  }

  // ---- 지도 지원 요청 메뉴 ------------------------------------------------
  _openMapMenu() {
    const r = this._radioAvailable();
    if (!r.ok) { this.hud.toast(r.reason, 2.4); return; }
    const p = this.paperMap.cursorWorld();
    if (!p) return;
    this._squadUI.mapMenu = { point: p, index: 0, acc: 0, grid: this._gridRef(p) };
  }

  _supportItems() {
    const S = this.support, L = SUPPORT_LABELS, left = S.left, items = [];
    const pc = S.pendingConfirm, pa = S.pendingAdjust;
    if (pc) items.push({ label: `위험 근접 확인 — ${L[pc.kind]} 그대로 사격하라`, act: 'confirm', mission: pc });
    if (pa) items.push({ label: `${L[pa.kind]} 수정 — 이 지점으로 효력 사격`, act: 'adjust', mission: pa });
    items.push({ label: `박격포 — 시험 사격부터 (남은 ${left.mortar})`, act: 'req', kind: 'mortar', mode: 'adjust', off: left.mortar <= 0 });
    items.push({ label: '박격포 — 바로 효력 사격', act: 'req', kind: 'mortar', mode: 'ffe', off: left.mortar <= 0 });
    items.push({ label: `포병 — 시험 사격부터 (남은 ${left.artillery})`, act: 'req', kind: 'artillery', mode: 'adjust', off: left.artillery <= 0 });
    items.push({ label: '포병 — 바로 효력 사격', act: 'req', kind: 'artillery', mode: 'ffe', off: left.artillery <= 0 });
    items.push({ label: `조명탄 3발 (밤 — 남은 ${left.illum})`, act: 'req', kind: 'illum', off: left.illum <= 0 || this.light.night < 0.35 });
    items.push({ label: `헬기 보급 (트인 곳 — 남은 ${left.resupply})`, act: 'req', kind: 'resupply', off: left.resupply <= 0 });
    if (pc) items.push({ label: '위험 근접 — 사격 취소', act: 'cancel', mission: pc });
    items.push({ label: '닫기', act: 'close' });
    return items;
  }

  /** 메뉴가 열려 있을 때: 마우스 위아래로 고르기 · 좌클릭 실행 · 우클릭 닫기 · 숫자키 바로 실행 */
  _mapMenuInput(d) {
    const inp = this.input, M = this._squadUI.mapMenu;
    const items = this._supportItems();
    if (inp.pressed('Mouse2')) { this._closeMapMenu(); return; }
    for (let k = 1; k <= Math.min(9, items.length); k++) {
      if (inp.pressed(`Digit${k}`)) { M.index = k - 1; this._doSupport(items[k - 1], M); return; }
    }
    if (inp.dragLook) {
      const els = this.paperMap.menuItems.children;
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        if (inp.clientY >= r.top && inp.clientY <= r.bottom && inp.clientX >= r.left - 20 && inp.clientX <= r.right + 20) M.index = i;
      }
    } else {
      M.acc += d.dy;
      while (M.acc > 34) { M.acc -= 34; M.index = Math.min(items.length - 1, M.index + 1); }
      while (M.acc < -34) { M.acc += 34; M.index = Math.max(0, M.index - 1); }
    }
    M.index = Math.max(0, Math.min(items.length - 1, M.index));
    if (inp.pressed('Mouse0')) { this._doSupport(items[M.index], M); return; }
    this.paperMap.setMenu(`지원 요청 — 좌표 ${M.grid} (마우스 위아래 · 좌클릭 · 우클릭 닫기 · 숫자키)`, items, M.index);
  }

  _closeMapMenu() { this._squadUI.mapMenu = null; this.paperMap.setMenu(null); }

  /** 요청 실행: 무전 (내 말 자막 + 무전 잡음) → FireSupport */
  _doSupport(item, M) {
    const S = this.support, L = SUPPORT_LABELS, p = M.point, PM = this.paperMap;
    if (!item || item.act === 'close') { this._closeMapMenu(); return; }
    if (item.off) {
      this.hud.toast(item.kind === 'illum' && S.left.illum > 0 ? SUPPORT_REFUSED.day : SUPPORT_REFUSED.none, 1.8);
      return;
    }
    const r = this._radioAvailable();
    if (!r.ok) { this.hud.toast(r.reason, 2.4); this._closeMapMenu(); return; }
    const say = (text) => { this.hud.chatter('나 (무전)', text, { me: true }); this.missionAudio.radio(Math.min(2.2, 0.8 + text.length * 0.02), 'progress'); };
    if (item.act === 'confirm') {
      if (S.confirm(item.mission)) say(`위험 근접 확인한다. ${L[item.mission.kind]} 그대로 사격하라.`);
    } else if (item.act === 'cancel') {
      S.cancel(item.mission);
      say('사격 취소. 반복한다, 사격 취소.');
    } else if (item.act === 'adjust') {
      const res = S.adjust(item.mission, p);
      if (res.ok) { PM.addMark(p.x, p.z, '수정'); say(`수정 — 좌표 ${M.grid}. 효력 사격 요청.`); }
    } else {
      const res = S.request(item.kind, p, { mode: item.mode, night: this.light.night });
      if (!res.ok) { this.hud.toast(SUPPORT_REFUSED[res.reason] ?? SUPPORT_REFUSED.kind, 2.2); return; }
      const label = { mortar: '박격포', artillery: '포병', illum: '조명', resupply: '보급' }[item.kind];
      PM.addMark(p.x, p.z, label);
      const what = item.kind === 'resupply' ? '보급 헬기 요청' : item.kind === 'illum' ? '조명탄 요청' : `${L[item.kind]} 화력 요청${item.mode === 'ffe' ? ', 바로 효력 사격' : ', 시험 사격부터'}`;
      say(`${what} — 좌표 ${M.grid}.`);
    }
    this._closeMapMenu();
  }

  /** 디버그 O: 분대 다시 생성 (임무 명단 그대로, 내 뒤에) */
  _debugRespawnSquad() {
    const R = this.runtime;
    if (!R?.active || !R.squadMode || !R.def?.squad) { this.hud.toast('분대 모드 임무에서만 — 단독 모드', 1.8); return; }
    this.enemies.clearFriends();
    FriendSquad.spawn(this.enemies, R.def.squad, { seed: R.def.seed, at: this.motor.position, yaw: this.motor.yaw });
    this._squadUI.radioCarried = false;
    this.hud.toast(`분대 다시 생성 — ${R.def.squad.map((r) => r.name).join(' · ')}`, 2.4);
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

  // =================================================================
  // 5단계: 손 (지도·나침반·탄창 채우기·줍기) · 탄약 주머니 · F 상호작용
  // =================================================================
  _updateHands(dt) {
    const K = CONFIG.controls, inp = this.input, H = this._hands, inj = this.injuries, m = this.motor;
    const can = this.mode === 'play' && !inj.dead && !this.controller.locked && !inj.aid;
    const fieldBusy = this.endurance.busy || !!this._field.probe || !!this._field.disarm;
    const mapHeld = can && inp.isDown(K.map) && !this.pouch.refilling && !H.interact && !fieldBusy;
    const compHeld = can && inp.isDown(K.compass) && !mapHeld && !this.pouch.refilling && !H.interact && !fieldBusy;
    const T = CONFIG.mission.handsRaise;
    const mapBusy = this.paperMap.update(dt, mapHeld, T);
    const heading = ((-this.controller.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const compBusy = this.wristGear.update(dt, compHeld, heading, this.runtime?.clock?.hours ?? 12, T);
    H.gear = mapBusy || compBusy;
    const F = this._field;
    H.busy = H.gear || this.pouch.refilling || !!H.interact || this.endurance.busy || !!F.probe || !!F.disarm || !!this._squadUI.signal;
    this.controller.handsBusy = H.busy;
    if (H.gear !== H.restricted) {
      H.restricted = H.gear;
      if (H.gear) m.setRestriction('hands', { maxSpeed: CONFIG.mission.handsSpeed, canSprint: false, canJump: false });
      else m.clearRestriction('hands');
    }
    // 손이 바쁘면 총은 화면 아래로 (그림 손이 대신) — 부상으로 떨어뜨렸거나 죽었으면 원래대로 안 보임
    this.weaponView.visible = !H.busy && !inj.weaponDropped && !inj.dead;
  }

  _wirePouch() {
    const p = this.pouch, wa = this.weaponAudio;
    p.on('start', () => {
      const w = this.shooter.weapon, i = w.refillIndex();
      this.refillView.start(i >= 0 ? w.mags[i].rounds : 0, w.data.magCapacity ?? 30);
    });
    p.on('round', (e) => {
      wa.mech('roundIn');
      const pos = this.motor.position;
      this.noise.emitNoise({ x: pos.x, y: pos.y + 0.6, z: pos.z }, CONFIG.ammo.noiseRadius, 'weaponMech', this.motor, { cause: 'refill' });
      this.refillView.round(e.rounds, this.shooter.weapon.data.magCapacity ?? 30);
    });
    p.on('stop', (e) => {
      const msg = { move: '움직여서 채우기를 멈췄다', stance: '자세가 바뀌어 채우기를 멈췄다', suppressed: '총알이 날아든다 — 채우기를 멈췄다', full: '탄창이 가득 찼다', empty: '낱발이 떨어졌다', hit: '채우기를 멈췄다' }[e.reason];
      if (msg) this.hud.toast(msg, 1.6);
    });
  }

  _updatePouch(dt) {
    const m = this.motor, inj = this.injuries, c = this.controller, H = this._hands;
    const held = this.mode === 'play' && c.refillHeld && !H.gear && !H.interact && !inj.dead && !c.locked && !inj.aid && !inj.weaponDropped
      && !this.endurance.busy && !this._field.probe && !this._field.disarm;
    const why = this.pouch.update(dt, this.shooter.weapon, {
      held, stance: m.stance, transitioning: m.transitioning, speed: Math.hypot(m.velocity.x, m.velocity.z),
      suppression: this.playerPerson.suppression.value, armsWounded: this.runtime ? this.runtime.armsWounded() : 0,
    });
    if (why) {
      const msg = {
        arms: '두 팔을 다쳐 탄창을 채울 수 없다', caliber: '이 총의 탄창에는 내 7.62mm 낱발이 맞지 않는다', empty: '낱발 탄약이 없다',
        stance: '앉거나 엎드려 멈춘 채로 채울 수 있다', move: '멈춰야 채울 수 있다', suppressed: '총알이 날아드는 중에는 채울 수 없다',
        full: '채울 탄창이 없다 — 모두 가득하다',
      }[why];
      if (msg) this.hud.toast(msg, 1.8);
    }
    this.refillView.update(dt, this.pouch.refilling, this.pouch.progress);
    if (c.pouchCheck && !inj.dead) this.hud.toast(`탄약 주머니: ${this.pouch.label}`, 1.6);
  }

  /**
   * F: 부상으로 떨어뜨린 내 총 → 인계철선 해제 → 개울 수통 → 7단계 (보급 상자 · 아군 치료 · 무전기 · 쓰러진 아군 물자)
   *    → 야영지 문서 (3초) → 가장 가까운 쓰러진 적의 소총 · 땅에 둔 총 (2초)
   */
  _startInteract() {
    const inj = this.injuries, H = this._hands;
    if (inj.dead || inj.stunned || inj.aid || H.interact || this._inj.pickup) return;
    if (inj.weaponDropped) { this._startPickup(); return; }
    if (this.pouch.refilling || H.gear) return;
    const m = this.motor.position, A = CONFIG.ammo, R = this.runtime;
    if (!R?.active) return;
    if (this.endurance.busy || this._field.probe || this._field.disarm) return;
    // 6단계: 알아챈 인계철선 해제 (5초, 멈춰서) — 팔을 다쳤으면 불가
    const wire = this.traps.disarmTarget(this.motor);
    if (wire) {
      if (R.armsWounded() > 0) { this.hud.toast('팔을 다쳐 철선을 해제할 수 없다', 2); return; }
      this._field.disarm = { trap: wire, t: 0, hits: inj.wounds.length };
      this.hud.toast('숨을 죽이고 철선을 끊는다…', CONFIG.traps.disarm.time);
      return;
    }
    // 알아챈 철선이 조금 멀면 (손이 닿지 않음) 알려 줌 — 아무 반응 없이 넘어가지 않게
    const farWire = this.traps.list.find((t) => t.kind === 'tripwire' && t.state === 'armed' && t.known
      && this.traps.distanceTo(t, m.x, m.z) < CONFIG.traps.disarm.range + 2);
    if (farWire) { this.hud.toast('철선에 손이 닿을 만큼 다가가야 끊을 수 있다', 1.8); return; }
    // 6단계: 개울·강 얕은 물가에서 앉아 수통 채우기 (10초, 물소리)
    if (this._atStream()) {
      if (this.motor.stance === 'stand') { this.hud.toast('앉아야 수통을 채울 수 있다', 1.6); return; }
      this.endurance.startRefill(true);
      return;
    }
    // 7단계: 보급 상자 열기 (3초)
    const crate = this.support.crates.find((c) => !c.opened && Math.hypot(c.x - m.x, c.z - m.z) < 1.9);
    if (crate) {
      const t = CONFIG.supply.crate.openTime;
      H.interact = { kind: 'crate', crate, t: 0, dur: t, hits: inj.wounds.length };
      this.hud.toast('보급 상자를 연다…', t);
      return;
    }
    // 7단계: 아군 — 치료 (내 붕대·지혈대, 내 처치 시간) · 무전기 줍기 · 쓰러진 아군의 탄창·낱발·붕대
    if (this._startAllyInteract(m)) return;
    const docs = R.def.camp && R.props.docs?.visible ? R.def.camp.docs : null;
    if (docs && Math.hypot(docs.x - m.x, docs.z - m.z) < 1.9 && !R.mission.objectives.find((o) => o.kind === 'documents')?.done) {
      const t = CONFIG.mission.raid.docTime;
      H.interact = { kind: 'docs', t: 0, dur: t, hits: inj.wounds.length };
      this.hud.toast('서류철을 챙긴다…', t);
      return;
    }
    let best = null, bd = A.pickupRange;
    for (const s of this.enemies.soldiers) {
      if (s.alive || s.weaponTaken || !s.weaponData?.pickup || s.faction === 'friend') continue;
      const d = Math.hypot(s.motor.position.x - m.x, s.motor.position.z - m.z);
      if (d < bd) { bd = d; best = { kind: 'enemyRifle', soldier: s }; }
    }
    for (const gw of R.props.groundWeapons) {
      const d = Math.hypot(gw.x - m.x, gw.z - m.z);
      if (d < bd) { bd = d; best = { kind: 'ground', gw }; }
    }
    if (best) {
      H.interact = { ...best, t: 0, dur: A.pickupTime, hits: inj.wounds.length };
      this.hud.toast(best.kind === 'enemyRifle' ? '쓰러진 적의 총을 집는다…' : '총을 집는다…', A.pickupTime);
    } else {
      // 쓰러진 적이 가까이 있는데 줍지 못하는 이유 (경기관총 등)
      const near = this.enemies.soldiers.find((s) => !s.alive && !s.weaponTaken && s.faction !== 'friend' && Math.hypot(s.motor.position.x - m.x, s.motor.position.z - m.z) < A.pickupRange);
      if (near) this.hud.toast(near.weaponData?.bipod ? '경기관총은 너무 무겁다' : '탄을 빼 쓸 수는 없다 — 총째로만 주울 수 있다', 1.8);
    }
  }

  _updateInteract(dt) {
    const H = this._hands, it = H.interact;
    if (!it) return;
    const inj = this.injuries, m = this.motor;
    if (inj.dead || this.mode !== 'play') { this._endInteract(); return; }
    if (Math.hypot(m.velocity.x, m.velocity.z) > CONFIG.injury.aid.moveCancelSpeed || inj.wounds.length !== it.hits || inj.stunned) {
      this._endInteract();
      this.hud.toast('취소');
      return;
    }
    // 7단계: 아군이 멀어짐 (끌려감·업혀 감) · 치료 중 숨짐
    if (it.ally) {
      const p = it.ally.motor.position;
      if (Math.hypot(p.x - m.position.x, p.z - m.position.z) > CONFIG.allies.treatRange + 1.2 || (it.kind === 'treatAlly' && !it.ally.alive)) {
        this._endInteract();
        this.hud.toast(it.ally.alive ? '멀어져서 멈췄다' : `${it.ally.name}${iGa(it.ally.name)} 숨을 거뒀다`, 1.8);
        return;
      }
    }
    if (it.kind === 'treatAlly') this.injuryAudio.aidTick(it.aid, it.t / it.dur, dt);
    it.t += dt;
    if (it.t < it.dur) return;
    this._endInteract(true);
    const R = this.runtime;
    if (it.kind === 'treatAlly') {
      const a = it.ally, w = it.wound;
      if (a.alive && a.injuries.applyTreatment(it.aid, w)) {
        if (it.aid === 'bandage') inj.bandages--; else inj.tourniquets--;
        this.injuryAudio.aidEnd(it.aid);
        const left = it.aid === 'bandage' ? inj.bandages : inj.tourniquets;
        this.hud.toast(`${a.name}의 ${w.label ?? '상처'}에 ${AID_LABEL[it.aid]}를 감았다 (남은 ${AID_LABEL[it.aid]} ${left}개)`, 2.2);
        a.say(a.injuries.blood < 60 ? '고맙다…' : '고맙다!', 'ack', { quiet: true, force: true });
      } else this.hud.toast('처치할 상처가 없다', 1.4);
    } else if (it.kind === 'radio') {
      if (!this.enemies.friendSquad?.takeRadio(it.ally)) { this.hud.toast('무전기를 가져올 수 없다', 1.6); return; }
      this._squadUI.radioCarried = true;
      R.noteSupply('radioTaken');
      this.weaponAudio.mech('magCheck');
      this.hud.toast(`무전기를 멨다 (${CONFIG.allies.radioKg}kg — 무겁다) · 이제 어디서든 지원을 요청할 수 있다 (M)`, 3.2);
    } else if (it.kind === 'loot') {
      const got = this._allyLoot(it.ally);
      R.noteSupply('looted');
      this.weaponAudio.mech('magIn');
      const parts = [];
      if (got.mags) parts.push(`탄창 ${got.mags}개`);
      if (got.loose) parts.push(`낱발 ${got.loose}발`);
      if (got.band) parts.push(`붕대 ${got.band}개`);
      if (got.tq) parts.push(`지혈대 ${got.tq}개`);
      this.hud.toast(parts.length ? `${it.ally.name}의 ${parts.join(' · ')}를 챙겼다` : '챙길 것이 없다', 2.6);
    } else if (it.kind === 'crate') {
      this._openCrate(it.crate);
    } else if (it.kind === 'docs') {
      R.props.takeDocs();
      R.mission.docsTaken();
      this.weaponAudio.mech('magCheck');
      this.hud.toast('문서를 챙겼다', 1.6);
    } else if (it.kind === 'enemyRifle') {
      const s = it.soldier;
      if (s.weaponTaken) return;
      this._swapWeapon(s.weaponData, s.shooter.weapon.snapshot());
      s.weaponTaken = true;
      this.hud.toast('적 소총을 들었다 — 내 낱발 7.62mm 는 이 탄창에 맞지 않는다', 2.8);
    } else if (it.kind === 'ground') {
      R.props.removeGroundWeapon(it.gw);
      this._swapWeapon(it.gw.data, it.gw.state);
      this.hud.toast(`${it.gw.data.label}을 들었다`, 2);
    }
  }

  /** 상호작용 끝 (취소·완료) — 아군 치료 표시 정리 */
  _endInteract(done = false) {
    const it = this._hands.interact;
    this._hands.interact = null;
    if (!it) return;
    if (it.kind === 'treatAlly' && it.ally.beingTreated === 'player') it.ally.beingTreated = null;
    if (!done && it.kind === 'treatAlly') this.injuryAudio.aidEnd?.(it.aid);
  }

  /** 7단계 F: 가까운 분대원 — 처치할 상처가 있으면 치료, 쓰러졌으면 무전기·물자 (했으면 true) */
  _startAllyInteract(m) {
    const inj = this.injuries, H = this._hands, A = CONFIG.allies;
    let best = null, bd = A.treatRange + 0.4;
    for (const a of this.enemies.friends) {
      const p = a.motor.position;
      const d = Math.hypot(p.x - m.x, p.z - m.z);
      if (d < bd) { bd = d; best = a; }
    }
    if (!best) return false;
    const a = best, hits = inj.wounds.length;
    if (a.alive) {
      const kind = a.injuries.treatmentKind(inj.tourniquets > 0);
      if (kind) {
        if (kind === 'bandage' && inj.bandages <= 0) { this.hud.toast('붕대가 없다', 1.6); return true; }
        if (a.beingTreated && a.beingTreated !== 'player') { this.hud.toast(`의무병이 ${a.name}${iGa(a.name) === '이' ? '을' : '를'} 처치하고 있다`, 1.8); return true; }
        const w = a.injuries.treatmentTarget(kind);
        if (!w) return false;
        const dur = kind === 'bandage' ? CONFIG.injury.aid.bandageTime : CONFIG.injury.aid.tourniquetTime;
        H.interact = { kind: 'treatAlly', ally: a, aid: kind, wound: w, t: 0, dur, hits };
        a.beingTreated = 'player';
        this.injuryAudio.aidStart(kind);
        this.hud.toast(`${a.name}에게 ${AID_LABEL[kind]}를 감는다 (${dur.toFixed(1)}초) — 움직이면 취소`, Math.min(4, dur));
        return true;
      }
    }
    if (!a.alive || a.unconscious) {
      if (a.hasRadio && !this._squadUI.radioCarried) {
        H.interact = { kind: 'radio', ally: a, t: 0, dur: 2, hits };
        this.hud.toast(`${a.name}의 무전기를 벗겨 멘다…`, 2);
        return true;
      }
      if (!a.looted && this._allyLoot(a, true)) {
        H.interact = { kind: 'loot', ally: a, t: 0, dur: A.lootTime, hits };
        this.hud.toast(`${a.name}의 탄창·낱발·붕대를 챙긴다…`, A.lootTime);
        return true;
      }
    }
    return false;
  }

  /** 쓰러진 아군의 물자 (dry: 챙길 게 있나만) — 내 총과 같은 탄창은 탄창째, 아니면 (기관총 탄띠 등) 낱발로 */
  _allyLoot(a, dry = false) {
    const w = a.shooter.weapon, ai = a.injuries, mine = this.shooter.weapon;
    const fits = w.data === mine.data && !w.data.bipod;
    const got = { mags: 0, loose: 0, band: 0, tq: 0 };
    const band = (ai.bandages ?? 0) + (a.medKit?.bandages ?? 0), tq = (ai.tourniquets ?? 0) + (a.medKit?.tourniquets ?? 0);
    if (dry) return w.mags.some((x) => x.rounds > 0) || (a.loose ?? 0) > 0 || band > 0 || tq > 0;
    for (const x of w.mags) {
      if (x.rounds <= 0) continue;
      if (fits) { mine.mags.push({ rounds: x.rounds }); got.mags++; } else { this.pouch.loose += x.rounds; got.loose += x.rounds; }
      x.rounds = 0;
    }
    if (a.loose > 0) { this.pouch.loose += a.loose; got.loose += a.loose; a.loose = 0; }
    this.injuries.bandages += band; this.injuries.tourniquets += tq;
    got.band = band; got.tq = tq;
    ai.bandages = 0; ai.tourniquets = 0;
    if (a.medKit) { a.medKit.bandages = 0; a.medKit.tourniquets = 0; }
    a.looted = true;
    return got;
  }

  /** 보급 상자: 탄창·낱발·붕대·지혈대·수통 물 */
  _openCrate(crate) {
    if (crate.opened) return;
    crate.opened = true;
    this.supportMeshes.openCrate(crate);
    const U = CONFIG.supply.crate, w = this.shooter.weapon, cap = CONFIG.weapons.rifle762.magCapacity;
    let magNote = `탄창 ${U.mags}개`;
    if (w.data === CONFIG.weapons.rifle762) for (let i = 0; i < U.mags; i++) w.mags.push({ rounds: cap });
    else { this.pouch.loose += U.mags * cap; magNote = `탄창 ${U.mags}개 (이 총엔 맞지 않아 낱발로)`; }
    this.pouch.loose += U.loose;
    this.injuries.bandages += U.bandages;
    this.injuries.tourniquets += U.tourniquets;
    if (U.water) this.endurance.refillAll();
    this.runtime.noteSupply('crate');
    this.weaponAudio.mech('magIn');
    this.hud.toast(`보급: ${magNote} · 낱발 ${U.loose}발 · 붕대 ${U.bandages} · 지혈대 ${U.tourniquets}${U.water ? ' · 수통을 채웠다' : ''}`, 3.5);
  }

  /** 지금 총을 발 앞에 내려놓고 새 총을 든다 (그 총의 탄창·장전 상태가 그대로 따라옴) */
  _swapWeapon(data, state) {
    const sh = this.shooter, p = this.motor.position, yaw = this.controller.yaw;
    const old = sh.weapon;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    this.runtime.props.addGroundWeapon(old.data.model ?? 'wood', p.x + fx * 0.5 + rx * 0.35, p.z + fz * 0.5 + rz * 0.35, yaw + 0.9,
      { data: old.data, state: old.snapshot() });
    sh.setWeapon(data, state);
    this.weaponView.attach(sh);
    this.weaponAudio.mech('boltPull');
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
