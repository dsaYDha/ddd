// =====================================================================
//  TargetRange — F8 표적 사격장 (순수 로직: three.js·DOM 없음 → Node 헤드리스에서도 동작)
//  플레이어 정면 15·30·50·100m (CONFIG.testRange.targets) 에 사람 크기 표적을 세운다.
//  표적 = 팔을 내린 Person (Hitboxes 부위별 캡슐 그대로 → 판정과 TargetMesh 모습이 같은 캡슐). 제압 없음 (마네킹).
//
//  배치 place(eye, yaw):
//   · 까다로운 표적부터 자리를 잡는다: 엎드린 표적 (마른 평지 + 땅에 붙은 사격선) → 걷는 표적 (긴 길) → 나머지 → 수풀 표적,
//     같은 순위면 가까운 것부터. 나중 표적은 먼저 선 (보이는) 표적의 사격선을 몸·수풀로 가리지 않는 자리로 비켜 선다.
//   · 후보 = 바라보는 방향으로 거리 ±distanceSearch × 좌우 ±lateralSearch 격자를 '덜 벗어난' 순서로
//     (좌우 1m = 거리 2m — 라벨 거리를 지키되 앞뒤로 조금 옮기는 건 덜 어색하다). 정면에서 maxOffAxisDeg 넘게는 빼고.
//   · 자리 조건: 지면 (통나무·바위 위가 아님, 경사 ≤ maxSlopeDeg, 물 깊이 ≤ 자세별 한도, 논둑 위면 둑 윗면에 선다),
//     몸이 줄기·대나무·덩굴 벽과 겹치지 않음, 다른 표적과 spacing 이상 (엎드린 몸 길이·걷는 길 전체로),
//     눈→가슴 직선이 다른 표적 몸·수풀을 지나지 않음, 눈에서 본 다른 표적과 minSeparationDeg 이상 (앞뒤로 겹쳐 보이지 않게),
//     BulletWorld.cast 와 raycastWorld 'bullet' 둘 다 막힘 없음 (bulletBlock 'full'·지형·논둑),
//     시야 투과율 ≥ minVisibility (풀·덤불에 묻히지 않음) — raycastWorld 'vision' × 화면에 그려지는 낱개 덤불·토란·코끼리풀
//     잎 덩어리를 지날 때마다 (1 - PLANT_OPACITY) (σ 장은 1m 칸 통계라 사격선 바로 위의 키 큰 덤불 하나를 놓친다).
//     수풀 없는 서기·앉기 표적은 눈→엉덩이 직선이 지나는 덤불도 곱한다 (가슴 높이 덤불 뒤에 아랫몸이 묻힌 자리 제외).
//   · 다 맞는 자리가 없으면 단계적으로 푼다 (target.level, _findSite 참고): 0 = 조건 전부 · 1 = 흐릿해도 보이면 ·
//     2 = 내 사격선이 남을 지나도 · 3 = 막혀도 (고개 너머 '사각' 등 — 플레이어가 다가가면 보임) · 4·5 = 지면만 / 정면 그대로.
//     target.clear = (level 0), visibility = 눈→가슴 시야 투과율, blockedBy = 막은 물체.
//   · 수풀 표적 (cover): 플레이어 쪽 cover.gap m 앞에 덤불 — 플레이어 눈에서 볼 때 표적 키 × heightFrac 아래(아랫부분)를 가린다.
//     range.bushes 와 combat.world.extraFoliage 에 같은 객체를 넣는다 (탄을 막지 않고 잎 적분으로 빗나갈 수 있음).
//   · 걷는 표적 (walk): 사격선에 수직인 축으로 가운데에서 ±walkRange — 걸을 수 있는 데까지만 (줄기·물·경사).
//     길 위 5점의 사격선을 확인 (가운데가 막히면 탈락, 나머지는 지나가며 잠깐 가려져도 됨).
//  update(dt): 걷기 (walkSpeed 로 왕복, 걷는 방향을 바라봄, 끝에서 walkTurnTime 동안 플레이어 쪽으로 몸을 돌려 180°,
//              지면 높이를 따라감 — 판정 캡슐도 바로 갱신) + 맞았을 때의 흔들림 스프링 (화면 표현만, TargetMesh 가 읽음).
//  combat 'hit' 이 표적이면: 흔들림 충격 (탄 진행 방향, 높이 맞을수록 크게) + 로그 맨 앞에 추가 + 'log' {entry}.
//   로그 글: '30m 서기 표적 · 가슴 상부(심장) · 30.2m · 0.045s · 관통 없음' / '… · 관통: 대나무' (같은 종류 여럿: '대나무 ×2')
//   (3단계: 끝에 부상 결과 '· 치명(심장)' / '· 부상(동맥)' / '· 스침' — 로그는 F3 디버그에서만 보인다. 명중 표시 없음)
//  3단계 사람 개체: query(실제 지형)가 있으면 표적마다 HumanEntity (HumanMotor + Injuries) — 맞으면 부위대로 쓰러지거나
//   주저앉고 엄폐물로 기어가며, 출혈로 죽는다. 걷기도 이동 컴포넌트로. t.entity, t.injuries 로 상태를 읽는다.
//   query 가 없으면(헤드리스 평지) 예전처럼 움직이지 않는 마네킹 (판정·로그만).
//  이벤트: 'state' {active, targets, bushes} (배치·제거), 'log' {entry},
//          'vocal' {target, kind, position} · 'bleed' {target, position, rate} · 'fall' {target, kind, dir} · 'death' {target, cause}
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { DEG, clamp, smoothstep, wrapAngle } from '../core/math.js';
import { RNG } from '../core/rng.js';
import { buildHitboxes, partLabel } from './Hitboxes.js';
import { HumanEntity } from './HumanEntity.js';
import { segCapsuleRaw } from './geom.js';

