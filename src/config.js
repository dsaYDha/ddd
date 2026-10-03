// =====================================================================
//  모든 조정 수치는 이 파일 한 곳에 모은다.
//  (단위: 거리 m, 시간 s, 속도 m/s, 각도 °, 무게 kg)
// =====================================================================

export const CONFIG = {
  // ------------------------------------------------------------------
  // 월드
  // ------------------------------------------------------------------
  world: {
    seed: 7741,
    size: 400,              // 400m × 400m, 원점 중심 (-200 ~ 200)
    heightRes: 1,           // 높이맵 격자 간격 (m)
    surfaceRes: 0.5,        // 지면 종류 격자 간격 (m)
    chunkSize: 32,          // 식생 청크 크기 (m)
    safetyMargin: 3,        // 자연 장애물 뒤에 숨겨둔 최후 안전 경계 (m, 가장자리에서)
    start: { x: -10, z: -50, yaw: 2.6 },  // yaw: 라디안, 0 = -Z(북) 방향
    // 1단계 테스트용 순간이동 지점 (F3 디버그 중 숫자키 1~8)
    testPoints: [
      { key: '1', name: '시작 / 다져진 흙길', x: -10, z: -50 },
      { key: '2', name: '진흙 오솔길', x: -33, z: -22 },
      { key: '3', name: '늪 가장자리', x: -46, z: 6 },
      { key: '4', name: '논둑 (주 논둑)', x: 10, z: 32 },
      { key: '5', name: '개울 여울', x: 86, z: 35 },
      { key: '6', name: '코끼리풀 군락', x: 18, z: -30 },
      { key: '7', name: '젖은 급경사 (개울 둑)', x: 0, z: 0 },   // 생성 시 실제 경사지로 재배치됨
      { key: '8', name: '대나무 숲', x: -40, z: -70 },
    ],
  },

  // ------------------------------------------------------------------
  // 지면 종류별 이동 저항
  //  speed      : 속도 배율
  //  stamina    : 스태미나 소모 배율
  //  sink       : 이동 중 빠지는 깊이 (m)
  //  sinkStill  : 가만히 서 있을 때 최대로 빠지는 깊이 (m) — mud.stillSinkTime 동안 진행
  //  accel/decel: 가속·감속 (m/s²) — 진흙에선 출발·정지·방향 전환이 둔함
  //  stepPulse  : 걸음 주기에 맞춘 속도 출렁임 (0~1) — 발을 빼는 느낌
  //  stride     : 보폭 배율 (작을수록 짧고 무거운 걸음)
  //  bob        : 머리 흔들림 배율
  //  slip       : 미끄러움 (0~1), wetSlip: 젖음도 1일 때 추가되는 미끄러움
  //  slipDeg    : 미끄러지기 시작하는 경사 (젖음도에 따라 slope.slipWetReductionDeg 만큼 낮아짐)
  //  wetSpeed   : 젖음도 1일 때 추가 속도 감소 비율, wetStamina: 추가 스태미나 소모 비율
  //  noise      : 기본 발소리 소음 반경 (m, 보통 걸음 기준)
  //  sound      : 발소리 종류 (audio/Footsteps.js)
  // ------------------------------------------------------------------
  surfaces: {
    packedDirt:   { label: '다져진 흙길',   speed: 1.0,  stamina: 1.0, sink: 0,    sinkStill: 0,    accel: 9,   decel: 11,  stepPulse: 0,    stride: 1.0,  bob: 1.0, slip: 0.15, wetSlip: 0.55, slipDeg: 30, wetSpeed: 0.06, wetStamina: 0.05, noise: 12, sound: 'dirt',    noSprint: false, noJump: false, noProne: false },
    leafLitter:   { label: '낙엽·부엽토',   speed: 0.9,  stamina: 1.1, sink: 0,    sinkStill: 0,    accel: 8,   decel: 10,  stepPulse: 0,    stride: 0.95, bob: 1.05, slip: 0.1, wetSlip: 0.45, slipDeg: 32, wetSpeed: 0.05, wetStamina: 0.05, noise: 18, sound: 'leaves',  noSprint: false, noJump: false, noProne: false },
    wetEarth:     { label: '젖은 흙',       speed: 0.8,  stamina: 1.3, sink: 0.03, sinkStill: 0.05, accel: 6,   decel: 7,   stepPulse: 0.1,  stride: 0.9,  bob: 1.15, slip: 0.75, wetSlip: 0.25, slipDeg: 25, wetSpeed: 0.12, wetStamina: 0.12, noise: 12, sound: 'wetDirt', noSprint: false, noJump: false, noProne: false },
    shallowMud:   { label: '얕은 진흙',     speed: 0.55, stamina: 1.7, sink: 0.15, sinkStill: 0.22, accel: 3.2, decel: 4,   stepPulse: 0.45, stride: 0.75, bob: 1.5, slip: 0.9,  wetSlip: 0.2,  slipDeg: 25, wetSpeed: 0.18, wetStamina: 0.18, noise: 16, sound: 'mud',     noSprint: false, noJump: true,  noProne: false },
    deepMud:      { label: '깊은 진흙·늪',  speed: 0.25, stamina: 2.8, sink: 0.32, sinkStill: 0.5,  accel: 1.4, decel: 2.2, stepPulse: 0.75, stride: 0.6,  bob: 2.2, slip: 1.0,  wetSlip: 0.1,  slipDeg: 25, wetSpeed: 0.2,  wetStamina: 0.2,  noise: 24, sound: 'deepMud', noSprint: true,  noJump: true,  noProne: true  },
    paddy:        { label: '논 (물+진흙)',  speed: 0.35, stamina: 2.2, sink: 0.25, sinkStill: 0.38, accel: 1.8, decel: 2.6, stepPulse: 0.65, stride: 0.65, bob: 1.9, slip: 1.0,  wetSlip: 0.1,  slipDeg: 25, wetSpeed: 0.12, wetStamina: 0.12, noise: 22, sound: 'paddy',   noSprint: true,  noJump: true,  noProne: false },
    shallowWater: { label: '얕은 물',       speed: 0.7,  stamina: 1.3, sink: 0,    sinkStill: 0,    accel: 3.5, decel: 4.5, stepPulse: 0.25, stride: 0.85, bob: 1.3, slip: 0.4,  wetSlip: 0.1,  slipDeg: 28, wetSpeed: 0.05, wetStamina: 0.05, noise: 22, sound: 'splash',  noSprint: false, noJump: true,  noProne: false },
    deepWater:    { label: '깊은 물 (허리)', speed: 0.3, stamina: 2.2, sink: 0,    sinkStill: 0,    accel: 1.6, decel: 2.4, stepPulse: 0.4,  stride: 0.7,  bob: 1.6, slip: 0.4,  wetSlip: 0.1,  slipDeg: 28, wetSpeed: 0.05, wetStamina: 0.05, noise: 26, sound: 'wade',    noSprint: true,  noJump: true,  noProne: true  },
    brush:        { label: '코끼리풀·덤불', speed: 0.6,  stamina: 1.3, sink: 0,    sinkStill: 0,    accel: 4.5, decel: 6,   stepPulse: 0.15, stride: 0.85, bob: 1.2, slip: 0.1,  wetSlip: 0.35, slipDeg: 32, wetSpeed: 0.05, wetStamina: 0.08, noise: 24, sound: 'brush',   noSprint: false, noJump: false, noProne: false },
  },

  // ------------------------------------------------------------------
  // 이동 (사람 공용 — 플레이어와 4단계 적 병사가 같은 규칙을 받음)
  // ------------------------------------------------------------------
  movement: {
    speed: { walk: 1.6, sprint: 4.5, quiet: 0.8, crouch: 0.9, prone: 0.35 },
    backwardMul: 0.7,         // 뒤로 걸을 때
    strafeMul: 0.85,          // 옆걸음
    radius: 0.3,              // 몸 반경 (충돌)
    stepHeight: 0.45,         // 점프 없이 올라설 수 있는 높이 (논둑 포함)
    jumpHeight: 0.4,          // 통나무를 넘는 정도
    gravity: 9.81,
    airControl: 0.15,
    maxWadeDepth: 1.25,       // 이보다 깊은 물(가슴 이상)은 진입 불가
    standStrideLength: 0.75,  // 걷기 한 걸음 길이 (m)
    sprintStrideLength: 1.35,
    crouchStrideLength: 0.55,
    proneStrideLength: 0.45,
    lowStaminaThreshold: 20,  // 이 아래로 떨어지면 다리가 무거워짐
    lowStaminaSpeedMul: 0.85,
  },

  // 장비 무게 — 2단계에서 무기 무게가 더해짐
  load: {
    baseKg: 25,
    freeKg: 8,                // 이 무게까지는 영향 없음
    speedPerKg: 0.005,        // kg당 속도 감소 비율
    staminaPerKg: 0.015,      // kg당 스태미나 소모 증가 비율
    sprintPerKg: 0.004,       // kg당 추가 달리기 속도 감소
  },

  stance: {
    eyeHeight: { stand: 1.65, crouch: 1.05, prone: 0.32 },
    bodyHeight: { stand: 1.8, crouch: 1.2, prone: 0.45 },
    // 자세 전환 시간 (s)
    transition: {
      'stand>crouch': 0.35, 'crouch>stand': 0.35,
      'crouch>prone': 0.8,  'prone>crouch': 0.8,
      'stand>prone': 1.0,   'prone>stand': 1.2,
    },
    moveMulDuringTransition: 0.3,
    // 물·진흙에 잠긴 상태에서 자세를 허용할 최소 여유 (눈높이 - 물깊이)
    waterHeadroom: 0.25,
  },

  lean: {
    offset: 0.35,      // 좌우 이동 (m)
    rollDeg: 12,       // 기울기
    speed: 7,          // 1/s
    clearance: 0.15,   // 나무·지형과 유지할 거리
    proneMul: 0.35,    // 엎드린 상태 기울이기 비율
  },

  // 진흙 특수 규칙
  mud: {
    stillSinkTime: 3.0,        // 가만히 서 있을 때 최대 깊이까지 빠지는 시간
    extractTime: 0.8,          // 빠진 상태에서 발을 빼는 지연
    extractSpeedMul: 0.06,     // 발을 빼는 동안 속도
    extractMinExcess: 0.04,    // 이보다 덜 빠졌으면 지연 없음 (m)
    sinkRecoverRate: 0.35,     // 이동 중 깊이 회복 속도 (m/s)
  },

  // 경사
  slope: {
    slowStartDeg: 15,          // 오르막 감속 시작
    maxClimbDeg: 35,           // 이 이상은 못 오름
    minUphillSpeedMul: 0.3,    // 35° 직전 속도 배율
    uphillStaminaPerDeg: 0.035,// 오르막 1°당 스태미나 소모 증가 (5° 초과분)
    downhillSpeedMul: 0.92,    // 급한 내리막(20°+)에서 조심스러운 걸음
    slipWetReductionDeg: 8,    // 젖음도 1일 때 미끄러짐 기준각 감소
    minSlipperiness: 0.35,     // 이보다 덜 미끄러우면 미끄러지지 않음
    slipAccel: 1.0,            // 미끄러짐 가속 배율 (g 기준)
    slipSprintMul: 2.0,        // 달리면 더 크게 미끄러짐
    slipDamping: 1.6,          // 미끄러지는 중 감쇠 (1/s)
    slipStopDamping: 6,        // 경사를 벗어나면 감쇠 (1/s)
    cliffDeg: 45,              // 이 이상은 지면 종류와 무관하게 미끄러져 내려옴
  },

  // 스태미나 (0~100) — 수치 바 없이 숨소리·비네트·카메라 흔들림으로만 표현
  stamina: {
    max: 100,
    drain: { sprint: 10, walk: 2, quiet: 2, crouch: 2, prone: 3 },   // 초당
    regen: { idle: 12, moving: 4, sprint: 0 },                      // 초당
    exhaustedRecoverTo: 30,    // 0이 되면 여기까지 회복될 때까지 달리기 불가
    jumpCost: 6,
    proneToStandCost: 4,
    slipStruggleDrain: 3,      // 미끄러지는 중 버티느라 추가 소모
  },

  // 심박수 — 2단계 조준 흔들림에 사용
  heart: {
    rest: 68,
    max: 185,
    riseRate: 0.22,            // 목표로 올라가는 속도 (1/s)
    fallRate: 0.05,            // 내려가는 속도 (1/s)
    effortWeight: 0.75,
    fatigueWeight: 0.4,
  },

  // ------------------------------------------------------------------
  // 카메라
  // ------------------------------------------------------------------
  camera: {
    fov: 75,
    near: 0.05,
    far: 420,
    pitchLimitDeg: 85,
    pronePitchLimitDeg: { up: 35, down: 30 },
    sensitivity: 0.0022,      // rad / px (설정 배율 1.0 기준)
    eyeHeightSmoothing: 10,   // 1/s
    bob: {
      walkVertical: 0.032, walkLateral: 0.022, walkRoll: 0.5,     // m, m, °
      sprintVertical: 0.06, sprintLateral: 0.04, sprintRoll: 1.0,
      crouchMul: 0.7, proneMul: 0.5,
      mudLurchRollDeg: 2.2,   // 진흙에서 걸음마다 몸이 기우뚱
      mudLurchPitchDeg: 1.2,
    },
    breath: {                 // 호흡 흔들림 (스태미나·심박수 연동)
      restAmplitude: 0.0015,  // rad
      exhaustedAmplitude: 0.014,
      verticalAmplitude: 0.02,// m (지쳤을 때)
    },
    landingDip: 0.08,
  },

  // ------------------------------------------------------------------
  // 소음 이벤트 — 4단계에서 적이 이걸 듣고 반응
  // ------------------------------------------------------------------
  noise: {
    gaitMul: { sprint: 1.8, walk: 1.0, quiet: 0.4, crouch: 0.6, prone: 0.35 },
    landingMul: 1.6,
    suctionRadius: 16,        // 진흙에서 발 빼는 소리
    stanceChangeRadius: { prone: 6, other: 4 },
    slideRadius: 14,
    rainReduction: 0.55,      // 폭우(강도 1)일 때 반경 감소 비율
    historySeconds: 6,
  },

  // 노출도 (0~1) — 4단계 적 시야용
  exposure: {
    stance: { stand: 1.0, crouch: 0.62, prone: 0.3 },
    coverRadius: 2.5,
    lightMin: 0.35,           // 완전 그늘에서의 빛 계수
    movingBonus: 0.12,
    elevatedBonus: 0.15,      // 논둑처럼 주변보다 높이 노출된 곳
  },

  // ------------------------------------------------------------------
  // 오브젝트 태그 (2~4단계 사용)
  //  blocksMovement: 이동 차단 여부
  //  visionBlock   : 0~1 시야 차단 (단단한 물체: 통과 시 차단 비율 / 풀·덤불 같은 체적형: 1m 통과 시 차단 비율)
  //  bulletBlock   : 'none' | 'partial' | 'full'
  // ------------------------------------------------------------------
  objects: {
    terrain:       { blocksMovement: true,  visionBlock: 1.0,  bulletBlock: 'full' },
    bigTree:       { blocksMovement: true,  visionBlock: 1.0,  bulletBlock: 'full' },
    canopy:        { blocksMovement: false, visionBlock: 0.5,  bulletBlock: 'none' },
    palm:          { blocksMovement: true,  visionBlock: 1.0,  bulletBlock: 'full' },
    banana:        { blocksMovement: true,  visionBlock: 0.6,  bulletBlock: 'none' },
    bamboo:        { blocksMovement: true,  visionBlock: 0.8,  bulletBlock: 'partial' },
    bambooDense:   { blocksMovement: true,  visionBlock: 1.0,  bulletBlock: 'partial' },
    fern:          { blocksMovement: false, visionBlock: 0.35, bulletBlock: 'none' },
    elephantGrass: { blocksMovement: false, visionBlock: 0.75, bulletBlock: 'none' },
    shrub:         { blocksMovement: false, visionBlock: 0.6,  bulletBlock: 'none' },
    sapling:       { blocksMovement: true,  visionBlock: 0.15, bulletBlock: 'none' },     // 가는 줄기
    saplingCrown:  { blocksMovement: false, visionBlock: 0.45, bulletBlock: 'none' },     // 어린 나무 잎 (높이 1.3m 이상)
    rice:          { blocksMovement: false, visionBlock: 0.05, bulletBlock: 'none' },
    log:           { blocksMovement: true,  visionBlock: 1.0,  bulletBlock: 'full' },
    rock:          { blocksMovement: true,  visionBlock: 1.0,  bulletBlock: 'full' },
    root:          { blocksMovement: true,  visionBlock: 0.9,  bulletBlock: 'full' },
    dike:          { blocksMovement: false, visionBlock: 1.0,  bulletBlock: 'full' },
    water:         { blocksMovement: false, visionBlock: 0.9,  bulletBlock: 'partial' },
  },

  // ------------------------------------------------------------------
  // 날씨·시간대
  // ------------------------------------------------------------------
  weather: {
    presets: {
      clear: { label: '맑음', rain: 0,   wetness: 0.2,  fogAdd: 0,     sunMul: 1.0,  skyGray: 0 },
      rain:  { label: '비',   rain: 0.5, wetness: 0.65, fogAdd: 0.012, sunMul: 0.3,  skyGray: 0.55 },
      storm: { label: '폭우', rain: 1.0, wetness: 1.0,  fogAdd: 0.026, sunMul: 0.1,  skyGray: 0.85 },
    },
    wettingRate: 0.04,        // 젖음도 증가 속도 (/s) — 폭우면 약 20초 후 최대
    dryingRate: 0.004,        // 마르는 속도 (/s)
    transitionRate: 0.35,     // 비 강도·안개 전환 속도 (1/s)
  },

  timeOfDay: {
    presets: {
      dawn: {
        label: '새벽 안개', sunElevation: 9, sunAzimuth: 75,
        sunColor: [1.0, 0.78, 0.55], sunIntensity: 2.2,
        skyColor: [0.62, 0.68, 0.72], groundColor: [0.2, 0.19, 0.14], hemiIntensity: 1.3,
        fogColor: [0.6, 0.64, 0.64], fogDensity: 0.02, mist: 0.015,
        skyTop: [0.42, 0.52, 0.62], skyHorizon: [0.78, 0.74, 0.68], exposure: 1.2,
        ambienceDawn: 1, ambienceDay: 0.3, ambienceDusk: 0,
      },
      noon: {
        label: '한낮', sunElevation: 68, sunAzimuth: 160,
        sunColor: [1.0, 0.96, 0.88], sunIntensity: 4.2,
        skyColor: [0.66, 0.74, 0.8], groundColor: [0.22, 0.21, 0.15], hemiIntensity: 1.6,
        fogColor: [0.66, 0.71, 0.7], fogDensity: 0.0095, mist: 0.004,
        skyTop: [0.36, 0.52, 0.72], skyHorizon: [0.76, 0.8, 0.8], exposure: 1.0,
        ambienceDawn: 0.2, ambienceDay: 1, ambienceDusk: 0,
      },
      dusk: {
        label: '해질녘', sunElevation: 7, sunAzimuth: 255,
        sunColor: [1.0, 0.56, 0.3], sunIntensity: 2.4,
        skyColor: [0.56, 0.48, 0.48], groundColor: [0.17, 0.14, 0.11], hemiIntensity: 1.05,
        fogColor: [0.5, 0.42, 0.38], fogDensity: 0.016, mist: 0.012,
        skyTop: [0.3, 0.32, 0.45], skyHorizon: [0.86, 0.56, 0.38], exposure: 1.2,
        ambienceDawn: 0, ambienceDay: 0.35, ambienceDusk: 1,
      },
    },
  },

  // ------------------------------------------------------------------
  // 그래픽 품질 (Esc 메뉴에서 변경)
  // ------------------------------------------------------------------
  graphics: {
    low: {
      label: '낮음', vegDensity: 0.45, grassDensity: 0.4, shadows: false, shadowMapSize: 1024, shadowRadius: 0,
      pixelRatio: 0.75, viewDistance: 120, nearLodDistance: 20, grassDistance: 30, fernDistance: 24, smallDistance: 50,
      lightShafts: false, rainDrops: 2500,
    },
    medium: {
      label: '중간', vegDensity: 0.7, grassDensity: 0.7, shadows: true, shadowMapSize: 1024, shadowRadius: 24,
      pixelRatio: 1.0, viewDistance: 170, nearLodDistance: 30, grassDistance: 45, fernDistance: 34, smallDistance: 75,
      lightShafts: true, rainDrops: 5000,
    },
    high: {
      label: '높음', vegDensity: 1.0, grassDensity: 1.0, shadows: true, shadowMapSize: 2048, shadowRadius: 40,
      pixelRatio: 1.5, viewDistance: 230, nearLodDistance: 42, grassDistance: 62, fernDistance: 46, smallDistance: 100,
      lightShafts: true, rainDrops: 9000,
    },
  },

  // ------------------------------------------------------------------
  // 사운드
  // ------------------------------------------------------------------
  audio: {
    master: 0.8,
    footsteps: 0.9,
    ambience: 0.55,
    weather: 0.75,
    breathing: 0.7,
    breathAudibleFrom: 0.2,   // 호흡 강도가 이 이상이면 들림
  },

  // 조작 키 (KeyboardEvent.code). Ctrl은 브라우저 단축키와 충돌하므로 쓰지 않는다.
  controls: {
    forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
    sprint: ['ShiftLeft', 'ShiftRight'], quiet: 'KeyX', crouch: 'KeyC', prone: 'KeyZ',
    leanLeft: 'KeyQ', leanRight: 'KeyE', jump: 'Space',
    debug: 'F3', incapacitate: 'F6',
  },

  // 사용자 설정 기본값 (Esc 메뉴, localStorage 저장)
  defaults: {
    sensitivity: 1.0,
    fov: 75,
    quality: 'medium',
    timeOfDay: 'dawn',
    weather: 'clear',
    volume: 0.8,
  },
};

export const SURFACE_KEYS = Object.keys(CONFIG.surfaces);
