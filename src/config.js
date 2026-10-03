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
    // 물방울 침식 (언덕 사면에 골을 팜)
    erosion: { drops: 45000, maxSteps: 40, inertia: 0.08, capacity: 2.6, deposit: 0.22, erode: 0.15, evaporate: 0.025, gravity: 5, radius: 2 },
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
      { key: '9', name: '울창한 숲속 (덤불)', x: -20, z: -20 },   // 생성 시 실제 덤불 지대로 재배치됨
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
  //  rustle     : 식물을 헤치고 지나갈 때 걸음마다 내는 '바스락' 소음 반경 (m, 식생 지면만)
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
    brush:        { label: '키 큰 풀·밀집 덤불', speed: 0.55, stamina: 1.4, sink: 0, sinkStill: 0,  accel: 4.2, decel: 6,   stepPulse: 0.15, stride: 0.8,  bob: 1.2, slip: 0.1,  wetSlip: 0.35, slipDeg: 32, wetSpeed: 0.05, wetStamina: 0.08, noise: 12, rustle: 24, sound: 'brush',       noSprint: false, noJump: false, noProne: false },
    // ---- 1단계 보완: 식생 지면 (키 순서가 지면 ID — 기존 0~8 유지, 9·10 추가)
    groundCover:  { label: '낮은 지피식물', speed: 0.9,  stamina: 1.1, sink: 0,    sinkStill: 0,    accel: 7.5, decel: 9.5, stepPulse: 0,    stride: 0.95, bob: 1.05, slip: 0.12, wetSlip: 0.45, slipDeg: 31, wetSpeed: 0.05, wetStamina: 0.05, noise: 10, rustle: 9, sound: 'groundCover', noSprint: false, noJump: false, noProne: false },
    shrub:        { label: '무릎~허리 덤불', speed: 0.7, stamina: 1.3, sink: 0,    sinkStill: 0,    accel: 5.5, decel: 7,   stepPulse: 0.1,  stride: 0.85, bob: 1.12, slip: 0.1, wetSlip: 0.4,  slipDeg: 32, wetSpeed: 0.05, wetStamina: 0.06, noise: 10, rustle: 16, sound: 'shrub',      noSprint: false, noJump: false, noProne: false },
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

  // 장비 무게 — 2단계부터 플레이어는 여기에 무기·탄창 무게(weapons.*)가 더해짐 (탄을 쓰면 가벼워짐)
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
    stressWeight: 0.6,         // 외부 긴장(제압 등, motor.stress 0~1)이 목표 심박에 더하는 비율
    stressRiseRate: 0.9,       // 긴장으로 올라갈 때 속도 (1/s) — 총알이 스치면 심장이 바로 뛴다
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
    rustleGaitMul: { sprint: 1.6, walk: 1.0, quiet: 0.45, crouch: 0.7, prone: 0.55 },  // 식물 헤치는 소리 배율
    rainReduction: 0.55,      // 폭우(강도 1)일 때 반경 감소 비율
    historySeconds: 6,
    // 2단계: 사격 관련 소음 (4단계 적 반응용)
    gunshot: 900,             // 총성
    impact: 30,               // 착탄
    weaponMech: 6,            // 탄창 분리·결합, 노리쇠
    dryFire: 3,               // 빈 약실·고장 '딸깍'
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
    midTree:       { blocksMovement: true,  visionBlock: 1.0,  bulletBlock: 'full' },     // 중층 나무 (9~18m)
    canopy:        { blocksMovement: false, visionBlock: 0.5,  bulletBlock: 'none' },
    epiphyte:      { blocksMovement: false, visionBlock: 0.3,  bulletBlock: 'none' },     // 줄기의 이끼·착생 양치
    liana:         { blocksMovement: false, visionBlock: 0.2,  bulletBlock: 'partial' },  // 늘어진 굵은 덩굴
    palm:          { blocksMovement: true,  visionBlock: 1.0,  bulletBlock: 'full' },
    banana:        { blocksMovement: true,  visionBlock: 0.6,  bulletBlock: 'none' },
    bananaLeaves:  { blocksMovement: false, visionBlock: 0.55, bulletBlock: 'none' },     // 바나나 잎 (높이 1.5m 이상)
    bamboo:        { blocksMovement: true,  visionBlock: 0.8,  bulletBlock: 'partial' },
    bambooDense:   { blocksMovement: true,  visionBlock: 1.0,  bulletBlock: 'partial' },
    treeFern:      { blocksMovement: true,  visionBlock: 0.25, bulletBlock: 'partial' },  // 섬유질 줄기
    treeFernCrown: { blocksMovement: false, visionBlock: 0.55, bulletBlock: 'none' },
    sapling:       { blocksMovement: true,  visionBlock: 0.15, bulletBlock: 'none' },     // 가는 줄기
    saplingCrown:  { blocksMovement: false, visionBlock: 0.45, bulletBlock: 'none' },     // 어린 나무 잎 (높이 1.2m 이상)
    vineWall:      { blocksMovement: true,  visionBlock: 0.95, bulletBlock: 'partial' },  // 얽힌 덩굴 벽 (통과 불가)
    // 체적형 (visionBlock = 1m 통과 시 차단 비율)
    groundCover:   { blocksMovement: false, visionBlock: 0.7,  bulletBlock: 'none' },     // 고사리·넓은잎 풀·이끼·덩굴 (0~0.5m)
    shrub:         { blocksMovement: false, visionBlock: 0.5,  bulletBlock: 'none' },     // 덤불 (0.5~3m)
    taro:          { blocksMovement: false, visionBlock: 0.55, bulletBlock: 'none' },     // 토란잎 식물
    rattan:        { blocksMovement: false, visionBlock: 0.6,  bulletBlock: 'none' },     // 등나무류 (가시 덤불)
    fern:          { blocksMovement: false, visionBlock: 0.35, bulletBlock: 'none' },
    elephantGrass: { blocksMovement: false, visionBlock: 0.75, bulletBlock: 'none' },
    reed:          { blocksMovement: false, visionBlock: 0.6,  bulletBlock: 'none' },     // 갈대·부들
    waterPlant:    { blocksMovement: false, visionBlock: 0.05, bulletBlock: 'none' },     // 물 위 수생식물
    rice:          { blocksMovement: false, visionBlock: 0.05, bulletBlock: 'none' },
    log:           { blocksMovement: true,  visionBlock: 1.0,  bulletBlock: 'full' },
    rock:          { blocksMovement: true,  visionBlock: 1.0,  bulletBlock: 'full' },
    root:          { blocksMovement: true,  visionBlock: 0.9,  bulletBlock: 'full' },
    buttress:      { blocksMovement: true,  visionBlock: 1.0,  bulletBlock: 'full' },     // 판근
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
        fogColor: [0.6, 0.64, 0.64], fogDensity: 0.015, mist: 0.012,
        skyTop: [0.42, 0.52, 0.62], skyHorizon: [0.78, 0.74, 0.68], exposure: 1.2,
        ambienceDawn: 1, ambienceDay: 0.3, ambienceDusk: 0,
      },
      noon: {
        label: '한낮', sunElevation: 68, sunAzimuth: 160,
        sunColor: [1.0, 0.96, 0.88], sunIntensity: 4.2,
        skyColor: [0.66, 0.74, 0.8], groundColor: [0.22, 0.21, 0.15], hemiIntensity: 1.6,
        fogColor: [0.66, 0.71, 0.7], fogDensity: 0.0085, mist: 0.004,
        skyTop: [0.36, 0.52, 0.72], skyHorizon: [0.76, 0.8, 0.8], exposure: 1.0,
        ambienceDawn: 0.2, ambienceDay: 1, ambienceDusk: 0,
      },
      dusk: {
        label: '해질녘', sunElevation: 7, sunAzimuth: 255,
        sunColor: [1.0, 0.56, 0.3], sunIntensity: 2.4,
        skyColor: [0.56, 0.48, 0.48], groundColor: [0.17, 0.14, 0.11], hemiIntensity: 1.05,
        fogColor: [0.5, 0.42, 0.38], fogDensity: 0.013, mist: 0.01,
        skyTop: [0.3, 0.32, 0.45], skyHorizon: [0.86, 0.56, 0.38], exposure: 1.2,
        ambienceDawn: 0, ambienceDay: 0.35, ambienceDusk: 1,
      },
    },
  },

  // ------------------------------------------------------------------
  // 그래픽 품질 (Esc 메뉴에서 변경)
  // ------------------------------------------------------------------
  graphics: {
    // vegDensity: 중층 식생 밀도, grassDensity: 하층(덤불·풀) 밀도
    // groundCoverRadius: 지피식물 고밀도 반경(m), groundCoverDensity: 지피식물 밀도 배율
    // treeNear/treeMid: 큰 나무 LOD 거리, shrubDistance: 덤불 그리는 거리, terrainNear: 지형 1m 격자 거리(밖은 2m), shafts: 빛기둥 수
    low: {
      label: '낮음', vegDensity: 0.75, grassDensity: 0.7, groundCoverRadius: 18, groundCoverDensity: 0.55,
      shadows: false, shadowMapSize: 1024, shadowRadius: 0, pixelRatio: 0.75,
      viewDistance: 105, treeNear: 16, treeMid: 48, nearLodDistance: 16, smallDistance: 40, shrubDistance: 34,
      grassDistance: 27, terrainNear: 40, shafts: 0, lightShafts: false, rainDrops: 2500,
    },
    medium: {
      label: '중간', vegDensity: 0.95, grassDensity: 0.92, groundCoverRadius: 32, groundCoverDensity: 0.8,
      shadows: true, shadowMapSize: 1024, shadowRadius: 24, pixelRatio: 1.0,
      viewDistance: 165, treeNear: 26, treeMid: 80, nearLodDistance: 26, smallDistance: 70, shrubDistance: 58,
      grassDistance: 45, terrainNear: 60, shafts: 28, lightShafts: true, rainDrops: 5000,
    },
    high: {
      label: '높음', vegDensity: 1.0, grassDensity: 1.0, groundCoverRadius: 42, groundCoverDensity: 1.0,
      shadows: true, shadowMapSize: 2048, shadowRadius: 40, pixelRatio: 1.5,
      viewDistance: 220, treeNear: 36, treeMid: 105, nearLodDistance: 36, smallDistance: 95, shrubDistance: 78,
      grassDistance: 62, terrainNear: 90, shafts: 56, lightShafts: true, rainDrops: 9000,
    },
  },
  performance: {
    autoQuality: true,           // 첫 실행 때 프레임이 계속 낮으면 품질을 한 단계 낮추고 알림
    autoQualityMinFps: 33,
  },

  // ------------------------------------------------------------------
  // 식생 (1단계 보완 — 울창한 정글)
  // ------------------------------------------------------------------
  vegetation: {
    // 숲 바닥 분류 비율에 영향 (0~1): 덤불 지면이 되는 하층 밀도 기준값, 밀집 덤불 기준값
    shrubThreshold: 0.5,
    thicketThreshold: 0.5,
    litterPatchThreshold: 0.36,  // 클수록 그늘진 낙엽 바닥 조각이 줄어듦
    // 정적 배치 밀도 (1m² 당 시도 수 × 확률)
    saplingSpacing: 4.4,
    midTreeSpacing: 8,           // 중층 나무 (9~18m) 배치 간격
    treeFernSpacing: 5.5,
    shrubSpacing: 1.45,
    vineWalls: 34,               // 얽힌 덩굴 벽 개수
    lianaChance: 0.4,            // 이웃한 큰 나무 사이 굵은 덩굴 확률
    // 은폐(시야 레이·노출도) 높이 구간 (지면 위 m) — 구간마다 1m 통과 시 소광계수(σ)를 저장
    coverBands: [0, 0.5, 1.2, 2.0, 3.2],
    // 숲 바닥 종류별 기본 σ (구간 순서대로). 개별 덤불·풀·갈대는 이 위에 더해진다.
    coverProfiles: {
      litter:  [0.25, 0, 0, 0],
      cover:   [1.2, 0.08, 0, 0],
      bank:    [1.0, 0.3, 0.02, 0],
      shrub:   [1.3, 0.35, 0.03, 0],
      thicket: [1.5, 0.8, 0.25, 0.1],
      grass:   [1.4, 0.8, 0.3, 0.05],
      reed:    [0.9, 0.6, 0.3, 0.05],
    },
    // 동적 지피층 (플레이어 주변만 고밀도로 렌더링, 시드 기반이라 같은 자리엔 항상 같은 풀)
    groundCover: {
      cellSize: 4,
      fadeStart: 0.62,           // 반경의 이 비율부터 밀도·크기가 줄어듦
      farDensity: 0.25,          // 반경 끝에서 남는 밀도
      // 종류별 1m² 당 개수 (밀도 배율 1 기준)
      species: {
        creeper: 0.85,           // 바닥을 기는 덩굴 (납작)
        moss: 0.35,              // 이끼 덩어리 (낙엽 바닥·밑동)
        herb: 0.75,              // 넓은잎 풀
        fern: 0.45,              // 작은 고사리
        grassTuft: 0.5,          // 풀 포기
        seedling: 0.22,          // 어린 묘목
        bankGrass: 1.4,          // 개울가 물풀
      },
    },
  },

  // 바람·식물 밀림
  wind: {
    direction: [0.8, 0.45],      // 바람 방향 (x, z)
    gustSpeed: 0.31,
    flutter: 0.035,              // 잎 떨림 (m)
  },
  interaction: {
    pushRadius: 1.0,             // 플레이어가 지나가면 식물이 밀려나는 반경 (m)
    pushStrength: 0.55,          // 최대 밀림 (m)
  },

  // 빛·분위기
  lighting: {
    sunfleckTile: 9,             // 햇빛 얼룩 무늬 한 장의 크기 (m) — 작을수록 얼룩이 잘아짐
    sunfleckStrength: 0.95,      // 캐노피가 햇빛을 가리는 세기 (1 = 얼룩 사이는 완전히 그늘)
    canopyTint: [0.8, 1.0, 0.68],// 잎을 통과한 환경광 (녹색)
    floorAO: 0.62,               // 줄기 밑동·덤불 아래 어두워짐 세기
    translucency: 0.55,          // 역광에서 잎이 비치는 세기
    grading: { saturation: 0.9, contrast: 1.07 },
    vignette: 0.22,
  },
  fog: {
    mistBase: 7.0,               // 저지대 안개가 짙어지는 기준 높이 (m)
    mistFalloff: 4.5,            // 위로 갈수록 옅어지는 정도 (m)
    underCanopyDim: 0.75,        // 숲속에서 안개가 어둡고 녹회색이 되는 정도 (0~1)
    sunScatter: 0.55,            // 해 쪽을 볼 때 안개가 밝아지는 정도
  },

  // ==================================================================
  //  2단계: 무기·조준·탄도·제압
  // ==================================================================
  // 무기 데이터 — 무기를 추가하려면 같은 형식의 항목을 하나 더 만들고 default 를 바꾸면 된다.
  weapons: {
    default: 'rifle762',
    rifle762: {
      label: '7.62mm 돌격소총',
      weightKg: 3.9,              // 총 무게 (탄창 제외)
      magCapacity: 30,
      magsCarried: 6,             // 휴대 탄창 수 (장전 1 + 예비 5)
      magEmptyKg: 0.33,           // 빈 탄창 무게
      roundKg: 0.0163,            // 탄 1발 무게
      rpm: 600,                   // 연사 속도 (발/분)
      modes: ['semi', 'auto'],    // 사격 모드 (B로 전환, 첫 값이 기본)
      muzzleVelocity: 715,        // 초속 (m/s)
      dragK: 0.00142,             // 공기 저항 dv/dt = -k·v² (1/m) — 100m에서 약 620m/s, 300m에서 약 470m/s
      zeroRange: 100,             // 영점 거리 (m)
      sightHeight: 0.06,          // 총열 중심에서 조준선까지 높이 (m)
      sightRadius: 0.378,         // 가늠자~가늠쇠 거리 (m, 화면 모델용)
      dispersionMOA: 4.5,         // 고유 산포: 탄의 90%가 들어가는 원의 지름 (MOA, 1 MOA = 1/60°)
      tracer: false,              // 예광탄 (true 면 tracerEvery 발마다 1발)
      tracerEvery: 1,
      // 반동 (°) — 시선(카메라)을 직접 밀어 올림
      recoil: {
        vertical: 1.8,            // 발당 수직 반동
        verticalJitter: 0.3,      // ± 무작위
        horizontal: 0.9,          // 수평 ± 무작위
        autoRecover: 0.4,         // 저절로 돌아오는 비율 — 나머지 60%는 플레이어가 마우스로 끌어내려야 함
        kickTime: 0.05,           // 반동이 시선에 실리는 시간 (s)
        recoverDelay: 0.08,       // 자동 회복이 시작되기까지 (s)
        recoverTime: 0.22,        // 자동 회복 시간상수 (s)
        burstGrowth: [1.0, 1.15, 1.3, 1.45, 1.6],  // 연발 n번째 발의 수직 반동 배율 (5발째부터 ×1.6)
        burstGap: 0.25,           // 이만큼 쉬면 연발 누적 초기화 (s)
        kickBackM: 0.045,         // 화면 모델이 뒤로 튀는 거리 (m)
        kickUpDeg: 3.5,           // 화면 모델이 위로 들리는 각 (°)
      },
      // 동작 시간 (s)
      reload: {
        tactical: 2.3,            // 탄이 남은 상태 (약실 1발 유지 → 31발)
        empty: 3.0,               // 빈 상태 (노리쇠 당기기 포함)
        magCheck: 1.5,            // 탄창 확인 (T)
        clear: 1.5,               // 기능 고장 해결 (R로 노리쇠 당기기)
        // 동작 중 소리·화면 모델 타이밍 (전체 시간에 대한 비율)
        tacticalTimeline: { magOut: 0.16, magIn: 0.62 },
        emptyTimeline: { magOut: 0.13, magIn: 0.5, boltPull: 0.74, boltRelease: 0.82 },
        clearTimeline: { boltPull: 0.42, boltRelease: 0.58 },   // 고장 해결: 당길 때 불발탄 배출, 놓을 때 다음 탄 장전
      },
      // 기능 고장 (발당 확률, 오염도 0~100 에 따라 최대 foulingMaxMul 배)
      malfunction: { perShot: 0.0005, foulingMaxMul: 20 },
    },
    // 탄창 확인 결과 (탄창의 남은 비율 이상이면 그 표시) — 숫자는 보여주지 않는다
    magCheckLabels: [[0.8, '가득'], [0.4, '절반쯤'], [0.12, '조금'], [0, '거의 없음']],
    modeLabels: { semi: '단발', auto: '연발' },   // 사격 모드 짧은 표시 (HUD)
    // 무기 오염도 증가 (초당) — Weapon.updateFouling(dt, { stance, surface, moving, waterDepth }) 가 계산
    fouling: {
      proneMud: 4,                // 진흙·논에서 엎드려 기어갈 때
      proneWet: 1.2,              // 젖은 흙·얕은 물에서 엎드려 기어갈 때
      submerged: 15,              // 총이 물에 잠겼을 때
      proneStillMul: 0.25,        // 엎드려 가만히 있을 때 (기어갈 때 대비 비율 — 총이 바닥에 닿아 있긴 하다)
      mudSurfaces: ['shallowMud', 'deepMud', 'paddy'],   // proneMud 지면
      wetSurfaces: ['wetEarth', 'shallowWater'],         // proneWet 지면
      gunHeight: { stand: 1.15, crouch: 0.7, prone: 0.15 },  // 물이 이보다 깊으면 총이 잠김 (자세별 총 높이, m)
    },
  },

  // 조준 (흔들림·관성·숨 참기·거치·지향사격 퍼짐) — 사람 공용 (4단계 적 병사도 같은 값)
  //  src/combat/AimModel.js(흔들림·관성·반동·숨 참기·가늠자) · Rest.js(거치 감지) · Shooter.js(탄 출발점)가 호출 시점에 읽는다.
  aim: {
    adsTime: 0.35,                // 가늠자 조준 전환 (s), 우클릭을 누르고 있는 동안 조준
    adsOutTime: 0.25,             // 조준을 풀 때 총을 내리는 시간 (s)
    sprintDelay: 0.5,             // 달리기 직후 총을 들어 올리기까지 지연 (s) — 그동안 조준·사격 불가
    sprintLowerTime: 0.2,         // 달리기 시작하면 총을 낮춰 드는 시간 (s) — 잠깐만 뛰었으면 덜 내려간 만큼 지연도 짧다
    adsFovMul: 0.93,              // 조준 시 시야각 배율 (확대 아님 — 스코프 없음)
    adsMoveMul: 0.5,              // 조준 중 이동 속도 배율
    // 비조준(지향) 사격 퍼짐: 원뿔 반각 (°) — 원판 안 균일 (평균 반경 = 반각의 2/3)
    hipSpread: { stand: 3.5, crouch: 2.5, prone: 1.5 },
    hipMoveMul: 2.0,              // 이동 중 최대 배율
    hipMoveFullSpeed: 1.6,        // 이 속도(m/s)에서 최대 배율
    hipOffset: { right: 0.17, down: 0.22, forward: 0.1 },   // 지향사격 탄 출발점: 눈에서 오른쪽·아래·앞 (m). 방향은 조준선 그대로
    // 조준 흔들림 (°): 호흡에 따른 8자 궤적. 진폭 = 8자 궤적의 세로 최대 변위
    sway: {
      stand: 1.0, crouch: 0.6, prone: 0.3, rested: 0.15,
      figureAspect: 0.6,          // 8자 궤적의 가로/세로 비
      figurePhase: 0,             // 가로 성분 위상 (rad) — 0 이면 가운데에서 교차하는 반듯한 8자
      rateMul: 1,                 // 8자 한 바퀴 = 호흡 한 번 × 이 배율
      depthVar: 0.15,             // 호흡마다 깊이(8자 크기)가 달라지는 정도 (±비율) — 같은 궤적이 반복되지 않게
      drift: 0.35,                // 느리고 불규칙한 흔들림 (진폭 배율) — 8자 전체가 떠다님
      driftAspect: 1.0,           // 표류의 가로/세로 비
      driftHz: [0.07, 0.35],      // 표류 주파수 범위 (Hz)
      tremorDeg: 0.04,            // 손떨림 (기본, 심박에 비례해 커짐)
      tremorHz: [8, 12],          // 손떨림 주파수 범위 (Hz)
      restTremorMul: 0.5,         // 거치하면 손떨림 배율 (총 무게를 손이 버티지 않는다)
      triggerJerkDeg: 0.16,       // 방아쇠를 당길 때 생기는 흔들림 (축별 표준편차, 거치하면 절반) — 흔들림이 작은 엎드려 쏘기에서 상대적으로 큼
                                  //  (0.12 → 0.15: 엎드려 50m 단발이 75% 경계에서 약 70%로, 서서 30m 는 그대로 약 42%)
                                  //  (0.15 → 0.16, npm run aim 시드 10개: 엎드려 50m 평균 69.4 → 67.7% (60~75% 의 가운데, 시드별 65~71%),
                                  //   서서 30m 는 43% 그대로 — 0.01° 당 엎드려 약 −1.6%p, 서서는 거의 무관. 0.15 에선 시드에 따라 72.7% 까지 올라 경계 2%p 근처)
      restJerkMul: 0.5,           // 거치했을 때 방아쇠 흔들림 배율
      ampSmoothing: 4,            // 진폭이 목표(자세·심박·제압·숨 참기)를 따라가는 속도 (1/s) — 조준선이 순간이동하지 않게
    },
    // 호흡수 (Hz) — 호출자가 호흡수(BreathCycle.rate)를 주지 않을 때 심박에서: baseHz + hrHz × n^hrExp (n = heart.rest~max 비율)
    breath: { baseHz: 0.25, hrHz: 0.6, hrExp: 1.2 },
    heart: { restBpm: 70, maxBpm: 170, maxMul: 2.5 },   // 심박 70 → ×1.0, 170 → ×2.5
    stamina: { below: 60, maxMul: 1.6, exponent: 1.5 }, // 스태미나가 60 아래면 추가로 커짐 (0이면 ×1.6, 낮을수록 가파르게)
    move: { swayPerMps: 0.8 },                          // 조준 중 이동: 속도 1m/s 당 흔들림 +80%
    // 숨 참기 (조준 중 Shift)
    holdBreath: {
      duration: 4, swayMul: 0.3,                        // 최대 4초, 흔들림 ×0.3
      recoverTime: 3, recoverSwayMul: 1.8,              // 이후 3초간 흔들림 ×1.8
      staminaCost: 15,                                  // 스태미나 -15
      cooldown: 5,                                      // 5초간 다시 숨 참기 불가
      minFraction: 0.4,                                 // 일찍 놓아도 회복·대가는 최소 이 비율만큼
      phaseRateMul: 0.1,                                // 숨 참는 동안 8자 궤적 진행 속도 (거의 멈춤)
      recoverRateMul: 1.6,                              // 숨을 몰아쉬는 동안 호흡(8자)이 빨라짐
    },
    // 무기 관성: 시선을 돌리면 총이 늦게 따라오고, 빠르게 돌리면 지나쳤다 돌아옴 (감쇠 스프링)
    //  stiffness = 고유 각진동수 ω (rad/s, 14 → 주기 약 0.45초), damping = 감쇠비 ζ (<1 이면 지나침, 0.42 → 약 23%)
    //  gain = 시선 변화 중 총이 뒤처지는 비율, maxLagDeg = 최대 뒤처짐, hipMul = 비조준일 때 gain 배율 (몸에 붙여 듦)
    inertia: { stiffness: 14, damping: 0.42, gain: 0.85, maxLagDeg: 7, hipMul: 0.6 },
    // 자세별 반동 배율 (거치하면 자세 대신 rested)
    recoilStanceMul: { stand: 1.0, crouch: 0.75, prone: 0.5, rested: 0.45 },
    recoilHorizontalRecover: 1.0, // 수평 반동의 자동 회복 비율 (무기 recoil.autoRecover 대비 — 1 이면 수평도 40%만 돌아옴)
    shake: { frequency: 5, damping: 0.3 },   // 근접 통과 움찔(addShake): 총이 튀었다 가라앉는 스프링 (Hz, 감쇠비 → 약 0.3초)
    // 화면 모델 반동 스프링 (뒤로·위로 튀는 크기는 무기 recoil.kickBackM·kickUpDeg) — side·roll 은 발마다 ± 무작위 (°)
    weaponKick: { frequency: 8, damping: 0.55, sideDeg: 0.6, rollDeg: 2.5 },
    // 거치: 조준 중 총몸 아래(통나무·바위·흙둔덕) 또는 옆(나무 줄기)에 받칠 곳이 있으면 자동
    rest: {
      forward: 0.45,              // 눈에서 총몸(손잡이 덮개)까지 앞쪽 거리 (m)
      below: 0.09,                // 조준선 아래로 총몸 아랫면까지 (m)
      minGap: -0.05, maxGap: 0.1, // 총몸 아랫면과 받칠 곳 윗면 사이 허용 간격 (m)
      probeAhead: 0.15,           // 손잡이 덮개가 길어서 이만큼 앞쪽도 받침을 살핌 (m)
      // 자세를 더 낮춰 아래 받침에 총을 얹을 수 있는 거리 (m) — 서기: 무릎을 굽힘, 앉기: 더 낮게 앉음, 엎드리기: 없음.
      // 자세별 눈높이가 고정이라 이게 없으면 높이 0.4~0.8m 통나무·바위에 앉아서 얹을 수 없다 (0 = 정확히 maxGap 까지만)
      reach: { stand: 0.15, crouch: 0.3, prone: 0 },
      sideGap: 0.12,              // 나무 줄기 옆면까지 허용 거리 (m)
      minTrunkR: 0.05,            // 옆에 기댈 수 있는 기둥의 최소 반경 (m)
      maxSpeed: 0.3,              // 이보다 빠르게 움직이면 거치 풀림 (m/s)
      enterTime: 0.15, exitTime: 0.25,   // 감지가 이만큼 이어져야 거치 / 해제 (가장자리에서 깜빡이지 않게)
      blendTime: 0.2,             // 거치 효과(흔들림·반동 감소)가 섞여 들어가는 시간 (s)
      lowerM: 0.015,              // 거치되면 총이 내려앉는 거리 (화면 표현, m)
    },
  },

  // 탄도 (실제 투사체 — 히트스캔 아님)
  ballistics: {
    gravity: 9.81,
    speedOfSound: 343,
    maxStep: 1 / 240,             // 적분 간격 (s)
    maxTime: 3, maxRange: 1000,
    minSpeed: 120,                // 이보다 느려지면 소멸 (m/s)
    // bulletBlock 'partial' (대나무·얇은 줄기·덩굴 벽): 속도 배율 [최소, 최대], 굴절 [최소, 최대] (°)
    partial: { speedMul: [0.45, 0.7], deflectDeg: [1, 5] },
    partialByType: {
      bamboo: { speedMul: [0.45, 0.65] }, bambooDense: { speedMul: [0.4, 0.6] },
      vineWall: { speedMul: [0.5, 0.7] }, treeFern: { speedMul: [0.55, 0.75] }, liana: { speedMul: [0.7, 0.85], deflectDeg: [0.5, 2] },
    },
    // bulletBlock 'none' (풀잎·덤불·수관): '빽빽한 잎을 지나면 0~1° 랜덤하게 빗나갈 수 있음'
    //  빽빽한 잎 = 국소 σ ≥ denseSigma (0.7 ≈ 1m 지나면 시야 절반이 가려지는 잎 — 코끼리풀·밀집 덤불·덤불 한가운데·덩굴).
    //  그런 잎 속의 Σσ·ds 만 세어 확률 1 − exp(−chancePerSigmaM·Σσds) 로 U(0, maxDeflectDeg) 무작위 방향 빗나감 —
    //  가슴 높이의 보통 숲 공기(σ 대부분 < 0.3)는 세지 않는다. 한 탄의 잎 빗나감은 모두 합쳐 maxDeflectDeg 이내.
    //  (npm 없이 재는 법·전후 수치: 코끼리풀 3m 약 35%, 높이 1.5m 덤불 한가운데 약 17%, 보통 숲 30m 약 6% — 전에는 20%)
    //  잎 효과('foliage' 이벤트)는 국소 σ ≥ leafFxSigma 인 잎 속을 leafFxEvery m 지날 때마다 최대 1번
    foliage: { chancePerSigmaM: 0.12, maxDeflectDeg: 1.0, denseSigma: 0.7, leafFxEvery: 1.5, leafFxSigma: 0.3 },
    // 물: 수면 진입 시 속도 배율, 물속 감속 (1/m), 얕은 각도면 튕김 (튕길 때 흩어짐 °)
    water: { entrySpeedMul: 0.3, drag: 1.2, ricochetDeg: 6, ricochetSpeedMul: 0.55, ricochetScatterDeg: 3 },
    ricochet: { rockDeg: 12, speedMul: 0.5, scatterDeg: 8 },   // 바위에 얕은 각으로 맞으면 튕김
    rockSlopeDeg: 42,             // 이보다 가파른 지형은 착탄 재질 '바위' (흙이 드러난 급사면)
    nearPassRadius: 2,            // 제압: 근접 통과 판정 거리 (m)
    crackRadius: 15,              // 초음속 '딱' 소리가 들리는 최대 빗나감 거리 (m)
    nearImpactRadius: 2,          // 제압: 근처 착탄 판정 거리 (m)
  },

  // 제압 (0~100) — 사람 공용 (플레이어·4단계 적 병사)
  suppression: {
    passGain: [[0.3, 30], [1.0, 15], [2.0, 5]],   // 빗나간 거리(m) → 증가량 (사이는 선형 보간, 0.3 이하는 30)
    impactGain: 10,               // 2m 이내 착탄 (판정 거리 = ballistics.nearImpactRadius)
    decayDelay: 2,                // 마지막 이벤트 후 대기 (s)
    decayRate: 12,                // 이후 초당 감소
    levels: { light: 30, heavy: 60, pinned: 85 },  // 경미 / 강함 / 완전 제압
    // 플레이어에게 나타나는 효과 (수치 100 기준 최대값)
    effects: {
      swayMaxMul: 2.5,            // 조준 흔들림 배율 (선형)
      pinnedSwayMul: 1,           // 완전 제압(85 이상)이면 추가 배율 — 1 = 추가 없음. 사용자 기준 '흔들림 배율 최대 ×2.5'를 지키려고
                                  //  1.3 → 1 (1.3 이면 85 에서 ×2.96, 100 에서 ×3.25 로 최대를 넘었다). 85 의 '정밀 조준 사실상 불가'는
                                  //  흔들림 ×2.28 + 미세 떨림 0.26° + 심박 약 119 로 충분 (npm run aim #6: 시드 10개 3.5~5.4%, 기준 10% 이하 —
                                  //  서서 조준 평소 약 43% 의 1/8. 1.3 일 때는 2.4~3.8%)
      tremorDeg: 0.3,             // 지속적인 미세 떨림 (°)
      heartStress: 0.85,          // 심박 긴장 (motor.stress)
      tunnel: 0.85,               // 터널 시야 (가장자리 어둡고 흐림)
      muffle: 0.55,               // 주변 소리 먹먹함
      shakeDeg: 1.6,              // 근접 통과 순간 화면 흔들림 (0.3m 이내 기준, °)
    },
  },

  // 부위별 피격 판정 (캡슐) — 3단계에서 부상과 연결. 반경 (m)
  hitboxes: {
    // 몸통(가슴 상부·복부·골반)은 좌우로 나란한 캡슐 2개씩 → 두께 = 2r, 너비 = 2r + 간격 (가슴 0.23 × 0.33m)
    radius: { head: 0.1, neck: 0.055, upperChest: 0.115, abdomen: 0.105, pelvis: 0.11, upperArm: 0.05, forearm: 0.042, thigh: 0.075, shin: 0.055 },
    labels: {
      head: '머리', neck: '목', upperChest: '가슴 상부(심장)', abdomen: '복부', pelvis: '골반',
      upperArmL: '왼팔 상완', upperArmR: '오른팔 상완', forearmL: '왼팔 하완', forearmR: '오른팔 하완',
      thighL: '왼다리 대퇴', thighR: '오른다리 대퇴', shinL: '왼다리 하퇴', shinR: '오른다리 하퇴',
    },
  },

  // ------------------------------------------------------------------
  // 3단계: 부위별 피격·부상 (사람 공용 — 플레이어·F8 표적·4단계 적 병사가 같은 규칙)
  //  출혈 단위: 혈액량 %/분 (혈액 100 에서 시작, 상처마다 더함). 시간 단위: s, 거리: m
  // ------------------------------------------------------------------
  injury: {
    // 치명 부위: 머리·목 전체 + 가슴 상부 캡슐 안의 심장·대혈관(구) + 상부 척추(등 쪽 캡슐).
    //  탄이 들어간 점에서 진행 방향으로 pathLength m 의 탄 경로가 이 구·캡슐을 지나면 치명.
    //  심장: 가슴 상부 중심에서 앞 forward · 위 up · 왼쪽 left (m), 지름 2×heartRadius ≈ 13cm
    heartRadius: 0.065, heartOffset: { forward: 0.035, up: -0.01, left: 0.015 },
    //  척추: 목 아래(목 캡슐 아래 끝 높이)에서 몸통 축을 따라 length m 내려간 선, 가슴 중심축에서 등 쪽 back m, 반경
    spine: { radius: 0.035, back: 0.075, length: 0.2 },
    pathLength: 0.45,
    pathParts: ['upperChest', 'abdomen', 'upperArmL', 'upperArmR'],  // 심장·척추 경로 판정을 하는 부위 (머리·목은 원래 치명)
    lowSpeedRatio: 0.4,        // 2단계 관통·도탄 뒤 남은 속도 비율이 이 미만이면 한 단계 약하게 (치명 → 가슴 중상, 비치명 → 스침)
    grazeDepth: 0.02,          // 탄 경로가 판정 표면에서 이만큼 안쪽까지만 들어가면(또는 바깥 이 거리 안을 지나면) 스침
    stun: 1.5,                 // 비치명 명중: 조작 불가 (s)
    grazeStun: 2,              // 스침: 경직 (s)
    // 혈액량 단계 (%): 미만이면 — weak: 심박·흔들림 증가 / faint: 화면 회색·흐림·소리 멀어짐·기는 속도 감소 / dead: 의식 상실 → 사망
    thresholds: { weak: 80, faint: 60, dead: 40 },
    // 상처 종류별 효과 (가장 심한 제한이 적용되고 출혈은 더한다)
    //  forceStance: 맞는 순간 강제로 그 자세 (넘어짐), canStand/canCrouch/canSprint/canJump: 이동 컴포넌트 제한,
    //  maxSpeed: 최대 이동 속도 (m/s — 숫자면 모든 자세, 객체면 자세별), maxStamina: 스태미나 상한,
    //  swayMul/recoilMul/reloadMul: 조준 흔들림·반동·재장전(동작) 시간 배율, bleed: %/분,
    //  arterial: { chance, bleed } — 맞을 때 그 확률로 동맥 출혈 (출혈 %/분이 바뀜)
    wounds: {
      graze: { bleed: 1, swayMul: 1.3 },
      chest: { forceStance: 'prone', canStand: false, canCrouch: false, canSprint: false, canJump: false, maxSpeed: 0.15, maxStamina: 30, swayMul: 2, bleed: 12, cough: true },
      abdomen: { forceStance: 'prone', canStand: false, canCrouch: false, canSprint: false, canJump: false, maxSpeed: 0.15, swayMul: 2, bleed: 8 },
      pelvis: { forceStance: 'prone', canStand: false, canCrouch: false, canSprint: false, canJump: false, maxSpeed: 0.15, swayMul: 2, bleed: 8 },
      thigh: { forceStance: 'prone', canStand: false, canSprint: false, canJump: false, maxSpeed: 0.25, bleed: 5, arterial: { chance: 0.25, bleed: 30 } },
      shin: { canSprint: false, canJump: false, maxSpeed: { stand: 0.3, crouch: 0.3 }, limp: true, bleed: 3 },
      upperArm: { swayMul: 4, recoilMul: 2.5, reloadMul: 2.5, bleed: 4, arterial: { chance: 0.15, bleed: 25 } },
      forearm: { swayMul: 2.5, recoilMul: 2, reloadMul: 2, bleed: 2 },
    },
    // 절뚝임 (하퇴): 선 채로 걸을 때 limpSteps 걸음마다 휘청 (속도 × stumbleSpeedMul, 화면이 꺼짐)
    limp: { steps: [3, 5], stumbleSpeedMul: 0.15 },
    // 팔: 방아쇠 팔(오른쪽) → 연발 불가 + 발사 지연, 지지 팔(왼쪽) → 흔들림 추가 배율, 맞으면 총을 떨어뜨릴 확률
    arm: { triggerSide: 'R', noAuto: true, fireDelay: 0.3, supportSwayMul: 1.3, dropChance: 0.3, pickupTime: 2, pickupRange: 1.6 },
    // 가슴 부상 기침 간격 (s)
    cough: { interval: [4, 9], swayKick: 1.2 },
    // 혈액 손실: weak 미만부터 dead 까지 흔들림 배율이 1 → swayMulAtDead 로, 심박 긴장 0 → heartStress
    //  faint 미만: 엎드려 기는 속도 × faintCrawlMul
    bloodLoss: { swayMulAtDead: 1.6, heartStress: 0.6, faintCrawlMul: 0.6 },
    pain: { heartStress: 0.45 },     // 부상이 있으면 심박 긴장 (motor.stress)
    // 자가 처치: H 붕대 (일반 출혈 × bandageMul, 동맥 출혈은 × bandageArterialMul 까지만),
    //  G 지혈대 (팔다리 출혈 정지 — 그 팔다리는 계속 못 씀, 몸통 불가). 팔 부상이면 시간 × armTimeMul.
    //  처치 중 움직이거나(moveCancelSpeed m/s 이상) 맞으면 취소 (붕대·지혈대는 쓰지 않은 것으로)
    aid: { bandages: 2, tourniquets: 1, bandageTime: 7, tourniquetTime: 5, armTimeMul: 1.5, bandageMul: 0.15, bandageArterialMul: 0.6, moveCancelSpeed: 0.12 },
    // 사람 개체 (F8 표적): 쓰러진 뒤 가장 가까운 엄폐물로 crawlMin~crawlMax m 기어감 (coverSearch m 안에서 찾음),
    //  신음·거친 숨 간격 (s), 치명 피격 시 쓰러지는 시간 (s)
    entity: { crawlMin: 3, crawlMax: 5, coverSearch: 12, vocalInterval: [2.5, 6], fallTime: 0.9, slumpTime: 2.4 },
    // 플레이어 표현: 이명 (s), 사망 화면까지 (s), 의식 상실 페이드 (s)
    player: { tinnitus: 3, blur: 0.6, deathScreenDelay: 1.6, faintFade: 3 },
    // 사망 원인 표기
    causes: { head: '머리 관통', neck: '목 관통', heart: '심장 관통', spine: '척추 손상', bleed: '출혈' },
    typeLabels: {
      graze: '스침', chest: '가슴', abdomen: '복부', pelvis: '골반', thigh: '대퇴', shin: '하퇴', upperArm: '상완', forearm: '하완',
      lethal: '치명',
    },
  },

  // 테스트 도구
  testRange: {
    // F8 표적 (플레이어 정면): 거리(m), 자세, cover = 수풀 뒤에 반쯤 가림, walk = 좌우로 걷기
    targets: [
      { distance: 15, stance: 'stand' },
      { distance: 30, stance: 'stand', walk: true },
      { distance: 30, stance: 'crouch', cover: true },
      { distance: 50, stance: 'stand', cover: true },
      { distance: 50, stance: 'prone' },
      { distance: 100, stance: 'stand' },
    ],
    walkSpeed: 1.4, walkRange: 4,  // 걷는 표적 속도 (m/s), 좌우 왕복 반경 (m)
    walkTurnTime: 0.8,             // 걷는 표적이 끝에서 돌아서는 시간 (s) — 플레이어 쪽으로 몸을 돌리며 180°
    // 배치 탐색: 정면 거리마다 좌우 ±lateralSearch (lateralStep 간격) × 거리 ±distanceSearch (distanceStep 간격) 후보를
    //  덜 벗어난 순으로 훑어 눈→가슴 직선이 단단한 것(bulletBlock 'full')에 막히지 않고 시야 투과율 ≥ minVisibility 인 첫 자리
    lateralSearch: 12,             // 시야가 트인 자리를 찾는 좌우 범위 (m)
    lateralStep: 1.5,              // 좌우 탐색 간격 (m)
    distanceSearch: 0.1, distanceStep: 0.05,   // 거리 탐색 ±10% (5% 간격)
    maxOffAxisDeg: 35,             // 정면에서 벗어날 수 있는 최대 각 — 가까운 표적이 시야 밖 옆으로 빠지지 않게
    minVisibility: 0.25,           // 눈→가슴 시야 투과율 하한 (풀·덤불에 묻혀 안 보이는 자리 제외)
    spacing: 2.5,                  // 표적끼리 최소 간격 (m) — 엎드린 몸은 몸 길이, 걷는 표적은 걷는 길 전체 기준
    minSeparationDeg: 1.5,         // 플레이어 눈에서 본 표적끼리 최소 각 (°) — 화면에서 앞뒤로 겹쳐 보이지 않게 (걷는 표적은 길 가운데 기준)
    maxSlopeDeg: 25,               // 표적을 세울 지면 최대 경사 (°)
    maxWaterDepth: { stand: 0.35, crouch: 0.2, prone: 0.03 },  // 자세별 허용 물 깊이 (m) — 엎드린 표적이 논물에 잠기지 않게
    // 반쯤 가리는 수풀: 표적 앞 gap m (플레이어 쪽), 반경, 플레이어 눈에서 볼 때 표적 키 × heightFrac 아래를 가리는 높이
    //  (오르막·내리막에서도 — 최소 minHeight), 잎 소광계수 σ (1/m)
    //  σ 는 탄의 잎 적분(ballistics.foliage 빗나감)에 들어간다 — 수풀은 bulletBlock 'none' (막지 않음)
    cover: { gap: 1.2, radius: 0.75, heightFrac: 0.55, minHeight: 0.45, sigma: 1.6 },
    // 맞으면 흔들림 (화면 표현만): 충격 기울기 (°, 정수리 높이 명중 기준 — 낮게 맞을수록 작음, 감쇠 때문에 실제 최대는 약 3/4),
    //  스프링 진동수 (Hz), 감쇠비, 최대 기울기 (°, 연사로 계속 맞아도), 자세별 배율
    wobble: { impulseDeg: 5, frequency: 1.6, damping: 0.22, maxDeg: 12, stanceMul: { stand: 1, crouch: 0.7, prone: 0.25 } },
    logSize: 8,                    // 화면 구석 피격 로그 줄 수
    // 피격 로그 표기: 자세, 관통한 물체 (BulletWorld objectType → 이름)
    stanceLabels: { stand: '서기', crouch: '앉기', prone: '엎드리기' },
    objectLabels: {
      bamboo: '대나무', bambooDense: '대나무 덤불', vineWall: '덩굴 벽', liana: '굵은 덩굴', treeFern: '나무고사리 줄기',
      water: '물', bigTree: '큰 나무', midTree: '나무', palm: '야자나무', log: '통나무', rock: '바위', root: '뿌리',
      buttress: '판근', dike: '논둑', terrain: '지면', sapling: '어린 나무', banana: '바나나',
    },
    // F7 제압 테스트: 플레이어 주변으로 일부러 빗나가는 연발
    suppression: {
      distance: [50, 150],         // 사수 거리 (m), 방향은 무작위
      burst: [3, 8],               // 연발 발수
      interval: [1.6, 3.2],        // 연발 사이 간격 (s)
      duration: 30,                // 자동 종료 (s)
      miss: [0.3, 2.2],            // 플레이어 머리·몸통에서 빗나가는 거리 (m)
      minClear: 0.25,              // 플레이어 캡슐과의 최소 간격 (m) — 절대 맞지 않게
      collideWithin: 30,           // 플레이어 앞 이 거리부터만 지형·나무와 충돌 (먼 사수의 탄이 숲에 다 막히지 않게)
      shooterHeight: 1.4,          // 가상 사수 총구 높이 (지면 위 m)
      startDelay: 0.6,             // F7 을 누른 뒤 첫 연발까지 (s)
      missAngleDeg: [-35, 215],    // 사격선에 수직인 면에서 빗나가는 방향 (0° = 오른쪽, 90° = 위) — 발밑(땅속) 쪽 110° 는 뺌
      clearPast: 3,                // '트인 사격선' = 충돌이 켜지는 곳부터 플레이어를 이만큼 지날 때까지 막히지 않음 (m)
      tries: 16,                   // 트인 방향(연발마다)·안전한 빗나갈 지점(발마다)을 찾는 최대 시도 수
      roundTries: 6,               // 발마다 사격선이 막혀 다시 겨누는 최대 횟수 (사격선 확인 1번 ≈ 0.01~0.3ms — 한 프레임에 몰리지 않게)
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
    weapons: 0.9,             // 총성·기계음·착탄음 (audio/WeaponAudio.js)
    crack: 0.9,               // 초음속 '딱' 버스 — 먹먹함 필터를 건너뜀 (제압 중에도 날카롭게)
    reverb: 1.0,              // 정글 잔향(Convolver) 되돌림 크기 — 소리마다 보내는 양은 WeaponAudio 가 정함
    // 제압 먹먹함: setMuffle(0~1) → 저역 통과 maxHz → minHz (지수 보간), 세상 소리 크기 ×(1 - duck×양)
    //  제압 효과 muffle 0.55(수치 100) ≈ 2.2kHz 차단 — '약간 먹먹함'
    muffle: { maxHz: 20000, minHz: 350, duck: 0.25, smoothing: 0.08 },
  },

  // 조작 키 (KeyboardEvent.code). Ctrl은 브라우저 단축키와 충돌하므로 쓰지 않는다.
  controls: {
    forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
    sprint: ['ShiftLeft', 'ShiftRight'], quiet: 'KeyX', crouch: 'KeyC', prone: 'KeyZ',
    leanLeft: 'KeyQ', leanRight: 'KeyE', jump: 'Space',
    debug: 'F3', incapacitate: 'F6',
    // 2단계: 마우스 버튼은 'Mouse0'(왼쪽)·'Mouse2'(오른쪽)로 표기. 조준 중 Shift(sprint 키) = 숨 참기
    fire: 'Mouse0', aim: 'Mouse2',
    fireAlt: 'KeyV',          // 마우스 잠금이 안 되는 환경(끌어서 보기)에서 사격 (3단계: F 는 총 줍기)
    reload: 'KeyR', fireMode: 'KeyB', magCheck: 'KeyT',
    suppressionTest: 'F7', targets: 'F8',
    // 3단계: 붕대, 지혈대, 떨어뜨린 총 줍기, 피격 테스트 메뉴, 사망 후 다시 시작
    bandage: 'KeyH', tourniquet: 'KeyG', pickup: 'KeyF', hitTest: 'F9', restart: 'Enter',
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