// 자리 고르기 모양 상수 (몸 비율·여유 — 판정 수치가 아님)
const DIST_COST = 0.5;          // 후보 순서: 거리 1m 변경 = 좌우 0.5m 이동만큼 벗어난 것으로
const BODY_R = 0.35;            // 줄기·대나무와 몸 사이 여유 반경 (m)
const STAND_TOP = 1.8;          // 걷는 길 확인용 몸 높이 (m)
const PRONE_LEN = 1.45;         // 엎드린 몸: 원점(눈 아래, 머리 쪽)에서 발끝까지 뒤로 (Hitboxes 엎드리기 몸 길이)
const PRONE_PROBE = [0.5, 1.0, PRONE_LEN];   // 엎드린 몸 아래 지면·줄기를 더 확인할 지점 (원점에서 뒤로 m)
const LINE_MARGIN = 0.25;       // 사격선과 다른 표적 몸·수풀 사이 여유 (m)
const MAP_MARGIN = 4;           // 맵 가장자리에서 (m)
const WALK_PROBE = 0.5;         // 걷는 길 확인 간격 (m)
const WOBBLE_STEP = 1 / 120;    // 흔들림 스프링 적분 간격 (s)
const WALK_Y_RATE = 14;         // 걷는 표적 발 높이가 지면을 따라가는 속도 (1/s) — 논둑 턱(0.3m)을 순간이동 대신 디뎌 오르게
const STANCES = ['stand', 'crouch', 'prone'];
// 화면에 그려지는 낱개 식물의 잎 덩어리 (PlantGeometry 메시 비율 [윗면/키, 잎 덩어리 반경/키], 키 = 배치 height).
//  시야 σ 장은 1m 칸 통계라 사격선 바로 위의 키 큰 덤불 하나를 놓친다 → 그 덩어리를 지나는 사격선은 덩어리마다
//  PLANT_OPACITY 만큼 더 가려진 것으로 본다 (시야 투과율 × (1 - 0.75)^개수). 렌더링 밀도 설정과 무관하게 전부 센다 (보수적).
const PLANT_SHAPES = { shrub: [0.9, 0.28], taro: [0.93, 0.45], rattan: [0.3, 0.25], grass: [1.12, 0.18], reed: [1.04, 0.09] };
const PLANT_OPACITY = 0.75;
const PLANT_CELL = 4;           // 식물 격자 칸 (m)
const PLANT_NEAR = 1.0;         // 눈 앞 이 거리 안의 식물은 무시 (몸을 살짝 비키면 보인다)

const yawOf = (dx, dz) => Math.atan2(-dx, -dz);   // 바라보는 방향 → yaw (0 = -Z 북, + = 왼쪽)
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class TargetRange extends EventEmitter {
  /**
   * @param {import('./CombatSystem.js').CombatSystem} combat  표적 Person 을 넣고 'hit' 을 듣는다
   * @param {import('../world/WorldQuery.js').WorldQuery|null} query  지면·시야 질의 (null 이면 combat.world 의 평지)
   * @param {{rng?: RNG}} opts  걷는 표적 첫 방향·좌우 우선순위
   */
  constructor(combat, query, opts = {}) {
    super();
    this.combat = combat;
    this.query = query ?? null;
    this.rng = opts.rng ?? new RNG((Math.random() * 4294967296) >>> 0);
    this.active = false;
    /** [{ person, def, label, distance (라벨 거리), stance, cover, walk, pos, yaw, axis, phase (걷는 축 위치 m),
     *    wobble {x, z, vx, vz} (rad 기울기 스프링), hits, lateral, along, range, level, clear, visibility, blockedBy, top, bush, … }] */
    this.targets = [];
    /** 반쯤 가리는 수풀 [{x, y, z, r, height, sigma}] — combat.world.extraFoliage 에도 같은 객체 */
    this.bushes = [];
    /** 피격 로그 (최신이 앞, 최대 logSize) [{ text, part, partLabel, distance, tof, penetrated, target, time, … }] */
    this.log = [];
    this.time = 0;
    this.lastPlaceMs = 0;          // 마지막 배치 계산 시간 (디버그)
    this._byPerson = new Map();    // Person → 표적
    this._castOut = {};            // BulletWorld.cast 결과 (탄도 계산과 공유하지 않게 따로)
    this._g = { ok: true, y: 0, why: '' };
    this._offHit = combat ? combat.on('hit', (e) => this._onHit(e)) : null;
  }

  /** 배치 ↔ 제거. @returns {boolean} 배치 상태 */
  toggle(eye, yaw) {
    if (this.active) this.clear();
    else this.place(eye, yaw);
    return this.active;
  }

  /** eye {x,y,z} (카메라 위치), yaw (시선) 기준으로 표적을 세운다 (이미 있으면 치우고 다시) */
  place(eye, yaw) {
    if (this.active || this.targets.length) this.clear();
    const t0 = now();
    const R = CONFIG.testRange;
    const ctx = {
      eye: { x: eye.x, y: eye.y, z: eye.z },
      f: { x: -Math.sin(yaw), z: -Math.cos(yaw) },   // 앞
      r: { x: Math.cos(yaw), z: -Math.sin(yaw) },    // 오른쪽
      side: this.rng.sign(),                          // 좌우 같은 비용이면 먼저 볼 쪽 (표적마다 번갈아)
      placed: [], bushes: [],
    };
    const order = R.targets.map((def, index) => ({ def, index }))
      .sort((a, b) => (priority(a.def) - priority(b.def)) || (a.def.distance - b.def.distance) || (a.index - b.index));
    const sites = [];
    for (const { def, index } of order) {
      const s = this._findSite(def, ctx, index);
      s.index = index;
      ctx.placed.push(s);
      if (s.bush) ctx.bushes.push(s.bush);
      sites.push(s);
    }
    sites.sort((a, b) => a.index - b.index);   // 표적 목록은 config 순서
    this.log.length = 0;
    for (const s of sites) this._addTarget(s);
    this.active = true;
    this.lastPlaceMs = now() - t0;
    this.emit('state', { active: true, targets: this.targets, bushes: this.bushes });
    return this.targets;
  }

  /** 표적·수풀 제거 (사람 목록과 탄도 잎 목록에서도) */
  clear() {
    const world = this.combat?.world;
    for (const t of this.targets) {
      if (t.entity) t.entity.dispose();
      else if (this.combat) this.combat.removePerson(t.person);
    }
    if (world && Array.isArray(world.extraFoliage)) {
      for (const b of this.bushes) {
        const i = world.extraFoliage.indexOf(b);
        if (i >= 0) world.extraFoliage.splice(i, 1);
      }
    }
    this.targets.length = 0;
    this.bushes.length = 0;
    this._byPerson.clear();
    const was = this.active;
    this.active = false;
    if (was) this.emit('state', { active: false, targets: this.targets, bushes: this.bushes });
  }

  /** 'hit' 구독까지 해제 */
  dispose() {
    this.clear();
    if (this._offHit) { this._offHit(); this._offHit = null; }
  }

  /** 걷는 표적 이동 + 흔들림 스프링. 게임 루프에서 combat.update 다음, 사수 발사 전에 부르면 판정이 화면과 같은 프레임 */
  update(dt) {
    if (!(dt > 0)) return;
    this.time += dt;
    if (!this.active) return;
    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i];
      if (t.entity) this._entityStep(t, dt);
      else if (t.walk) this._walk(t, dt);
      this._wobble(t, dt);
    }
  }

  // =================================================================
  // 배치
  // =================================================================
  /**
   * 한 표적 자리: 조건을 단계적으로 풀며 후보를 '덜 벗어난' 순서로 (지면·간격은 늘 지킨다).
   *  0: 남의 사격선을 가리지 않음 + 내 사격선이 남을 지나지 않고 화면에서 겹치지 않음 + 막힘 없음
   *     + 시야 ≥ minVisibility (걷는 길 5점 모두)
   *  1: 위와 같되 흐릿해도 (투과율 > 0)   2: 내 사격선이 남을 지나도·겹쳐 보여도 됨 (막힘만 없으면)
   *  3: 남의 사격선만 안 가리면 (막혀도 — 고개를 넘어야 보이는 '사각' 등)   4: 지면·간격만   5: 정면 그대로
   *  싼 판정을 먼저, 시야 광선(가장 비쌈)은 마지막에 후보마다 한 번만 계산한다.
   */
  _findSite(def, ctx, index) {
    const cands = this._candidates(def, ctx, index);
    const memo = new Map();
    const site = (c) => {
      let s = memo.get(c);
      if (!s) { s = this._site(c, def, ctx); memo.set(c, s); }
      return s;
    };
    const sight = (s) => s.sight || (s.sight = this._sight(s, ctx.eye));
    for (let level = 0; level <= 4; level++) {
      for (let i = 0; i < cands.length; i++) {
        const s = site(cands[i]);
        if (!s.ok || !this._spaced(s, ctx)) continue;
        if (level <= 3 && this._hidesOthers(s, ctx)) continue;
        if (level <= 1 && (this._crossesOthers(s, ctx) || this._overlapsOnScreen(s, ctx))) continue;
        if (level <= 2 && !sightOk(sight(s), level)) continue;
        sight(s);
        s.level = level;
        return s;
      }
    }
    const s = site(cands[0]);
    sight(s);
    s.level = 5;
    return s;
  }

  /** 후보 자리 (덜 벗어난 순) */
  _candidates(def, ctx, index) {
    const R = CONFIG.testRange;
    const D = def.distance;
    const latMax = Math.min(R.lateralSearch, D * Math.tan(clamp(R.maxOffAxisDeg, 0, 89) * DEG));
    const step = Math.max(0.1, R.lateralStep);
    const dStep = Math.max(0.005, R.distanceStep);
    const nl = Math.floor(latMax / step + 1e-9), nd = Math.floor(Math.max(0, R.distanceSearch) / dStep + 1e-9);
    const side = ctx.side * (index % 2 ? -1 : 1);
    const { eye, f, r } = ctx;
    const out = [];
    for (let i = -nl; i <= nl; i++) {
      for (let j = -nd; j <= nd; j++) {
        const lat = i * step, dist = D * (1 + j * dStep);
        out.push({
          lat, dist,
          cost: Math.abs(lat) + DIST_COST * Math.abs(dist - D) + (lat * side < 0 ? 1e-6 : 0),
          x: eye.x + f.x * dist + r.x * lat, z: eye.z + f.z * dist + r.z * lat,
        });
      }
    }
    out.sort((a, b) => a.cost - b.cost);
    return out;
  }

  /** 후보 하나의 표적 자세·발자리·수풀 (ok = 지면·몸 자리 조건) */
  _site(c, def, ctx) {
    const R = CONFIG.testRange;
    const stance = STANCES.includes(def.stance) ? def.stance : 'stand';
    const walk = !!def.walk && stance !== 'prone';
    const eye = ctx.eye;
    let fx = eye.x - c.x, fz = eye.z - c.z;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl; fz /= fl;                                   // 표적 → 플레이어 (수평)
    const s = {
      def, stance, walk, cover: !!def.cover, ok: true, why: '', lat: c.lat, dist: c.dist, range: fl,
      x: c.x, y: 0, z: c.z, face: { x: fx, z: fz }, faceYaw: yawOf(fx, fz), axis: { x: -fz, z: fx },
      pose: null, caps: null, chest: null, hip: null, top: 0, footA: null, footB: null,
      walkMin: 0, walkMax: 0, samples: null, bush: null, sight: null, level: 4, index: 0,
    };
    const fail = (why) => { if (s.ok) { s.ok = false; s.why = why; } };
    const g = this._ground(c.x, c.z, stance);
    if (!g.ok) fail(g.why);
    s.y = g.ok ? g.y : this._groundY(c.x, c.z);
    const pose = { x: c.x, y: s.y, z: c.z, yaw: s.faceYaw, stance, arms: 'down' };
    s.footA = { x: c.x, z: c.z };
    s.footB = s.footA;

    if (stance === 'prone') {
      // 몸이 경사를 따라 눕도록 (머리 쪽이 높으면 +) — 다리가 땅에 박히거나 뜨지 않게
      const hf = this._groundY(c.x + fx * 0.3, c.z + fz * 0.3);
      const hb = this._groundY(c.x - fx * (PRONE_LEN - 0.15), c.z - fz * (PRONE_LEN - 0.15));
      pose.bodyPitch = Math.atan2(hf - hb, PRONE_LEN + 0.15);
      if (Math.abs(pose.bodyPitch) > R.maxSlopeDeg * DEG) fail('slope');
      if (!this._bodyClear(c.x, c.z, s.y, 0.5, BODY_R * 0.8)) fail('trunk');
      for (const d of PRONE_PROBE) {
        const px = c.x - fx * d, pz = c.z - fz * d;
        const gg = this._ground(px, pz, 'prone');
        if (!gg.ok) fail(gg.why);
        else if (!this._bodyClear(px, pz, gg.y, 0.5, BODY_R * 0.8)) fail('trunk');
      }
      s.footB = { x: c.x - fx * PRONE_LEN, z: c.z - fz * PRONE_LEN };
    }

    if (walk) {
      // 걷는 길: 가운데에서 양쪽으로 걸을 수 있는 데까지 (최대 walkRange)
      const ax = s.axis.x, az = s.axis.z;
      const span = [0, 0];
      for (let k = 0; k < 2; k++) {
        const sg = k ? 1 : -1;
        let d = 0;
        while (d + WALK_PROBE <= R.walkRange + 1e-9) {
          const px = c.x + ax * sg * (d + WALK_PROBE), pz = c.z + az * sg * (d + WALK_PROBE);
          const gg = this._ground(px, pz, stance);
          if (!gg.ok || !this._bodyClear(px, pz, gg.y, STAND_TOP, BODY_R)) break;
          d += WALK_PROBE;
        }
        span[k] = d;
      }
      s.walkMin = span[0];
      s.walkMax = span[1];
      if (span[0] + span[1] < R.walkRange) fail('walk');
      pose.yaw = yawOf(ax, az);
      s.samples = [-span[0], -span[0] / 2, 0, span[1] / 2, span[1]].map((o) => {
        const px = c.x + ax * o, pz = c.z + az * o;
        const caps = buildHitboxes({ x: px, y: this._groundY(px, pz), z: pz, yaw: pose.yaw, stance, arms: 'down' }, []);
        return { o, chest: { ...caps.chest } };
      });
      s.footA = { x: c.x - ax * span[0], z: c.z - az * span[0] };
      s.footB = { x: c.x + ax * span[1], z: c.z + az * span[1] };
    }

    s.pose = pose;
    s.caps = buildHitboxes(pose, []);
    s.chest = { ...s.caps.chest };
    s.top = topOf(s.caps) - s.y;
    // 엉덩이 (골반 캡슐 두 개의 가운데) — 수풀 없는 서기·앉기 표적은 아랫몸도 낱개 덤불에 묻히지 않아야 '보이는' 표적
    if (stance !== 'prone' && !s.cover) s.hip = partCenter(s.caps, 'pelvis');
    if (stance !== 'prone' && !this._bodyClear(c.x, c.z, s.y, s.top, BODY_R)) fail('trunk');
    if (s.cover) s.bush = this._makeBush(s, eye);
    return s;
  }

  /**
   * 수풀: 표적 앞 (플레이어 쪽) cover.gap m. 윗면은 '플레이어 눈에서 본' 표적 키 × heightFrac 높이 —
   * 눈 → (표적 발 + 키 × heightFrac) 직선이 수풀 자리를 지나는 높이. 표적이 위(오르막)에 있으면 수풀을 낮추고
   * 아래에 있으면 높여서, 어디서 보든 아랫부분만 가린다 (발 기준 높이로 두면 올려다볼 때 가슴까지 묻힌다).
   */
  _makeBush(s, eye) {
    const C = CONFIG.testRange.cover;
    const x = s.x + s.face.x * C.gap, z = s.z + s.face.z * C.gap;
    const y = this._groundY(x, z);
    const coverY = s.y + s.top * C.heightFrac;
    const k = s.range > C.gap ? (s.range - C.gap) / s.range : 0;   // 눈 → 표적 수평 거리 중 수풀까지 비율
    const top = eye.y + (coverY - eye.y) * k;
    const height = clamp(top - y, C.minHeight, Math.max(C.minHeight, s.top * 1.5));
    return { x, y, z, r: C.radius, height, sigma: C.sigma };
  }

  /** 다른 표적과 간격 (발자리 선분끼리 — 엎드린 몸·걷는 길 포함) */
  _spaced(s, ctx) {
    const min = CONFIG.testRange.spacing;
    for (let i = 0; i < ctx.placed.length; i++) {
      const o = ctx.placed[i];
      if (segSegDistSq2(s.footA, s.footB, o.footA, o.footB) < min * min) return false;
    }
    return true;
  }

  /** 내 가슴까지 사격선이 이미 선 표적 몸·수풀을 지나는가 (걷는 표적은 지나가며 잠깐 가릴 뿐이라 뺀다) */
  _crossesOthers(s, ctx) {
    const e = ctx.eye;
    for (let i = 0; i < ctx.placed.length; i++) {
      const o = ctx.placed[i];
      if (!o.walk && lineHitsCaps(e, s.chest, o.caps)) return true;
    }
    for (let i = 0; i < ctx.bushes.length; i++) if (lineHitsBush(e, s.chest, ctx.bushes[i])) return true;
    return false;
  }

  /** 눈에서 본 방향이 이미 선 표적과 minSeparationDeg 보다 가까운가 (앞뒤로 겹쳐 보여 어느 표적인지 헷갈림) */
  _overlapsOnScreen(s, ctx) {
    const e = ctx.eye;
    const cosMin = Math.cos(Math.max(0, CONFIG.testRange.minSeparationDeg) * DEG);
    const ax = s.chest.x - e.x, ay = s.chest.y - e.y, az = s.chest.z - e.z;
    const al = Math.hypot(ax, ay, az) || 1;
    for (let i = 0; i < ctx.placed.length; i++) {
      const c = ctx.placed[i].chest;
      const bx = c.x - e.x, by = c.y - e.y, bz = c.z - e.z;
      if ((ax * bx + ay * by + az * bz) / (al * (Math.hypot(bx, by, bz) || 1)) > cosMin) return true;
    }
    return false;
  }

  /** 내 몸(걷는 표적 제외)·수풀이 이미 선 표적의 사격선을 가리는가 — 보이는 표적(level ≤ 1)만 지킨다 */
  _hidesOthers(s, ctx) {
    const e = ctx.eye;
    for (let i = 0; i < ctx.placed.length; i++) {
      const o = ctx.placed[i];
      if (o.level > 1) continue;
      if (!s.walk && lineHitsCaps(e, o.chest, s.caps)) return true;
      if (s.bush && lineHitsBush(e, o.chest, s.bush)) return true;
    }
    return false;
  }

  /**
   * 눈 → 가슴 (걷는 표적은 길 위 5점, 가운데부터 — 가운데가 막히면 나머지는 보지 않음) 시야: 막힘·투과율.
   * 수풀 없는 서기·앉기 표적은 엉덩이까지 직선이 지나는 낱개 덤불도 투과율에 곱한다 (가슴 높이 덤불 뒤에 아랫몸이 묻힌 자리 제외).
   */
  _sight(s, eye) {
    const pts = s.samples ? s.samples.map((q) => q.chest) : [s.chest];
    const mid = s.samples ? 2 : 0;
    const first = this._ray(eye, pts[mid]);
    if (!first.blocked && s.hip && first.vis > 0) {
      first.plantsLow = this._plantsCrossed(eye, s.hip);
      first.vis *= (1 - PLANT_OPACITY) ** first.plantsLow;
    }
    const out = { blocked: first.blocked, blockedSamples: first.blocked ? 1 : 0, vis: first.vis, visMid: first.vis, by: first.by, partials: first.partials };
    if (first.blocked || pts.length === 1) return out;
    let vis = first.vis, blocked = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i === mid) continue;
      const r = this._ray(eye, pts[i]);
      if (r.blocked) { blocked++; if (!out.by) out.by = r.by; } else vis += r.vis;
    }
    out.blockedSamples = blocked;
    out.blocked = blocked * 2 > pts.length;
    out.vis = vis / pts.length;
    return out;
  }

  /**
   * 직선 하나: 막힘 (BulletWorld.cast — 해석적이라 빠르고 지지형·논둑·리아나까지 정확, 그다음 raycastWorld 'bullet')
   * → raycastWorld 'vision' 투과율. 막히면 비싼 시야 행진은 하지 않는다.
   */
  _ray(eye, p) {
    const q = this.query;
    const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-6) return { blocked: false, by: null, vis: 1, partials: [] };
    const w = this.combat?.world;
    if (w && typeof w.cast === 'function') {
      const c = w.cast(eye, p, this._castOut);
      if (c.hit) return { blocked: true, by: c.objectType, vis: 0, partials: [] };
    }
    if (!q) return { blocked: false, by: null, vis: 1, partials: [], plants: 0 };
    const dir = { x: dx, y: dy, z: dz };
    const rb = q.raycastWorld(eye, dir, L, 'bullet');
    if (rb.hit) return { blocked: true, by: rb.object?.type ?? 'terrain', vis: 0, partials: [], plants: 0 };
    const partials = rb.passed.filter((e) => e.block === 'partial').map((e) => e.type);
    const rv = q.raycastWorld(eye, dir, L, 'vision');
    const plants = rv.hit ? 0 : this._plantsCrossed(eye, p);
    return { blocked: false, by: null, vis: rv.hit ? 0 : rv.transmittance * (1 - PLANT_OPACITY) ** plants, partials, plants };
  }

  /** 사격선 e→p 가 지나는 낱개 식물 잎 덩어리 수 (식물 격자를 선분이 지나는 칸 순서로 훑음, 눈 앞 PLANT_NEAR m 제외) */
  _plantsCrossed(e, p) {
    if (this._plants === undefined) this._plants = buildPlantGrid(this.query?.data?.placements, this.query?.half);
    const G = this._plants;
    if (!G) return 0;
    const dx = p.x - e.x, dy = p.y - e.y, dz = p.z - e.z;
    const l2 = dx * dx + dz * dz;
    if (l2 < 1e-6) return 0;
    const tNear = PLANT_NEAR / Math.sqrt(l2);
    const stamp = ++G.stamp;
    const cs = PLANT_CELL, N = G.n, h = G.half;
    let i = clampCell(Math.floor((e.x + h) / cs), N), j = clampCell(Math.floor((e.z + h) / cs), N);
    const iEnd = clampCell(Math.floor((p.x + h) / cs), N), jEnd = clampCell(Math.floor((p.z + h) / cs), N);
    const si = dx > 0 ? 1 : dx < 0 ? -1 : 0, sj = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const tdx = si ? cs / Math.abs(dx) : Infinity, tdz = sj ? cs / Math.abs(dz) : Infinity;
    let tmx = si > 0 ? ((i + 1) * cs - h - e.x) / dx : si < 0 ? (i * cs - h - e.x) / dx : Infinity;
    let tmz = sj > 0 ? ((j + 1) * cs - h - e.z) / dz : sj < 0 ? (j * cs - h - e.z) / dz : Infinity;
    let n = 0;
    for (let guard = 0; guard < 4 * N; guard++) {
      const list = G.cells[j * N + i];
      if (list) {
        for (let k = 0; k < list.length; k++) {
          const q = list[k];
          if (q.s === stamp) continue;
          q.s = stamp;
          const t = ((q.x - e.x) * dx + (q.z - e.z) * dz) / l2;   // 덩어리 중심에 가장 가까운 사격선 위 점
          if (t < tNear || t > 1) continue;                        // 눈 바로 앞, 표적 뒤는 상관없음
          const cx = e.x + dx * t - q.x, cz = e.z + dz * t - q.z;
          if (cx * cx + cz * cz >= q.r * q.r) continue;
          const y = e.y + dy * t;
          if (y >= q.y0 && y <= q.y1) n++;
        }
      }
      if (i === iEnd && j === jEnd) break;
      if (tmx < tmz) { i += si; tmx += tdx; } else { j += sj; tmz += tdz; }
      if (i < 0 || i >= N || j < 0 || j >= N) break;
    }
    return n;
  }

  // =================================================================
  // 지면
  // =================================================================
  /** 표적이 설 수 있는 지면인가 (공용 결과 객체 — 바로 읽을 것) */
  _ground(x, z, stance) {
    const G = this._g;
    const q = this.query;
    G.ok = true; G.why = '';
    if (!q) { G.y = this._flatY(); return G; }
    const R = CONFIG.testRange;
    const lim = q.half - MAP_MARGIN;
    if (!(Math.abs(x) <= lim && Math.abs(z) <= lim)) return bad(G, 'edge');
    const gi = q.getGroundInfo(x, z);
    G.y = gi.support;
    if (gi.obstacle) return bad(G, 'obstacle');                         // 통나무·바위·뿌리 위
    if (gi.waterDepth > (R.maxWaterDepth?.[stance] ?? 0.3)) return bad(G, 'water');
    if (!gi.onDike && q.getSlope(x, z).deg > R.maxSlopeDeg) return bad(G, 'slope');
    return G;
  }

  /** 발 높이: 지형 또는 논둑 윗면 (통나무·바위 윗면은 아님) */
  _groundY(x, z) {
    const q = this.query;
    if (!q) return this._flatY();
    const gi = q.getGroundInfo(x, z);
    return gi.obstacle ? gi.terrain : gi.support;
  }

  _flatY() {
    const g = this.combat?.world?.groundY;
    return Number.isFinite(g) ? g : 0;
  }

  /** 몸 자리(반경 radius, 높이 y~y+top)가 줄기·대나무·덩굴 벽 원기둥과 겹치지 않는가 (잎 덩어리는 겹쳐도 됨) */
  _bodyClear(x, z, y, top, radius) {
    const q = this.query;
    if (!q) return true;
    // 원기둥은 몸 반경(0.6m)만큼 넓힌 칸에 들어 있어 이 칸만 보면 된다 (WorldQuery.resolveCircles 와 같은 규칙)
    const list = q.circleGrid.at(x, z);
    for (let k = 0; k < list.length; k++) {
      const c = list[k];
      const tg = c.tags;
      if (!tg.blocksMovement && tg.bulletBlock === 'none') continue;
      if (c.y1 < y || c.y0 > y + top) continue;
      const dx = x - c.x, dz = z - c.z, rr = c.r + radius;
      if (dx * dx + dz * dz < rr * rr) return false;
    }
    return true;
  }

  // =================================================================
  // 표적 만들기
  // =================================================================
  _addTarget(s) {
    const R = CONFIG.testRange;
    const def = s.def;
    const t = {
      person: null, def,
      label: `${def.distance}m ${R.stanceLabels?.[s.stance] ?? s.stance} 표적`,
      distance: def.distance, stance: s.stance, cover: s.cover, walk: s.walk,
      pos: { x: s.x, y: s.y, z: s.z }, yaw: s.pose.yaw, axis: { x: s.axis.x, z: s.axis.z }, phase: 0,
      wobble: { x: 0, z: 0, vx: 0, vz: 0 }, hits: 0,
      // 배치 결과 (보고·디버그)
      lateral: s.lat, along: s.dist, range: s.range, level: s.level, clear: s.level === 0,
      visibility: s.sight ? s.sight.vis : 0, blockedBy: s.sight ? s.sight.by : null, why: s.why,
      top: s.top, bush: null,
      // 걷기: 가운데, 축 위 범위 [-walkMin, walkMax], 방향, 돌아서기
      center: { x: s.x, z: s.z }, walkMin: s.walkMin, walkMax: s.walkMax, walkDir: 1,
      turn: 0, turnTime: 0, turnFrom: 0, turnDelta: 0, faceYaw: s.faceYaw,
      pose: { ...s.pose },
    };
    if (t.walk) {
      t.walkDir = this.rng.sign();
      t.yaw = walkYaw(t);
      t.pose.yaw = t.yaw;
    }
    if (this.query && typeof this.query.getGroundInfo === 'function') {
      // 사람 개체: 이동 컴포넌트가 지면·걷기·자세를, 부상 컴포넌트가 피격 결과를 맡는다
      const e = new HumanEntity(this.query, this.combat, {
        x: s.x, z: s.z, y: s.y, yaw: t.yaw, stance: s.stance, name: t.label, arms: 'down',
        rng: new RNG((this.rng.float() * 4294967296) >>> 0), data: { kind: 'target', target: t },
        walk: t.walk ? { center: { x: s.x, z: s.z }, axis: { x: t.axis.x, z: t.axis.z }, min: t.walkMin, max: t.walkMax, dir: t.walkDir, faceYaw: t.faceYaw } : null,
      });
      t.entity = e;
      t.person = e.person;
      t.injuries = e.injuries;
      for (const ev of ['vocal', 'bleed', 'fall', 'death']) e.on(ev, (x) => this.emit(ev, { ...x, target: t }));
      this._syncEntity(t);
    } else {
      t.person = this.combat.addPerson({ name: t.label, getPose: () => t.pose, suppression: null, data: { kind: 'target', target: t } });
    }
    this._byPerson.set(t.person, t);
    if (s.bush) {
      const b = { ...s.bush };
      t.bush = b;
      this.bushes.push(b);
      const world = this.combat.world;
      if (world && Array.isArray(world.extraFoliage)) world.extraFoliage.push(b);
    }
    this.targets.push(t);
    return t;
  }

  // =================================================================
  // 움직임
  // =================================================================
  _walk(t, dt) {
    const v = Math.max(0, CONFIG.testRange.walkSpeed);
    let rem = dt;
    for (let guard = 0; rem > 1e-9 && guard < 16; guard++) {
      if (t.turn > 0) {
        const used = Math.min(rem, t.turn);
        t.turn -= used;
        rem -= used;
        if (t.turn <= 1e-9) {
          t.turn = 0;
          t.walkDir = -t.walkDir;
          t.yaw = walkYaw(t);
        } else {
          t.yaw = t.turnFrom + t.turnDelta * smoothstep(0, 1, 1 - t.turn / t.turnTime);
        }
        continue;
      }
      if (!(v > 0) || t.walkMin + t.walkMax < 1e-6) break;
      const end = t.walkDir > 0 ? t.walkMax : -t.walkMin;
      const left = (end - t.phase) * t.walkDir;   // 끝까지 남은 거리 (m)
      if (v * rem < left) {
        t.phase += t.walkDir * v * rem;
        rem = 0;
      } else {
        t.phase = end;
        rem -= Math.max(0, left) / v;
        this._startTurn(t);
      }
    }
    t.pos.x = t.center.x + t.axis.x * t.phase;
    t.pos.z = t.center.z + t.axis.z * t.phase;
    // 경사에서는 거의 그대로 (1.4m/s × 10° 경사 → 2cm 지연), 턱에서는 0.1~0.2초에 걸쳐 디딤 — 판정과 화면이 같은 pos 를 쓴다
    t.pos.y += (this._groundY(t.pos.x, t.pos.z) - t.pos.y) * (1 - Math.exp(-WALK_Y_RATE * dt));
    const p = t.pose;
    p.x = t.pos.x; p.y = t.pos.y; p.z = t.pos.z; p.yaw = t.yaw;
    t.person.refresh();   // 이번 프레임 사격이 화면과 같은 자리를 맞히게 캡슐을 바로 갱신
  }

  /** 사람 개체 한 프레임: 이동·부상 → 표적 필드(pos, yaw, stance, pose)를 개체에서 읽어 둔다 (TargetMesh·로그용) */
  _entityStep(t, dt) {
    t.entity.update(dt);
    this._syncEntity(t);
    t.person.refresh();   // 이번 프레임 사격이 화면과 같은 자리를 맞히게 캡슐을 바로 갱신
  }

  _syncEntity(t) {
    const e = t.entity, m = e.motor;
    t.pos.x = m.position.x; t.pos.y = m.position.y; t.pos.z = m.position.z;
    t.yaw = m.yaw;
    t.stance = m.stance;
    t.pose = e.pose();
    t.state = e.state;
  }

  /** 끝에 닿음: 플레이어를 바라보는 쪽으로 돌아 반대 방향까지 (앞모습을 보이며 180°) */
  _startTurn(t) {
    const T = Math.max(0, CONFIG.testRange.walkTurnTime);
    if (!(T > 0)) { t.walkDir = -t.walkDir; t.yaw = walkYaw(t); return; }
    t.turn = T;
    t.turnTime = T;
    t.turnFrom = t.yaw;
    const half = wrapAngle(t.faceYaw - t.yaw);
    t.turnDelta = 2 * (Math.abs(half) > 1e-3 ? half : Math.PI / 2);
  }

  /** 기울기 스프링 (rad): 맞으면 _kick 이 속도를 더하고 여기서 감쇠 진동 */
  _wobble(t, dt) {
    const w = t.wobble;
    if (w.x === 0 && w.z === 0 && w.vx === 0 && w.vz === 0) return;
    const W = CONFIG.testRange.wobble;
    const om = 2 * Math.PI * W.frequency, k = om * om, c = 2 * W.damping * om;
    const n = Math.max(1, Math.ceil(dt / WOBBLE_STEP));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      w.vx += (-k * w.x - c * w.vx) * h;
      w.vz += (-k * w.z - c * w.vz) * h;
      w.x += w.vx * h;
      w.z += w.vz * h;
    }
    const max = W.maxDeg * DEG, m = Math.hypot(w.x, w.z);
    if (m > max) { w.x *= max / m; w.z *= max / m; }
    if (m < 1e-5 && Math.hypot(w.vx, w.vz) < 1e-4) { w.x = 0; w.z = 0; w.vx = 0; w.vz = 0; }
  }

  // =================================================================
  // 피격
  // =================================================================
  _onHit(e) {
    const t = this._byPerson.get(e.person);
    if (!t) return;
    t.hits++;
    const w = e.wound ?? null;
    if (!w || !w.alreadyDead) this._kick(t, e);
    if (t.entity) t.entity.onHit(e);
    const pen = Array.isArray(e.penetrated) ? e.penetrated.slice() : [];
    const label = partLabel(e.part);
    const text = `${t.label} · ${label} · ${(e.distance ?? 0).toFixed(1)}m · ${(e.timeOfFlight ?? 0).toFixed(3)}s · ${pen.length ? `관통: ${penetrationText(pen)}` : '관통 없음'}${woundText(w)}`;
    const entry = {
      text, part: e.part, partLabel: label, distance: e.distance, tof: e.timeOfFlight, penetrated: pen, target: t, time: this.time,
      speed: e.speed, incidenceDeg: e.incidenceDeg, point: { x: e.point.x, y: e.point.y, z: e.point.z }, shooter: e.shooter ?? null,
      wound: w,
    };
    this.log.unshift(entry);
    const max = Math.max(1, CONFIG.testRange.logSize | 0);
    if (this.log.length > max) this.log.length = max;
    this.emit('log', { entry });
  }

  /** 맞은 높이가 높을수록(머리) 크게, 탄이 날아간 수평 방향으로 기울어짐 */
  _kick(t, e) {
    const W = CONFIG.testRange.wobble;
    const d = e.dir;
    const h = d ? Math.hypot(d.x, d.z) : 0;
    if (h < 1e-6) return;
    const rel = clamp((e.point.y - t.pos.y) / Math.max(0.3, t.top), 0.15, 1);
    const amp = W.impulseDeg * DEG * rel * (W.stanceMul?.[t.stance] ?? 1);
    const v = amp * 2 * Math.PI * W.frequency;   // 감쇠가 작으면 최대 기울기 ≈ amp
    t.wobble.vx += (d.x / h) * v;
    t.wobble.vz += (d.z / h) * v;
  }
}

// ---------------------------------------------------------------
// 도우미
// ---------------------------------------------------------------
/**
 * 자리 잡는 순서 (같은 순위면 가까운 것부터): 엎드린 표적(마른 평지 + 낮은 사격선 — 가장 까다로움) → 걷는 표적(긴 길)
 * → 나머지 → 수풀 표적. 나중 표적은 먼저 선 표적의 보이는 사격선을 가리지 않는 자리로 비켜 선다.
 */
function priority(def) {
  if (def.stance === 'prone') return 0;
  if (def.walk) return 1;
  return def.cover ? 3 : 2;
}

function sightOk(sight, level) {
  if (sight.blocked) return false;
  if (level === 0) return sight.blockedSamples === 0 && sight.vis >= CONFIG.testRange.minVisibility;
  if (level === 1) return sight.vis > 0;
  return true;
}

function bad(G, why) { G.ok = false; G.why = why; return G; }

function clampCell(v, n) { return v < 0 ? 0 : v >= n ? n - 1 : v; }

/** 낱개 식물 잎 덩어리 격자 (처음 배치할 때 한 번) — 덩어리 {x, z, y0, y1, r} 를 발자리가 걸친 칸마다 */
function buildPlantGrid(P, half) {
  if (!P || !Number.isFinite(half)) return null;
  const N = Math.ceil((2 * half) / PLANT_CELL) + 1;
  const cells = new Array(N * N);
  let count = 0;
  for (const key in PLANT_SHAPES) {
    const list = P[key];
    if (!Array.isArray(list)) continue;
    const [topK, rK] = PLANT_SHAPES[key];
    for (let k = 0; k < list.length; k++) {
      const p = list[k];
      const hgt = p.height ?? 1, top = hgt * topK;
      const q = { x: p.x, z: p.z, y0: p.y + top * 0.15, y1: p.y + top, r: hgt * rK, s: 0 };   // 아래 15% 는 줄기
      const i0 = clampCell(Math.floor((q.x - q.r + half) / PLANT_CELL), N), i1 = clampCell(Math.floor((q.x + q.r + half) / PLANT_CELL), N);
      const j0 = clampCell(Math.floor((q.z - q.r + half) / PLANT_CELL), N), j1 = clampCell(Math.floor((q.z + q.r + half) / PLANT_CELL), N);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (cells[j * N + i] ||= []).push(q);
      count++;
    }
  }
  return count ? { N, n: N, half, cells, count, stamp: 0 } : null;
}

function walkYaw(t) { return yawOf(t.axis.x * t.walkDir, t.axis.z * t.walkDir); }

/** 부위 캡슐들(좌우 쌍 포함)의 끝점 평균 */
function partCenter(caps, part) {
  let x = 0, y = 0, z = 0, n = 0;
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    if (c.part !== part) continue;
    x += c.a.x + c.b.x; y += c.a.y + c.b.y; z += c.a.z + c.b.z; n += 2;
  }
  return n ? { x: x / n, y: y / n, z: z / n } : null;
}

function topOf(caps) {
  let top = -Infinity;
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    top = Math.max(top, c.a.y + c.r, c.b.y + c.r);
  }
  return top;
}

/** 직선 e→p 가 캡슐(반경 + LINE_MARGIN) 중 하나라도 지나는가 */
function lineHitsCaps(e, p, caps) {
  const dx = p.x - e.x, dy = p.y - e.y, dz = p.z - e.z;
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    if (segCapsuleRaw(e.x, e.y, e.z, dx, dy, dz, c.a.x, c.a.y, c.a.z, c.b.x, c.b.y, c.b.z, c.r + LINE_MARGIN) >= 0) return true;
  }
  return false;
}

/** 직선 e→p 가 수풀 원기둥(반경 + LINE_MARGIN, 높이 y~y+height)을 지나는가 */
function lineHitsBush(e, p, b) {
  const dx = p.x - e.x, dz = p.z - e.z;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((b.x - e.x) * dx + (b.z - e.z) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = e.x + dx * t - b.x, cz = e.z + dz * t - b.z;
  const rr = b.r + LINE_MARGIN;
  if (cx * cx + cz * cz >= rr * rr) return false;
  const y = e.y + (p.y - e.y) * t;
  return y < b.y + b.height && y > b.y - LINE_MARGIN;
}

/** 수평 선분 a0-a1 과 b0-b1 사이 최단 거리² (점이면 a0 === a1) */
function segSegDistSq2(a0, a1, b0, b1) {
  if (segsCross2(a0, a1, b0, b1)) return 0;
  return Math.min(pointSegSq2(a0, b0, b1), pointSegSq2(a1, b0, b1), pointSegSq2(b0, a0, a1), pointSegSq2(b1, a0, a1));
}
function pointSegSq2(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = a.x + dx * t - p.x, cz = a.z + dz * t - p.z;
  return cx * cx + cz * cz;
}
function segsCross2(a0, a1, b0, b1) {
  const d1 = cross2(b0, b1, a0), d2 = cross2(b0, b1, a1), d3 = cross2(a0, a1, b0), d4 = cross2(a0, a1, b1);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function cross2(o, a, b) { return (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x); }

/** 관통한 물체 종류 → '대나무 ×2, 물' (처음 나온 순서) */
/** 부상 결과 꼬리말 (F3 로그) */
function woundText(w) {
  if (!w) return '';
  if (w.alreadyDead) return ' · (이미 사망)';
  const J = CONFIG.injury;
  if (w.severity === 'lethal') return ` · 치명(${J.causes[w.zone] ?? w.zone})`;
  if (w.severity === 'graze') return ` · 스침${w.lowSpeed ? '(저속)' : ''}`;
  return ` · 부상(${J.typeLabels[w.type] ?? w.type}${w.arterial ? '·동맥' : ''}${w.lowSpeed ? '·저속' : ''})`;
}

function penetrationText(types) {
  const labels = CONFIG.testRange.objectLabels ?? {};
  const counts = new Map();
  for (const ty of types) counts.set(ty, (counts.get(ty) || 0) + 1);
  const parts = [];
  for (const [ty, n] of counts) parts.push(n > 1 ? `${labels[ty] ?? ty} ×${n}` : (labels[ty] ?? ty));
  return parts.join(', ');
}
